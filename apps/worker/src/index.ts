import { saveDailyBillingReport } from '@filemorph/core/billing-report';
import { runBilled, processBillingProbe, reconcileBillingTargets } from './billing-worker';
import { billingProbes } from '@filemorph/core/schema';
import { processWatermark } from './watermark-worker';
import { isWatermarkTool } from '@filemorph/core/watermark';
import { watermarkDocuments, watermarkRuns, watermarkSteps } from '@filemorph/core/schema';
import { watermarkQueue, watermarkQueueName } from '@filemorph/core/queue';
import {
  processTranslation,
  processTranslationExport,
  updateTranslationCapabilities,
} from './translation-worker';
import { isTranslationTool } from '@filemorph/core/translation';
import { processReading } from './reading-worker';
import { processTranscription } from './transcription';
import { processTranscriptExport } from './transcript-export';
import { processPreparation } from './preparation';
import { isEditorTool, type EditOptions } from '@filemorph/core/editing';
import { processEdit, probeEditor } from './processors/editor';
import { Worker } from 'bullmq';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { db, eq, and, or, inArray, lt, isNull, sql, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  outbox,
  archives,
  preparations,
  jobInputs,
  transcripts,
  transcriptionChunks,
  transcriptExports,
  translationDocuments,
  translationSteps,
  translationExports,
  translationActivities,
} from '@filemorph/core/schema';
import {
  queueName,
  connection,
  mediaQueue,
  transcriptionQueueName,
  transcriptionQueue,
  queueForTool,
  translationQueue,
  translationQueueName,
  readingQueue,
  readingQueueName,
} from '@filemorph/core/queue';
import {
  downloadToFile,
  uploadFromFile,
  deleteObject,
  abortUpload,
  deletePrefix,
} from '@filemorph/core/storage';
import { MediaError } from '@filemorph/core/media';
import { processFile } from './processors';
import { processArchive } from './archive';
import { limits } from '@filemorph/core/config';
import { cleanTemporaryFiles } from '@filemorph/core/temp';

const tempRoot = resolve(process.env.WORKER_TEMP_DIR || join(tmpdir(), 'filemorph-worker'));
await mkdir(tempRoot, { recursive: true });
const activeTemp = new Set<string>();
await cleanTemporaryFiles(tempRoot, Date.now() - limits.jobTimeoutMs - 60000, activeTemp);
let lastTempCleanup = Date.now();
const controllers = new Set<AbortController>();
const worker = new Worker<{ id: string; attempt: number; kind?: string }>(
  queueName,
  async (queued) => {
    if (queued.data.kind === 'billing-probe')
      return processBillingProbe(queued.data.id, tempRoot, controllers, activeTemp);
    return runBilled(queued.data.kind || 'job', queued.data.id, queued.data.attempt, async () => {
      if (queued.data.kind === 'transcript-export')
        return processTranscriptExport(
          queued.data.id,
          queued.data.attempt,
          controllers,
          activeTemp,
          tempRoot,
        );
      if (queued.data.kind === 'prepare')
        return processPreparation(
          queued.data.id,
          queued.data.attempt,
          controllers,
          activeTemp,
          tempRoot,
        );
      if (queued.data.kind === 'archive') return processArchive(queued.data.id, controllers);
      const { id, attempt } = queued.data;
      const [job] = await db()
        .update(jobs)
        .set({ state: 'processing', progress: 1, updatedAt: new Date(), error: null })
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.attempt, attempt),
            eq(jobs.deleting, false),
            inArray(jobs.state, ['queued', 'processing']),
            sql`${jobs.expiresAt}>now()`,
          ),
        )
        .returning();
      if (!job) return;
      const [asset] = await db().select().from(assets).where(eq(assets.id, job.assetId));
      if (!asset) throw new Error('Missing job input');
      const controller = new AbortController();
      controllers.add(controller);
      const { signal } = controller;
      let temp: string | undefined,
        committed = false,
        checking = false;
      const outputKey =
        job.tool === 'video-compressor'
          ? `outputs/${id}/${attempt}.mp4`
          : `outputs/${id}/${attempt}/result`;
      const timeout = setTimeout(
        () => controller.abort(new MediaError('TIMEOUT', 'Processing exceeded the time limit')),
        limits.jobTimeoutMs,
      );
      const cancellation = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const [current] = await db().select().from(jobs).where(eq(jobs.id, id));
          if (
            !current ||
            current.state === 'cancelling' ||
            current.deleting ||
            current.attempt !== attempt ||
            current.expiresAt <= new Date()
          )
            controller.abort(new MediaError('CANCELLED', 'Task cancelled'));
        } catch {
          controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost connection to task state'));
        } finally {
          checking = false;
        }
      }, 750);
      try {
        const disk = await statfs(tempRoot);
        const estimatedOutput =
          (('targetMb' in job.options ? job.options.targetMb : undefined) ||
            (asset.size / 1024 / 1024) * 2) *
          1024 *
          1024;
        if (
          disk.bavail * disk.bsize <
          (job.inputSize ?? asset.size) +
            (isEditorTool(job.tool)
              ? Math.max(estimatedOutput, 512 * 1024 ** 2)
              : estimatedOutput) +
            256 * 1024 * 1024
        )
          throw new MediaError('DISK_FULL', 'Insufficient temporary disk space');
        temp = await mkdtemp(join(tempRoot, 'job-'));
        activeTemp.add(temp);
        const input = join(temp, 'input');
        await downloadToFile(asset.key, input, signal);
        let progress = 7,
          lastWrite = 0;
        const writes: Promise<unknown>[] = [];
        const result = isEditorTool(job.tool)
          ? await (async () => {
              const sources: import('./processors/editor').EditorInput[] = [];
              for (const sourceId of job.sourceIds) {
                const [a] = await db()
                  .select()
                  .from(assets)
                  .where(
                    and(
                      eq(assets.id, sourceId),
                      eq(assets.owner, job.owner),
                      eq(assets.state, 'ready'),
                      sql`${assets.expiresAt}>now()`,
                    ),
                  );
                if (!a) throw new MediaError('ASSET_NOT_FOUND', 'Missing editor source');
                const path: string =
                  sourceId === asset.id ? input : join(temp!, `input-${sources.length}`);
                if (sourceId !== asset.id) await downloadToFile(a.key, path, signal);
                sources.push({
                  id: a.id,
                  name: a.name,
                  path,
                  media: await probeEditor(path, signal),
                });
              }
              return processEdit(
                job.tool as import('@filemorph/core/editing').EditorTool,
                job.options as EditOptions,
                sources,
                temp!,
                signal,
                (value) => {
                  // Processor progress can be fractional; jobs.progress is an integer.
                  value = Math.floor(value);
                  if (value <= progress || Date.now() - lastWrite < 500) return;
                  progress = value;
                  lastWrite = Date.now();
                  writes.push(
                    db()
                      .update(jobs)
                      .set({ progress: value, updatedAt: new Date() })
                      .where(
                        and(
                          eq(jobs.id, id),
                          eq(jobs.attempt, attempt),
                          eq(jobs.state, 'processing'),
                        ),
                      )
                      .catch(() =>
                        controller.abort(
                          new MediaError('PROGRESS_SAVE_FAILED', 'Progress persistence failed'),
                        ),
                      ),
                  );
                },
                job.purpose,
              );
            })()
          : await processFile(job.tool, job.options, asset.name, input, temp, signal, (value) => {
              // Normalize at the database boundary for every file processor.
              value = Math.floor(value);
              if (value <= progress || Date.now() - lastWrite < 500) return;
              progress = value;
              lastWrite = Date.now();
              writes.push(
                db()
                  .update(jobs)
                  .set({ progress: value, updatedAt: new Date() })
                  .where(
                    and(eq(jobs.id, id), eq(jobs.attempt, attempt), eq(jobs.state, 'processing')),
                  )
                  .catch(() =>
                    controller.abort(
                      new MediaError('PROGRESS_SAVE_FAILED', 'Progress persistence failed'),
                    ),
                  ),
              );
            });
        await Promise.all(writes);
        signal.throwIfAborted();
        const size = await uploadFromFile(outputKey, result.output, signal, result.mime);
        let inputPreview = null,
          outputPreview = null;
        if (result.inputPreview) {
          const key = `outputs/${id}/${attempt}/original-preview`;
          await uploadFromFile(key, result.inputPreview, signal, result.previewMime);
          inputPreview = { key, mime: result.previewMime! };
        }
        if (result.outputPreview) {
          const key = `outputs/${id}/${attempt}/output-preview`;
          await uploadFromFile(key, result.outputPreview, signal, result.previewMime);
          outputPreview = { key, mime: result.previewMime! };
        }
        signal.throwIfAborted();
        const updated = await db()
          .update(jobs)
          .set({
            state: 'completed',
            progress: 100,
            outputKey,
            outputSize: size,
            outputName: result.name,
            outputMime: result.mime,
            media: result.media,
            note: result.note,
            inputPreview,
            outputPreview,
            inputMedia: result.inputMedia || null,
            outputMedia: result.outputMedia || null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(jobs.id, id),
              eq(jobs.attempt, attempt),
              eq(jobs.state, 'processing'),
              eq(jobs.deleting, false),
              sql`${jobs.expiresAt}>now()`,
            ),
          )
          .returning({ id: jobs.id });
        committed = updated.length === 1;
      } catch (error) {
        const reason = signal.aborted ? signal.reason : error;
        const code = reason instanceof MediaError ? reason.code : 'PROCESSING_FAILED';
        await db()
          .update(jobs)
          .set({
            state: code === 'CANCELLED' ? 'cancelled' : 'failed',
            error: code === 'CANCELLED' ? null : code,
            errorDetail:
              error instanceof Error ? error.message.slice(-4000) : 'Unknown processing error',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(jobs.id, id),
              eq(jobs.attempt, attempt),
              inArray(jobs.state, ['processing', 'cancelling']),
            ),
          );
        console.error(`Task ${id} ended: ${code}`);
      } finally {
        clearTimeout(timeout);
        clearInterval(cancellation);
        controllers.delete(controller);
        if (!committed) {
          await deleteObject(outputKey).catch(() => {});
          await deletePrefix(`outputs/${id}/${attempt}/`).catch(() => {});
        }
        if (temp) {
          activeTemp.delete(temp);
          await rm(temp, { recursive: true, force: true });
        }
      }
    });
  },
  {
    connection: connection(),
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1)),
    maxStalledCount: 2,
    stalledInterval: 15000,
    lockDuration: 30000,
  },
);
const wmWorker = new Worker<{ id: string; attempt: number; kind?: string }>(
  watermarkQueueName,
  (q) =>
    runBilled(
      q.data.kind === 'watermark-run' ? 'watermark-run' : 'job',
      q.data.id,
      q.data.attempt,
      () =>
        processWatermark(
          q.data.id,
          q.data.attempt,
          q.data.kind === 'watermark-run' ? 'run' : 'analyze',
          controllers,
          activeTemp,
          tempRoot,
        ),
    ),
  {
    connection: connection(),
    concurrency: 1,
    maxStalledCount: 1,
    stalledInterval: 15000,
    lockDuration: 30000,
  },
);
wmWorker.on('error', (error) => console.error('Watermark worker error', error.name));
wmWorker.on('failed', async (q) => {
  if (!q) return;
  const table = q.data.kind === 'watermark-run' ? watermarkRuns : jobs;
  await db()
    .update(table)
    .set({ state: 'failed', error: 'WORKER_INTERRUPTED' })
    .where(
      and(
        eq(table.id, q.data.id),
        eq(table.attempt, q.data.attempt),
        inArray(table.state, ['queued', 'processing', 'cancelling']),
      ),
    );
});
const speechWorker = new Worker<{ id: string; attempt: number }>(
  transcriptionQueueName,
  (queued) =>
    runBilled('job', queued.data.id, queued.data.attempt, () =>
      processTranscription(queued.data.id, queued.data.attempt, controllers, activeTemp, tempRoot),
    ),
  {
    connection: connection(),
    concurrency: 1,
    maxStalledCount: 1,
    stalledInterval: 15000,
    lockDuration: 30000,
  },
);
const translateWorker = new Worker<{ id: string; attempt: number; kind?: string }>(
  translationQueueName,
  (queued) =>
    runBilled(
      queued.data.kind === 'translation-export' ? 'translation-export' : 'job',
      queued.data.id,
      queued.data.attempt,
      () =>
        queued.data.kind === 'translation-export'
          ? processTranslationExport(
              queued.data.id,
              queued.data.attempt,
              controllers,
              activeTemp,
              tempRoot,
            )
          : processTranslation(
              queued.data.id,
              queued.data.attempt,
              controllers,
              activeTemp,
              tempRoot,
            ),
    ),
  {
    connection: connection(),
    concurrency: 2,
    maxStalledCount: 1,
    stalledInterval: 15000,
    lockDuration: 30000,
  },
);
translateWorker.on('error', (error) => console.error('Translation worker error', error.name));
const readerWorker = new Worker<{ id: string; attempt: number; kind?: string }>(
  readingQueueName,
  (queued) =>
    runBilled(
      queued.data.kind === 'translation-export' ? 'translation-export' : 'reading',
      queued.data.id,
      queued.data.attempt,
      () =>
        queued.data.kind === 'translation-export'
          ? processTranslationExport(
              queued.data.id,
              queued.data.attempt,
              controllers,
              activeTemp,
              tempRoot,
            )
          : processReading(queued.data.id, queued.data.attempt, controllers, activeTemp, tempRoot),
    ),
  {
    connection: connection(),
    concurrency: 2,
    maxStalledCount: 1,
    stalledInterval: 15000,
    lockDuration: 30000,
  },
);
readerWorker.on('error', (error) => console.error('Reading worker error', error.name));
readerWorker.on('failed', async (queued) => {
  if (queued) {
    const table =
      queued.data.kind === 'translation-export' ? translationExports : translationActivities;
    await db()
      .update(table)
      .set({ state: 'failed', error: 'AI_RESULT_UNKNOWN' })
      .where(
        and(
          eq(table.id, queued.data.id),
          eq(table.attempt, queued.data.attempt),
          inArray(table.state, ['queued', 'processing']),
        ),
      );
  }
});
translateWorker.on('failed', async (queued) => {
  if (!queued) return;
  const table = queued.data.kind === 'translation-export' ? translationExports : jobs;
  await db()
    .update(table)
    .set({ state: 'failed', error: 'AI_RESULT_UNKNOWN' })
    .where(
      and(
        eq(table.id, queued.data.id),
        eq(table.attempt, queued.data.attempt),
        inArray(table.state, ['queued', 'processing']),
      ),
    );
});
let lastCapabilityCheck = 0;
speechWorker.on('error', (error) => console.error('Transcription worker error', error.name));
speechWorker.on('failed', async (queued) => {
  if (queued)
    await db()
      .update(jobs)
      .set({ state: 'failed', error: 'AI_RESULT_UNKNOWN', updatedAt: new Date() })
      .where(
        and(
          eq(jobs.id, queued.data.id),
          eq(jobs.attempt, queued.data.attempt),
          inArray(jobs.state, ['queued', 'processing']),
        ),
      );
});
worker.on('error', (error) => console.error('Worker connection error', error.message));
worker.on('failed', async (queued, error) => {
  if (!queued) return;
  if (queued.data.kind === 'billing-probe') {
    await db()
      .update(billingProbes)
      .set({ state: 'failed', error: 'PROBE_INTERRUPTED', updatedAt: new Date() })
      .where(
        and(
          eq(billingProbes.assetId, queued.data.id),
          inArray(billingProbes.state, ['queued', 'processing']),
        ),
      );
    return;
  }
  if (queued.data.kind === 'transcript-export') {
    await db()
      .update(transcriptExports)
      .set({ state: 'failed', error: 'WORKER_INTERRUPTED' })
      .where(
        and(
          eq(transcriptExports.id, queued.data.id),
          eq(transcriptExports.attempt, queued.data.attempt),
          inArray(transcriptExports.state, ['queued', 'processing']),
        ),
      );
    return;
  }
  if (queued.data.kind === 'prepare') {
    await db()
      .update(preparations)
      .set({ state: 'failed', error: 'WORKER_INTERRUPTED' })
      .where(
        and(
          eq(preparations.id, queued.data.id),
          eq(preparations.attempt, queued.data.attempt),
          inArray(preparations.state, ['queued', 'processing']),
        ),
      );
    return;
  }
  if (queued.data.kind === 'archive') {
    await db()
      .update(archives)
      .set({ state: 'failed', error: 'WORKER_INTERRUPTED' })
      .where(
        and(eq(archives.id, queued.data.id), inArray(archives.state, ['queued', 'processing'])),
      );
    return;
  }
  await db()
    .update(jobs)
    .set({
      state: 'failed',
      error: 'WORKER_INTERRUPTED',
      errorDetail: error.message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, queued.data.id),
        eq(jobs.attempt, queued.data.attempt),
        inArray(jobs.state, ['queued', 'processing']),
      ),
    )
    .catch(() => {});
});

let maintaining = false;
let lastBillingReport = 0;
async function maintain() {
  if (maintaining) return;
  maintaining = true;
  try {
    if (Date.now() - lastTempCleanup >= 60000) {
      await cleanTemporaryFiles(tempRoot, Date.now() - limits.jobTimeoutMs - 60000, activeTemp);
      lastTempCleanup = Date.now();
    }
    if (Date.now() - lastCapabilityCheck > 30000) {
      await updateTranslationCapabilities(tempRoot);
      lastCapabilityCheck = Date.now();
    }
    await reconcileBillingTargets();
    if (Date.now() - lastBillingReport > 60000) {
      await saveDailyBillingReport();
      lastBillingReport = Date.now();
    }
    const probes = await db()
      .select()
      .from(billingProbes)
      .where(inArray(billingProbes.state, ['queued', 'processing']))
      .limit(20);
    for (const p of probes)
      await mediaQueue().add(
        'billing-probe',
        { id: p.assetId, attempt: 1, kind: 'billing-probe' },
        { jobId: 'billing-probe-' + p.assetId },
      );
    // Deterministic queue IDs make an enqueue success followed by a DB failure safe to retry.
    const watermarkPending = await db()
      .select()
      .from(watermarkRuns)
      .where(inArray(watermarkRuns.state, ['queued', 'cancelling']))
      .limit(100);
    for (const r of watermarkPending) {
      if (r.state === 'cancelling') {
        const q = await watermarkQueue().getJob('watermark-run-' + r.id + '-' + r.attempt);
        if ((await q?.getState()) !== 'active')
          await db()
            .update(watermarkRuns)
            .set({ state: 'cancelled' })
            .where(and(eq(watermarkRuns.id, r.id), eq(watermarkRuns.state, 'cancelling')));
      } else if (!r.dispatchedAt) {
        await watermarkQueue().add(
          'watermark-run',
          { id: r.id, attempt: r.attempt, kind: 'watermark-run' },
          { jobId: 'watermark-run-' + r.id + '-' + r.attempt },
        );
        await db()
          .update(watermarkRuns)
          .set({ dispatchedAt: new Date() })
          .where(and(eq(watermarkRuns.id, r.id), eq(watermarkRuns.attempt, r.attempt)));
      }
    }
    const pending = await db().select().from(outbox).where(isNull(outbox.dispatchedAt)).limit(50);
    for (const event of pending) {
      const [pendingJob] = await db()
        .select({ tool: jobs.tool })
        .from(jobs)
        .where(eq(jobs.id, event.jobId));
      if (!pendingJob) continue;
      await queueForTool(pendingJob.tool).add(
        'process',
        { id: event.jobId, attempt: event.attempt },
        { jobId: `${event.jobId}-${event.attempt}` },
      );
      await db()
        .update(outbox)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(outbox.jobId, event.jobId), eq(outbox.attempt, event.attempt)));
    }
    const pendingPreparations = await db()
      .select()
      .from(preparations)
      .where(
        and(
          eq(preparations.state, 'queued'),
          isNull(preparations.dispatchedAt),
          sql`${preparations.expiresAt}>now()`,
        ),
      )
      .limit(20);
    for (const p of pendingPreparations) {
      await mediaQueue().add(
        'prepare',
        { id: p.id, attempt: p.attempt, kind: 'prepare' },
        { jobId: `prepare-${p.id}-${p.attempt}` },
      );
      await db()
        .update(preparations)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(preparations.id, p.id), eq(preparations.attempt, p.attempt)));
    }
    const readingPending = await db()
      .select()
      .from(translationActivities)
      .where(
        and(
          eq(translationActivities.state, 'queued'),
          isNull(translationActivities.dispatchedAt),
          sql`${translationActivities.expiresAt}>now()`,
        ),
      )
      .limit(30);
    for (const a of readingPending) {
      await readingQueue().add(
        'reading',
        { id: a.id, attempt: a.attempt },
        { jobId: `reading-${a.id}-${a.attempt}`, priority: a.kind === 'preview' ? 1 : 2 },
      );
      await db()
        .update(translationActivities)
        .set({ dispatchedAt: new Date() })
        .where(
          and(eq(translationActivities.id, a.id), eq(translationActivities.attempt, a.attempt)),
        );
    }
    const readingCancelling = await db()
      .select()
      .from(translationActivities)
      .where(eq(translationActivities.state, 'cancelling'))
      .limit(50);
    for (const a of readingCancelling) {
      const q = await readingQueue().getJob(`reading-${a.id}-${a.attempt}`);
      if ((await q?.getState()) !== 'active')
        await db()
          .update(translationActivities)
          .set({ state: 'cancelled', waitingUntil: null })
          .where(
            and(
              eq(translationActivities.id, a.id),
              eq(translationActivities.attempt, a.attempt),
              eq(translationActivities.state, 'cancelling'),
            ),
          );
    }
    const translateExports = await db()
      .select()
      .from(translationExports)
      .where(
        and(eq(translationExports.state, 'queued'), sql`${translationExports.expiresAt}>now()`),
      )
      .limit(20);
    for (const e of translateExports) {
      // Move legacy waiting exports off the long-running translation queue.
      const legacy = await translationQueue().getJob(`translation-export-${e.id}-${e.attempt}`);
      if ((await legacy?.getState()) === 'active') continue;
      if (legacy) await legacy.remove();
      await readingQueue().add(
        'translation-export',
        { id: e.id, attempt: e.attempt, kind: 'translation-export' },
        { jobId: `translation-export-${e.id}-${e.attempt}`, priority: 1 },
      );
      await db()
        .update(translationExports)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(translationExports.id, e.id), eq(translationExports.attempt, e.attempt)));
    }
    const cancellingTranslations = await db()
      .select()
      .from(translationExports)
      .where(eq(translationExports.state, 'cancelling'))
      .limit(50);
    for (const e of cancellingTranslations) {
      const q =
        (await readingQueue().getJob(`translation-export-${e.id}-${e.attempt}`)) ||
        (await translationQueue().getJob(`translation-export-${e.id}-${e.attempt}`));
      if ((await q?.getState()) !== 'active')
        await db()
          .update(translationExports)
          .set({ state: 'cancelled' })
          .where(
            and(
              eq(translationExports.id, e.id),
              eq(translationExports.attempt, e.attempt),
              eq(translationExports.state, 'cancelling'),
            ),
          );
    }
    const pendingExports = await db()
      .select()
      .from(transcriptExports)
      .where(
        and(
          eq(transcriptExports.state, 'queued'),
          isNull(transcriptExports.dispatchedAt),
          sql`${transcriptExports.expiresAt}>now()`,
        ),
      )
      .limit(20);
    for (const e of pendingExports) {
      await mediaQueue().add(
        'transcript-export',
        { id: e.id, attempt: e.attempt, kind: 'transcript-export' },
        { jobId: `transcript-export-${e.id}-${e.attempt}` },
      );
      await db()
        .update(transcriptExports)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(transcriptExports.id, e.id), eq(transcriptExports.attempt, e.attempt)));
    }
    const cancellingExports = await db()
      .select()
      .from(transcriptExports)
      .where(eq(transcriptExports.state, 'cancelling'))
      .limit(50);
    for (const e of cancellingExports) {
      const q = await mediaQueue().getJob(`transcript-export-${e.id}-${e.attempt}`);
      if ((await q?.getState()) !== 'active')
        await db()
          .update(transcriptExports)
          .set({ state: 'cancelled' })
          .where(
            and(
              eq(transcriptExports.id, e.id),
              eq(transcriptExports.attempt, e.attempt),
              eq(transcriptExports.state, 'cancelling'),
            ),
          );
    }
    const stalePreparations = await db()
      .select()
      .from(preparations)
      .where(lt(preparations.expiresAt, new Date()))
      .limit(100);
    for (const p of stalePreparations) {
      const q = await mediaQueue().getJob(`prepare-${p.id}-${p.attempt}`);
      if ((await q?.getState()) === 'active') continue;
      await deletePrefix(`preparations/${p.id}/`);
      await db().delete(preparations).where(eq(preparations.id, p.id));
    }
    const pendingArchives = await db()
      .select()
      .from(archives)
      .where(
        and(
          eq(archives.state, 'queued'),
          isNull(archives.dispatchedAt),
          sql`${archives.expiresAt}>now()`,
        ),
      )
      .limit(20);
    for (const archive of pendingArchives) {
      await mediaQueue().add(
        'archive',
        { id: archive.id, attempt: 1, kind: 'archive' },
        { jobId: `archive-${archive.id}` },
      );
      await db()
        .update(archives)
        .set({ dispatchedAt: new Date() })
        .where(eq(archives.id, archive.id));
    }
    const staleArchives = await db()
      .select()
      .from(archives)
      .where(or(eq(archives.state, 'expired'), lt(archives.expiresAt, new Date())))
      .limit(100);
    for (const archive of staleArchives) {
      await db().update(archives).set({ state: 'expired' }).where(eq(archives.id, archive.id));
      const queued = await mediaQueue().getJob(`archive-${archive.id}`);
      if ((await queued?.getState()) === 'active') continue;
      await deleteObject(archive.key);
      await db().delete(archives).where(eq(archives.id, archive.id));
    }
    const expired = await db()
      .select()
      .from(jobs)
      .where(
        or(
          eq(jobs.deleting, true),
          and(lt(jobs.expiresAt, new Date()), sql`${jobs.state}<>'expired'`),
          eq(jobs.state, 'cancelling'),
        ),
      )
      .limit(100);
    for (const job of expired) {
      if (['processing', 'cancelling'].includes(job.state)) {
        await db()
          .update(jobs)
          .set({ state: 'cancelling' })
          .where(and(eq(jobs.id, job.id), inArray(jobs.state, ['processing', 'cancelling'])));
        const queued = await queueForTool(job.tool).getJob(`${job.id}-${job.attempt}`);
        if ((await queued?.getState()) === 'active') continue;
        await db()
          .update(jobs)
          .set({ state: 'cancelled', updatedAt: new Date() })
          .where(and(eq(jobs.id, job.id), eq(jobs.state, 'cancelling')));
        continue;
      }
      if (!job.deleting && job.expiresAt > new Date()) continue;
      // Also catches old MP4 keys and uncommitted files from hard worker exits.
      if (job.batchId)
        await db()
          .update(archives)
          .set({ state: 'expired' })
          .where(eq(archives.batchId, job.batchId));
      if (isTranslationTool(job.tool) || job.tool === 'transcription') {
        const activities = await db()
          .select()
          .from(translationActivities)
          .where(eq(translationActivities.jobId, job.id));
        let readingActive = false;
        for (const a of activities) {
          const q = await readingQueue().getJob(`reading-${a.id}-${a.attempt}`);
          if ((await q?.getState()) === 'active') {
            readingActive = true;
            break;
          }
        }
        if (readingActive) continue;
        const exports = await db()
          .select()
          .from(translationExports)
          .where(eq(translationExports.jobId, job.id));
        let active = false;
        for (const e of exports) {
          const q =
            (await readingQueue().getJob(`translation-export-${e.id}-${e.attempt}`)) ||
            (await translationQueue().getJob(`translation-export-${e.id}-${e.attempt}`));
          if ((await q?.getState()) === 'active') {
            active = true;
            break;
          }
        }
        if (active) continue;
        await deletePrefix(`translations/${job.id}/`);
        await db().delete(translationActivities).where(eq(translationActivities.jobId, job.id));
        await db().delete(translationExports).where(eq(translationExports.jobId, job.id));
        await db().delete(translationSteps).where(eq(translationSteps.jobId, job.id));
        await db().delete(translationDocuments).where(eq(translationDocuments.jobId, job.id));
      }
      if (job.tool === 'transcription' || job.tool === 'video-translator') {
        const exports = await db()
          .select()
          .from(transcriptExports)
          .where(eq(transcriptExports.jobId, job.id));
        let active = false;
        for (const e of exports) {
          const q = await mediaQueue().getJob(`transcript-export-${e.id}-${e.attempt}`);
          if ((await q?.getState()) === 'active') {
            active = true;
            break;
          }
        }
        if (active) continue;
        await db().delete(transcripts).where(eq(transcripts.jobId, job.id));
        await db().delete(transcriptionChunks).where(eq(transcriptionChunks.jobId, job.id));
        await db().delete(transcriptExports).where(eq(transcriptExports.jobId, job.id));
        // A deleted transcript no longer needs its source/preview. Preserve shared editor inputs.
        if (job.deleting)
          await db()
            .update(preparations)
            .set({ expiresAt: new Date(0) })
            .where(
              and(
                inArray(preparations.assetId, job.sourceIds),
                sql`not exists(select 1 from job_inputs ji join jobs j on j.id=ji.job_id where ji.asset_id=preparations.asset_id and j.id<>${job.id} and not j.deleting and j.expires_at>now())`,
              ),
            );
      }
      if (isWatermarkTool(job.tool)) {
        const runs = await db().select().from(watermarkRuns).where(eq(watermarkRuns.jobId, job.id));
        let active = false;
        for (const run of runs) {
          const q = await watermarkQueue().getJob('watermark-run-' + run.id + '-' + run.attempt);
          if ((await q?.getState()) === 'active') {
            active = true;
            break;
          }
        }
        if (active) continue;
        await deletePrefix('watermarks/' + job.id + '/');
        await db().delete(watermarkRuns).where(eq(watermarkRuns.jobId, job.id));
        await db().delete(watermarkSteps).where(eq(watermarkSteps.jobId, job.id));
        await db().delete(watermarkDocuments).where(eq(watermarkDocuments.jobId, job.id));
      }
      await deletePrefix(`outputs/${job.id}/`);
      if (job.deleting) {
        await db()
          .delete(jobs)
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.deleting, true),
              inArray(jobs.state, ['queued', 'completed', 'failed', 'cancelled', 'expired']),
            ),
          );
        await db()
          .update(assets)
          .set({ state: 'deleting' })
          .where(
            and(
              inArray(assets.id, job.sourceIds),
              sql`not exists(select 1 from job_inputs where job_inputs.asset_id=assets.id)`,
              sql`not exists(select 1 from preparations where preparations.asset_id=assets.id and preparations.expires_at>now())`,
            ),
          );
      } else if (job.state !== 'expired')
        await db()
          .update(jobs)
          .set({ state: 'expired', outputKey: null, updatedAt: new Date() })
          .where(
            and(
              eq(jobs.id, job.id),
              inArray(jobs.state, ['queued', 'completed', 'failed', 'cancelled']),
            ),
          );
    }
    const staleAssets = await db()
      .select()
      .from(assets)
      .where(
        and(
          or(eq(assets.state, 'deleting'), lt(assets.expiresAt, new Date())),
          sql`${assets.state}<>'expired'`,
        ),
      )
      .limit(100);
    for (const asset of staleAssets) {
      const [active] = await db()
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(jobInputs, eq(jobInputs.jobId, jobs.id))
        .where(
          and(eq(jobInputs.assetId, asset.id), inArray(jobs.state, ['processing', 'cancelling'])),
        )
        .limit(1);
      const [preparing] = await db()
        .select()
        .from(preparations)
        .where(and(eq(preparations.assetId, asset.id), eq(preparations.state, 'processing')))
        .limit(1);
      if (active || preparing) continue;
      if (asset.uploadId) await abortUpload(asset.key, asset.uploadId);
      await deleteObject(asset.key);
      await db()
        .update(assets)
        .set({ state: 'expired', uploadId: null })
        .where(eq(assets.id, asset.id));
    }
  } catch (error) {
    console.error(
      'Maintenance will retry',
      error instanceof Error ? error.message : 'Unknown error',
    );
  } finally {
    maintaining = false;
  }
}
const interval = setInterval(() => void maintain(), 2000);
await maintain();
console.log(`FormatOwl media worker ready. Concurrency ${worker.opts.concurrency}.`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  for (const controller of controllers)
    controller.abort(new MediaError('WORKER_INTERRUPTED', 'Worker stopped'));
  await wmWorker.close();
  await watermarkQueue().close();
  await worker.close();
  await speechWorker.close();
  await translateWorker.close();
  await readerWorker.close();
  await readingQueue().close();
  await translationQueue().close();
  await transcriptionQueue().close();
  await mediaQueue().close();
  await sqlClient().end();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
