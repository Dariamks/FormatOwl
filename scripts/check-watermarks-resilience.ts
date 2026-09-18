// Stop the ordinary worker before running. Signals target only process groups spawned here.
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from './check-watermarks';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { jobs, watermarkRuns, watermarkSteps } from '@filemorph/core/schema';
const root = resolve('.data/watermark-test'),
  log = resolve(root, 'recovery-calls.txt');
const processes = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
if (processes.split('\n').some((s) => s.includes('tsx') && s.trim().endsWith('src/index.ts')))
  throw new Error('Stop the ordinary worker before running resilience checks.');
const children = new Set<ChildProcess>();
function start(id: string, attempt: number, kind = 'run', mode = 'normal') {
  const child = spawn(
    resolve('node_modules/.bin/tsx'),
    ['--env-file=.env', 'scripts/watermark-test-child.ts', id, String(attempt), kind, mode],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(child);
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (data) => void appendFile(resolve(root, 'recovery-log.txt'), data));
  child.on('exit', () => children.delete(child));
  return child;
}
async function wait(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((res, rej) => {
    child.once('exit', (code) => (code === 0 ? res() : rej(new Error('Child exit ' + code))));
    child.once('error', rej);
  });
}
async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for own test process');
}
async function count() {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).length;
}
const a = new Client();
await writeFile(log, '');
const created: string[] = [];
try {
  await a.call('session');
  const assetId = await a.upload('gradient.png');
  const { id } = await a.call('jobs', {
    assetId,
    requestId: crypto.randomUUID(),
    tool: 'image-watermark-remover',
    options: {},
  });
  created.push(id);
  await wait(start(id, 1, 'analyze'));
  let v = await a.call('jobs/' + id + '/watermark');
  const selection = {
    candidates: [],
    regions: [
      {
        id: crypto.randomUUID(),
        targetId: 'image',
        kind: 'rect',
        x: 0.32,
        y: 0.39,
        width: 0.34,
        height: 0.21,
        strokes: [],
      },
    ],
  };
  let saved = await a.call(
    'jobs/' + id + '/watermark',
    { revision: v.revision, ...selection },
    'PATCH',
  );
  const options = {
    requestId: crypto.randomUUID(),
    revision: saved.revision,
    kind: 'export',
    format: 'png',
  };
  const { id: runId } = await a.call('jobs/' + id + '/watermark/runs', options);
  const child = start(runId, 1, 'run', 'slow');
  await until(async () => (await count()) === 1);
  assert.ok(child.pid);
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise<void>((res) => child.once('exit', () => res()));
  await wait(start(runId, 1));
  let [run] = await db().select().from(watermarkRuns).where(eq(watermarkRuns.id, runId));
  assert.equal(run.state, 'failed');
  assert.equal(run.error, 'AI_RESULT_UNKNOWN');
  assert.equal(await count(), 1);
  await a.call('watermark-runs/' + runId + '/retry', {});
  await wait(start(runId, 2));
  [run] = await db().select().from(watermarkRuns).where(eq(watermarkRuns.id, runId));
  assert.equal(run.state, 'completed');
  assert.equal(await count(), 2);
  const again = await a.call('jobs/' + id + '/watermark/runs', {
    ...options,
    requestId: crypto.randomUUID(),
  });
  await wait(start(again.id, 1));
  assert.equal(await count(), 2);
  console.log(
    'PASS SIGKILL: uncertain requests require explicit retry; completed repair is reused by later exports',
  );
  selection.regions[0].width = 0.36;
  saved = await a.call(
    'jobs/' + id + '/watermark',
    { revision: saved.revision, ...selection },
    'PATCH',
  );
  const cancelled = await a.call('jobs/' + id + '/watermark/runs', {
    ...options,
    revision: saved.revision,
    requestId: crypto.randomUUID(),
  });
  const pending = start(cancelled.id, 1, 'run', 'slow');
  await until(async () => (await count()) === 3);
  await a.call('watermark-runs/' + cancelled.id + '/cancel', {});
  await wait(pending);
  [run] = await db().select().from(watermarkRuns).where(eq(watermarkRuns.id, cancelled.id));
  assert.equal(run.state, 'cancelled');
  const queued = await a.call('jobs/' + id + '/watermark/runs', {
    ...options,
    revision: saved.revision,
    requestId: crypto.randomUUID(),
  });
  await a.call('watermark-runs/' + queued.id + '/cancel', {});
  await wait(start(queued.id, 1));
  assert.equal(await count(), 3);
  console.log('PASS processing and queued cancellation without extra provider requests');
  await db()
    .update(jobs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(jobs.id, id));
  await a.call('jobs/' + id + '/watermark', undefined, 'GET', 410);
  await a.call('watermark-runs/' + again.id + '/download', undefined, 'GET', 410);
  await writeFile(
    resolve(root, 'recovery-report.json'),
    JSON.stringify({
      id,
      runs: [runId, again.id, cancelled.id, queued.id],
      providerCalls: await count(),
    }),
  );
  console.log(
    'PASS expiry blocks reads and downloads; ordinary worker can now clean the expired synthetic task',
  );
} finally {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
  await sqlClient().end();
}
