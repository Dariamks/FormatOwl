import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { assets, jobs, billingOperations } from '@filemorph/core/schema';
import { listJobs } from '@filemorph/core/jobs';
import { billingOverview } from '@filemorph/core/billing';
import { initialPriceBook } from '@filemorph/core/billing-model';

const original = process.env.DATABASE_URL!;
const url = new URL(original);
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
const admin = sqlClient();
const name = `filemorph_pagination_test_${randomUUID().replaceAll('-', '')}`;
await admin.unsafe(`CREATE DATABASE "${name}"`);
url.pathname = '/' + name;
process.env.DATABASE_URL = url.href;
(globalThis as any).filemorphSql = undefined;
try {
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await sqlClient().unsafe(
      await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'),
    );
  const owner = 'anon:pagination-test';
  const assetId = randomUUID();
  const createdAt = new Date();
  await db()
    .insert(assets)
    .values({
      id: assetId,
      owner,
      key: `test/${assetId}`,
      name: 'test.pdf',
      mime: 'application/pdf',
      size: 100,
      expiresAt: new Date(Date.now() + 86400000),
    });
  const ids = Array.from({ length: 101 }, () => randomUUID())
    .sort()
    .reverse();
  await db()
    .insert(jobs)
    .values(
      ids.map((id) => ({
        id,
        owner,
        assetId,
        requestId: randomUUID(),
        state: 'completed' as const,
        options: { preset: 'balanced' as const },
        createdAt,
        expiresAt: new Date(Date.now() + 86400000),
      })),
    );
  await db()
    .insert(jobs)
    .values([
      {
        id: randomUUID(),
        owner: 'anon:other',
        assetId,
        requestId: randomUUID(),
        options: { preset: 'balanced' },
        expiresAt: createdAt,
      },
      {
        id: randomUUID(),
        owner,
        assetId,
        requestId: randomUUID(),
        purpose: 'preview',
        options: { preset: 'balanced' },
        expiresAt: createdAt,
      },
      {
        id: randomUUID(),
        owner,
        assetId,
        requestId: randomUUID(),
        deleting: true,
        options: { preset: 'balanced' },
        expiresAt: createdAt,
      },
    ]);
  await db()
    .insert(billingOperations)
    .values([
      ...ids.map((id) => ({
        id,
        owner,
        mode: 'shadow' as const,
        state: 'settled',
        priceBook: initialPriceBook,
        createdAt,
      })),
      {
        id: randomUUID(),
        owner: 'anon:other',
        mode: 'shadow',
        priceBook: initialPriceBook,
        createdAt,
      },
    ]);
  const jobIds: string[] = [],
    operationIds: string[] = [];
  for (let page = 1; page <= 11; page++) {
    const tasks = await listJobs(owner, page);
    const billing = await billingOverview(owner, page);
    assert.equal(tasks.pagination.total, 101);
    assert.equal(billing.pagination.total, 101);
    assert.equal(tasks.jobs.length, page === 11 ? 1 : 10);
    assert.equal(billing.operations.length, page === 11 ? 1 : 10);
    jobIds.push(...tasks.jobs.map((job) => job.id));
    operationIds.push(...billing.operations.map((operation) => operation.id));
  }
  assert.deepEqual(jobIds, ids);
  assert.deepEqual(operationIds, ids);
  assert.equal((await listJobs(owner, 999)).pagination.page, 11);
  assert.equal((await billingOverview(owner, 999)).pagination.page, 11);
  await db()
    .update(jobs)
    .set({ deleting: true })
    .where(eq(jobs.id, ids.at(-1)!));
  assert.equal((await listJobs(owner, 11)).pagination.page, 10);
  assert.equal((await listJobs('anon:empty', 9)).pagination.page, 1);
  assert.equal((await billingOverview('anon:empty', 9)).pagination.total, 0);
  console.log(
    'PASS pagination: all 101 records reachable, stable tie ordering, owner scope, hidden tasks, empty lists and last-page deletion.',
  );
} finally {
  await sqlClient().end();
  (globalThis as any).filemorphSql = undefined;
  await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  process.env.DATABASE_URL = original;
}
