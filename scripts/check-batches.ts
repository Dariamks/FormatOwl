import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, sql, sqlClient } from '@filemorph/core/db';
import { jobs, batches, archives } from '@filemorph/core/schema';
import { headObject } from '@filemorph/core/storage';
import { runProcess } from '@filemorph/core/media';
import { pythonBinary } from '../apps/worker/src/processors';
import type { BatchView, JobView, BatchTool } from '@filemorph/core/domain';
const origin = 'http://127.0.0.1:3000';
class Client {
  cookie = '';
  async call<T = any>(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    status = 200,
  ): Promise<T> {
    const response = await fetch(`${origin}/api/${path}`, {
      method,
      headers: { Origin: origin, Cookie: this.cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of response.headers.getSetCookie())
      if (c.startsWith('fm-session=')) this.cookie = c.split(';')[0];
    const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  async upload(name: string, alias = name) {
    const bytes = await readFile(resolve('.data/fixtures', name));
    const upload = await this.call('uploads', { name: alias, size: bytes.length });
    for (
      let start = 0, partNumber = 1;
      start < bytes.length;
      start += upload.partSize, partNumber++
    ) {
      const { url } = await this.call(`uploads/${upload.id}/parts`, { partNumber });
      const response = await fetch(url, {
        method: 'PUT',
        body: bytes.subarray(start, start + upload.partSize),
      });
      assert.equal(response.status, 200);
    }
    await this.call(`uploads/${upload.id}/complete`, {});
    return upload.id as string;
  }
}
const a = new Client(),
  b = new Client();
const ids: string[] = [];
async function waitBatch(id: string) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const { batch } = await a.call<{ batch: BatchView }>(`batches/${id}`);
    if (batch.jobs.every((j) => ['completed', 'failed', 'cancelled'].includes(j.state)))
      return batch;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timeout ${id}`);
}
async function missing(key: string) {
  try {
    await headObject(key);
    return false;
  } catch (e) {
    return (e as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === 404;
  }
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Cleanup timeout');
}
await mkdir('.data/batch-checks', { recursive: true });
try {
  await a.call('session');
  await b.call('session');
  for (const [tool, names] of [
    ['image-compressor', ['photo.jpg', 'photo.jpeg', 'animated.gif', 'photo.heic', 'broken.png']],
    ['pdf-compressor', ['document.pdf', 'scan.pdf', 'encrypted.pdf']],
    ['audio-compressor', ['audio.wav', 'audio.ogg', 'broken.mp3']],
  ] as [BatchTool, string[]][]) {
    const assetIds = [];
    for (const name of names)
      assetIds.push(await a.upload(name, name === 'photo.jpeg' ? 'photo.jpg' : name));
    const options =
      tool === 'audio-compressor'
        ? { preset: 'balanced', format: 'm4a', sampleRate: '44100', channels: '1' }
        : { preset: 'balanced' };
    const body = { tool, assetIds, requestId: crypto.randomUUID(), options };
    const { id } = await a.call('batches', body);
    ids.push(id);
    assert.equal((await a.call('batches', body)).id, id);
    await a.call('batches', { ...body, options: { ...options, preset: 'strong' } }, 'POST', 409);
    await b.call(`batches/${id}`, undefined, 'GET', 404);
    const batch = await waitBatch(id);
    assert.equal(batch.jobs.filter((j) => j.state === 'completed').length, names.length - 1);
    assert.equal(batch.jobs.filter((j) => j.state === 'failed').length, 1);
    for (const job of batch.jobs.filter((j) => j.state === 'completed')) {
      const { url } = await a.call(`jobs/${job.id}/download`);
      const response = await fetch(url);
      assert.equal(response.headers.get('content-type'), job.outputMime);
      assert.equal((await response.arrayBuffer()).byteLength, job.outputSize);
      const { url: preview } = await a.call(`jobs/${job.id}/download?preview=1&inline=1`);
      assert.equal((await fetch(preview)).status, 200);
    }
    const { id: archiveId } = await a.call(`batches/${id}/archive`, {});
    assert.equal((await a.call(`batches/${id}/archive`, {})).id, archiveId);
    await b.call(`archives/${archiveId}`, undefined, 'GET', 404);
    let archive;
    await eventually(async () => {
      archive = await a.call(`archives/${archiveId}`);
      return archive.state === 'completed' || archive.state === 'failed';
    });
    assert.equal(archive!.state, 'completed');
    const zipped = await fetch(archive!.url);
    const path = resolve('.data/batch-checks', `${tool}.zip`);
    await writeFile(path, Buffer.from(await zipped.arrayBuffer()));
    const manifest = JSON.parse(
      await runProcess(pythonBinary, [
        '-c',
        'import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(z.namelist()))',
        path,
      ]),
    );
    assert.equal(manifest.length, names.length - 1);
    assert.equal(new Set(manifest).size, manifest.length);
    const failed = batch.jobs.find((j) => j.state === 'failed')!;
    await a.call(`jobs/${failed.id}/retry`, {});
    // Cleanup may already have removed the expired archive tombstone. Both deny access.
    const expired = await fetch(`${origin}/api/archives/${archiveId}`, {
      headers: { Cookie: a.cookie },
    });
    assert([404, 410].includes(expired.status));
    await waitBatch(id);
    console.log(
      `PASS ${tool}: real upload, partial failure, metadata/download, ZIP, duplicate names, ownership, idempotency, archive invalidation`,
    );
  }
  // A whole batch can be cancelled before it starts, then retried atomically.
  const cancelledIds = [await a.upload('audio.wav'), await a.upload('audio.mp3')];
  const { id: cancelId } = await a.call('batches', {
    tool: 'audio-compressor',
    assetIds: cancelledIds,
    requestId: crypto.randomUUID(),
    options: { preset: 'strong' },
  });
  ids.push(cancelId);
  await a.call(`batches/${cancelId}/cancel`, {});
  let cancelled = await waitBatch(cancelId);
  assert(cancelled.jobs.every((j) => j.state === 'cancelled'));
  await a.call(`batches/${cancelId}/retry`, {});
  cancelled = await waitBatch(cancelId);
  assert(cancelled.jobs.every((j) => j.state === 'completed' && j.attempt === 2));
  console.log('PASS batch cancel and retry');
  const batch = await waitBatch(ids[0]);
  const job = batch.jobs.find((j) => j.state === 'completed')!;
  const [stored] = await db().select().from(jobs).where(eq(jobs.id, job.id));
  await db()
    .update(jobs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(jobs.id, job.id));
  await a.call(`jobs/${job.id}/download`, undefined, 'GET', 410);
  await eventually(() => missing(stored.outputKey!));
  console.log('PASS expiry rejects access and removes output');
} finally {
  for (const id of ids) await a.call(`batches/${id}`, undefined, 'DELETE').catch(() => {});
  await sqlClient().end();
}
console.log('Batch integration checks passed');
