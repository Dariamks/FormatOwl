import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, eq, and, inArray, sql, sqlClient } from '@filemorph/core/db';
import { jobs, assets, transcriptExports } from '@filemorph/core/schema';
import { uploadFromFile, deleteObject } from '@filemorph/core/storage';
import { runProcess, MediaError } from '@filemorph/core/media';
import { pythonBinary } from './processors';
const mime: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  srt: 'application/x-subrip',
  vtt: 'text/vtt; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export async function processTranscriptExport(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
) {
  const lease = await sqlClient().reserve();
  let locked = false;
  try {
    const [row] =
      await lease`select pg_try_advisory_lock(hashtextextended(${id}, 0)) as locked, pg_backend_pid() as pid`;
    locked = row.locked;
    if (!locked) return;
    await runTranscriptExport(id, attempt, controllers, activeTemp, tempRoot, async () => {
      const [current] = await lease`select pg_backend_pid() as pid`;
      if (current.pid !== row.pid) throw new MediaError('SERVICE_UNAVAILABLE', 'Export lease lost');
    });
  } finally {
    if (locked) await lease`select pg_advisory_unlock(hashtextextended(${id}, 0))`.catch(() => {});
    lease.release();
  }
}
async function runTranscriptExport(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  checkLease: () => Promise<void>,
) {
  const [e] = await db()
    .update(transcriptExports)
    .set({ state: 'processing', error: null })
    .where(
      and(
        eq(transcriptExports.id, id),
        eq(transcriptExports.attempt, attempt),
        inArray(transcriptExports.state, ['queued', 'processing']),
        sql`${transcriptExports.expiresAt}>now()`,
      ),
    )
    .returning();
  if (!e) return;
  const controller = new AbortController(),
    { signal } = controller;
  controllers.add(controller);
  const key = `outputs/${e.jobId}/transcript-exports/${id}/${attempt}.${e.format}`;
  let temp: string | undefined,
    committed = false,
    checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await checkLease();
      const [row] = await db()
        .select({ e: transcriptExports, j: jobs })
        .from(transcriptExports)
        .innerJoin(jobs, eq(jobs.id, transcriptExports.jobId))
        .where(eq(transcriptExports.id, id));
      if (
        !row ||
        row.e.state !== 'processing' ||
        row.e.attempt !== attempt ||
        row.j.deleting ||
        row.j.expiresAt <= new Date()
      )
        controller.abort(new MediaError('CANCELLED', 'Export cancelled'));
    } catch {
      controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost task state'));
    } finally {
      checking = false;
    }
  }, 500);
  try {
    const [source] = await db()
      .select({ name: assets.name })
      .from(jobs)
      .innerJoin(assets, eq(jobs.assetId, assets.id))
      .where(and(eq(jobs.id, e.jobId), eq(jobs.deleting, false), sql`${jobs.expiresAt}>now()`));
    if (!source) throw new MediaError('EXPIRED', 'Source expired');
    temp = await mkdtemp(join(tempRoot, 'transcript-export-'));
    activeTemp.add(temp);
    const output = join(temp, `transcript.${e.format}`),
      params = join(temp, 'params.json');
    await writeFile(params, JSON.stringify({ data: e.snapshot, options: e.options, output }));
    await runProcess(
      pythonBinary,
      [fileURLToPath(new URL('../python/export_transcript.py', import.meta.url)), params],
      signal,
      undefined,
      300000,
    );
    signal.throwIfAborted();
    await checkLease();
    await uploadFromFile(key, output, signal, mime[e.format]);
    const name = `${source.name.replace(/\.[^.]*$/, '')}-transcript-v${e.revision}.${e.format}`;
    const result = await db()
      .update(transcriptExports)
      .set({ state: 'completed', key, name, mime: mime[e.format] })
      .where(
        and(
          eq(transcriptExports.id, id),
          eq(transcriptExports.attempt, attempt),
          eq(transcriptExports.state, 'processing'),
          sql`exists(select 1 from jobs where jobs.id=${e.jobId} and not jobs.deleting and jobs.expires_at>now())`,
        ),
      )
      .returning();
    committed = result.length === 1;
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error;
    await db()
      .update(transcriptExports)
      .set({
        state: reason instanceof MediaError && reason.code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: reason instanceof MediaError ? reason.code : 'EXPORT_FAILED',
      })
      .where(
        and(
          eq(transcriptExports.id, id),
          eq(transcriptExports.attempt, attempt),
          inArray(transcriptExports.state, ['processing', 'cancelling']),
        ),
      );
  } finally {
    clearInterval(timer);
    controllers.delete(controller);
    if (!committed) await deleteObject(key).catch(() => {});
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
  }
}
