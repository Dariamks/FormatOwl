// Stop the ordinary worker first. Recognition responses here are fixtures, never real API calls.
// FFmpeg, storage, persistence, exports, cancellation and recovery run without mocks.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  jobInputs,
  transcripts,
  transcriptionChunks,
  transcriptExports,
  outbox,
} from '@filemorph/core/schema';
import { uploadFromFile, deleteObject, deletePrefix } from '@filemorph/core/storage';
import { MediaError, runProcess } from '@filemorph/core/media';
import { changeJob } from '@filemorph/core/jobs';
import {
  patchTranscript,
  readTranscript,
  createTranscriptExport,
  transcriptDownload,
  changeTranscriptExport,
} from '@filemorph/core/transcripts';
import { processTranscription, type SpeechProvider } from '../apps/worker/src/transcription';
import { processTranscriptExport } from '../apps/worker/src/transcript-export';
const root = resolve('.data/transcription-checks');
await mkdir(root, { recursive: true });
const controllers = new Set<AbortController>(),
  activeTemp = new Set<string>();
const run = (id: string, attempt: number, provider: SpeechProvider) =>
  processTranscription(id, attempt, controllers, activeTemp, root, provider);
if (process.argv[2] === '--child') {
  process.env.TRANSCRIPTION_PROVIDER = process.argv[4] === 'durable' ? 'dashscope' : 'openai';
  process.env.TRANSCRIPTION_MODEL =
    process.argv[4] === 'durable' ? 'fun-asr' : 'gpt-4o-transcribe-diarize';
  await run(process.argv[3], 1, async (_file, _language, _signal, context) => {
    if (process.argv[4] === 'durable')
      await context!.submitted('fixture-cloud-task', 'fixture-submit-request');
    process.stdout.write('REQUEST_IN_FLIGHT\n');
    return new Promise(() => {});
  });
  await sqlClient().end();
  process.exit(0);
}
// Permit only the server retry guard; every run below injects its fixture provider.
process.env.TRANSCRIPTION_PROVIDER = 'openai';
process.env.TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';
process.env.OPENAI_API_KEY = 'fixture-provider-only-no-network';
process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
const owner = `anon:${randomUUID()}`,
  seeded: { id: string; assetId: string; key: string }[] = [];
let child: ChildProcess | undefined;
const report: string[] = [];
function pass(message: string) {
  report.push(message);
  console.log('PASS', message);
}
async function job(id: string) {
  return (await db().select().from(jobs).where(eq(jobs.id, id)))[0];
}
async function chunks(id: string) {
  return db()
    .select()
    .from(transcriptionChunks)
    .where(eq(transcriptionChunks.jobId, id))
    .orderBy(transcriptionChunks.index);
}
async function seed(file: string) {
  const id = randomUUID(),
    assetId = randomUUID(),
    key = `inputs/${assetId}/source`;
  seeded.push({ id, assetId, key });
  await uploadFromFile(key, file);
  const expiresAt = new Date(Date.now() + 3600000);
  await db().transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId,
      owner,
      key,
      name: basename(file),
      size: (await stat(file)).size,
      mime: 'audio/mpeg',
      state: 'ready',
      expiresAt,
    });
    await tx.insert(jobs).values({
      id,
      owner,
      requestId: randomUUID(),
      assetId,
      sourceIds: [assetId],
      tool: 'transcription',
      options: { language: 'auto', streamIndex: 0 },
      state: 'queued',
      expiresAt,
    });
    await tx.insert(jobInputs).values({ jobId: id, assetId });
  });
  return id;
}
async function retry(id: string) {
  await changeJob(id, owner, 'retry');
  await db().delete(outbox).where(eq(outbox.jobId, id));
}
const fixture: SpeechProvider = async (file) => ({
  body: {
    segments: [{ start: 1, end: 2, text: `你好 Hello ${basename(file)}`, speaker: 'A' }],
    usage: { type: 'duration', seconds: 2 },
  },
  requestId: 'fixture-' + basename(file),
});
try {
  const short = resolve('.data/conversion-checks/fixtures/audio.mp3');
  const long = resolve(root, 'two-hours.flac');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-t',
    '7200',
    '-ac',
    '1',
    '-c:a',
    'flac',
    long,
  ]);
  const longId = await seed(long);
  const firstCalls: string[] = [];
  await run(longId, 1, async (file, language, signal) => {
    firstCalls.push(basename(file));
    if (firstCalls.length === 2)
      throw new MediaError('AI_RESULT_UNKNOWN', 'Simulated uncertain response');
    return fixture(file, language, signal);
  });
  assert.equal((await job(longId)).error, 'AI_RESULT_UNKNOWN');
  const partial = await chunks(longId);
  assert.equal(partial.filter((c) => c.state === 'completed').length, 1);
  assert.equal((await readTranscript(longId, owner)).segments.length, 1);
  assert.ok(partial.length >= 12);
  assert.ok(partial.every((c) => c.range.endMs - c.range.startMs <= 600000));
  pass('Two-hour source: real extraction/chunking, partial text retained after uncertain request');
  await retry(longId);
  const retryCalls: string[] = [];
  await run(longId, 2, async (file, language, signal) => {
    retryCalls.push(basename(file));
    assert.ok((await stat(file)).size < 24_000_000);
    return fixture(file, language, signal);
  });
  assert.equal((await job(longId)).state, 'completed', (await job(longId)).error || '');
  assert.equal(retryCalls.length, partial.length - 1);
  assert.ok(!retryCalls.includes('chunk-0.mp3'));
  const complete = await readTranscript(longId, owner);
  assert.equal(complete.totalChunks, complete.completedChunks);
  assert.equal(new Set(complete.speakers.map((s) => s.id)).size, partial.length);
  assert.ok(complete.segments.at(-1)!.startMs > 7100000);
  pass(
    'Explicit retry sends only unfinished chunks; original timeline and independent speaker IDs survive',
  );
  await assert.rejects(
    readTranscript(longId, 'anon:someone-else'),
    (e: any) => e.code === 'JOB_NOT_FOUND',
  );
  const edited = { ...complete.segments[0], text: '已保存的中文。Saved English.' };
  const saved = await patchTranscript(longId, owner, {
    revision: complete.revision,
    upsert: [edited],
  });
  await assert.rejects(
    patchTranscript(longId, owner, { revision: complete.revision, upsert: [edited] }),
    (e: any) => e.code === 'TRANSCRIPT_CONFLICT',
  );
  const options = {
    revision: saved.revision,
    format: 'txt',
    includeSpeakers: true,
    includeTimestamps: true,
  };
  const export1 = await createTranscriptExport(longId, owner, options);
  assert.equal((await createTranscriptExport(longId, owner, options)).id, export1.id);
  await patchTranscript(longId, owner, {
    revision: saved.revision,
    upsert: [{ ...edited, text: 'Newer edit' }],
  });
  await Promise.all([
    processTranscriptExport(export1.id, 1, controllers, activeTemp, root),
    processTranscriptExport(export1.id, 1, controllers, activeTemp, root),
  ]);
  const { url } = await transcriptDownload(export1.id, owner);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes(edited.text));
  assert.ok(!text.includes('Newer edit'));
  await assert.rejects(transcriptDownload(export1.id, 'anon:someone-else'));
  pass(
    'Ownership, revision conflict, export deduplication, duplicate delivery and immutable saved-version snapshots',
  );
  const current = await readTranscript(longId, owner);
  const cancelledExport = await createTranscriptExport(longId, owner, {
    ...options,
    revision: current.revision,
    format: 'pdf',
  });
  await changeTranscriptExport(cancelledExport.id, owner, 'cancel');
  await processTranscriptExport(cancelledExport.id, 1, controllers, activeTemp, root);
  assert.equal(
    (
      await db()
        .select()
        .from(transcriptExports)
        .where(eq(transcriptExports.id, cancelledExport.id))
    )[0].state,
    'cancelled',
  );
  await changeTranscriptExport(cancelledExport.id, owner, 'retry');
  await processTranscriptExport(cancelledExport.id, 2, controllers, activeTemp, root);
  assert.ok((await transcriptDownload(cancelledExport.id, owner)).url);
  await db()
    .update(jobs)
    .set({ expiresAt: new Date(0) })
    .where(eq(jobs.id, longId));
  await assert.rejects(readTranscript(longId, owner));
  await assert.rejects(
    patchTranscript(longId, owner, { revision: current.revision, upsert: [edited] }),
  );
  await assert.rejects(transcriptDownload(export1.id, owner));
  pass('Export cancel/retry and expired read/save/download rejection');
  const cancelId = await seed(short);
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let calls = 0;
  const pending = run(cancelId, 1, async (_file, _language, signal) => {
    calls++;
    announce();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new MediaError('AI_RESULT_UNKNOWN', 'Interrupted request')),
        { once: true },
      ),
    );
    return { body: {}, requestId: null };
  });
  await started;
  await run(cancelId, 1, async () => {
    calls++;
    throw new Error('Duplicate provider call');
  });
  assert.equal(calls, 1);
  assert.equal((await job(cancelId)).state, 'processing');
  await changeJob(cancelId, owner, 'cancel');
  await pending;
  assert.equal((await job(cancelId)).state, 'cancelled');
  assert.equal((await chunks(cancelId))[0].state, 'uncertain');
  pass(
    'Duplicate deliveries cannot disturb an in-flight request; cancellation retains uncertainty',
  );
  const crashId = await seed(short);
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--env-file=.env', 'scripts/check-transcription.ts', '--child', crashId],
    { cwd: resolve('.'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child request timeout')), 30000);
    child!.stdout!.on('data', (data) => {
      if (String(data).includes('REQUEST_IN_FLIGHT')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child!.once('error', reject);
    child!.once('exit', (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error('Child exited before request'));
    });
  });
  const exit = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGKILL');
  await exit;
  child = undefined;
  let recoveredCalls = 0;
  await run(crashId, 1, async () => {
    recoveredCalls++;
    throw new Error('Unsafe automatic replay');
  });
  assert.equal(recoveredCalls, 0);
  assert.equal((await job(crashId)).error, 'AI_RESULT_UNKNOWN');
  await retry(crashId);
  await run(crashId, 2, async () => ({ body: { segments: [] }, requestId: 'silence' }));
  assert.equal((await job(crashId)).state, 'completed');
  assert.equal((await readTranscript(crashId, owner)).total, 0);
  pass(
    'SIGKILL of test-owned process: no automatic replay; explicit retry and empty-speech result',
  );
  const durableId = await seed(short);
  child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--env-file=.env',
      'scripts/check-transcription.ts',
      '--child',
      durableId,
      'durable',
    ],
    { cwd: resolve('.'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Durable child request timeout')), 30000);
    child!.stdout!.on('data', (data) => {
      if (String(data).includes('REQUEST_IN_FLIGHT')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child!.once('error', reject);
    child!.once('exit', (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error('Child exited before durable request'));
    });
  });
  const durableExit = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGKILL');
  await durableExit;
  child = undefined;
  assert.equal((await chunks(durableId))[0].providerTaskId, 'fixture-cloud-task');
  let resumed = 0;
  await run(durableId, 1, async (file, language, signal, context) => {
    assert.equal(context!.taskId, 'fixture-cloud-task');
    // A recovered run must use the original routing snapshot even after local configuration changes.
    assert.equal(context!.config.kind, 'dashscope');
    resumed++;
    return fixture(file, language, signal);
  });
  assert.equal(resumed, 1);
  assert.equal((await job(durableId)).state, 'completed');
  pass(
    'SIGKILL after cloud task persistence resumes the existing task with its original provider configuration',
  );
  assert.equal(activeTemp.size, 0);
  assert.equal(controllers.size, 0);
  await writeFile(
    resolve(root, 'report.json'),
    JSON.stringify(
      { provider: 'injected fixtures; no recognition quality claim', checks: report },
      null,
      2,
    ),
  );
} finally {
  if (child?.pid && child.exitCode === null && !child.signalCode)
    process.kill(-child.pid, 'SIGKILL');
  for (const entry of seeded) {
    await db().delete(jobs).where(eq(jobs.id, entry.id));
    await db().delete(assets).where(eq(assets.id, entry.assetId));
    await deleteObject(entry.key);
    await deletePrefix(`outputs/${entry.id}/`);
  }
  await sqlClient().end();
}
