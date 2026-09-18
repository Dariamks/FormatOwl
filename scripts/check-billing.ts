import { recordPlatformUsage } from '@filemorph/core/billing-usage';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  billingProbes,
  billingSettings,
  billingPriceBooks,
  billingOperations,
  billingTargets,
  billingQuotes,
  costUsage,
  creditLedger,
  outbox,
} from '@filemorph/core/schema';
import { initialPriceBook, type PriceBook } from '@filemorph/core/billing-model';
import {
  account,
  grantCredits,
  billingRequest,
  billingConfig,
  finishBillingTarget,
  billingTargetKey,
  billingReceipt,
} from '@filemorph/core/billing';
import { createQuote, operationFingerprint, readQuote } from '@filemorph/core/billing-quotes';
import { startUsage, completeUsage, unknownUsage, withUsage } from '@filemorph/core/billing-usage';
import { createJob, createBatch, changeJob } from '@filemorph/core/jobs';
import { saveDailyBillingReport } from '@filemorph/core/billing-report';
import { prepareAsset } from '@filemorph/core/preparations';
import { preparations } from '@filemorph/core/schema';
import { MediaError, runProcess } from '@filemorph/core/media';
const original = process.env.DATABASE_URL!,
  url = new URL(original);
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname),
  'Only an isolated local database may be used',
);
const admin = sqlClient(),
  name = `filemorph_billing_test_${randomUUID().replaceAll('-', '')}`;
await admin.unsafe(`CREATE DATABASE "${name}"`);
url.pathname = '/' + name;
process.env.DATABASE_URL = url.href;
(globalThis as any).filemorphSql = undefined;
let checked = 0;
function ok(message: string) {
  checked++;
  console.log(`PASS ${message}`);
}
try {
  const client = sqlClient();
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await client.unsafe(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const book: PriceBook = {
    ...initialPriceBook,
    version: 'test-only',
    rates: initialPriceBook.rates.map((r) => ({
      ...r,
      verified: true,
      cnyPerUnit: r.cnyPerUnit ?? (r.meter === 'runtime_ms' ? 0.000001 : 0),
    })),
  };
  await billingConfig();
  await db().insert(billingPriceBooks).values({ version: book.version, data: book });
  await db()
    .update(billingSettings)
    .set({
      mode: 'enforced',
      priceVersion: book.version,
      productionVerified: true,
      paymentVerified: true,
      paymentFeeRate: '0.01',
      paymentFixedCny: '0',
    })
    .where(eq(billingSettings.id, 'default'));
  const owner = 'user:billing-test',
    other = 'user:billing-other',
    asset = randomUUID();
  await db()
    .insert(assets)
    .values({
      id: asset,
      owner,
      key: `test/${asset}`,
      name: 'sample.mp4',
      mime: 'video/mp4',
      size: 1000000,
      state: 'ready',
      expiresAt: new Date(Date.now() + 86400000),
    });
  await db()
    .insert(billingProbes)
    .values({
      assetId: asset,
      owner,
      state: 'completed',
      facts: {
        bytes: 1000000,
        duration: 600,
        width: 1920,
        height: 1080,
        fps: 30,
        source: 'synthetic-test',
      },
    });
  async function newQuote(requestId = randomUUID(), mode = 'jobs') {
    const body =
      mode === 'batches'
        ? { requestId, assetIds: [asset], tool: 'video-converter', options: { format: 'mp4' } }
        : {
            requestId,
            assetId: asset,
            tool: 'video-compressor',
            options: {
              preset: 'balanced',
              crf: 28,
              codec: 'h264',
              resolution: 'original',
              speed: 'medium',
            },
          };
    return createQuote(owner, { path: mode, body });
  }
  async function submit(q: Awaited<ReturnType<typeof newQuote>>) {
    const b = q.operation.body;
    return billingRequest.run(
      { owner, quoteId: q.id, fingerprint: await operationFingerprint(owner, q.operation) },
      () => createJob(owner, asset, b.requestId as string, b.options as any, 'video-compressor'),
    );
  }
  const q = await newQuote();
  assert.equal(q.state, 'ready');
  assert(q.maximumCredits! > q.estimatedCredits!);
  ok('server metadata creates a bounded, versioned quote');
  await assert.rejects(() => readQuote(other, q.id));
  ok('quote ownership is enforced');
  await assert.rejects(
    () => submit(q),
    (e: any) => e.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal((await db().select().from(jobs)).length, 0);
  assert.equal((await db().select().from(outbox)).length, 0);
  ok('insufficient balance rolls back jobs and outbox');
  await grantCredits(owner, q.maximumCredits!, 'receipt-one', 'isolated test');
  await grantCredits(owner, q.maximumCredits!, 'receipt-one', 'isolated test');
  assert.equal((await account(owner)).available, q.maximumCredits);
  ok('receipt grants are idempotent');
  const q2 = await newQuote();
  const attempts = await Promise.allSettled([submit(q), submit(q2)]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  ok('concurrent submissions cannot overspend');
  const result = attempts.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>,
    job = result.value;
  const usedQuote = job.requestId === q.operation.body.requestId ? q : q2;
  const again = await submit(usedQuote);
  assert.equal(again.id, job.id);
  assert.equal(
    (await db().select().from(creditLedger)).filter((x) => x.kind === 'reserve').length,
    1,
  );
  ok('duplicate submission never reserves twice');
  await withUsage('job', job.id, 1, async () => {
    const u = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 1000 });
    await completeUsage(u, 500);
    await completeUsage(u, 500);
  });
  await finishBillingTarget(billingTargetKey('job', job.id), 'completed');
  await finishBillingTarget(billingTargetKey('job', job.id), 'completed');
  let a = await account(owner);
  assert.equal(a.reserved, 0);
  assert.equal(a.available, q.maximumCredits! - 1);
  ok('settlement rounds once, returns unused credits, and is idempotent');
  const next = await newQuote();
  await grantCredits(owner, next.maximumCredits!, 'receipt-two', 'isolated test');
  const j2 = await submit(next);
  await withUsage('job', j2.id, 1, async () => {
    await assert.rejects(
      () =>
        startUsage({
          meter: 'repair_images',
          stage: 'repair',
          maximum: 1,
          route: 'https://pdhlzy.art/v1',
          model: 'gpt-image-2',
        }),
      (e: any) => e.code === 'BILLING_STAGE_REQUIRED',
    );
    await assert.rejects(
      () => startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 1e12 }),
      (e: any) => e.code === 'BILLING_BUDGET_EXCEEDED',
    );
  });
  ok('stage and maximum budget gates run before provider work');
  await finishBillingTarget(billingTargetKey('job', j2.id), 'failed', 'ENCODE_FAILED');
  assert.equal((await account(owner)).reserved, 0);
  ok('failure without deliverable returns the full reservation');
  const third = await newQuote();
  const j3 = await submit(third);
  await withUsage('job', j3.id, 1, async () => {
    const u = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 1000 });
    await unknownUsage([u], 'TEST_CRASH');
  });
  await finishBillingTarget(billingTargetKey('job', j3.id), 'failed', 'AI_RESULT_UNKNOWN');
  const target = (
    await db()
      .select()
      .from(billingTargets)
      .where(eq(billingTargets.key, billingTargetKey('job', j3.id)))
  )[0];
  const receipt = await billingReceipt(owner, target.operationId);
  assert.equal(receipt.state, 'reconciling');
  assert((await account(owner)).reserved > 0);
  ok('unknown provider outcome retains reservation for reconciliation');
  await assert.rejects(() => billingReceipt(other, target.operationId));
  ok('receipts are owner scoped');
  await assert.rejects(
    () =>
      billingRequest.run({ owner, quoteId: q.id, fingerprint: 'tampered' }, () =>
        createJob(owner, asset, randomUUID(), q.operation.body.options as any),
      ),
    (e: any) => e.code === 'QUOTE_MISMATCH',
  );
  ok('tampered quote is rejected transactionally');
  await db().update(jobs).set({ state: 'failed', error: 'TEST_FINISHED' });
  const retryOp = { path: `jobs/${j3.id}/retry`, body: {} };
  const retryQuote = await createQuote(owner, retryOp);
  const retryHash = await operationFingerprint(owner, retryOp);
  await assert.rejects(
    () =>
      billingRequest.run({ owner, quoteId: retryQuote.id, fingerprint: retryHash }, () =>
        changeJob(j3.id, owner, 'retry'),
      ),
    (e: any) => e.code === 'BILLING_RECONCILING',
  );
  ok('uncertain supplier outcomes cannot be resubmitted by retry');
  for (const u of await db()
    .select()
    .from(costUsage)
    .where(eq(costUsage.operationId, target.operationId)))
    await completeUsage(u.id, 250, { reconciliation: 'synthetic supplier invoice' });
  await finishBillingTarget(target.key, 'failed', 'AI_RESULT_UNKNOWN');
  assert.equal((await billingReceipt(owner, target.operationId)).state, 'refunded');
  ok('reconciliation resolves a retained reservation exactly once');
  await grantCredits(owner, 100000, 'extended-tests', 'isolated synthetic credits');
  const cancelled = await newQuote(),
    jc = await submit(cancelled);
  await withUsage('job', jc.id, 1, async () => {
    const id = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 20000 });
    await completeUsage(id, 10000);
  });
  await finishBillingTarget(billingTargetKey('job', jc.id), 'cancelled');
  const ct = (
    await db().select().from(billingTargets).where(eq(billingTargets.targetId, jc.id))
  )[0];
  assert.equal((await billingReceipt(owner, ct.operationId)).chargedCredits, 6);
  ok('cancellation charges only work already executed and returns the rest');
  const paused = await newQuote(),
    jp = await submit(paused);
  await withUsage('job', jp.id, 1, async () => {
    const id = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 20000 });
    await completeUsage(id, 10000);
  });
  await db()
    .update(jobs)
    .set({ state: 'failed', error: 'BILLING_BUDGET_EXCEEDED' })
    .where(eq(jobs.id, jp.id));
  const resumeOp = { path: `jobs/${jp.id}/retry`, body: {} },
    resumeQ = await createQuote(owner, resumeOp);
  await billingRequest.run(
    { owner, quoteId: resumeQ.id, fingerprint: await operationFingerprint(owner, resumeOp) },
    () => changeJob(jp.id, owner, 'retry'),
  );
  const pt = (
    await db()
      .select()
      .from(billingTargets)
      .where(eq(billingTargets.key, billingTargetKey('job', jp.id)))
  )[0];
  assert.equal((await billingReceipt(owner, pt.operationId)).state, 'needs_quote');
  assert.equal((await billingReceipt(owner, pt.operationId)).chargedCredits, 6);
  await finishBillingTarget(billingTargetKey('job', jp.id, 2), 'cancelled');
  ok('immediate retry settles the previous attempt before the maintenance loop');
  await db().update(jobs).set({ state: 'failed', error: 'TEST_FINISHED' });
  const exp = await newQuote();
  await db()
    .update(billingQuotes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(billingQuotes.id, exp.id));
  await assert.rejects(
    () => submit(exp),
    (e: any) => e.code === 'QUOTE_EXPIRED',
  );
  ok('expired quotes cannot reserve or enqueue');
  const oldVersion = await newQuote();
  const changed = {
    ...book,
    version: 'test-double-runtime',
    rates: book.rates.map((r) => ({
      ...r,
      cnyPerUnit: r.meter === 'runtime_ms' ? 0.000002 : r.cnyPerUnit,
    })),
  };
  await db().insert(billingPriceBooks).values({ version: changed.version, data: changed });
  await db()
    .update(billingSettings)
    .set({ priceVersion: changed.version })
    .where(eq(billingSettings.id, 'default'));
  const jv = await submit(oldVersion);
  await withUsage('job', jv.id, 1, async () => {
    const id = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 20000 });
    await completeUsage(id, 10000);
  });
  await finishBillingTarget(billingTargetKey('job', jv.id), 'completed');
  const vt = (
    await db().select().from(billingTargets).where(eq(billingTargets.targetId, jv.id))
  )[0];
  assert.equal((await billingReceipt(owner, vt.operationId)).chargedCredits, 6);
  ok('valid old quotes retain the old price after a price change');
  await db()
    .update(billingSettings)
    .set({ priceVersion: book.version })
    .where(eq(billingSettings.id, 'default'));
  const asset2 = randomUUID();
  await db()
    .insert(assets)
    .values({
      id: asset2,
      owner,
      key: `test/${asset2}`,
      name: 'sample2.mp4',
      mime: 'video/mp4',
      size: 1000000,
      state: 'ready',
      expiresAt: new Date(Date.now() + 86400000),
    });
  await db()
    .insert(billingProbes)
    .values({
      assetId: asset2,
      owner,
      state: 'completed',
      facts: {
        bytes: 1000000,
        duration: 7200,
        width: 1920,
        height: 1080,
        source: 'synthetic-test',
      },
    });
  const batchOp = {
    path: 'batches',
    body: {
      requestId: randomUUID(),
      assetIds: [asset, asset2],
      tool: 'video-converter',
      options: { format: 'mp4' },
    },
  };
  await recordPlatformUsage('batch:second-file:probe', 'runtime_ms', 5000, { assetId: asset2 });
  const bq = await createQuote(owner, batchOp);
  const batch = await billingRequest.run(
    { owner, quoteId: bq.id, fingerprint: await operationFingerprint(owner, batchOp) },
    () =>
      createBatch(owner, [asset, asset2], batchOp.body.requestId, 'video-converter', {
        format: 'mp4',
      } as any),
  );
  const bj = await db().select().from(jobs).where(eq(jobs.batchId, batch.id));
  const [batchSource] = await db()
    .select()
    .from(costUsage)
    .where(eq(costUsage.eventKey, 'batch:second-file:probe'));
  const [batchAllocation] = await db()
    .select()
    .from(costUsage)
    .where(eq(costUsage.eventKey, `allocation:${batchSource.id}`));
  assert.equal(
    batchAllocation.targetKey,
    billingTargetKey('job', bj.find((j) => j.assetId === asset2)!.id),
  );
  for (const j of bj)
    await withUsage('job', j.id, 1, async () => {
      const id = await startUsage({ meter: 'runtime_ms', stage: 'process', maximum: 20000 });
      await completeUsage(id, 10000);
    });
  await finishBillingTarget(billingTargetKey('job', bj[0].id), 'completed');
  await finishBillingTarget(billingTargetKey('job', bj[1].id), 'failed', 'TEST_FAILURE');
  const bt = (
      await db().select().from(billingTargets).where(eq(billingTargets.targetId, bj[0].id))
    )[0],
    br = await billingReceipt(owner, bt.operationId);
  assert.equal(br.chargedCredits, 6);
  assert(br.lines.some((l) => l.platformLoss));
  ok('partial batches charge successful members; failed costs stay with the platform');
  await db().update(jobs).set({ state: 'failed', error: 'TEST_FINISHED' });
  const prepOp = { path: `assets/${asset}/prepare`, body: { profile: 'video' } },
    pq = await createQuote(owner, prepOp);
  const prep = await billingRequest.run(
    { owner, quoteId: pq.id, fingerprint: await operationFingerprint(owner, prepOp) },
    () => prepareAsset(owner, asset, 'video'),
  );
  await db().update(preparations).set({ state: 'completed' }).where(eq(preparations.id, prep.id));
  await finishBillingTarget(billingTargetKey('prepare', prep.id), 'completed');
  const beforeLedger = (await db().select().from(creditLedger)).length;
  assert.equal((await prepareAsset(owner, asset, 'video')).id, prep.id);
  assert.equal((await db().select().from(creditLedger)).length, beforeLedger);
  ok('cached preparations return without requiring or charging another quote');
  const noNewWork = await newQuote();
  const beforeJobs = (await db().select().from(jobs)).length;
  await assert.rejects(
    () =>
      billingRequest.run({ owner, reuseOnly: true, fingerprint: '' }, () =>
        createJob(
          owner,
          asset,
          noNewWork.operation.body.requestId as string,
          noNewWork.operation.body.options as any,
        ),
      ),
    (e: any) => e.code === 'BILLING_NEW_WORK_REQUIRED',
  );
  assert.equal((await db().select().from(jobs)).length, beforeJobs);
  assert.equal(
    (
      await billingRequest.run({ owner, reuseOnly: true, fingerprint: '' }, () =>
        prepareAsset(owner, asset, 'video'),
      )
    ).id,
    prep.id,
  );
  ok('reuse-only requests return cached work and cannot enqueue or reserve new work');
  const legacyCount = (await db().select().from(billingOperations)).length;
  await finishBillingTarget(`job:${randomUUID()}:1`, 'completed');
  assert.equal((await db().select().from(billingOperations)).length, legacyCount);
  ok('historical unbilled tasks are never charged retroactively');
  await recordPlatformUsage('test:probe-overhead', 'runtime_ms', 5000, { assetId: asset });
  await recordPlatformUsage('test:probe-overhead', 'runtime_ms', 5000, { assetId: asset });
  const overheadQ = await newQuote(),
    overheadJob = await submit(overheadQ);
  await finishBillingTarget(billingTargetKey('job', overheadJob.id), 'completed');
  const [oh] = await db()
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.targetId, overheadJob.id));
  assert.equal((await billingReceipt(owner, oh.operationId)).chargedCredits, 3);
  const secondUse = await newQuote(),
    secondJob = await submit(secondUse);
  await finishBillingTarget(billingTargetKey('job', secondJob.id), 'completed');
  const [secondTarget] = await db()
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.targetId, secondJob.id));
  assert.equal((await billingReceipt(owner, secondTarget.operationId)).lines.length, 0);
  const overheadEvents = await db()
    .select()
    .from(costUsage)
    .where(eq(costUsage.eventKey, 'test:probe-overhead'));
  assert.equal(overheadEvents.length, 1);
  ok('source overhead is attributed only once; retries and reuse cannot charge it again');
  await db().update(jobs).set({ state: 'failed', error: 'TEST_FINISHED' });
  const boundedQ = await newQuote();
  await db()
    .update(billingQuotes)
    .set({ maximumCredits: 2, estimatedCredits: 1 })
    .where(eq(billingQuotes.id, boundedQ.id));
  const boundedJob = await submit(boundedQ);
  await assert.rejects(
    () =>
      withUsage('job', boundedJob.id, 1, () =>
        runProcess(
          process.execPath,
          ['-e', 'setTimeout(()=>{},10000)'],
          undefined,
          undefined,
          10000,
        ),
      ),
    (e: any) => e.code === 'BILLING_BUDGET_EXCEEDED',
  );
  await finishBillingTarget(
    billingTargetKey('job', boundedJob.id),
    'paused',
    'BILLING_BUDGET_EXCEEDED',
  );
  const [boundedTarget] = await db()
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.targetId, boundedJob.id));
  const boundedReceipt = await billingReceipt(owner, boundedTarget.operationId);
  assert.equal(boundedReceipt.state, 'needs_quote');
  assert(boundedReceipt.chargedCredits <= 2);
  assert(boundedReceipt.lines.some((l) => l.meter === 'runtime_ms' && l.quantity > 0));
  ok('a real subprocess stops at the authorized budget and never debits more than the maximum');
  const report = await saveDailyBillingReport();
  assert(report.consumedCredits > 0);
  assert(report.allocatedResourceCostCny > 0);
  assert.equal(
    report.provisionalProfitCny,
    report.revenueCny * 0.9 - report.knownVariableCostCny - 300,
  );
  ok(
    'daily report serializes after ORM initialization and avoids double-counting allocated resources',
  );
  await db()
    .update(billingSettings)
    .set({ mode: 'shadow', priceVersion: initialPriceBook.version })
    .where(eq(billingSettings.id, 'default'));
  const unpriced = await newQuote();
  assert.equal(unpriced.state, 'unpriced');
  assert.equal(unpriced.maximumCredits, null);
  ok('unverified resource prices never present a complete price');
  const shadowJob = await createJob(owner, asset, randomUUID(), q.operation.body.options as any);
  await finishBillingTarget(billingTargetKey('job', shadowJob.id), 'completed');
  ok('shadow mode records work without charging');
  const oldEnvironment = process.env.NODE_ENV,
    oldOverride = process.env.BILLING_SHADOW_EXECUTION;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.BILLING_SHADOW_EXECUTION;
    await assert.rejects(
      () => createJob(owner, asset, randomUUID(), q.operation.body.options as any),
      (e: any) => e.code === 'BILLING_PREVIEW_ONLY',
    );
    assert.equal((await prepareAsset(owner, asset, 'video')).id, prep.id);
  } finally {
    if (oldEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnvironment;
    if (oldOverride === undefined) delete process.env.BILLING_SHADOW_EXECUTION;
    else process.env.BILLING_SHADOW_EXECUTION = oldOverride;
  }
  ok('production shadow mode blocks new work while allowing existing cached results');

  console.log(
    `Billing integration: ${checked} scenarios passed. No production data or cloud AI used.`,
  );
} finally {
  await sqlClient().end();
  (globalThis as any).filemorphSql = undefined;
  await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  process.env.DATABASE_URL = original;
}
