import { randomUUID } from 'node:crypto';
import { runtimeEstimate } from './billing-estimate';
export { runtimeEstimate } from './billing-estimate';
import { z } from 'zod';
import { db, eq, and, inArray, gt, sql } from './db';
import {
  assets,
  jobs,
  batches,
  preparations,
  transcripts,
  translationDocuments,
  translationActivities,
  translationExports,
  transcriptExports,
  watermarkDocuments,
  watermarkRuns,
  billingProbes,
  billingTargets,
  costUsage,
  billingQuotes,
  type BillingSnapshot,
} from './schema';
import { account, billingConfig, fingerprint, type BillingTx } from './billing';
import {
  billingDefaults,
  chargeablePath,
  creditsForMicroCny,
  findRate,
  microCny,
  type QuoteLine,
  type QuoteView,
  type PriceBook,
  type BillingFacts,
  type Meter,
} from './billing-model';
import { translationRoute } from './translation';
import { transcriptionConfig } from './transcription';
import { jobSpecSchema } from './domain';
import { assertToolPublished, assertOwnerNotBlocked } from './access';
import { ServiceError } from './service-error';
type Store = ReturnType<typeof db> | BillingTx;
const operationSchema = z
  .object({ path: z.string().max(160), body: z.record(z.string(), z.unknown()).default({}) })
  .strict();
export type BillingOperationInput = z.infer<typeof operationSchema>;
export function parseBillingOperation(value: unknown): BillingOperationInput {
  const o = operationSchema.parse(value);
  if (!chargeablePath(o.path) || 'billingQuoteId' in o.body || 'billingReuseOnly' in o.body)
    throw new ServiceError(400, 'INVALID_REQUEST');
  return o;
}
function id(value: unknown) {
  return z.string().uuid().parse(value);
}
async function resolveOperation(owner: string, o: BillingOperationInput, store: Store) {
  const p = o.path.split('/'),
    b = o.body;
  let ids: string[] = [],
    tool = '',
    options: any = b.options || {},
    data: any = null,
    revision = 0,
    maxTargets = 1,
    kind = 'job';
  let parentJobId: string | undefined;
  let retryTargets: string[] = [],
    budgetRetry = false;
  if (p.length === 1) {
    const spec = jobSpecSchema.parse({ ...b, tool: b.tool || 'video-compressor' });
    tool = spec.tool;
    options = spec.options;
    ids = Array.isArray(b.assetIds)
      ? b.assetIds.map(id)
      : Array.isArray(b.sourceIds)
        ? b.sourceIds.map(id)
        : [id(b.assetId)];
    if (p[0] === 'batches') maxTargets = ids.length;
  } else if (p[0] === 'assets') {
    ids = [id(p[1])];
    tool = b.profile === 'video' ? 'video-prepare' : 'audio-prepare';
    kind = 'prepare';
    if (b.retry) {
      const [previous] = await store
        .select()
        .from(preparations)
        .where(
          and(
            eq(preparations.assetId, ids[0]),
            eq(preparations.owner, owner),
            eq(preparations.profile, b.profile === 'video' ? 'video' : 'audio'),
            eq(preparations.streamIndex, Number(b.streamIndex ?? -1)),
          ),
        );
      if (previous) {
        retryTargets = [previous.id];
        budgetRetry = previous.error === 'BILLING_BUDGET_EXCEEDED';
      }
    }
  } else {
    let jobId: string | undefined = p[0] === 'jobs' ? id(p[1]) : undefined;
    if (p[0] === 'batches') {
      const [batch] = await store
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.id, id(p[1])),
            eq(batches.owner, owner),
            gt(batches.expiresAt, new Date()),
          ),
        );
      if (!batch) throw new ServiceError(404, 'BATCH_NOT_FOUND');
      const members = await store
        .select()
        .from(jobs)
        .where(and(eq(jobs.batchId, batch.id), eq(jobs.owner, owner), eq(jobs.deleting, false)));
      const selected = members.filter((j) =>
        p[2] === 'retry' ? ['failed', 'cancelled'].includes(j.state) : j.state === 'completed',
      );
      ids = selected.map((j) => j.assetId);
      if (p[2] === 'retry') {
        retryTargets = selected.map((j) => j.id);
        budgetRetry = selected.some((j) => j.error === 'BILLING_BUDGET_EXCEEDED');
      }
      maxTargets = p[2] === 'retry' ? selected.length : 1;
      await assertToolPublished(batch.tool);
      tool = p[2] === 'archive' ? 'archive' : batch.tool;
      kind = p[2] === 'archive' ? 'archive' : 'job';
      options = batch.options;
      data = {
        members: selected.map((j) => ({ id: j.id, attempt: j.attempt, outputSize: j.outputSize })),
      };
    } else if (p[0] !== 'jobs') {
      const table =
        p[0] === 'reading-activities'
          ? translationActivities
          : p[0] === 'translation-exports'
            ? translationExports
            : p[0] === 'transcript-exports'
              ? transcriptExports
              : watermarkRuns;
      const [row] = await store
        .select()
        .from(table)
        .where(eq(table.id, id(p[1])));
      if (!row) throw new ServiceError(404, 'NOT_FOUND');
      jobId = row.jobId;
      retryTargets = [row.id];
      budgetRetry = row.error === 'BILLING_BUDGET_EXCEEDED';
      options = row.options;
      kind =
        p[0] === 'reading-activities'
          ? 'reading'
          : p[0] === 'watermark-runs'
            ? 'watermark-run'
            : p[0] === 'translation-exports'
              ? 'translation-export'
              : 'transcript-export';
    }
    if (jobId) {
      const [j] = await store
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.owner, owner),
            eq(jobs.deleting, false),
            gt(jobs.expiresAt, new Date()),
          ),
        );
      if (!j) throw new ServiceError(404, 'JOB_NOT_FOUND');
      ids = j.sourceIds.length ? j.sourceIds : [j.assetId];
      tool = j.tool;
      parentJobId = j.id;
      if (p[0] === 'jobs' && p.at(-1) === 'retry') {
        retryTargets = [j.id];
        budgetRetry = j.error === 'BILLING_BUDGET_EXCEEDED';
      }
      if (p[0] === 'jobs') {
        options = p.length === 3 && p[2] === 'retry' ? j.options : b;
        kind =
          p[2] === 'reading'
            ? 'reading'
            : p[3] === 'exports'
              ? `${p[2]}-export`
              : p[2] === 'watermark'
                ? 'watermark-run'
                : 'job';
        if (p[2] === 'translation' && p[3] === 'retry') options = { ...j.options, ...b };
      }
      if (tool === 'transcription') {
        const [doc] = await store.select().from(transcripts).where(eq(transcripts.jobId, j.id));
        data = doc?.data;
        revision = doc?.revision || 0;
      } else if (tool.endsWith('translator')) {
        const [doc] = await store
          .select()
          .from(translationDocuments)
          .where(eq(translationDocuments.jobId, j.id));
        data = doc?.data;
        revision = doc?.revision || 0;
      } else if (tool.endsWith('watermark-remover')) {
        const [doc] = await store
          .select()
          .from(watermarkDocuments)
          .where(eq(watermarkDocuments.jobId, j.id));
        data = doc ? { ...doc.data, selection: doc.selection } : null;
        revision = doc?.revision || 0;
      }
    }
  }
  if (tool && !['video-prepare', 'audio-prepare', 'archive'].includes(tool))
    await assertToolPublished(tool);
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 20 || !maxTargets) throw new ServiceError(400, 'INVALID_SOURCES');
  const inputs = await store
    .select()
    .from(assets)
    .where(
      and(
        inArray(assets.id, ids),
        eq(assets.owner, owner),
        eq(assets.state, 'ready'),
        gt(assets.expiresAt, new Date()),
      ),
    );
  if (inputs.length !== ids.length) throw new ServiceError(404, 'ASSET_NOT_FOUND');
  return {
    ids,
    inputs,
    tool,
    options,
    data,
    revision,
    kind,
    maxTargets,
    parentJobId,
    retryTargets,
    budgetRetry,
  };
}
export async function assertOperationAllowed(owner: string, operation: BillingOperationInput) {
  await assertOwnerNotBlocked(owner);
  await resolveOperation(owner, operation, db());
}

export async function operationFingerprint(
  owner: string,
  o: BillingOperationInput,
  store: Store = db(),
) {
  const r = await resolveOperation(owner, o, store);
  return fingerprint({
    operation: o,
    assets: r.inputs
      .map((a) => ({ id: a.id, size: a.size, key: a.key, expiresAt: a.expiresAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    revision: r.revision,
    data: r.data,
  });
}
async function build(owner: string, o: BillingOperationInput, book: PriceBook, enqueue: boolean) {
  await assertOwnerNotBlocked(owner);
  const r = await resolveOperation(owner, o, db());
  const probes = await db()
    .select()
    .from(billingProbes)
    .where(inArray(billingProbes.assetId, r.ids));
  let probing = false,
    failed = false;
  for (const a of r.inputs) {
    const p = probes.find((p) => p.assetId === a.id);
    if (!p && enqueue) {
      const [{ count }] = await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(billingProbes)
        .where(
          and(
            eq(billingProbes.owner, owner),
            sql`${billingProbes.createdAt}>now()-interval '24 hours'`,
          ),
        );
      if (count >= 20) throw new ServiceError(429, 'QUOTE_PROBE_LIMIT');
      await db().insert(billingProbes).values({ assetId: a.id, owner }).onConflictDoNothing();
    }
    if (!p || ['queued', 'processing'].includes(p.state)) probing = true;
    if (p?.state === 'failed') failed = true;
  }
  const facts = r.inputs.map(
    (a) => probes.find((p) => p.assetId === a.id)?.facts || { bytes: a.size, source: 'pending' },
  );
  const lines: QuoteLine[] = [],
    warnings = ['Production resource coefficients require calibration.'];
  const add = (
    label: string,
    meter: Meter,
    quantity: number,
    maximum = quantity,
    route?: { baseURL: string; model: string },
    tokens = 0,
  ) => {
    if (quantity <= 0 && maximum <= 0) return;
    const rate = findRate(book, meter, route?.baseURL, route?.model, tokens);
    lines.push({
      label,
      meter,
      quantity,
      maximum,
      rateId: rate?.id || `${route?.model || 'infrastructure'}:${meter}`,
      estimatedMicroCny: rate?.cnyPerUnit == null ? null : microCny(quantity, rate.cnyPerUnit),
      maximumMicroCny: rate?.cnyPerUnit == null ? null : microCny(maximum, rate.cnyPerUnit),
      verified: !!rate?.verified,
    });
  };
  let previousRuntime = 0;
  if (r.budgetRetry && r.retryTargets.length) {
    const runs = await db()
      .select({ ms: sql<number>`sum(${costUsage.quantity})` })
      .from(costUsage)
      .innerJoin(billingTargets, eq(costUsage.targetKey, billingTargets.key))
      .where(
        and(
          inArray(billingTargets.targetId, r.retryTargets),
          eq(billingTargets.kind, r.kind),
          eq(costUsage.meter, 'runtime_ms'),
        ),
      )
      .groupBy(costUsage.targetKey);
    previousRuntime = Math.max(0, ...runs.map((run) => Number(run.ms)));
    if (previousRuntime)
      warnings.push(
        'Previous runtime exceeded its budget; this quote increases the processing allowance.',
      );
  }
  for (const f of facts) {
    const seconds = runtimeEstimate(r.tool, r.kind, f, r.options);
    add(
      'Processing / 处理资源',
      'runtime_ms',
      Math.max(seconds * 1000, (previousRuntime * 1.25) / facts.length),
      Math.max(30000, seconds * 4000, (previousRuntime * 2) / facts.length),
    );
    add(
      '24h storage / 24 小时存储',
      'storage_gib_day',
      (f.bytes / 1024 ** 3) * 3,
      (f.bytes / 1024 ** 3) * 8,
    );
    add(
      'Transfer / 文件传输',
      'transfer_gib',
      (f.bytes / 1024 ** 3) * 2,
      (f.bytes / 1024 ** 3) * 8,
    );
    add('Object reads / 对象读取', 'storage_read', 3, 20);
    add('Object writes / 对象写入', 'storage_write', 3, 20);
  }
  const overhead = await db()
    .select()
    .from(costUsage)
    .where(
      sql`${costUsage.operationId} is null and ${costUsage.rawUsage}->>'assetId'=any(array[${sql.join(
        r.ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]) and not exists(select 1 from cost_usage allocated where allocated.event_key='allocation:'||${costUsage.id}::text)`,
    );
  for (const event of overhead)
    add('Source preparation / 原件准备', event.meter, event.quantity, event.quantity);
  let stage = 'process',
    allowedStages = ['process', 'storage'];
  const sourceChars =
    r.data?.blocks?.reduce((n: number, b: any) => n + String(b.sourceText || '').length, 0) ||
    r.data?.segments?.reduce((n: number, b: any) => n + String(b.text || '').length, 0) ||
    facts.reduce((n, f) => n + (f.characters || 0), 0);
  const pages = facts.reduce((n, f) => n + (f.pages || 1), 0),
    scanPages = facts.reduce((n, f) => n + (f.scanPages || 0), 0);
  const tokenLines = (purpose: 'ocr' | 'translate' | 'reading', chars: number, count = 1) => {
    const route = translationRoute(purpose),
      input = Math.max(1, chars * 2 + count * 2000),
      output = Math.max(200, count * 500 + chars * 2);
    const maximumInput =
      purpose === 'ocr' ? 32000 * count : Math.max(input * 2, chars * 4 + count * 12000);
    add(
      `${purpose} input / 输入`,
      'input_tokens',
      input,
      maximumInput,
      route,
      Math.min(maximumInput, 1000000),
    );
    add(
      `${purpose} output / 输出`,
      'output_tokens',
      output,
      Math.max(output * 2, count * (purpose === 'reading' ? 12000 : 8192)),
      route,
      Math.min(maximumInput, 1000000),
    );
    allowedStages.push(purpose);
  };
  if (r.kind === 'reading' && r.options.kind !== 'preview') {
    stage = 'reading';
    tokenLines(
      'reading',
      sourceChars + String(r.options.question || '').length + 12000,
      Math.max(1, Math.ceil(sourceChars / 20000)),
    );
  } else if (
    r.kind === 'job' &&
    ['transcription', 'video-translator'].includes(r.tool) &&
    !r.data
  ) {
    const c = transcriptionConfig();
    const seconds = facts.reduce((n, f) => n + (f.duration || 0), 0);
    stage = 'asr';
    allowedStages.push('asr');
    add(
      'Speech recognition / 语音识别',
      'asr_seconds',
      seconds,
      Math.ceil(seconds + Math.ceil(seconds / 600)),
      { baseURL: c.baseURL, model: c.model },
    );
    if (r.tool === 'video-translator')
      warnings.push('Speech recognition first; translation requires a new confirmed quote.');
  } else if (r.kind === 'job' && r.tool.endsWith('translator')) {
    const remainingOcr = r.data?.pages?.filter((p: any) => p.needsOcr).length;
    const needsOcr =
      !r.options.operation &&
      (r.data ? remainingOcr > 0 : r.tool === 'image-translator' || scanPages > 0);
    if (needsOcr) {
      stage = 'ocr';
      tokenLines(
        'ocr',
        Math.max(remainingOcr ?? scanPages, r.tool === 'image-translator' ? 1 : 0) * 6000,
        Math.max(1, remainingOcr ?? scanPages),
      );
      warnings.push('OCR first; translation and background repair require a new quote.');
    } else {
      stage = r.options.operation === 'repair' ? 'repair' : 'translate';
      if (stage === 'translate')
        tokenLines(
          'translate',
          sourceChars,
          Math.max(1, r.data?.blocks?.length || Math.ceil(sourceChars / 2000)),
        );
      const count =
        r.data?.blocks?.filter(
          (b: any) => !b.hidden && !b.keepOriginal && b.box && b.raster !== false && !b.localRepair,
        ).length || 0;
      if (count) {
        const route = translationRoute('repair');
        add('Background repair regions / 背景修复区域', 'repair_images', count, count, route);
        allowedStages.push('repair');
      }
    }
  } else if (r.kind === 'watermark-run') {
    if (r.options.kind === 'detect') {
      stage = 'ocr';
      tokenLines('ocr', 6000, 1);
    } else {
      const selected = r.data?.selection;
      const count = Math.max(
        0,
        (selected?.regions?.length || 0) + (selected?.candidates?.length || 0),
      );
      if (count) {
        stage = 'repair';
        const route = translationRoute('repair');
        add('Selected repair regions / 所选修复区域', 'repair_images', count, count, route);
        allowedStages.push('repair');
        if (r.tool === 'pdf-watermark-remover') tokenLines('ocr', pages * 6000, pages);
      }
    }
  }
  if (r.kind.includes('export') || (r.kind === 'reading' && r.options.kind === 'preview')) {
    stage = 'export';
    allowedStages = ['process', 'storage'];
  }
  const missingPrices = [
    ...new Set(lines.filter((l) => !l.verified || l.maximumMicroCny === null).map((l) => l.rateId)),
  ];
  const known = lines.reduce((n, l) => n + (l.estimatedMicroCny || 0), 0),
    max = lines.reduce((n, l) => n + (l.maximumMicroCny || 0), 0);
  return { r, lines, missingPrices, stage, allowedStages, warnings, probing, failed, known, max };
}
export async function createQuote(owner: string, value: unknown): Promise<QuoteView> {
  const operation = parseBillingOperation(value),
    { settings, book } = await billingConfig();
  const b = await build(owner, operation, book, true),
    hash = await operationFingerprint(owner, operation);
  const snapshot: BillingSnapshot = {
    book,
    lines: b.lines,
    missingPrices: b.missingPrices,
    stage: b.stage,
    allowedStages: b.allowedStages,
    warnings: b.warnings,
    maxTargets: b.r.maxTargets,
    assetIds: b.r.ids,
    factsHash: hash,
  };
  const [q] = await db()
    .insert(billingQuotes)
    .values({
      id: randomUUID(),
      owner,
      fingerprint: hash,
      operation,
      snapshot,
      mode: settings.mode,
      state: b.probing
        ? 'probing'
        : b.failed
          ? 'failed'
          : b.missingPrices.length
            ? 'unpriced'
            : 'ready',
      estimatedCredits:
        b.missingPrices.length || b.probing || b.failed ? null : creditsForMicroCny(b.known),
      maximumCredits:
        b.missingPrices.length || b.probing || b.failed ? null : creditsForMicroCny(b.max),
      knownCredits: creditsForMicroCny(b.known, false),
      expiresAt: new Date(
        Math.min(
          Date.now() + billingDefaults.quoteMinutes * 60000,
          ...b.r.inputs.map((a) => a.expiresAt.getTime()),
        ),
      ),
    })
    .returning();
  return quoteView(q, owner);
}
async function quoteView(q: typeof billingQuotes.$inferSelect, owner: string): Promise<QuoteView> {
  return {
    id: q.id,
    mode: q.mode,
    state: q.state as QuoteView['state'],
    estimatedCredits: q.estimatedCredits,
    maximumCredits: q.maximumCredits,
    knownCredits: q.knownCredits,
    currency: 'credits',
    priceVersion: q.snapshot.book.version,
    expiresAt: q.expiresAt.toISOString(),
    balance: (await account(owner)).available,
    lines: q.snapshot.lines,
    missingPrices: q.snapshot.missingPrices,
    stage: q.snapshot.stage,
    warnings: q.snapshot.warnings,
    operation: q.operation,
  };
}
export async function readQuote(owner: string, id: string) {
  let [q] = await db()
    .select()
    .from(billingQuotes)
    .where(and(eq(billingQuotes.id, id), eq(billingQuotes.owner, owner)));
  if (!q) throw new ServiceError(404, 'NOT_FOUND');
  if (q.expiresAt <= new Date()) throw new ServiceError(409, 'QUOTE_EXPIRED');
  if (q.state === 'probing') {
    const b = await build(owner, q.operation, q.snapshot.book, false);
    if (!b.probing)
      [q] = await db()
        .update(billingQuotes)
        .set({
          state: b.failed ? 'failed' : b.missingPrices.length ? 'unpriced' : 'ready',
          estimatedCredits: b.missingPrices.length || b.failed ? null : creditsForMicroCny(b.known),
          maximumCredits: b.missingPrices.length || b.failed ? null : creditsForMicroCny(b.max),
          knownCredits: creditsForMicroCny(b.known, false),
          snapshot: {
            ...q.snapshot,
            lines: b.lines,
            missingPrices: b.missingPrices,
            stage: b.stage,
            allowedStages: b.allowedStages,
            warnings: b.warnings,
          },
        })
        .where(eq(billingQuotes.id, id))
        .returning();
  }
  return quoteView(q, owner);
}
