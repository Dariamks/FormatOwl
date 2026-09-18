import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { db, eq, and, inArray, sql } from '@filemorph/core/db';
import { assets, preparations } from '@filemorph/core/schema';
import { downloadToFile, uploadFromFile, deletePrefix } from '@filemorph/core/storage';
import { limits } from '@filemorph/core/config';
import { MediaError } from '@filemorph/core/media';
import { prepareMedia, probeEditor } from './processors/editor';

export async function processPreparation(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
) {
  const [prep] = await db()
    .update(preparations)
    .set({ state: 'processing', progress: 1, error: null })
    .where(
      and(
        eq(preparations.id, id),
        eq(preparations.attempt, attempt),
        inArray(preparations.state, ['queued', 'processing']),
        sql`${preparations.expiresAt}>now()`,
      ),
    )
    .returning();
  if (!prep) return;
  const controller = new AbortController(),
    { signal } = controller;
  controllers.add(controller);
  let temp: string | undefined,
    committed = false,
    checking = false;
  const prefix = `preparations/${id}/${attempt}/`;
  const timer = setTimeout(
    () => controller.abort(new MediaError('TIMEOUT', 'Preparation timed out')),
    limits.jobTimeoutMs,
  );
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const [p] = await db().select().from(preparations).where(eq(preparations.id, id));
      const [a] = await db().select().from(assets).where(eq(assets.id, prep.assetId));
      if (
        !p ||
        p.attempt !== attempt ||
        p.state !== 'processing' ||
        p.expiresAt <= new Date() ||
        !a ||
        a.state !== 'ready' ||
        a.expiresAt <= new Date()
      )
        controller.abort(new MediaError('CANCELLED', 'Preparation no longer active'));
    } catch {
      controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost task state'));
    } finally {
      checking = false;
    }
  }, 750);
  try {
    const [asset] = await db()
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, prep.assetId),
          eq(assets.owner, prep.owner),
          eq(assets.state, 'ready'),
          sql`${assets.expiresAt}>now()`,
        ),
      );
    if (!asset) throw new MediaError('ASSET_NOT_FOUND', 'Missing source');
    const disk = await statfs(tempRoot);
    if (disk.bavail * disk.bsize < asset.size * 3 + 2 * 1024 ** 3)
      throw new MediaError('DISK_FULL', 'Insufficient space');
    temp = await mkdtemp(join(tempRoot, 'prepare-'));
    activeTemp.add(temp);
    const input = join(temp, 'input');
    await downloadToFile(asset.key, input, signal);
    const media = await probeEditor(input, signal);
    await db()
      .update(preparations)
      .set({ media, progress: 8 })
      .where(and(eq(preparations.id, id), eq(preparations.attempt, attempt)));
    let lastWrite = 0;
    const writes: Promise<unknown>[] = [];
    const result = await prepareMedia(
      input,
      media,
      prep.profile,
      prep.streamIndex,
      temp,
      signal,
      (progress) => {
        if (Date.now() - lastWrite < 500) return;
        lastWrite = Date.now();
        writes.push(
          db()
            .update(preparations)
            .set({ progress })
            .where(
              and(
                eq(preparations.id, id),
                eq(preparations.attempt, attempt),
                eq(preparations.state, 'processing'),
              ),
            )
            .catch(() =>
              controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Progress write failed')),
            ),
        );
      },
    );
    await Promise.all(writes);
    signal.throwIfAborted();
    await uploadFromFile(
      `${prefix}preview`,
      result.preview,
      signal,
      prep.profile === 'video' ? 'video/mp4' : 'audio/mp4',
    );
    if (result.peaks)
      await uploadFromFile(`${prefix}peaks`, result.peaks, signal, 'application/json');
    if (result.thumbnails)
      await uploadFromFile(`${prefix}thumbnails`, result.thumbnails, signal, 'image/jpeg');
    signal.throwIfAborted();
    const rows = await db()
      .update(preparations)
      .set({
        state: 'completed',
        progress: 100,
        previewKey: `${prefix}preview`,
        peaksKey: result.peaks ? `${prefix}peaks` : null,
        thumbnailsKey: result.thumbnails ? `${prefix}thumbnails` : null,
      })
      .where(
        and(
          eq(preparations.id, id),
          eq(preparations.attempt, attempt),
          eq(preparations.state, 'processing'),
          sql`${preparations.expiresAt}>now()`,
        ),
      )
      .returning();
    committed = rows.length === 1;
  } catch (error) {
    const e = signal.aborted ? signal.reason : error;
    const code = e instanceof MediaError ? e.code : 'PROCESSING_FAILED';
    await db()
      .update(preparations)
      .set({ state: code === 'CANCELLED' ? 'cancelled' : 'failed', error: code })
      .where(
        and(
          eq(preparations.id, id),
          eq(preparations.attempt, attempt),
          eq(preparations.state, 'processing'),
        ),
      );
    console.error(
      `Preparation ${id}: ${code}`,
      error instanceof Error ? error.message.slice(-1000) : '',
    );
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    controllers.delete(controller);
    if (!committed) await deletePrefix(prefix).catch(() => {});
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
  }
}
