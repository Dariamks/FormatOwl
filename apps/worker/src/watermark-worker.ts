import sharp from 'sharp';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { db, eq, and, inArray, sql } from '@filemorph/core/db';
import {
  jobs,
  assets,
  watermarkDocuments,
  watermarkRuns,
  watermarkSteps,
} from '@filemorph/core/schema';
import { translationRoute, type TranslationBox } from '@filemorph/core/translation';
import {
  type WatermarkData,
  type WatermarkRegion,
  type WatermarkSelection,
  type WatermarkCandidate,
} from '@filemorph/core/watermark';
import { watermarkCapabilities } from '@filemorph/core/watermarks';
import { downloadToFile, uploadFromFile } from '@filemorph/core/storage';
import { mimeForName } from '@filemorph/core/domain';
import { runProcess, MediaError } from '@filemorph/core/media';
import { pythonBinary } from './processors';
import {
  translationProvider,
  type TranslationProvider,
  type ProviderResult,
  type ProviderRoute,
} from './translation-provider';
const script = fileURLToPath(new URL('../python/watermark_file.py', import.meta.url));
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex')
    .slice(0, 32);
const codes = [
  'UNSUPPORTED_ANIMATION',
  'IMAGE_LIMIT',
  'ENCRYPTED_PDF',
  'SIGNED_PDF',
  'DOCUMENT_LIMIT',
  'WATERMARK_OBJECT_LIMIT',
  'UNSAFE_DOCUMENT',
  'WATERMARK_UNSUPPORTED',
  'WATERMARK_TEXT_OVERLAP',
  'WATERMARK_EMPTY',
];
export async function pythonWatermark(
  payload: Record<string, unknown>,
  folder: string,
  signal: AbortSignal,
): Promise<any> {
  const id = randomUUID(),
    params = join(folder, id + '.json'),
    result = join(folder, id + '.result.json');
  await writeFile(params, JSON.stringify({ ...payload, result }));
  try {
    await runProcess(pythonBinary, [script, params], signal, undefined, 600000);
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    const message = String(e);
    throw new MediaError(
      codes.find((c) => message.includes(c)) || 'DOCUMENT_PROCESSING_FAILED',
      message.slice(-800),
    );
  }
  return JSON.parse(await readFile(result, 'utf8'));
}
async function aiStep(
  id: string,
  key: string,
  kind: 'ocr' | 'repair',
  signal: AbortSignal,
  fn: (route: ProviderRoute) => Promise<ProviderResult>,
) {
  const where = and(eq(watermarkSteps.jobId, id), eq(watermarkSteps.stepKey, key));
  const [old] = await db().select().from(watermarkSteps).where(where);
  if (old?.state === 'completed') return old.result!;
  if (old && ['sending', 'uncertain'].includes(old.state))
    throw new MediaError('AI_RESULT_UNKNOWN', 'Explicit retry required');
  const route = old?.providerConfig || translationRoute(kind);
  await db()
    .insert(watermarkSteps)
    .values({ jobId: id, stepKey: key, state: 'waiting', providerConfig: route })
    .onConflictDoUpdate({
      target: [watermarkSteps.jobId, watermarkSteps.stepKey],
      set: { state: 'waiting', error: null },
      setWhere: eq(watermarkSteps.state, 'pending'),
    });
  let sent = false;
  try {
    signal.throwIfAborted();
    const r = await fn({
      ...route,
      onSending: async () => {
        const claimed = await db()
          .update(watermarkSteps)
          .set({ state: 'sending' })
          .where(and(where, eq(watermarkSteps.state, sent ? 'sending' : 'waiting')))
          .returning();
        if (!claimed.length)
          throw new MediaError('AI_RESULT_UNKNOWN', 'Another attempt owns this request');
        sent = true;
      },
    });
    await db()
      .update(watermarkSteps)
      .set({
        state: 'completed',
        result: r.result,
        requestId: r.requestId,
        usage: r.usage,
        error: null,
      })
      .where(where);
    return r.result;
  } catch (e) {
    if (!sent) throw e;
    const [current] = await db().select().from(watermarkSteps).where(where);
    await db()
      .update(watermarkSteps)
      .set({
        state:
          current?.state === 'sending' &&
          !(
            e instanceof MediaError && ['AI_QUOTA', 'AI_AUTH', 'AI_REQUEST_FAILED'].includes(e.code)
          )
            ? 'uncertain'
            : 'pending',
        error: e instanceof MediaError ? e.code : 'AI_RESULT_UNKNOWN',
      })
      .where(where);
    throw e;
  }
}
type OcrBlock = { text: string; box: TranslationBox; review?: string[] };
// Re-detection preserves checked candidates and manual masks. Match by content
// and overlap, not OCR array order, which may change between provider versions.
export function mergeDetectedCandidates(
  data: WatermarkData,
  selection: WatermarkSelection,
  targetId: string,
  candidates: WatermarkCandidate[],
) {
  const previous = data.candidates.filter((c) => c.reason === 'ocr' && c.targetId === targetId);
  const available = [...previous];
  const updated = candidates.map((candidate) => {
    const region = candidate.region!;
    const index = available.findIndex((old) => {
      const r = old.region;
      return (
        old.label === candidate.label &&
        r &&
        r.x < region.x + region.width &&
        r.x + r.width > region.x &&
        r.y < region.y + region.height &&
        r.y + r.height > region.y
      );
    });
    const old = index < 0 ? undefined : available.splice(index, 1)[0];
    return old
      ? { ...candidate, id: old.id, region: { ...region, id: old.region!.id } }
      : candidate;
  });
  const nextData = {
    ...data,
    candidates: [...data.candidates.filter((c) => !previous.includes(c)), ...updated],
    detected: [...new Set([...data.detected, targetId])],
  };
  const nextSelection = {
    ...selection,
    candidates: selection.candidates.filter((id) => nextData.candidates.some((c) => c.id === id)),
  };
  return {
    data: nextData,
    selection: nextSelection,
    changed: !isDeepStrictEqual(data, nextData) || !isDeepStrictEqual(selection, nextSelection),
  };
}
const suspect = (b: OcrBlock) =>
  /watermark|draft|confidential|sample|preview|copyright|水印|机密|草稿|样本|内部资料/i.test(
    b.text,
  ) || Math.abs(b.box.angle) > 12;
// A rotated paragraph or a sentence containing “draft” is still body text. Raster
// PDF repair accepts only unambiguous short watermark labels; other text is protected.
export function scanTextIsProtected(b: OcrBlock) {
  return (
    !!b.review?.length ||
    !/^(draft|confidential|sample|preview|watermark|水印|机密|草稿|样本|内部资料)(\s+(copy|only|副本))?$/i.test(
      b.text.trim(),
    )
  );
}
async function recognize(
  id: string,
  target: WatermarkData['targets'][number],
  folder: string,
  signal: AbortSignal,
  provider: TranslationProvider,
) {
  if (!watermarkCapabilities().ocr)
    throw new MediaError('AI_NOT_CONFIGURED', 'OCR is required for text protection');
  const contentHash = createHash('sha256')
    .update(await readFile(join(folder, target.file)))
    .digest('hex');
  const small = join(folder, 'ocr-input.png');
  const meta = await sharp(join(folder, target.file), { limitInputPixels: 100_000_000 })
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(small);
  const result = await aiStep(
    id,
    'ocr-v1-' + hash([contentHash, translationRoute('ocr')]),
    'ocr',
    signal,
    async (route) => {
      const r = await provider.ocr(small, meta.width, meta.height, signal, route);
      const blocks = (r.result.blocks as OcrBlock[]).map((b) => ({
        ...b,
        box: {
          ...b.box,
          x: (b.box.x * target.width) / meta.width,
          y: (b.box.y * target.height) / meta.height,
          width: (b.box.width * target.width) / meta.width,
          height: (b.box.height * target.height) / meta.height,
        },
      }));
      return { ...r, result: { blocks } };
    },
  );
  if (!Array.isArray(result.blocks))
    throw new MediaError('AI_INVALID_RESPONSE', 'Missing OCR blocks');
  return result.blocks as OcrBlock[];
}
async function hydrate(id: string, data: WatermarkData, folder: string, signal: AbortSignal) {
  for (const file of new Set([
    ...data.pages.map((p) => p.file),
    ...data.targets.map((t) => t.file),
  ])) {
    if (!/^[a-zA-Z0-9._-]+$/.test(file))
      throw new MediaError('INVALID_REQUEST', 'Invalid artifact');
    await downloadToFile('watermarks/' + id + '/' + file, join(folder, file), signal);
  }
}
async function repairs(
  id: string,
  data: WatermarkData,
  selection: WatermarkSelection,
  folder: string,
  signal: AbortSignal,
  provider: TranslationProvider,
) {
  const regions = [
    ...selection.regions,
    ...data.candidates
      .filter((c) => selection.candidates.includes(c.id) && c.region)
      .map((c) => c.region!),
  ];
  const patches: Record<string, string> = {};
  for (const target of data.targets) {
    const chosen = regions.filter((r) => r.targetId === target.id);
    if (!chosen.length) continue;
    const source = join(folder, target.file),
      contentHash = createHash('sha256')
        .update(await readFile(source))
        .digest('hex');
    const output = join(folder, 'fixed-' + target.id + '.png');
    let protectedBoxes: TranslationBox[] = [];
    if (target.strict) {
      const blocks = await recognize(id, target, folder, signal, provider);
      // Scanned PDFs never repair through ordinary document text, even with a manual selection.
      protectedBoxes = blocks.filter(scanTextIsProtected).map((b) => b.box);
    }
    const mask = join(folder, 'mask.png'),
      crop = join(folder, 'crop.png'),
      cropMask = join(folder, 'crop-mask.png');
    const prep = await pythonWatermark(
      {
        action: 'prepare-repair',
        source,
        regions: chosen,
        protected: protectedBoxes,
        mask,
        crop,
        cropMask,
        output,
      },
      folder,
      signal,
    );
    const key = 'repair-v2-' + hash([contentHash, prep.maskHash, translationRoute('repair')]);
    const [cached] = await db()
      .select()
      .from(watermarkSteps)
      .where(and(eq(watermarkSteps.jobId, id), eq(watermarkSteps.stepKey, key)));
    if (cached?.state === 'completed' && typeof cached.result?.file === 'string') {
      await downloadToFile('watermarks/' + id + '/' + cached.result.file, output, signal);
      patches[target.id] = output;
      continue;
    }
    const stored = 'repair-' + key + '.png';
    if (prep.local) {
      await uploadFromFile('watermarks/' + id + '/' + stored, output, signal, 'image/png');
      await db()
        .insert(watermarkSteps)
        .values({ jobId: id, stepKey: key, state: 'completed', result: { file: stored } })
        .onConflictDoUpdate({
          target: [watermarkSteps.jobId, watermarkSteps.stepKey],
          set: { state: 'completed', result: { file: stored } },
        });
    } else {
      if (!watermarkCapabilities().repair)
        throw new MediaError('AI_NOT_CONFIGURED', 'Repair service is not configured');
      await aiStep(id, key, 'repair', signal, async (route) => {
        const r = await provider.repair(crop, signal, route, cropMask),
          bytes = await provider.image(String(r.result.url), signal),
          patch = join(folder, 'patch.png');
        await writeFile(patch, bytes);
        await pythonWatermark(
          { action: 'compose', source, mask, patch, box: prep.box, output },
          folder,
          signal,
        );
        await uploadFromFile('watermarks/' + id + '/' + stored, output, signal, 'image/png');
        return { ...r, result: { file: stored } };
      });
      // A recovered completed call can return without rebuilding this local file.
      await downloadToFile('watermarks/' + id + '/' + stored, output, signal);
    }
    patches[target.id] = output;
  }
  return patches;
}
export async function processWatermark(
  id: string,
  attempt: number,
  kind: 'analyze' | 'run',
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  provider: TranslationProvider = translationProvider,
) {
  const table = kind === 'run' ? watermarkRuns : jobs;
  const [claimed] = await db()
    .update(table)
    .set({ state: 'processing', progress: 1, error: null })
    .where(
      and(
        eq(table.id, id),
        eq(table.attempt, attempt),
        inArray(table.state, ['queued', 'processing']),
      ),
    )
    .returning();
  if (!claimed) return;
  const run = kind === 'run' ? (claimed as typeof watermarkRuns.$inferSelect) : undefined;
  const jobId = run?.jobId || id;
  const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId));
  const controller = new AbortController();
  controllers.add(controller);
  const { signal } = controller;
  let folder: string | undefined,
    checking = false;
  const timeout = setTimeout(
    () => controller.abort(new MediaError('TIMEOUT', 'Watermark processing timed out')),
    3600000,
  );
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const [j] = await db().select().from(jobs).where(eq(jobs.id, jobId));
      const [r] = await db().select().from(table).where(eq(table.id, id));
      if (
        !j ||
        !r ||
        j.deleting ||
        j.expiresAt <= new Date() ||
        r.state === 'cancelling' ||
        r.attempt !== attempt
      )
        controller.abort(new MediaError('CANCELLED', 'Cancelled'));
    } catch {
      controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost task state'));
    } finally {
      checking = false;
    }
  }, 750);
  try {
    if (!job || job.deleting || job.expiresAt <= new Date())
      throw new MediaError('CANCELLED', 'Expired');
    const [asset] = await db()
      .select()
      .from(assets)
      .where(
        and(eq(assets.id, job.assetId), eq(assets.owner, job.owner), eq(assets.state, 'ready')),
      );
    if (!asset) throw new MediaError('ASSET_NOT_FOUND', 'Missing source');
    folder = await mkdtemp(join(tempRoot, 'watermark-'));
    activeTemp.add(folder);
    const source = join(folder, 'source' + extname(asset.name).toLowerCase());
    await downloadToFile(asset.key, source, signal);
    if (!run) {
      const data = (await pythonWatermark(
        { action: 'analyze', source, format: extname(asset.name).slice(1).toLowerCase(), folder },
        folder,
        signal,
      )) as WatermarkData;
      for (const file of new Set([
        ...data.pages.map((p) => p.file),
        ...data.targets.map((t) => t.file),
      ]))
        await uploadFromFile(
          'watermarks/' + jobId + '/' + file,
          join(folder, file),
          signal,
          'image/png',
        );
      signal.throwIfAborted();
      await db().transaction(async (tx) => {
        const [current] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
        if (
          !current ||
          current.state !== 'processing' ||
          current.attempt !== attempt ||
          current.deleting ||
          current.expiresAt <= new Date()
        )
          throw new MediaError('CANCELLED', 'Cancelled');
        await tx.insert(watermarkDocuments).values({ jobId, data }).onConflictDoNothing();
        await tx
          .update(jobs)
          .set({ state: 'completed', progress: 100, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
      });
    } else {
      const { data } = run.snapshot;
      await hydrate(jobId, data, folder, signal);
      if (run.options.kind === 'detect') {
        const target = data.targets.find((t) => t.id === run.options.targetId)!;
        const blocks = await recognize(jobId, target, folder, signal, provider);
        const suspects = blocks.filter(
          (b) =>
            suspect(b) ||
            (!target.strict &&
              (b.box.y < target.height * 0.15 || b.box.y + b.box.height > target.height * 0.82)),
        );
        const refined = (await pythonWatermark(
          {
            action: 'refine-regions',
            source: join(folder, target.file),
            boxes: suspects.map((b) => b.box),
            protected: blocks.map((b) => b.box),
            strict: target.strict,
          },
          folder,
          signal,
        )) as { boxes: TranslationBox[] };
        const candidates: WatermarkCandidate[] = suspects.map((b, i) => {
          const box = refined.boxes[i],
            region: WatermarkRegion = {
              id: randomUUID(),
              targetId: target.id,
              kind: 'rect',
              x: box.x / target.width,
              y: box.y / target.height,
              width: box.width / target.width,
              height: box.height / target.height,
              strokes: [],
            };
          return {
            id: 'ocr-' + hash([target.id, b.text, b.box]),
            label: b.text,
            reason: 'ocr',
            pages: target.pages,
            boxes:
              target.id === 'image'
                ? [
                    {
                      page: 0,
                      x: region.x,
                      y: region.y,
                      width: region.width,
                      height: region.height,
                    },
                  ]
                : [],
            scope: target.label,
            group: hash(b.text),
            targetId: target.id,
            region,
          };
        });
        signal.throwIfAborted();
        await db().transaction(async (tx) => {
          const [parent] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
          const [currentRun] = await tx
            .select()
            .from(watermarkRuns)
            .where(eq(watermarkRuns.id, run.id))
            .for('update');
          if (
            !parent ||
            parent.deleting ||
            parent.expiresAt <= new Date() ||
            currentRun?.state !== 'processing' ||
            currentRun.attempt !== attempt
          )
            throw new MediaError('CANCELLED', 'Cancelled');
          const [doc] = await tx
            .select()
            .from(watermarkDocuments)
            .where(eq(watermarkDocuments.jobId, jobId))
            .for('update');
          if (!doc?.data) throw new MediaError('CANCELLED', 'Deleted document');
          const updated = mergeDetectedCandidates(doc.data, doc.selection, target.id, candidates);
          if (updated.changed) {
            await tx
              .update(watermarkDocuments)
              .set({
                data: updated.data,
                selection: updated.selection,
                revision: doc.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(watermarkDocuments.jobId, jobId));
          }
        });
        await finishRun(run, { pages: [] }, signal);
      } else {
        const selected = structuredClone(run.snapshot.selection),
          page = run.options.page;
        if (run.options.kind === 'preview') {
          selected.candidates = selected.candidates.filter((id) =>
            data.candidates.find((c) => c.id === id)?.pages.includes(page!),
          );
          selected.regions = selected.regions.filter((r) =>
            data.targets.find((t) => t.id === r.targetId)?.pages.includes(page!),
          );
        }
        const patches = await repairs(jobId, data, selected, folder, signal, provider);
        await db()
          .update(watermarkRuns)
          .set({ progress: 70 })
          .where(and(eq(watermarkRuns.id, id), eq(watermarkRuns.attempt, attempt)));
        const format =
            run.options.format ||
            (['jpg', 'jpeg', 'png', 'webp'].includes(data.format) ? 'png' : data.format),
          output = join(folder, 'result.' + format),
          prefix = 'run-' + id + '-' + attempt;
        const rendered = await pythonWatermark(
          {
            action: 'export',
            source,
            folder,
            data,
            selection: selected,
            patches,
            output,
            format,
            prefix,
            pages: run.options.kind === 'preview' ? [page] : undefined,
          },
          folder,
          signal,
        );
        const pages: { index: number; file: string }[] = rendered.pages.map((p: any) => ({
          index: p.index,
          file: p.file,
        }));
        for (const p of pages)
          await uploadFromFile(
            'watermarks/' + jobId + '/' + p.file,
            join(folder, p.file),
            signal,
            'image/png',
          );
        const file = prefix + '.' + format,
          name = asset.name.replace(/\.[^.]+$/, '') + '-formatowl.' + format;
        if ((await stat(output)).size > 512 * 1024 ** 2)
          throw new MediaError('OUTPUT_TOO_LARGE', 'Output too large');
        await uploadFromFile('watermarks/' + jobId + '/' + file, output, signal, mimeForName(file));
        await finishRun(
          run,
          {
            pages,
            ...(run.options.kind === 'export' ? { file, name, mime: mimeForName(file) } : {}),
          },
          signal,
        );
      }
    }
  } catch (e) {
    const error = signal.aborted ? signal.reason : e;
    const code = error instanceof MediaError ? error.code : 'DOCUMENT_PROCESSING_FAILED';
    await db()
      .update(table)
      .set({ state: code === 'CANCELLED' ? 'cancelled' : 'failed', error: code })
      .where(
        and(
          eq(table.id, id),
          eq(table.attempt, attempt),
          inArray(table.state, ['processing', 'cancelling']),
        ),
      );
    console.error(
      'Watermark processing:',
      code,
      error instanceof Error ? error.message.slice(-600) : '',
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
    controllers.delete(controller);
    if (folder) {
      activeTemp.delete(folder);
      await rm(folder, { recursive: true, force: true });
    }
  }
}
async function finishRun(
  run: typeof watermarkRuns.$inferSelect,
  result: NonNullable<typeof watermarkRuns.$inferSelect.result>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await db().transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, run.jobId)).for('update');
    if (!job || job.deleting || job.expiresAt <= new Date())
      throw new MediaError('CANCELLED', 'Deleted or expired');
    const saved = await tx
      .update(watermarkRuns)
      .set({ state: 'completed', progress: 100, result })
      .where(
        and(
          eq(watermarkRuns.id, run.id),
          eq(watermarkRuns.attempt, run.attempt),
          eq(watermarkRuns.state, 'processing'),
        ),
      )
      .returning();
    if (!saved.length) throw new MediaError('CANCELLED', 'Cancelled');
  });
}
