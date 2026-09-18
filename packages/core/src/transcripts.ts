import { admitBilling } from './billing';
import { randomUUID } from 'node:crypto';
import { db, eq, and, inArray, sql, desc } from './db';
import { jobs, transcripts, transcriptionChunks, transcriptExports } from './schema';
import { ServiceError, jobForOwner, lockOwner, capacity } from './jobs';
import {
  transcriptPatchSchema,
  transcriptExportSchema,
  type TranscriptView,
  type TranscriptExportView,
  type TranscriptData,
} from './transcription';
import { downloadUrl } from './storage';

async function checkedJob(id: string, owner: string) {
  const { job } = await jobForOwner(id, owner);
  if (job.tool !== 'transcription') throw new ServiceError(400, 'INVALID_REQUEST');
  if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
  return job;
}
export async function readTranscript(
  id: string,
  owner: string,
  offset = 0,
): Promise<TranscriptView> {
  await checkedJob(id, owner);
  const [document] = await db().select().from(transcripts).where(eq(transcripts.jobId, id));
  const chunks = await db()
    .select({ state: transcriptionChunks.state })
    .from(transcriptionChunks)
    .where(eq(transcriptionChunks.jobId, id));
  const data: TranscriptData = document?.data ?? { durationMs: 0, segments: [], speakers: [] };
  const next = offset + 100;
  return {
    ...data,
    segments: data.segments.slice(offset, next),
    revision: document?.revision ?? 0,
    total: data.segments.length,
    nextOffset: next < data.segments.length ? next : null,
    completedChunks: chunks.filter((c) => c.state === 'completed').length,
    totalChunks: chunks.length,
  };
}
export async function patchTranscript(id: string, owner: string, body: unknown) {
  const patch = transcriptPatchSchema.parse(body);
  return db().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || job.tool !== 'transcription') throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    if (job.state !== 'completed') throw new ServiceError(409, 'NOT_READY');
    const [doc] = await tx
      .select()
      .from(transcripts)
      .where(eq(transcripts.jobId, id))
      .for('update');
    if (!doc || doc.revision !== patch.revision) throw new ServiceError(409, 'TRANSCRIPT_CONFLICT');
    const map = new Map(doc.data.segments.map((s) => [s.id, s]));
    if (
      new Set(patch.upsert.map((s) => s.id)).size !== patch.upsert.length ||
      patch.remove.some((id) => patch.upsert.some((s) => s.id === id))
    )
      throw new ServiceError(400, 'INVALID_REQUEST');
    for (const id of patch.remove) map.delete(id);
    for (const s of patch.upsert) map.set(s.id, s);
    const speakerMap = new Map(doc.data.speakers.map((s) => [s.id, s]));
    for (const speaker of patch.speakerUpsert) speakerMap.set(speaker.id, speaker);
    if (patch.mergeSpeaker) {
      const { from, to } = patch.mergeSpeaker;
      if (from === to || !speakerMap.has(from) || !speakerMap.has(to))
        throw new ServiceError(400, 'INVALID_TRANSCRIPT');
      for (const [id, s] of map) if (s.speakerId === from) map.set(id, { ...s, speakerId: to });
      speakerMap.delete(from);
    }
    const speakers = [...speakerMap.values()];
    const ids = new Set(speakers.map((s) => s.id));
    const segments = [...map.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    if (
      speakers.length > 256 ||
      ids.size !== speakers.length ||
      segments.length > 20000 ||
      segments.some(
        (s) => s.endMs > doc.data.durationMs || (s.speakerId !== null && !ids.has(s.speakerId)),
      )
    )
      throw new ServiceError(400, 'INVALID_TRANSCRIPT');
    const [saved] = await tx
      .update(transcripts)
      .set({
        data: { ...doc.data, segments, speakers },
        revision: doc.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(transcripts.jobId, id))
      .returning();
    return { revision: saved.revision };
  });
}
function exportView(e: typeof transcriptExports.$inferSelect): TranscriptExportView {
  return {
    id: e.id,
    revision: e.revision,
    format: e.format,
    state: e.state,
    error: e.error,
    includeSpeakers: e.options.includeSpeakers,
    includeTimestamps: e.options.includeTimestamps,
  };
}
export async function listTranscriptExports(id: string, owner: string) {
  await checkedJob(id, owner);
  return (
    await db()
      .select()
      .from(transcriptExports)
      .where(eq(transcriptExports.jobId, id))
      .orderBy(desc(transcriptExports.revision))
  ).map(exportView);
}
export async function createTranscriptExport(id: string, owner: string, body: unknown) {
  const options = transcriptExportSchema.parse(body);
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)))
      .for('update');
    if (!job || job.tool !== 'transcription') throw new ServiceError(404, 'JOB_NOT_FOUND');
    if (job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    if (job.state !== 'completed') throw new ServiceError(409, 'NOT_READY');
    const [doc] = await tx.select().from(transcripts).where(eq(transcripts.jobId, id));
    if (!doc || doc.revision !== options.revision)
      throw new ServiceError(409, 'TRANSCRIPT_CONFLICT');
    if (!doc.data.segments.some((s) => s.text.trim())) throw new ServiceError(409, 'NO_RESULTS');
    const [existing] = await tx
      .select()
      .from(transcriptExports)
      .where(
        and(
          eq(transcriptExports.jobId, id),
          eq(transcriptExports.revision, options.revision),
          eq(transcriptExports.format, options.format),
          sql`${transcriptExports.options}->>'includeSpeakers'=${String(options.includeSpeakers)}`,
          sql`${transcriptExports.options}->>'includeTimestamps'=${String(options.includeTimestamps)}`,
        ),
      );
    if (existing) return exportView(existing);
    await capacity(tx, owner, 1);
    const [created] = await tx
      .insert(transcriptExports)
      .values({
        id: randomUUID(),
        jobId: id,
        revision: doc.revision,
        format: options.format,
        options,
        snapshot: doc.data,
        expiresAt: job.expiresAt,
      })
      .returning();
    await admitBilling(tx, owner, 'transcript-export', created.id, 1);
    return exportView(created);
  });
}
export async function transcriptExportForOwner(id: string, owner: string) {
  const [row] = await db()
    .select({ export: transcriptExports, job: jobs })
    .from(transcriptExports)
    .innerJoin(jobs, eq(transcriptExports.jobId, jobs.id))
    .where(and(eq(transcriptExports.id, id), eq(jobs.owner, owner), eq(jobs.deleting, false)));
  if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND');
  if (row.job.expiresAt <= new Date() || row.export.expiresAt <= new Date())
    throw new ServiceError(410, 'EXPIRED');
  return row.export;
}
export async function transcriptDownload(id: string, owner: string) {
  const e = await transcriptExportForOwner(id, owner);
  if (e.state !== 'completed' || !e.key || !e.name || !e.mime)
    throw new ServiceError(409, 'NOT_READY');
  return {
    url: await downloadUrl(
      e.key,
      e.name,
      false,
      e.mime,
      (e.expiresAt.getTime() - Date.now()) / 1000,
    ),
  };
}
export async function changeTranscriptExport(
  id: string,
  owner: string,
  action: 'cancel' | 'retry',
) {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const e = await transcriptExportForOwner(id, owner);
    if (action === 'retry') {
      await admitBilling(tx, owner, 'transcript-export', id, e.attempt + 1);
      if (!['failed', 'cancelled'].includes(e.state))
        throw new ServiceError(409, 'JOB_NOT_RETRYABLE');
      await capacity(tx, owner, 1);
      await tx
        .update(transcriptExports)
        .set({
          state: 'queued',
          attempt: e.attempt + 1,
          error: null,
          key: null,
          dispatchedAt: null,
        })
        .where(
          and(
            eq(transcriptExports.id, id),
            eq(transcriptExports.attempt, e.attempt),
            inArray(transcriptExports.state, ['failed', 'cancelled']),
          ),
        );
    } else
      await tx
        .update(transcriptExports)
        .set({ state: e.state === 'processing' ? 'cancelling' : 'cancelled' })
        .where(
          and(
            eq(transcriptExports.id, id),
            inArray(transcriptExports.state, ['queued', 'processing']),
          ),
        );
    return { id };
  });
}
