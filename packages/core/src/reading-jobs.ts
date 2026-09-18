import { admitBilling } from './billing';
import { createHash, randomUUID } from 'node:crypto';
import { db, eq, and, inArray, sql, desc } from './db';
import {
  jobs,
  transcripts,
  translationDocuments,
  translationActivities,
  translationSteps,
} from './schema';
import { transcriptReadingData } from './transcript-reading';
import { jobForOwner, lockOwner, ServiceError } from './jobs';
import {
  isTranslationTool,
  translationEnabled,
  translationRenderVersion,
  type TranslationData,
} from './translation';
import {
  readingBlocks,
  readingResultVersion,
  type ReadingOptions,
  readingOptionsSchema,
  validateReadingResult,
  type ReadingActivity,
  type ReadingResult,
} from './reading';
import { downloadUrl } from './storage';

export function contentHash(data: TranslationData) {
  return createHash('sha256')
    .update(JSON.stringify(readingBlocks(data)))
    .digest('hex');
}
function view(a: typeof translationActivities.$inferSelect): ReadingActivity {
  const result = a.result && 'sections' in a.result ? a.result : null;
  const cited = new Set(
    result
      ? [
          ...result.nodes.flatMap((n) => n.citations),
          ...result.sections.flatMap((s) => [
            ...s.citations,
            ...(s.blocks || []).flatMap((b) =>
              b.type === 'paragraph'
                ? b.citations
                : b.type === 'list'
                  ? b.items.flatMap((i) => i.citations)
                  : b.rows.flatMap((r) => r.citations),
            ),
          ]),
        ].map((c) => c.blockId)
      : [],
  );
  const citationTimes = Object.fromEntries(
    a.snapshot.blocks
      .filter((b) => cited.has(b.id) && b.startMs !== undefined)
      .map((b) => [b.id, b.startMs!]),
  );
  return {
    citationTimes,
    id: a.id,
    kind: a.kind,
    revision: a.revision,
    contentHash: a.contentHash,
    options: a.options,
    state: a.state,
    error: a.error,
    result: a.result,
    formats: Object.keys(a.files),
    completedUnits: a.completedUnits,
    totalUnits: a.totalUnits,
    waitingUntil: a.waitingUntil?.toISOString() || null,
    createdAt: a.createdAt.toISOString(),
  };
}
async function owned(id: string, owner: string) {
  const { job } = await jobForOwner(id, owner);
  if (!isTranslationTool(job.tool) && job.tool !== 'transcription')
    throw new ServiceError(400, 'INVALID_REQUEST');
  if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
  return job;
}
export async function listReading(id: string, owner: string) {
  const job = await owned(id, owner);
  const table = job.tool === 'transcription' ? transcripts : translationDocuments;
  const [doc] = await db().select().from(table).where(eq(table.jobId, id));
  const [analysis, previews] = await Promise.all([
    db()
      .select()
      .from(translationActivities)
      .where(
        and(eq(translationActivities.jobId, id), sql`${translationActivities.kind}<>'preview'`),
      )
      .orderBy(desc(translationActivities.createdAt))
      .limit(150),
    db()
      .select()
      .from(translationActivities)
      .where(and(eq(translationActivities.jobId, id), eq(translationActivities.kind, 'preview')))
      .orderBy(desc(translationActivities.createdAt))
      .limit(50),
  ]);
  const rows = [...analysis, ...previews].sort((a, b) => +b.createdAt - +a.createdAt);
  const data =
    doc?.data &&
    (job.tool === 'transcription'
      ? transcriptReadingData(
          doc.data as typeof transcripts.$inferSelect.data,
          'language' in job.options ? job.options.language : 'auto',
        )
      : (doc.data as TranslationData));
  return { contentHash: data ? contentHash(data) : '', activities: rows.map(view) };
}
export async function createReading(id: string, owner: string, body: unknown) {
  const options: ReadingOptions = {
    ...readingOptionsSchema.parse(body),
    resultVersion: readingResultVersion,
  };
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const job = await owned(id, owner);
    if (job.tool === 'transcription' && options.kind === 'preview')
      throw new ServiceError(400, 'INVALID_REQUEST');
    const previous = await tx
      .select()
      .from(translationActivities)
      .where(eq(translationActivities.jobId, id))
      .orderBy(desc(translationActivities.createdAt));
    // Request IDs identify the whole attempt, even if the file was edited before an HTTP retry.
    if (options.requestId) {
      const sameRequest = previous.find((a) => a.options.requestId === options.requestId);
      if (sameRequest) return view(sameRequest);
    }
    const activityId = randomUUID();
    if (options.kind === 'chat') {
      options.turnId = activityId;
      if (options.regenerateOf) {
        const target = previous.find((a) => a.id === options.regenerateOf && a.kind === 'chat');
        const last = previous.find((a) => a.kind === 'chat');
        if (
          !target ||
          !last ||
          (target.options.turnId || target.id) !== (last.options.turnId || last.id)
        )
          throw new ServiceError(400, 'INVALID_REQUEST');
        options.turnId = target.options.turnId || target.id;
        options.question = target.options.question;
      }
    }
    const table = job.tool === 'transcription' ? transcripts : translationDocuments;
    const [doc] = await tx.select().from(table).where(eq(table.jobId, id)).for('update');
    if (!doc?.data || doc.revision !== options.revision)
      throw new ServiceError(
        409,
        job.tool === 'transcription' ? 'TRANSCRIPT_CONFLICT' : 'TRANSLATION_CONFLICT',
      );
    const data =
      job.tool === 'transcription'
        ? transcriptReadingData(
            doc.data as typeof transcripts.$inferSelect.data,
            'language' in job.options ? job.options.language : 'auto',
          )
        : (doc.data as TranslationData);
    if (job.tool === 'transcription' && job.state !== 'completed')
      throw new ServiceError(409, 'READING_NOT_READY');
    if (
      options.optimizeLayout &&
      (data.format !== 'pdf' || !['completed', 'failed', 'cancelled'].includes(job.state))
    )
      throw new ServiceError(409, 'READING_NOT_READY');
    if (options.kind === 'preview' && (data.layoutVersion || 0) >= 3 && data.format === 'pdf')
      options.page = 0;
    if (options.kind !== 'preview' && !['completed', 'failed', 'cancelled'].includes(job.state))
      throw new ServiceError(409, 'READING_NOT_READY');
    if (options.kind !== 'preview' && (!translationEnabled() || !readingBlocks(data).length))
      throw new ServiceError(503, 'AI_NOT_CONFIGURED');
    if (
      options.kind === 'preview' &&
      (!data.pages[options.page] ||
        !['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'svg'].includes(data.format))
    )
      throw new ServiceError(400, 'INVALID_REQUEST');
    const hash =
      options.kind === 'preview'
        ? createHash('sha256')
            .update(
              JSON.stringify({
                format: data.format,
                rendererVersion: translationRenderVersion,
                layoutVersion: data.layoutVersion,
                optimizeLayout: !!options.optimizeLayout,
                page:
                  data.format === 'docx' ||
                  (data.format === 'pdf' &&
                    ((data.layoutVersion || 0) >= 3 || options.optimizeLayout))
                    ? data.pages
                    : data.pages[options.page],
                blocks:
                  data.format === 'docx' ||
                  (data.format === 'pdf' &&
                    ((data.layoutVersion || 0) >= 3 || options.optimizeLayout))
                    ? data.blocks
                    : data.blocks.filter((b) => b.page === options.page),
              }),
            )
            .digest('hex')
        : contentHash(data);
    const matching = previous.filter(
      (a) =>
        a.kind === options.kind &&
        a.contentHash === hash &&
        a.options.language === options.language &&
        (options.kind !== 'summary' || a.options.detail === options.detail) &&
        a.options.page === options.page &&
        (options.kind !== 'summary' ||
          ((a.options.template || 'notes') === options.template &&
            a.options.resultVersion === readingResultVersion)),
    );
    if (options.kind !== 'chat' && !options.regenerate) {
      const existing =
        matching.find((a) => ['queued', 'processing', 'cancelling'].includes(a.state)) ||
        matching.find((a) => a.state === 'completed') ||
        matching[0];
      if (existing) return view(existing);
    }
    if (options.kind === 'preview') {
      await tx
        .update(translationActivities)
        .set({ state: 'cancelled' })
        .where(
          and(
            eq(translationActivities.jobId, id),
            eq(translationActivities.kind, 'preview'),
            eq(translationActivities.state, 'queued'),
            sql`${translationActivities.options}->>'page'=${String(options.page)}`,
          ),
        );
    }
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(translationActivities)
      .innerJoin(jobs, eq(jobs.id, translationActivities.jobId))
      .where(
        and(
          eq(jobs.owner, owner),
          inArray(translationActivities.state, ['queued', 'processing', 'cancelling']),
        ),
      );
    if (count >= 20) throw new ServiceError(429, 'QUEUE_FULL');
    if (options.kind === 'chat' && previous.filter((a) => a.kind === 'chat').length >= 100)
      throw new ServiceError(429, 'READING_LIMIT');
    const seenTurns = new Set<string>(options.turnId ? [options.turnId] : []);
    const history =
      options.kind === 'chat'
        ? previous
            .filter((a) => {
              if (a.kind !== 'chat' || a.state !== 'completed' || a.contentHash !== hash)
                return false;
              const turn = a.options.turnId || a.id;
              if (seenTurns.has(turn)) return false;
              seenTurns.add(turn);
              return true;
            })
            .slice(0, 6)
            .reverse()
            .map((a) => ({ question: a.options.question, answer: a.result as ReadingResult }))
        : [];
    const [a] = await tx
      .insert(translationActivities)
      .values({
        id: activityId,
        jobId: id,
        kind: options.kind,
        revision: doc.revision,
        contentHash: hash,
        options,
        snapshot: data,
        history,
        expiresAt: job.expiresAt,
      })
      .returning();
    if (!options.optimizeLayout) await admitBilling(tx, owner, 'reading', a.id, 1);
    return view(a);
  });
}
export async function readingForOwner(id: string, owner: string) {
  const [row] = await db()
    .select({ a: translationActivities, j: jobs })
    .from(translationActivities)
    .innerJoin(jobs, eq(jobs.id, translationActivities.jobId))
    .where(and(eq(translationActivities.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)));
  if (!row) throw new ServiceError(404, 'NOT_FOUND');
  if (row.j.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
  return row.a;
}
export async function readingDownload(id: string, owner: string, format: string) {
  const a = await readingForOwner(id, owner),
    file = a.files[format];
  if (a.state !== 'completed' || !file) throw new ServiceError(409, 'NOT_READY');
  return {
    url: await downloadUrl(
      file.key,
      file.name,
      format === 'preview',
      file.mime,
      (a.expiresAt.getTime() - Date.now()) / 1000,
    ),
  };
}
export async function changeReading(id: string, owner: string, action: 'retry' | 'cancel') {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const a = await readingForOwner(id, owner);
    if (action === 'retry') {
      if (!a.options.optimizeLayout) await admitBilling(tx, owner, 'reading', id, a.attempt + 1);
      if (!['failed', 'cancelled'].includes(a.state))
        throw new ServiceError(409, 'JOB_NOT_RETRYABLE');
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(translationActivities)
        .innerJoin(jobs, eq(jobs.id, translationActivities.jobId))
        .where(
          and(
            eq(jobs.owner, owner),
            inArray(translationActivities.state, ['queued', 'processing', 'cancelling']),
          ),
        );
      if (count >= 20) throw new ServiceError(429, 'QUEUE_FULL');
      // Keep confirmed results, reset only unconfirmed calls after explicit user retry.
      const steps = await tx
        .select()
        .from(translationSteps)
        .where(
          and(
            eq(translationSteps.jobId, a.jobId),
            sql`starts_with(${translationSteps.stepKey},${`reading:${a.id}:`})`,
            eq(translationSteps.error, 'AI_INVALID_RESPONSE'),
          ),
        );
      for (const step of steps) {
        if (!step.result) continue;
        try {
          const result = validateReadingResult(step.result, a.snapshot, a.kind);
          await tx
            .update(translationSteps)
            .set({ state: 'completed', result, error: null })
            .where(
              and(eq(translationSteps.jobId, a.jobId), eq(translationSteps.stepKey, step.stepKey)),
            );
        } catch {}
      }
      await tx
        .delete(translationSteps)
        .where(
          and(
            eq(translationSteps.jobId, a.jobId),
            sql`starts_with(${translationSteps.stepKey},${`reading:${a.id}:`})`,
            sql`${translationSteps.state}<>'completed'`,
          ),
        );
      await tx
        .update(translationActivities)
        .set({
          state: 'queued',
          attempt: a.attempt + 1,
          error: null,
          dispatchedAt: null,
          waitingUntil: null,
        })
        .where(and(eq(translationActivities.id, id), eq(translationActivities.attempt, a.attempt)));
    } else
      await tx
        .update(translationActivities)
        .set({ state: a.state === 'processing' ? 'cancelling' : 'cancelled' })
        .where(
          and(
            eq(translationActivities.id, id),
            inArray(translationActivities.state, ['queued', 'processing']),
          ),
        );
    return { id };
  });
}
