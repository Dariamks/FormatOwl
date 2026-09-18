import { admitBilling } from './billing';
import { randomUUID } from 'node:crypto';
import { db, eq, and, inArray, desc, sql } from './db';
import { jobs, watermarkDocuments, watermarkRuns, watermarkSteps } from './schema';
import { ServiceError, jobForOwner, lockOwner, capacity } from './jobs';
import { downloadUrl } from './storage';
import { translationConfig, translationRoute, imageGatewayConfig } from './translation';
import {
  isWatermarkTool,
  watermarkPatchSchema,
  watermarkSelectionSchema,
  watermarkRunSchema,
  validateWatermarkSelection,
  type WatermarkView,
} from './watermark';

export function watermarkCapabilities() {
  let ocr = false,
    repair = false;
  try {
    ocr = !!translationConfig().apiKey;
    repair = translationRoute('repair').provider === 'openai' ? !!imageGatewayConfig().apiKey : ocr;
  } catch {}
  return { ocr, repair };
}
async function checked(id: string, owner: string) {
  const { job } = await jobForOwner(id, owner);
  if (!isWatermarkTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
  if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
  return job;
}
export async function readWatermark(id: string, owner: string): Promise<WatermarkView> {
  await checked(id, owner);
  const [doc] = await db()
    .select()
    .from(watermarkDocuments)
    .where(eq(watermarkDocuments.jobId, id));
  const runs = await db()
    .select()
    .from(watermarkRuns)
    .where(eq(watermarkRuns.jobId, id))
    .orderBy(desc(watermarkRuns.createdAt))
    .limit(100);
  return {
    revision: doc?.revision || 0,
    selection: doc?.selection || { candidates: [], regions: [] },
    capabilities: watermarkCapabilities(),
    data: doc?.data
      ? {
          ...doc.data,
          pages: doc.data.pages.map((p) => ({ ...p, file: '' })),
          candidates: doc.data.candidates.map(({ locator, ...c }) => c),
          targets: doc.data.targets.map(({ locator, ...t }) => ({ ...t, file: '' })),
        }
      : null,
    runs: runs.map((r) => ({
      id: r.id,
      revision: r.revision,
      state: r.state,
      error: r.error,
      progress: r.progress,
      options: r.options,
      pages: r.result?.pages.map((p) => p.index) || [],
    })),
  };
}
export async function saveWatermark(id: string, owner: string, body: unknown) {
  const { revision, ...selection } = watermarkPatchSchema.parse(body);
  return db().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || !isWatermarkTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    const [doc] = await tx
      .select()
      .from(watermarkDocuments)
      .where(eq(watermarkDocuments.jobId, id))
      .for('update');
    if (!doc?.data) throw new ServiceError(409, 'NOT_READY');
    if (doc.revision !== revision) throw new ServiceError(409, 'WATERMARK_CONFLICT');
    const error = validateWatermarkSelection(doc.data, selection);
    if (error) throw new ServiceError(400, error);
    if (JSON.stringify(watermarkSelectionSchema.parse(doc.selection)) === JSON.stringify(selection))
      return { revision };
    await tx
      .update(watermarkDocuments)
      .set({ selection, revision: revision + 1, updatedAt: new Date() })
      .where(eq(watermarkDocuments.jobId, id));
    return { revision: revision + 1 };
  });
}
export async function createWatermarkRun(id: string, owner: string, body: unknown) {
  const options = watermarkRunSchema.parse(body);
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || !isWatermarkTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    const [existing] = await tx
      .select()
      .from(watermarkRuns)
      .where(and(eq(watermarkRuns.jobId, id), eq(watermarkRuns.requestId, options.requestId)));
    if (existing) {
      if (JSON.stringify(watermarkRunSchema.parse(existing.options)) !== JSON.stringify(options))
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
      return { id: existing.id };
    }
    const [doc] = await tx
      .select()
      .from(watermarkDocuments)
      .where(eq(watermarkDocuments.jobId, id))
      .for('update');
    if (!doc?.data || job.state !== 'completed') throw new ServiceError(409, 'NOT_READY');
    if (doc.revision !== options.revision) throw new ServiceError(409, 'WATERMARK_CONFLICT');
    const [active] = await tx
      .select()
      .from(watermarkRuns)
      .where(
        and(
          eq(watermarkRuns.jobId, id),
          inArray(watermarkRuns.state, ['queued', 'processing', 'cancelling']),
        ),
      );
    if (active) throw new ServiceError(409, 'NOT_READY');
    if (options.kind === 'detect') {
      if (!options.targetId || !doc.data.targets.some((t) => t.id === options.targetId))
        throw new ServiceError(400, 'INVALID_REGION');
      if (!watermarkCapabilities().ocr) throw new ServiceError(503, 'AI_NOT_CONFIGURED');
    } else {
      if (!doc.selection.candidates.length && !doc.selection.regions.length)
        throw new ServiceError(400, 'WATERMARK_EMPTY');
      if (
        options.kind === 'preview' &&
        (options.page === undefined || !doc.data.pages[options.page])
      )
        throw new ServiceError(400, 'INVALID_REGION');
      if (
        options.kind === 'export' &&
        !(
          job.tool === 'image-watermark-remover' ? ['png', 'jpg', 'webp'] : [doc.data.format]
        ).includes(options.format || '')
      )
        throw new ServiceError(400, 'UNSUPPORTED_FORMAT');
      const error = validateWatermarkSelection(doc.data, doc.selection);
      if (error) throw new ServiceError(400, error);
    }
    await capacity(tx, owner, 1);
    const runId = randomUUID();
    await admitBilling(tx, owner, 'watermark-run', runId, 1);
    await tx.insert(watermarkRuns).values({
      id: runId,
      jobId: id,
      requestId: options.requestId,
      revision: doc.revision,
      options,
      snapshot: { data: doc.data, selection: doc.selection },
    });
    return { id: runId };
  });
}
export async function changeWatermarkRun(runId: string, owner: string, action: 'cancel' | 'retry') {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [row] = await tx
      .select({ run: watermarkRuns, job: jobs })
      .from(watermarkRuns)
      .innerJoin(jobs, eq(jobs.id, watermarkRuns.jobId))
      .where(and(eq(watermarkRuns.id, runId), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (row.job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    const r = row.run;
    if (action === 'cancel') {
      await tx
        .update(watermarkRuns)
        .set({
          state:
            r.state === 'queued' ? 'cancelled' : r.state === 'processing' ? 'cancelling' : r.state,
        })
        .where(eq(watermarkRuns.id, runId));
    } else {
      await admitBilling(tx, owner, 'watermark-run', runId, r.attempt + 1);
      if (!['failed', 'cancelled'].includes(r.state)) throw new ServiceError(409, 'NOT_READY');
      const [active] = await tx
        .select()
        .from(watermarkRuns)
        .where(
          and(
            eq(watermarkRuns.jobId, row.job.id),
            inArray(watermarkRuns.state, ['queued', 'processing', 'cancelling']),
          ),
        );
      if (active) throw new ServiceError(409, 'NOT_READY');
      await capacity(tx, owner, 1);
      await tx
        .update(watermarkSteps)
        .set({ state: 'pending', error: null })
        .where(
          and(eq(watermarkSteps.jobId, row.job.id), sql`${watermarkSteps.state}<>'completed'`),
        );
      await tx
        .update(watermarkRuns)
        .set({
          state: 'queued',
          error: null,
          progress: 0,
          attempt: r.attempt + 1,
          dispatchedAt: null,
        })
        .where(eq(watermarkRuns.id, runId));
    }
    return { id: runId };
  });
}
export async function watermarkMedia(id: string, owner: string, query: URLSearchParams) {
  await checked(id, owner);
  const [doc] = await db()
    .select()
    .from(watermarkDocuments)
    .where(eq(watermarkDocuments.jobId, id));
  if (!doc?.data) throw new ServiceError(409, 'NOT_READY');
  const target = query.get('target');
  const page = Number(query.get('page') || 0);
  if (!Number.isInteger(page) || page < 0 || page > 99)
    throw new ServiceError(400, 'INVALID_REGION');
  let file = target
    ? doc.data.targets.find((t) => t.id === target)?.file
    : doc.data.pages[page]?.file;
  if (query.has('run')) {
    const [run] = await db()
      .select()
      .from(watermarkRuns)
      .where(
        and(
          eq(watermarkRuns.id, watermarkRunSchema.shape.requestId.parse(query.get('run'))),
          eq(watermarkRuns.jobId, id),
        ),
      );
    if (!run || run.state !== 'completed') throw new ServiceError(409, 'NOT_READY');
    file = run.result?.pages.find((p) => p.index === page)?.file;
  }
  if (!file) throw new ServiceError(404, 'NOT_FOUND');
  return {
    url: await downloadUrl('watermarks/' + id + '/' + file, 'preview.png', true, 'image/png'),
  };
}
export async function watermarkDownload(runId: string, owner: string) {
  const [r] = await db().select().from(watermarkRuns).where(eq(watermarkRuns.id, runId));
  if (!r) throw new ServiceError(404, 'JOB_NOT_FOUND');
  await checked(r.jobId, owner);
  if (r.state !== 'completed' || !r.result?.file) throw new ServiceError(409, 'NOT_READY');
  return {
    url: await downloadUrl(
      'watermarks/' + r.jobId + '/' + r.result.file,
      r.result.name || 'formatowl',
      false,
      r.result.mime,
    ),
  };
}
