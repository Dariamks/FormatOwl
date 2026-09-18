import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { assets, jobs, preparations, jobInputs } from '@filemorph/core/schema';
import { headObject } from '@filemorph/core/storage';
import { type PreparationView, type EditOptions, type EditorTool } from '@filemorph/core/editing';
import type { JobView } from '@filemorph/core/domain';
const origin = 'http://127.0.0.1:3000';
class Client {
  cookie = '';
  async call<T = any>(
    path: string,
    body?: unknown,
    status = 200,
    method = body === undefined ? 'GET' : 'POST',
  ): Promise<T> {
    const r = await fetch(`${origin}/api/${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of r.headers.getSetCookie())
      if (c.startsWith('fm-session=')) this.cookie = c.split(';')[0];
    const data = await r.json();
    assert.equal(r.status, status, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
}
const a = new Client(),
  b = new Client(),
  ids: string[] = [],
  sourceIds: string[] = [];
async function until<T>(fn: () => Promise<T>, ready: (v: T) => boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (ready(v)) return v;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 400));
  }
}
async function upload(name: string) {
  const data = await readFile(`.data/fixtures/${name}`);
  const up = await a.call<{ id: string; partSize: number }>('uploads', { name, size: data.length });
  sourceIds.push(up.id);
  for (let i = 0, partNumber = 1; i < data.length; i += up.partSize, partNumber++) {
    const { url } = await a.call(`uploads/${up.id}/parts`, { partNumber });
    assert.equal(
      (await fetch(url, { method: 'PUT', body: data.subarray(i, i + up.partSize) })).status,
      200,
    );
  }
  await a.call(`uploads/${up.id}/complete`, {});
  return up.id;
}
async function prepare(id: string, profile: 'audio' | 'video', streamIndex = -1) {
  const first = await a.call<PreparationView>(`assets/${id}/prepare`, { profile, streamIndex });
  assert.equal(
    (await a.call<PreparationView>(`assets/${id}/prepare`, { profile, streamIndex })).id,
    first.id,
  );
  return until(
    () =>
      a.call<PreparationView>(`assets/${id}/prepare?profile=${profile}&streamIndex=${streamIndex}`),
    (p) => ['completed', 'failed'].includes(p.state),
  );
}
async function create(
  tool: EditorTool,
  assetIds: string[],
  options: EditOptions,
  purpose: 'export' | 'preview' = 'export',
) {
  const body = { tool, assetIds, options, purpose, requestId: crypto.randomUUID() };
  const result = await a.call<{ id: string }>('jobs', body);
  ids.push(result.id);
  assert.equal((await a.call('jobs', body)).id, result.id);
  if (tool === 'video-cutter' || tool === 'video-cropper')
    await a.call(
      'jobs',
      {
        ...body,
        options: {
          ...options,
          format: 'format' in options && options.format === 'mov' ? 'mkv' : 'mov',
        },
      },
      409,
    );
  await a.call(
    'jobs',
    { ...body, purpose: purpose === 'export' ? 'preview' : 'export' },
    tool === 'audio-cutter' ? 409 : 400,
  );
  const job = (
    await until(
      () => a.call<{ job: JobView }>(`jobs/${result.id}`),
      (r) => ['completed', 'failed', 'cancelled'].includes(r.job.state),
    )
  ).job;
  assert.equal(job.state, 'completed', job.error || '');
  const { url } = await a.call(`jobs/${job.id}/download`);
  const file = await fetch(url);
  assert.equal(file.status, 200);
  assert.equal(Number(file.headers.get('content-length')), job.outputSize);
  console.log(`PASS ${tool} ${purpose}: ${job.outputName}`);
  return job;
}
await mkdir('.data/editor-api-checks', { recursive: true });
try {
  await a.call('session');
  await b.call('session');
  const video = await upload('editor-multitrack.mp4'),
    sound = await upload('editor-low.wav');
  const vp = await prepare(video, 'video'),
    ap = await prepare(sound, 'audio');
  assert.equal(vp.state, 'completed');
  assert.equal(ap.state, 'completed');
  assert.equal(vp.media!.defaultAudioIndex, 2);
  for (const url of [vp.previewUrl, vp.thumbnailsUrl, ap.previewUrl, ap.peaksUrl])
    assert.equal((await fetch(url!)).status, 200);
  await b.call(`assets/${video}/prepare?profile=video`, undefined, 404);
  await b.call(`assets/${video}/prepare`, { profile: 'audio' }, 404);
  const v2 = await prepare(video, 'audio', 1);
  assert.equal(v2.state, 'completed');
  const extract = await create('video-to-mp3', [video], {
    audioStreamIndex: 2,
    bitrate: 320,
    range: { startMs: 200, endMs: 1800 },
  });
  assert.equal(extract.outputMedia?.kind, 'audio');
  const cut = await create('video-cutter', [video], {
    format: 'mkv',
    mode: 'remove',
    ranges: [{ startMs: 1000, endMs: 3000 }],
  });
  const cropped = await create('video-cropper', [video], {
    format: 'mov',
    rect: { x: 160, y: 120, width: 160, height: 120 },
  });
  assert.equal(cropped.outputMedia?.width, 160);
  for (const job of [cut, cropped]) {
    assert.equal(
      job.outputMime,
      job.tool === 'video-cutter' ? 'video/x-matroska' : 'video/quicktime',
    );
    const { url } = await a.call(`jobs/${job.id}/download?inline=1&preview=1`);
    const previewFile = await fetch(url);
    assert.equal(previewFile.status, 200);
    assert.equal(previewFile.headers.get('content-type'), 'video/mp4');
    assert.ok((await previewFile.arrayBuffer()).byteLength > 0);
    await b.call(`jobs/${job.id}/download?inline=1&preview=1`, undefined, 404);
  }
  const options = {
    format: 'm4r' as const,
    bitrate: 192 as const,
    clips: [
      { assetId: sound, streamIndex: 0, startMs: 0, endMs: 1500, fadeInMs: 250, fadeOutMs: 250 },
      { assetId: video, streamIndex: 1, startMs: 0, endMs: 1000, fadeInMs: 0, fadeOutMs: 0 },
    ],
  };
  const preview = await create('audio-cutter', [sound, video], options, 'preview');
  const joined = await create('audio-cutter', [sound, video], options);
  assert.equal(preview.outputMime, 'audio/mp4');
  assert.equal(joined.sourceIds.length, 2);
  assert.equal(joined.outputName?.endsWith('.m4r'), true);
  const listed = await a.call<{ jobs: JobView[] }>('jobs');
  assert.ok(!listed.jobs.some((j) => j.id === preview.id));
  await b.call(`jobs/${joined.id}/download`, undefined, 404);
  await b.call(
    'jobs',
    { assetIds: [sound, video], tool: 'audio-cutter', options, requestId: crypto.randomUUID() },
    404,
  );
  await a.call(
    'jobs',
    { assetIds: [sound], tool: 'audio-cutter', options, requestId: crypto.randomUUID() },
    400,
  );
  await a.call(
    'jobs',
    {
      assetId: video,
      tool: 'video-cropper',
      options: { rect: { x: 319, y: 0, width: 100, height: 100 } },
      requestId: crypto.randomUUID(),
    },
    400,
  );
  await a.call(
    'batches',
    {
      assetIds: [video],
      tool: 'video-cutter',
      options: { mode: 'keep', ranges: [{ startMs: 0, endMs: 1000 }] },
      requestId: crypto.randomUUID(),
    },
    400,
  );
  await a.call(
    'jobs',
    {
      assetId: video,
      tool: 'video-to-mp3',
      options: { audioStreamIndex: 99, bitrate: 192 },
      requestId: crypto.randomUUID(),
    },
    400,
  );
  console.log(
    'PASS ownership, source membership, invalid crop/track, explicit batch boundary, preview isolation',
  );
  await a.call(`jobs/${preview.id}`, undefined, 200, 'DELETE');
  await until(
    async () => (await db().select().from(jobs).where(eq(jobs.id, preview.id))).length,
    (n) => n === 0,
  );
  assert.equal((await db().select().from(assets).where(eq(assets.id, sound)))[0].state, 'ready');
  assert.equal(
    (await db().select().from(jobInputs).where(eq(jobInputs.jobId, joined.id))).length,
    2,
  );
  const { url } = await a.call(`jobs/${joined.id}/download`);
  assert.equal((await fetch(url)).status, 200);
  console.log('PASS deleting a preview preserves shared sources and exports');
  const silent = await upload('silent.mp4');
  assert.equal((await prepare(silent, 'audio')).error, 'NO_AUDIO');
  const hdr = await upload('editor-hdr.mp4');
  assert.equal((await prepare(hdr, 'video')).error, 'HDR_UNSUPPORTED');
  assert.equal((await prepare(hdr, 'audio')).state, 'completed');
  const broken = await upload('broken.mp4');
  assert.equal((await prepare(broken, 'video')).state, 'failed');
  console.log('PASS silent, HDR and corrupt input behavior');
  const [asset] = await db().select().from(assets).where(eq(assets.id, sound));
  await db()
    .update(assets)
    .set({ expiresAt: new Date(0) })
    .where(eq(assets.id, sound));
  await a.call(`assets/${sound}/prepare?profile=audio`, undefined, 404);
  await db().update(jobs).set({ state: 'failed' }).where(eq(jobs.id, joined.id));
  await a.call(`jobs/${joined.id}/retry`, {}, 404);
  await db()
    .update(preparations)
    .set({ expiresAt: new Date(0) })
    .where(eq(preparations.assetId, sound));
  await until(
    async () => (await db().select().from(assets).where(eq(assets.id, sound)))[0].state,
    (state) => state === 'expired',
  );
  await assert.rejects(() => headObject(asset.key));
  console.log('PASS expired source blocks retries and is physically removed');
  await writeFile(
    '.data/editor-api-checks/result.json',
    JSON.stringify({ passed: true, jobs: ids.length, sources: sourceIds.length }, null, 2),
  );
} finally {
  for (const id of ids) await a.call(`jobs/${id}`, undefined, 200, 'DELETE').catch(() => {});
  for (const id of sourceIds) {
    await db()
      .update(assets)
      .set({ expiresAt: new Date(0) })
      .where(eq(assets.id, id));
    await db()
      .update(preparations)
      .set({ expiresAt: new Date(0) })
      .where(eq(preparations.assetId, id));
  }
  await sqlClient().end();
}
