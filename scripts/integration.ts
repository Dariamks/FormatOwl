import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compressionSchema, type CompressionOptions, type JobView } from '@filemorph/core/domain';
import { probe } from '@filemorph/core/media';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { assets, jobs } from '@filemorph/core/schema';
import { mediaQueue } from '@filemorph/core/queue';
import { headObject } from '@filemorph/core/storage';
const origin = 'http://127.0.0.1:3000';
class Browser {
  cookie = '';
  async call<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    expected = 200,
  ): Promise<T> {
    const response = await fetch(`${origin}/api/${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie())
      if (cookie.startsWith('fm-session=')) this.cookie = cookie.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data as T;
  }
}
const a = new Browser(),
  b = new Browser();
const created: string[] = [];
await mkdir('.data/test-outputs', { recursive: true });
async function upload(name: string) {
  const data = await readFile(resolve('.data/fixtures', name));
  const result = await a.call<{ id: string; partSize: number }>('uploads', {
    name,
    size: data.length,
  });
  for (let start = 0, n = 1; start < data.length; start += result.partSize, n++) {
    const { url } = await a.call<{ url: string }>(`uploads/${result.id}/parts`, { partNumber: n });
    const response = await fetch(url, {
      method: 'PUT',
      body: data.subarray(start, start + result.partSize),
    });
    assert.equal(response.status, 200);
  }
  await a.call(`uploads/${result.id}/complete`, {});
  await a.call(`uploads/${result.id}/complete`, {});
  return result.id;
}
async function task(assetId: string, options: Partial<CompressionOptions> = {}) {
  const requestId = crypto.randomUUID();
  const body = { assetId, options: compressionSchema.parse(options), requestId };
  const { id } = await a.call<{ id: string }>('jobs', body);
  created.push(id);
  const again = await a.call<{ id: string }>('jobs', body);
  assert.equal(again.id, id);
  await a.call('jobs', { ...body, options: { ...body.options, crf: 39 } }, 'POST', 409);
  return id;
}
async function finished(id: string) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const { job } = await a.call<{ job: JobView }>(`jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Task timed out: ${id}`);
}
const results: string[] = [];
function pass(message: string) {
  results.push(message);
  console.log(`PASS ${message}`);
}
try {
  await a.call('session');
  await b.call('session');
  const denied = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test.mp4', size: 10 }),
  });
  assert.equal(denied.status, 403);
  await a.call('uploads', { name: 'test.mp4', size: 1024 ** 3 + 1 }, 'POST', 413);
  await a.call('uploads', { name: 'test.m3u8', size: 10 }, 'POST', 400);
  pass('Cross-origin mutations, excessive size and unsupported formats rejected');
  for (const name of [
    'sample.mp4',
    'sample.mov',
    'sample.mkv',
    'sample.webm',
    'silent.mp4',
    'rotated.mp4',
    'vfr.mp4',
  ]) {
    const assetId = await upload(name);
    await b.call(`uploads/${assetId}`, undefined, 'GET', 404);
    const id = await task(assetId);
    await b.call(`jobs/${id}`, undefined, 'GET', 404);
    await b.call(`jobs/${id}/download`, undefined, 'GET', 404);
    const job = await finished(id);
    assert.equal(job.state, 'completed', job.error || '');
    const { url } = await a.call<{ url: string }>(`jobs/${id}/download`);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const data = Buffer.from(await response.arrayBuffer());
    assert.equal(data.length, job.outputSize);
    const output = resolve('.data/test-outputs', name + '.mp4');
    await writeFile(output, data);
    const info = await probe(output);
    assert.ok(Math.abs(info.duration - 5) < 0.2);
    assert.equal(info.hasAudio, name !== 'silent.mp4');
    assert.equal(info.codec, 'h264');
    if (name === 'rotated.mp4') {
      assert.equal(info.width, 540);
      assert.equal(info.height, 960);
    }
    pass(`${name}: upload → persistent task → real H.264 output → private download`);
  }
  const assetId = await upload('sample.mp4');
  for (const codec of ['h264', 'h265'] as const) {
    const id = await task(assetId, {
      codec,
      targetMb: 0.5,
      resolution: '480',
      maxBitrateKbps: 1000,
    });
    const job = await finished(id);
    assert.equal(job.state, 'completed', job.error || '');
    assert.ok(job.outputSize! < 0.56 * 1024 * 1024);
    const { url } = await a.call<{ url: string }>(`jobs/${id}/download`);
    const path = resolve('.data/test-outputs', `target-${codec}.mp4`);
    await writeFile(path, Buffer.from(await (await fetch(url)).arrayBuffer()));
    const info = await probe(path);
    assert.equal(info.height, 480);
    assert.equal(info.codec, codec === 'h265' ? 'hevc' : 'h264');
    pass(`${codec}: two-pass target size, 480p and bitrate cap`);
  }
  const multipart = await readFile('.data/fixtures/multipart.mp4');
  const up = await a.call<{ id: string; partSize: number }>('uploads', {
    name: 'multipart.mp4',
    size: multipart.length,
  });
  const first = await a.call<{ url: string }>(`uploads/${up.id}/parts`, { partNumber: 1 });
  assert.equal(
    (await fetch(first.url, { method: 'PUT', body: multipart.subarray(0, up.partSize) })).status,
    200,
  );
  await a.call(`uploads/${up.id}/complete`, {}, 'POST', 400);
  const restored = new Browser();
  restored.cookie = a.cookie;
  const state = await restored.call<{ parts: { PartNumber: number }[] }>(`uploads/${up.id}`);
  assert.deepEqual(
    state.parts.map((p) => p.PartNumber),
    [1],
  );
  for (let start = up.partSize, n = 2; start < multipart.length; start += up.partSize, n++) {
    const { url } = await restored.call<{ url: string }>(`uploads/${up.id}/parts`, {
      partNumber: n,
    });
    assert.equal(
      (await fetch(url, { method: 'PUT', body: multipart.subarray(start, start + up.partSize) }))
        .status,
      200,
    );
  }
  await restored.call(`uploads/${up.id}/complete`, {});
  const multipartJob = await task(up.id);
  assert.equal((await finished(multipartJob)).state, 'completed');
  pass('Multipart upload restores after interruption and validates complete part inventory');
  const broken = await upload('broken.mp4'),
    badId = await task(broken);
  assert.equal((await finished(badId)).error, 'INVALID_MEDIA');
  await a.call(`jobs/${badId}/retry`, {});
  const retry = await finished(badId);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.state, 'failed');
  pass('Corrupted file fails clearly and manual retry creates a fresh processing attempt');
  await mediaQueue().pause();
  try {
    const cancelId = await task(assetId);
    await a.call(`jobs/${cancelId}/cancel`, {});
    assert.equal((await finished(cancelId)).state, 'cancelled');
    pass('Queued cancellation is durable');
  } finally {
    await mediaQueue().resume();
  }
  const expiryId = await task(assetId);
  assert.equal((await finished(expiryId)).state, 'completed');
  await db()
    .update(jobs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(jobs.id, expiryId));
  await a.call(`jobs/${expiryId}/download`, undefined, 'GET', 410);
  pass('Expired download denied');
  const deleteId = created[0];
  const [before] = await db().select().from(jobs).where(eq(jobs.id, deleteId));
  const [source] = await db().select().from(assets).where(eq(assets.id, before.assetId));
  await a.call(`jobs/${deleteId}`, undefined, 'DELETE');
  await a.call(`jobs/${deleteId}`, undefined, 'GET', 404);
  const deadline = Date.now() + 12000;
  let gone = false;
  while (Date.now() < deadline) {
    try {
      await headObject(before.outputKey!);
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404) {
        gone = true;
        break;
      }
      throw error;
    }
  }
  assert.ok(gone, 'Worker must remove deleted output');
  await assert.rejects(() => headObject(source.key));
  pass('Explicit deletion revokes access and removes original and result');
  await writeFile(
    '.data/test-outputs/integration-report.json',
    JSON.stringify({ date: new Date().toISOString(), passed: results.length, results }, null, 2),
  );
  console.log(`\n${results.length} integration checks passed.`);
} finally {
  for (const id of created) {
    try {
      await a.call(`jobs/${id}`, undefined, 'DELETE');
    } catch {
      /* It may already have been deleted. */
    }
  }
  await mediaQueue().close();
  await sqlClient().end();
}
