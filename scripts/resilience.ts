// Run with the normal worker stopped. This test owns and terminates only its own child workers.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { outbox, preparations, assets } from '@filemorph/core/schema';
import { runProcess } from '@filemorph/core/media';
import type { PreparationView } from '@filemorph/core/editing';
import { compressionSchema, type JobView } from '@filemorph/core/domain';
const origin = 'http://127.0.0.1:3000';
let cookie = '';
let child: ChildProcess | undefined;
const ids: string[] = [];
async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith('fm-session=')) cookie = value.split(';')[0];
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function until(id: string, predicate: (job: JobView) => boolean, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { job } = await api<{ job: JobView }>(`jobs/${id}`);
    if (predicate(job)) return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for task ${id}`);
}
async function startWorker() {
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--env-file=.env', 'apps/worker/src/index.ts'],
    { cwd: resolve('.'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const running = child;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker startup timeout')), 15000);
    running.stdout?.on('data', (data) => {
      if (String(data).includes('media worker ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    running.stderr?.on('data', () => {});
    running.once('error', reject);
    running.once('exit', (code) => {
      if (code) reject(new Error(`Worker exited ${code}`));
    });
  });
}
async function stopWorker(signal: 'SIGKILL' | 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const running = child;
  const done = new Promise<void>((resolve) => running.once('exit', () => resolve()));
  if (signal === 'SIGKILL') process.kill(-running.pid!, signal);
  else running.kill(signal);
  await done;
  child = undefined;
}
try {
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-stream_loop',
    '11',
    '-i',
    resolve('.data/fixtures/sample.mp4'),
    '-c',
    'copy',
    resolve('.data/fixtures/long.mp4'),
  ]);
  const data = await readFile('.data/fixtures/long.mp4');
  await api('session');
  const upload = await api<{ id: string; partSize: number }>('uploads', {
    name: 'long.mp4',
    size: data.length,
  });
  for (let start = 0, n = 1; start < data.length; start += upload.partSize, n++) {
    const { url } = await api<{ url: string }>(`uploads/${upload.id}/parts`, { partNumber: n });
    assert.equal(
      (await fetch(url, { method: 'PUT', body: data.subarray(start, start + upload.partSize) }))
        .status,
      200,
    );
  }
  await api(`uploads/${upload.id}/complete`, {});
  async function create() {
    const { id } = await api<{ id: string }>('jobs', {
      assetId: upload.id,
      requestId: crypto.randomUUID(),
      options: compressionSchema.parse({ speed: 'slow' }),
    });
    ids.push(id);
    return id;
  }
  const cancelId = await create();
  const [event] = await db().select().from(outbox).where(eq(outbox.jobId, cancelId));
  assert.equal(event.dispatchedAt, null);
  assert.equal((await api<{ job: JobView }>(`jobs/${cancelId}`)).job.state, 'queued');
  console.log('PASS Task remains durable while no dispatcher is running');
  await startWorker();
  await until(cancelId, (j) => j.state === 'processing' && j.progress >= 8);
  await api(`jobs/${cancelId}/cancel`, {});
  await until(cancelId, (j) => j.state === 'cancelled', 15000);
  console.log('PASS Cancelling an active encode terminates processing without publishing a result');
  const recoverId = await create();
  await until(recoverId, (j) => j.state === 'processing' && j.progress >= 8);
  await stopWorker('SIGKILL');
  console.log('Killed the test-owned worker process group during native encoding.');
  await startWorker();
  const recovered = await until(recoverId, (j) => j.state === 'completed' || j.state === 'failed');
  assert.equal(recovered.state, 'completed', recovered.error || '');
  assert.equal(recovered.attempt, 1);
  assert.ok(recovered.outputSize! > 0);
  console.log('PASS BullMQ recovered the interrupted job after the worker restarted');
  // The 50 MiB fixture exercises the new PDF dispatch and multipart upload path.
  const pdfData = await readFile('.data/fixtures/large.pdf');
  const pdfUpload = await api<{ id: string; partSize: number }>('uploads', {
    name: 'large.pdf',
    size: pdfData.length,
  });
  for (let start = 0, n = 1; start < pdfData.length; start += pdfUpload.partSize, n++) {
    const { url } = await api<{ url: string }>(`uploads/${pdfUpload.id}/parts`, { partNumber: n });
    assert.equal(
      (
        await fetch(url, {
          method: 'PUT',
          body: pdfData.subarray(start, start + pdfUpload.partSize),
        })
      ).status,
      200,
    );
  }
  await api(`uploads/${pdfUpload.id}/complete`, {});
  const { id: pdfId } = await api<{ id: string }>('jobs', {
    tool: 'pdf-compressor',
    assetId: pdfUpload.id,
    requestId: crypto.randomUUID(),
    options: { preset: 'strong' },
  });
  ids.push(pdfId);
  await until(pdfId, (j) => j.state === 'processing');
  await api(`jobs/${pdfId}/cancel`, {});
  await until(pdfId, (j) => j.state === 'cancelled');
  console.log('PASS A 50 MiB PDF task cancels without publishing a result');
  await api(`jobs/${pdfId}/retry`, {});
  await until(pdfId, (j) => j.state === 'processing');
  await stopWorker('SIGKILL');
  await startWorker();
  const pdfRecovered = await until(pdfId, (j) => j.state === 'completed' || j.state === 'failed');
  assert.equal(pdfRecovered.state, 'completed', pdfRecovered.error || '');
  assert.equal(pdfRecovered.outputMime, 'application/pdf');
  assert.equal(pdfRecovered.attempt, 2);
  assert.ok(pdfRecovered.outputSize! < pdfData.length);
  console.log(
    'PASS PDF retry survives a hard worker exit and completes with a smaller valid result',
  );
  // Editors use their own durable preparation records and multi-source task inputs.
  await stopWorker('SIGTERM');
  await api(`assets/${upload.id}/prepare`, { profile: 'video' });
  const [pending] = await db()
    .select()
    .from(preparations)
    .where(eq(preparations.assetId, upload.id));
  assert.equal(pending.dispatchedAt, null);
  async function waitPreparation(
    assetId: string,
    profile: 'video' | 'audio',
    predicate: (p: PreparationView) => boolean,
  ) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const p = await api<PreparationView>(`assets/${assetId}/prepare?profile=${profile}`);
      if (predicate(p)) return p;
      if (p.state === 'failed') throw new Error(p.error || 'Preparation failed');
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Preparation recovery timeout');
  }
  await startWorker();
  await waitPreparation(upload.id, 'video', (p) => p.state === 'processing' && p.progress >= 8);
  await stopWorker('SIGKILL');
  await startWorker();
  const prepared = await waitPreparation(upload.id, 'video', (p) => p.state === 'completed');
  assert.ok(prepared.previewUrl);
  assert.ok(prepared.thumbnailsUrl);
  console.log('PASS Editor preparation survives dispatcher absence and a hard worker exit');
  const low = await readFile('.data/fixtures/editor-low.wav');
  const lowUpload = await api<{ id: string }>('uploads', {
    name: 'editor-low.wav',
    size: low.length,
  });
  const lowPart = await api<{ url: string }>(`uploads/${lowUpload.id}/parts`, { partNumber: 1 });
  assert.equal((await fetch(lowPart.url, { method: 'PUT', body: low })).status, 200);
  await api(`uploads/${lowUpload.id}/complete`, {});
  await api(`assets/${lowUpload.id}/prepare`, { profile: 'audio' });
  await waitPreparation(lowUpload.id, 'audio', (p) => p.state === 'completed');
  const { id: editorId } = await api<{ id: string }>('jobs', {
    tool: 'audio-cutter',
    purpose: 'preview',
    assetIds: [upload.id, lowUpload.id],
    requestId: crypto.randomUUID(),
    options: {
      format: 'mp3',
      bitrate: 192,
      clips: [
        ...Array.from({ length: 12 }, () => ({
          assetId: upload.id,
          streamIndex: prepared.media!.defaultAudioIndex!,
          startMs: 0,
          endMs: 60000,
          fadeInMs: 100,
          fadeOutMs: 100,
        })),
        {
          assetId: lowUpload.id,
          streamIndex: 0,
          startMs: 0,
          endMs: 3000,
          fadeInMs: 100,
          fadeOutMs: 100,
        },
      ],
    },
  });
  ids.push(editorId);
  await until(editorId, (j) => j.state === 'processing');
  await api(`jobs/${editorId}/cancel`, {});
  const cancelled = await until(editorId, (j) => j.state === 'cancelled');
  assert.equal(cancelled.outputSize, null);
  console.log('PASS Multi-source composition cancellation publishes no result');
  await api(`jobs/${editorId}/retry`, {});
  await until(editorId, (j) => j.state === 'processing');
  await stopWorker('SIGKILL');
  await startWorker();
  const edited = await until(editorId, (j) => ['completed', 'failed'].includes(j.state));
  assert.equal(edited.state, 'completed', edited.error || '');
  assert.equal(edited.attempt, 2);
  assert.equal(edited.sourceIds.length, 2);
  assert.equal(edited.outputMime, 'audio/mp4');
  assert.ok(Math.abs(edited.outputMedia!.duration - 723) < 0.2);
  console.log(
    'PASS Retried multi-source composition recovers with its sources, order and preview format',
  );
  for (const sourceId of [upload.id, lowUpload.id]) {
    await db()
      .update(preparations)
      .set({ expiresAt: new Date(0) })
      .where(eq(preparations.assetId, sourceId));
    await db()
      .update(assets)
      .set({ expiresAt: new Date(0) })
      .where(eq(assets.id, sourceId));
  }
  await writeFile(
    '.data/test-outputs/resilience-report.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: 8,
        checks: [
          'Outbox after dispatcher absence',
          'Cancel active FFmpeg',
          'Hard worker exit and automatic recovery',
          'Cancel a 50 MiB PDF task',
          'PDF retry and hard exit recovery',
          'Editor preparation dispatcher absence and hard exit recovery',
          'Multi-source composition cancellation',
          'Multi-source composition retry and hard exit recovery',
        ],
      },
      null,
      2,
    ),
  );
  for (const id of ids) await api(`jobs/${id}`, undefined, 'DELETE');
} finally {
  await stopWorker('SIGTERM');
  await sqlClient().end();
}
