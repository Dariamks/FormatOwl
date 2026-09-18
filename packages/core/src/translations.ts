import { admitBilling } from './billing';
import { randomUUID } from 'node:crypto';
import { db, eq, and, inArray, sql, desc } from './db';
import {
  jobs,
  translationDocuments,
  translationSteps,
  translationExports,
  outbox,
  workerCapabilities,
} from './schema';
import { ServiceError, jobForOwner, lockOwner, capacity } from './jobs';
import { downloadUrl } from './storage';
import {
  isTranslationTool,
  translationEnabled,
  translationPatchSchema,
  translationRetrySchema,
  translationExportSchema,
  translationFormats,
  translationLimits,
  translationRenderVersion,
  type TranslationData,
  type TranslationView,
} from './translation';

async function checkedJob(id: string, owner: string) {
  const { job } = await jobForOwner(id, owner);
  if (!isTranslationTool(job.tool)) throw new ServiceError(400, 'INVALID_REQUEST');
  if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
  return job;
}
export async function translationCapabilities() {
  const [row] = await db()
    .select()
    .from(workerCapabilities)
    .where(eq(workerCapabilities.id, 'translation'));
  const runtime = row && Date.now() - row.updatedAt.getTime() < 90000 ? row.data : {};
  return {
    translation: translationEnabled(),
    aiReading: translationEnabled(),
    ocr: translationEnabled(),
    imageRepair: translationEnabled(),
    subtitleBurn: !!runtime.subtitleBurn,
    documentRendering: !!runtime.documentRendering,
    complexText: !!runtime.complexText,
    workerReady: !!row && Date.now() - row.updatedAt.getTime() < 90000,
  };
}
export async function readTranslation(id: string, owner: string): Promise<TranslationView> {
  await checkedJob(id, owner);
  const [doc] = await db()
    .select()
    .from(translationDocuments)
    .where(eq(translationDocuments.jobId, id));
  if (!doc) return { revision: 0, stage: 'queued', completedUnits: 0, totalUnits: 0, data: null };
  const data = doc.data && {
    ...doc.data,
    pages: doc.data.pages.map(({ originalFile, backgroundFile, previewFile, ...p }) => p),
    blocks: doc.data.blocks.map(({ locator, ...b }) => b),
  };
  return {
    revision: doc.revision,
    stage: doc.stage,
    completedUnits: doc.completedUnits,
    totalUnits: doc.totalUnits,
    waitingUntil: doc.waitingUntil?.toISOString() || null,
    data,
  };
}
function checkData(data: TranslationData) {
  if (
    data.blocks.length > translationLimits.maxBlocks ||
    data.blocks.reduce((n, b) => n + b.sourceText.length, 0) > translationLimits.maxCharacters ||
    data.blocks.reduce((n, b) => n + b.translatedText.length, 0) > 500000
  )
    throw new ServiceError(400, 'TRANSLATION_LIMIT');
  for (const b of data.blocks) {
    const page = data.pages[b.page];
    if (!page) throw new ServiceError(400, 'INVALID_REQUEST');
    if (
      b.box &&
      (b.box.x + b.box.width > page.width + 0.1 || b.box.y + b.box.height > page.height + 0.1)
    )
      throw new ServiceError(400, 'INVALID_REGION');
    if (
      b.kind === 'subtitle' &&
      (b.startMs === undefined ||
        b.endMs === undefined ||
        b.endMs <= b.startMs ||
        b.endMs > (data.durationMs || 0))
    )
      throw new ServiceError(400, 'INVALID_TRANSCRIPT');
  }
}
export async function patchTranslation(id: string, owner: string, body: unknown) {
  const patch = translationPatchSchema.parse(body);
  return db().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || !isTranslationTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    if (!['completed', 'failed', 'cancelled'].includes(job.state))
      throw new ServiceError(409, 'NOT_READY');
    const [doc] = await tx
      .select()
      .from(translationDocuments)
      .where(eq(translationDocuments.jobId, id))
      .for('update');
    if (!doc?.data || doc.revision !== patch.revision)
      throw new ServiceError(409, 'TRANSLATION_CONFLICT');
    const data = structuredClone(doc.data);
    if (
      new Set(patch.upsert.map((b) => b.id)).size !== patch.upsert.length ||
      patch.remove.some((id) => patch.upsert.some((b) => b.id === id))
    )
      throw new ServiceError(400, 'INVALID_REQUEST');
    for (const change of patch.upsert) {
      const b = data.blocks.find((b) => b.id === change.id && !b.hidden);
      if (!b) throw new ServiceError(404, 'BLOCK_NOT_FOUND');
      if (change.box && !b.box) throw new ServiceError(400, 'INVALID_REGION');
      if (change.box && data.format === 'pdf' && (data.layoutVersion || 0) >= 3)
        throw new ServiceError(400, 'INVALID_REGION');
      if ((change.startMs !== undefined || change.endMs !== undefined) && b.kind !== 'subtitle')
        throw new ServiceError(400, 'INVALID_REQUEST');
      const { reviewed, ...values } = change;
      if (change.sourceText !== undefined && change.sourceText !== b.sourceText) {
        b.stale = true;
        // Edited prose no longer matches the extracted slots. Do not translate
        // stale fragments or invent a character-length mapping back into them.
        if (b.inline?.length) {
          delete b.inline;
          delete b.translatedInline;
          if (!b.review.includes('INLINE_REVIEW')) b.review.push('INLINE_REVIEW');
        }
      }
      if (change.translatedText !== undefined && change.translatedText !== b.translatedText) {
        delete b.translatedInline;
        b.stale = false;
        b.review = b.review.filter((r) => r !== 'TRANSLATION_FAILED');
      }
      Object.assign(b, values);
      if (change.box || change.style) b.layoutEdited = true;
      if (reviewed) b.review = [];
    }
    if ((patch.add.length || patch.remove.length) && job.tool !== 'image-translator')
      throw new ServiceError(400, 'INVALID_REQUEST');
    for (const id of patch.remove) {
      const b = data.blocks.find((b) => b.id === id);
      if (!b) throw new ServiceError(404, 'BLOCK_NOT_FOUND');
      b.hidden = true;
      b.keepOriginal = true;
    }
    for (const added of patch.add)
      data.blocks.push({
        id: randomUUID(),
        ...added,
        originalBox: added.box,
        translatedText: '',
        kind: 'text',
        style: {
          fontSize: Math.max(8, Math.min(64, added.box.height * 0.7)),
          color: '#111111',
          align: 'left',
        },
        review: ['BACKGROUND_REVIEW'],
        stale: true,
        keepOriginal: false,
      });
    checkData(data);
    await tx
      .update(translationDocuments)
      .set({ data, revision: doc.revision + 1, updatedAt: new Date() })
      .where(eq(translationDocuments.jobId, id));
    return { revision: doc.revision + 1 };
  });
}
export async function retryTranslationBlocks(id: string, owner: string, body: unknown) {
  const input = translationRetrySchema.parse(body);
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || !isTranslationTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    if (!['completed', 'failed', 'cancelled'].includes(job.state))
      throw new ServiceError(409, 'NOT_READY');
    const [doc] = await tx
      .select()
      .from(translationDocuments)
      .where(eq(translationDocuments.jobId, id))
      .for('update');
    if (!doc?.data || doc.revision !== input.revision)
      throw new ServiceError(409, 'TRANSLATION_CONFLICT');
    if (input.blockIds.some((id) => !doc.data!.blocks.some((b) => b.id === id && !b.hidden)))
      throw new ServiceError(404, 'BLOCK_NOT_FOUND');
    if (input.operation === 'repair' && job.tool === 'video-translator')
      throw new ServiceError(400, 'INVALID_REQUEST');
    if (
      input.operation === 'repair' &&
      doc.data.format === 'pdf' &&
      (doc.data.layoutVersion || 0) >= 3
    )
      throw new ServiceError(400, 'INVALID_REQUEST');
    if (!translationEnabled()) throw new ServiceError(503, 'AI_NOT_CONFIGURED');
    await capacity(tx, owner, 1);
    await admitBilling(tx, owner, 'job', id, job.attempt + 1);
    // Explicit retries alone reset uncertain requests. Completed unrelated steps remain intact.
    for (const block of input.blockIds)
      await tx
        .delete(translationSteps)
        .where(
          and(
            eq(translationSteps.jobId, id),
            sql`starts_with(${translationSteps.stepKey}, ${`${input.operation}:${block}:`})`,
          ),
        );
    await tx
      .update(translationDocuments)
      .set({
        operation: { operation: input.operation, blockIds: input.blockIds },
        stage: input.operation,
        revision: doc.revision + 1,
      })
      .where(eq(translationDocuments.jobId, id));
    await tx
      .update(jobs)
      .set({
        state: 'queued',
        attempt: job.attempt + 1,
        progress: 0,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));
    await tx
      .insert(outbox)
      .values({ jobId: id, attempt: job.attempt + 1 })
      .onConflictDoUpdate({
        target: outbox.jobId,
        set: { attempt: job.attempt + 1, dispatchedAt: null },
      });
    return { id };
  });
}
export async function translationMedia(id: string, owner: string, page: number, kind: string) {
  const job = await checkedJob(id, owner);
  const [doc] = await db()
    .select()
    .from(translationDocuments)
    .where(eq(translationDocuments.jobId, id));
  const p = doc?.data?.pages[page];
  const file =
    kind === 'preview'
      ? p?.previewFile
      : kind === 'background'
        ? p?.backgroundFile
        : p?.originalFile;
  if (!file || !/^[a-zA-Z0-9._/-]+$/.test(file) || file.includes('..'))
    throw new ServiceError(409, 'NOT_READY');
  return {
    url: await downloadUrl(
      `translations/${id}/files/${file}`,
      kind === 'preview' ? 'preview.pdf' : 'page.png',
      true,
      kind === 'preview' ? 'application/pdf' : 'image/png',
      (job.expiresAt.getTime() - Date.now()) / 1000,
    ),
  };
}
function exportView(e: typeof translationExports.$inferSelect) {
  return {
    id: e.id,
    revision: e.revision,
    options: e.options,
    state: e.state,
    error: e.error,
    name: e.name,
  };
}
export async function listTranslationExports(id: string, owner: string) {
  await checkedJob(id, owner);
  return (
    await db()
      .select()
      .from(translationExports)
      .where(eq(translationExports.jobId, id))
      .orderBy(desc(translationExports.revision))
  ).map(exportView);
}
export async function createTranslationExport(id: string, owner: string, body: unknown) {
  const options = {
    ...translationExportSchema.parse(body),
    rendererVersion: translationRenderVersion,
  };
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || !isTranslationTool(job.tool)) throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    if (job.state !== 'completed') throw new ServiceError(409, 'NOT_READY');
    const [doc] = await tx
      .select()
      .from(translationDocuments)
      .where(eq(translationDocuments.jobId, id));
    if (!doc?.data || doc.revision !== options.revision)
      throw new ServiceError(409, 'TRANSLATION_CONFLICT');
    if (!translationFormats(job.tool, doc.data.format).includes(options.format))
      throw new ServiceError(400, 'UNSUPPORTED_FORMAT');
    if (job.tool === 'image-translator' && options.mode === 'bilingual')
      throw new ServiceError(400, 'INVALID_REQUEST');
    if (options.preview && (job.tool !== 'video-translator' || options.format !== 'mp4'))
      throw new ServiceError(400, 'INVALID_REQUEST');
    if (options.preview && options.previewStartMs >= (doc.data.durationMs || 0))
      throw new ServiceError(400, 'INVALID_REQUEST');
    if (
      options.mode !== 'original' &&
      doc.data.blocks.some(
        (b) => !b.hidden && !b.keepOriginal && (b.stale || !b.translatedText.trim()),
      )
    )
      throw new ServiceError(409, 'TRANSLATION_NEEDS_REVIEW');
    if (options.format === 'mp4' && !(await translationCapabilities()).subtitleBurn)
      throw new ServiceError(503, 'SUBTITLE_UNAVAILABLE');
    const [existing] = await tx
      .select()
      .from(translationExports)
      .where(
        and(
          eq(translationExports.jobId, id),
          eq(translationExports.revision, options.revision),
          sql`${translationExports.options}=${JSON.stringify(options)}::jsonb`,
        ),
      );
    if (existing) return exportView(existing);
    await capacity(tx, owner, 1);
    const [result] = await tx
      .insert(translationExports)
      .values({
        id: randomUUID(),
        jobId: id,
        revision: doc.revision,
        options,
        snapshot: doc.data,
        expiresAt: job.expiresAt,
      })
      .returning();
    await admitBilling(tx, owner, 'translation-export', result.id, 1);
    return exportView(result);
  });
}
export async function translationExportForOwner(id: string, owner: string) {
  const [row] = await db()
    .select({ e: translationExports, j: jobs })
    .from(translationExports)
    .innerJoin(jobs, eq(jobs.id, translationExports.jobId))
    .where(and(eq(translationExports.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)));
  if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND');
  if (row.j.expiresAt <= new Date() || row.e.expiresAt <= new Date())
    throw new ServiceError(410, 'EXPIRED');
  return row.e;
}
export async function translationDownload(id: string, owner: string, inline = false) {
  const e = await translationExportForOwner(id, owner);
  if (e.state !== 'completed' || !e.key || !e.name || !e.mime)
    throw new ServiceError(409, 'NOT_READY');
  return {
    url: await downloadUrl(
      inline && e.options.format === 'docx'
        ? `translations/${e.jobId}/exports/${e.id}/${e.attempt}-preview.pdf`
        : e.key,
      inline && e.options.format === 'docx' ? e.name.replace(/\.docx$/, '.pdf') : e.name,
      inline,
      inline && e.options.format === 'docx' ? 'application/pdf' : e.mime,
      (e.expiresAt.getTime() - Date.now()) / 1000,
    ),
  };
}
export async function changeTranslationExport(
  id: string,
  owner: string,
  action: 'cancel' | 'retry',
) {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const e = await translationExportForOwner(id, owner);
    if (action === 'retry') {
      await admitBilling(tx, owner, 'translation-export', id, e.attempt + 1);
      if (!['failed', 'cancelled'].includes(e.state))
        throw new ServiceError(409, 'JOB_NOT_RETRYABLE');
      await capacity(tx, owner, 1);
      await tx
        .update(translationExports)
        .set({
          state: 'queued',
          attempt: e.attempt + 1,
          error: null,
          key: null,
          dispatchedAt: null,
        })
        .where(
          and(
            eq(translationExports.id, id),
            eq(translationExports.attempt, e.attempt),
            inArray(translationExports.state, ['failed', 'cancelled']),
          ),
        );
    } else
      await tx
        .update(translationExports)
        .set({ state: e.state === 'processing' ? 'cancelling' : 'cancelled' })
        .where(
          and(
            eq(translationExports.id, id),
            inArray(translationExports.state, ['queued', 'processing']),
          ),
        );
    return { id };
  });
}
