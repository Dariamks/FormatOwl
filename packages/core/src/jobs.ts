import { assertOwnerNotBlocked, assertToolPublished } from './access';
import { pagination } from './pagination';
import { admitBilling } from './billing';
import { isWatermarkTool } from './watermark';
import { isTranslationTool, translationEnabled, translationOptionsSchema } from './translation';
import { transcriptEnabled, transcriptionSchema, maxTranscriptDurationMs } from './transcription';
import { isEditorTool, editValidation, type EditOptions } from './editing';
import { randomUUID, createHash } from 'node:crypto';
import { db, eq, and, inArray, gt, sql, desc } from './db';
import {
  assets,
  jobs,
  outbox,
  batches,
  archives,
  jobInputs,
  preparations,
  transcriptExports,
  transcriptionChunks,
  translationSteps,
  translationExports,
  watermarkRuns,
  guestClaims,
} from './schema';
import { limits } from './config';
import {
  supportsInput,
  batchToolSchema,
  jobSpecSchema,
  terminalStates,
  type Tool,
  type BatchTool,
  type ToolOptions,
  type JobView,
  type BatchView,
} from './domain';
import { ServiceError } from './service-error';
export { ServiceError } from './service-error';
type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];
const ordered = (v: unknown) =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
export async function lockOwner(tx: Tx, owner: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${owner}))`);
  if (owner.startsWith('anon:')) {
    const [claimed] = await tx
      .select({ owner: guestClaims.owner })
      .from(guestClaims)
      .where(eq(guestClaims.owner, owner));
    if (claimed) throw new ServiceError(401, 'AUTH_EXPIRED');
  }
}
export async function capacity(tx: Tx, owner: string, needed: number) {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(jobs)
    .where(and(eq(jobs.owner, owner), inArray(jobs.state, ['queued', 'processing', 'cancelling'])));
  const [{ count: preparing }] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(preparations)
    .where(
      and(eq(preparations.owner, owner), inArray(preparations.state, ['queued', 'processing'])),
    );
  const [{ count: exporting }] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(transcriptExports)
    .innerJoin(jobs, eq(jobs.id, transcriptExports.jobId))
    .where(
      and(
        eq(jobs.owner, owner),
        inArray(transcriptExports.state, ['queued', 'processing', 'cancelling']),
      ),
    );
  const [{ count: translatingExports }] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(translationExports)
    .innerJoin(jobs, eq(jobs.id, translationExports.jobId))
    .where(
      and(
        eq(jobs.owner, owner),
        inArray(translationExports.state, ['queued', 'processing', 'cancelling']),
      ),
    );
  const [{ count: watermarking }] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(watermarkRuns)
    .innerJoin(jobs, eq(jobs.id, watermarkRuns.jobId))
    .where(
      and(
        eq(jobs.owner, owner),
        inArray(watermarkRuns.state, ['queued', 'processing', 'cancelling']),
      ),
    );
  if (
    count + preparing + exporting + translatingExports + watermarking + needed >
    limits.maxActiveJobs
  )
    throw new ServiceError(429, 'TOO_MANY_ACTIVE_JOBS');
}
async function checkedAssets(tx: Tx, owner: string, ids: string[], tool: Tool) {
  const rows = await tx
    .select()
    .from(assets)
    .where(
      and(
        inArray(assets.id, ids),
        eq(assets.owner, owner),
        eq(assets.state, 'ready'),
        gt(assets.expiresAt, new Date()),
      ),
    )
    .for('update');
  if (rows.length !== ids.length) throw new ServiceError(404, 'ASSET_NOT_FOUND');
  if (rows.some((a) => !supportsInput(tool, a.name)))
    throw new ServiceError(400, 'UNSUPPORTED_FORMAT');
  return rows;
}
export async function createJob(
  owner: string,
  assetId: string,
  requestId: string,
  options: ToolOptions,
  tool: Tool = 'video-compressor',
  sourceIds: string[] = [assetId],
  purpose: 'export' | 'preview' = 'export',
) {
  await assertOwnerNotBlocked(owner);
  await assertToolPublished(tool);
  const parsed = jobSpecSchema.parse({ tool, options });
  if (
    !sourceIds.length ||
    sourceIds.length > 20 ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds[0] !== assetId ||
    (tool !== 'audio-cutter' && sourceIds.length !== 1) ||
    (purpose === 'preview' && tool !== 'audio-cutter')
  )
    throw new ServiceError(400, 'INVALID_SOURCES');
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [existing] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.owner, owner), eq(jobs.requestId, requestId)));
    if (existing) {
      if (
        existing.assetId !== assetId ||
        existing.tool !== tool ||
        existing.purpose !== purpose ||
        ordered(existing.sourceIds) !== ordered(sourceIds) ||
        ordered(existing.options) !== ordered(parsed.options)
      )
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const inputs = await checkedAssets(tx, owner, sourceIds, tool);
    const totalSize = inputs.reduce((n, a) => n + a.size, 0);
    if (isTranslationTool(tool) && !translationEnabled())
      throw new ServiceError(503, 'AI_NOT_CONFIGURED');
    if (
      (isWatermarkTool(tool) || (isTranslationTool(tool) && tool !== 'video-translator')) &&
      totalSize > 50 * 1024 ** 2
    )
      throw new ServiceError(413, 'FILE_TOO_LARGE');
    if (tool === 'transcription' || tool === 'video-translator') {
      if (!transcriptEnabled()) throw new ServiceError(503, 'AI_NOT_CONFIGURED');
      const opts =
        tool === 'video-translator'
          ? translationOptionsSchema.parse(parsed.options)
          : transcriptionSchema.parse(parsed.options);
      const [prep] = await tx
        .select()
        .from(preparations)
        .where(
          and(
            eq(preparations.assetId, assetId),
            eq(preparations.owner, owner),
            eq(preparations.profile, 'audio'),
            eq(preparations.state, 'completed'),
            gt(preparations.expiresAt, new Date()),
          ),
        );
      if (!prep?.media) throw new ServiceError(409, 'NOT_READY');
      if (prep.media.duration * 1000 > maxTranscriptDurationMs)
        throw new ServiceError(400, 'TRANSCRIPTION_LIMIT');
      if (!prep.media.tracks.some((t) => t.index === opts.streamIndex))
        throw new ServiceError(400, 'AUDIO_TRACK_NOT_FOUND');
    }
    if (isEditorTool(tool)) {
      if (totalSize > 1024 ** 3) throw new ServiceError(413, 'EDIT_LIMIT');
      const prepared = await tx
        .select()
        .from(preparations)
        .where(
          and(
            inArray(preparations.assetId, sourceIds),
            eq(preparations.owner, owner),
            eq(preparations.state, 'completed'),
            gt(preparations.expiresAt, new Date()),
          ),
        );
      const sources = sourceIds.map((id) => ({
        id,
        media: prepared.find((p) => p.assetId === id)?.media!,
      }));
      if (sources.some((s) => !s.media)) throw new ServiceError(409, 'NOT_READY');
      const error = editValidation(tool, parsed.options as EditOptions, sources);
      if (error) throw new ServiceError(400, error);
    }
    await capacity(tx, owner, 1);
    const [job] = await tx
      .insert(jobs)
      .values({
        id: randomUUID(),
        owner,
        assetId,
        requestId,
        tool,
        options: parsed.options,
        sourceIds,
        purpose,
        inputSize: totalSize,
        expiresAt: new Date(Math.min(...inputs.map((a) => a.expiresAt.getTime()))),
      })
      .returning();
    await admitBilling(tx, owner, 'job', job.id, 1);
    await tx.insert(jobInputs).values(sourceIds.map((id) => ({ jobId: job.id, assetId: id })));
    await tx.insert(outbox).values({ jobId: job.id, attempt: 1 });
    return job;
  });
}
export async function createBatch(
  owner: string,
  assetIds: string[],
  requestId: string,
  tool: BatchTool,
  options: ToolOptions,
) {
  batchToolSchema.parse(tool);
  if (!assetIds.length || assetIds.length > 20 || new Set(assetIds).size !== assetIds.length)
    throw new ServiceError(400, 'INVALID_BATCH');
  await assertOwnerNotBlocked(owner);
  await assertToolPublished(tool);
  const parsed = jobSpecSchema.parse({ tool, options });
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [existing] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.owner, owner), eq(batches.requestId, requestId)));
    if (existing) {
      if (
        existing.tool !== tool ||
        ordered(existing.assetIds) !== ordered(assetIds) ||
        ordered(existing.options) !== ordered(parsed.options)
      )
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const inputs = await checkedAssets(tx, owner, assetIds, tool);
    await capacity(tx, owner, assetIds.length);
    const expiresAt = new Date(Math.min(...inputs.map((a) => a.expiresAt.getTime())));
    const [batch] = await tx
      .insert(batches)
      .values({
        id: randomUUID(),
        owner,
        requestId,
        tool,
        assetIds,
        options: parsed.options,
        expiresAt,
      })
      .returning();
    for (const assetId of assetIds) {
      const id = randomUUID();
      await tx.insert(jobs).values({
        id,
        owner,
        requestId: randomUUID(),
        assetId,
        tool,
        options: parsed.options,
        batchId: batch.id,
        sourceIds: [assetId],
        expiresAt,
      });
      await admitBilling(tx, owner, 'job', id, 1);
      await tx.insert(jobInputs).values({ jobId: id, assetId });
      await tx.insert(outbox).values({ jobId: id, attempt: 1 });
    }
    return batch;
  });
}
export async function jobForOwner(id: string, owner: string) {
  const [row] = await db()
    .select({ job: jobs, asset: assets })
    .from(jobs)
    .innerJoin(assets, eq(jobs.assetId, assets.id))
    .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)));
  if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND');
  return row;
}
export function jobView({
  job,
  asset,
}: {
  job: typeof jobs.$inferSelect;
  asset: typeof assets.$inferSelect;
}): JobView {
  return {
    id: job.id,
    name: asset.name,
    tool: job.tool,
    batchId: job.batchId,
    state: job.expiresAt <= new Date() ? 'expired' : job.state,
    progress: job.progress,
    options: job.options,
    media: job.media,
    inputSize: job.inputSize ?? asset.size,
    purpose: job.purpose,
    sourceIds: job.sourceIds,
    inputMedia: job.inputMedia,
    outputMedia: job.outputMedia,
    outputSize: job.outputSize,
    outputName: job.outputName,
    outputMime: job.outputMime,
    note: job.note,
    error: job.error,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    expiresAt: job.expiresAt.toISOString(),
  } as JobView;
}
export async function listJobs(owner: string, requestedPage = 1) {
  const filter = and(eq(jobs.owner, owner), eq(jobs.deleting, false), eq(jobs.purpose, 'export'));
  const [{ total }] = await db()
    .select({ total: sql<number>`count(*)::integer` })
    .from(jobs)
    .innerJoin(assets, eq(jobs.assetId, assets.id))
    .where(filter);
  const page = pagination(total, requestedPage);
  const rows = await db()
    .select({ job: jobs, asset: assets })
    .from(jobs)
    .innerJoin(assets, eq(jobs.assetId, assets.id))
    .where(filter)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize);
  return { jobs: rows.map(jobView), pagination: page };
}
export async function batchForOwner(id: string, owner: string): Promise<BatchView> {
  const [batch] = await db()
    .select()
    .from(batches)
    .where(and(eq(batches.id, id), eq(batches.owner, owner)));
  if (!batch) throw new ServiceError(404, 'BATCH_NOT_FOUND');
  const rows = await db()
    .select({ job: jobs, asset: assets })
    .from(jobs)
    .innerJoin(assets, eq(jobs.assetId, assets.id))
    .where(and(eq(jobs.batchId, id), eq(jobs.deleting, false)))
    .orderBy(jobs.createdAt, jobs.id);
  const [archive] = await db()
    .select()
    .from(archives)
    .where(
      and(
        eq(archives.batchId, id),
        sql`${archives.state}<>'expired'`,
        gt(archives.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(archives.createdAt))
    .limit(1);
  return {
    id,
    tool: batch.tool,
    jobs: rows.map(jobView),
    expiresAt: batch.expiresAt.toISOString(),
    archive: archive
      ? {
          id: archive.id,
          state: archive.state,
          count: archive.members.length,
          error: archive.error,
        }
      : null,
  };
}
async function updateJobs(
  tx: Tx,
  owner: string,
  selected: (typeof jobs.$inferSelect)[],
  action: 'cancel' | 'retry' | 'delete',
) {
  if (action === 'retry') {
    if (selected.some((j) => !['failed', 'cancelled'].includes(j.state)))
      throw new ServiceError(409, 'JOB_NOT_RETRYABLE');
    if (selected.some((j) => j.expiresAt <= new Date())) throw new ServiceError(410, 'EXPIRED');
    for (const job of selected) await checkedAssets(tx, owner, job.sourceIds, job.tool);
    await capacity(tx, owner, selected.length);
  }
  const batchIds = [...new Set(selected.map((j) => j.batchId).filter((id): id is string => !!id))];
  if (batchIds.length)
    await tx.update(archives).set({ state: 'expired' }).where(inArray(archives.batchId, batchIds));
  for (const job of selected) {
    if (action === 'retry') {
      await admitBilling(tx, owner, 'job', job.id, job.attempt + 1);
      if (isTranslationTool(job.tool)) {
        if (!translationEnabled()) throw new ServiceError(503, 'AI_NOT_CONFIGURED');
        await tx
          .update(translationSteps)
          .set({ state: 'pending', error: null })
          .where(
            and(
              eq(translationSteps.jobId, job.id),
              sql`${translationSteps.state}<>'completed'`,
              sql`not starts_with(${translationSteps.stepKey},'reading:')`,
            ),
          );
      }
      if (job.tool === 'transcription' || job.tool === 'video-translator') {
        if (!transcriptEnabled()) throw new ServiceError(503, 'AI_NOT_CONFIGURED');
        await tx
          .update(transcriptionChunks)
          .set({
            state: 'pending',
            claim: null,
            providerTaskId: sql`case when ${transcriptionChunks.error} in ('AI_TASK_FAILED','AI_TASK_EXPIRED') then null else ${transcriptionChunks.providerTaskId} end`,
            error: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transcriptionChunks.jobId, job.id),
              sql`${transcriptionChunks.state}<>'completed'`,
            ),
          );
      }
      await tx
        .update(jobs)
        .set({
          state: 'queued',
          progress: 0,
          attempt: job.attempt + 1,
          error: null,
          errorDetail: null,
          outputKey: null,
          outputSize: null,
          outputName: null,
          outputMime: null,
          inputPreview: null,
          outputPreview: null,
          note: null,
          outputMedia: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      await tx
        .insert(outbox)
        .values({ jobId: job.id, attempt: job.attempt + 1 })
        .onConflictDoUpdate({
          target: outbox.jobId,
          set: { attempt: job.attempt + 1, dispatchedAt: null },
        });
    } else {
      const state =
        job.state === 'processing'
          ? 'cancelling'
          : job.state === 'queued'
            ? 'cancelled'
            : job.state;
      await tx
        .update(jobs)
        .set({ state, ...(action === 'delete' ? { deleting: true } : {}), updatedAt: new Date() })
        .where(eq(jobs.id, job.id));
    }
  }
}
export async function changeJob(id: string, owner: string, action: 'cancel' | 'retry' | 'delete') {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND');
    await updateJobs(tx, owner, [job], action);
  });
}
export async function changeBatch(
  id: string,
  owner: string,
  action: 'cancel' | 'retry' | 'delete',
) {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [batch] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.id, id), eq(batches.owner, owner)));
    if (!batch) throw new ServiceError(404, 'BATCH_NOT_FOUND');
    const rows = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, id), eq(jobs.deleting, false)))
      .for('update');
    const selected = rows.filter((j) =>
      action === 'retry'
        ? ['failed', 'cancelled'].includes(j.state)
        : action === 'cancel'
          ? !terminalStates.includes(j.state)
          : true,
    );
    await updateJobs(tx, owner, selected, action);
  });
}
export async function createArchive(id: string, owner: string) {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [batch] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.id, id), eq(batches.owner, owner)));
    if (!batch) throw new ServiceError(404, 'BATCH_NOT_FOUND');
    if (batch.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    const rows = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, id), eq(jobs.deleting, false)))
      .orderBy(jobs.id);
    if (rows.some((j) => !terminalStates.includes(j.state)))
      throw new ServiceError(409, 'NOT_READY');
    const members = rows
      .filter((j) => j.state === 'completed' && j.outputKey)
      .map((j) => ({ id: j.id, attempt: j.attempt, key: j.outputKey!, name: j.outputName! }));
    if (!members.length) throw new ServiceError(409, 'NO_RESULTS');
    const version = createHash('sha256').update(JSON.stringify(members)).digest('hex');
    const [existing] = await tx
      .select()
      .from(archives)
      .where(
        and(
          eq(archives.batchId, id),
          eq(archives.version, version),
          inArray(archives.state, ['queued', 'processing', 'completed']),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const archiveId = randomUUID();
    await admitBilling(tx, owner, 'archive', archiveId, 1);
    const [archive] = await tx
      .insert(archives)
      .values({
        id: archiveId,
        batchId: id,
        version,
        members,
        key: `archives/${archiveId}/results.zip`,
        expiresAt: batch.expiresAt,
      })
      .returning();
    return archive;
  });
}
export async function archiveForOwner(id: string, owner: string) {
  const [row] = await db()
    .select({ archive: archives, batch: batches })
    .from(archives)
    .innerJoin(batches, eq(archives.batchId, batches.id))
    .where(and(eq(archives.id, id), eq(batches.owner, owner)));
  if (!row) throw new ServiceError(404, 'BATCH_NOT_FOUND');
  if (row.archive.state === 'expired' || row.archive.expiresAt <= new Date())
    throw new ServiceError(410, 'EXPIRED');
  return row.archive;
}
