import { startUsage, completeUsage, runtimeAllowance } from '@filemorph/core/billing-usage';
import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';
import { db, eq, and, inArray, sql } from '@filemorph/core/db';
import { archives, jobs } from '@filemorph/core/schema';
import { objectStream, uploadStream, deleteObject } from '@filemorph/core/storage';
import { MediaError } from '@filemorph/core/media';
export async function processArchive(id: string, controllers: Set<AbortController>) {
  const [archive] = await db()
    .update(archives)
    .set({ state: 'processing' })
    .where(
      and(
        eq(archives.id, id),
        inArray(archives.state, ['queued', 'processing']),
        sql`${archives.expiresAt}>now()`,
      ),
    )
    .returning();
  if (!archive) return;
  const controller = new AbortController();
  controllers.add(controller);
  const { signal } = controller;
  const zip = new ZipArchive({ store: true, forceZip64: true });
  let checking = false;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const [current] = await db().select().from(archives).where(eq(archives.id, id));
      if (!current || current.state === 'expired' || current.expiresAt <= new Date())
        controller.abort();
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  }, 750);
  let runtimeId: string | null = null;
  const started = Date.now();
  let allowance = 3600000;
  try {
    allowance = Math.max(1, (await runtimeAllowance(3602000, true)) - 2000);
    runtimeId = await startUsage({
      meter: 'runtime_ms',
      stage: 'process',
      maximum: allowance + 2000,
    });
  } catch (error) {
    clearInterval(interval);
    controllers.delete(controller);
    await db()
      .update(archives)
      .set({ state: 'failed', error: error instanceof MediaError ? error.code : 'ARCHIVE_FAILED' })
      .where(eq(archives.id, id));
    throw error;
  }
  const timeout = setTimeout(
    () =>
      controller.abort(
        new MediaError(
          allowance < 3600000 ? 'BILLING_BUDGET_EXCEEDED' : 'TIMEOUT',
          'Archive time limit reached',
        ),
      ),
    allowance,
  );
  let committed = false;
  const stream = new PassThrough();
  zip.pipe(stream);
  let uploading: Promise<void> = Promise.resolve();
  zip.on('error', () => controller.abort());
  zip.on('warning', () => controller.abort());
  const abort = () => zip.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const members = await db()
      .select({ outputSize: jobs.outputSize })
      .from(jobs)
      .where(eq(jobs.batchId, archive.batchId));
    const maximumBytes =
      members.reduce((n, m) => n + (m.outputSize || 0), 0) + archive.members.length * 4096 + 4096;
    uploading = uploadStream(archive.key, stream, signal, 'application/zip', maximumBytes);
    // Attach the rejection handler before collecting members.
    uploading.catch((error) => {
      console.error('Archive upload failed', error.message);
      controller.abort(error);
    });
    const used = new Set<string>();
    for (const member of archive.members) {
      signal.throwIfAborted();
      let name = member.name.replace(/[\\/\x00-\x1f]/g, '_');
      const original = name;
      let number = 2;
      while (used.has(name.toLowerCase())) {
        const dot = original.lastIndexOf('.');
        name = `${original.slice(0, dot)} (${number++})${original.slice(dot)}`;
      }
      used.add(name.toLowerCase());
      // Sequential reads bound sockets and buffers even for twenty large audio files.
      const stream = await objectStream(member.key, signal);
      const consumed = new Promise<void>((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
      zip.append(stream, { name });
      await consumed;
    }
    await zip.finalize();
    await uploading;
    signal.throwIfAborted();
    const updated = await db()
      .update(archives)
      .set({ state: 'completed', error: null })
      .where(
        and(
          eq(archives.id, id),
          eq(archives.state, 'processing'),
          sql`${archives.expiresAt}>now()`,
        ),
      )
      .returning();
    committed = updated.length === 1;
  } catch (error) {
    console.error('Archive failed', error instanceof Error ? error.message : 'Unknown error');
    controller.abort();
    zip.abort();
    await uploading.catch(() => {});
    await db()
      .update(archives)
      .set({
        state: 'failed',
        error:
          error instanceof MediaError
            ? error.code
            : signal.reason instanceof MediaError
              ? signal.reason.code
              : 'ARCHIVE_FAILED',
      })
      .where(and(eq(archives.id, id), eq(archives.state, 'processing')));
  } finally {
    try {
      await completeUsage(runtimeId, Date.now() - started, { measurement: 'archive_wall_ms' });
    } finally {
      clearInterval(interval);
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (!committed) await deleteObject(archive.key).catch(() => {});
    }
  }
}
