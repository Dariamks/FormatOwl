import { mkdir, mkdtemp, rm, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { db, eq, and, inArray, sql, sqlClient } from '@filemorph/core/db';
import {
  jobs,
  assets,
  transcripts,
  translationDocuments,
  translationSteps,
  translationExports,
  workerCapabilities,
} from '@filemorph/core/schema';
import {
  translationRoute,
  translationOptionsSchema,
  translationLimits,
  type TranslationData,
  type TranslationBlock,
  type TranslationBox,
} from '@filemorph/core/translation';
import { runProcess, MediaError } from '@filemorph/core/media';
import { downloadToFile, uploadFromFile, deleteObject } from '@filemorph/core/storage';
import { mimeForName } from '@filemorph/core/domain';
import { limits } from '@filemorph/core/config';
import { pythonBinary } from './processors';
import { processTranscription, callSpeech, type SpeechProvider } from './transcription';
import {
  translationProvider,
  type TranslationProvider,
  type ProviderResult,
  type ProviderRoute,
} from './translation-provider';
import { exportVideoTranslation } from './translation-video';
import { probeEditor } from './processors/editor';
import {
  inlineRequests,
  inlineBatches,
  parseFragmentResult,
} from '@filemorph/core/translation-inline';
const script = fileURLToPath(new URL('../python/translate_file.py', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
export async function documentPreview(source: string, temp: string, signal: AbortSignal) {
  const profile = join(temp, 'office-profile'),
    output = join(temp, 'office-output');
  await mkdir(join(profile, 'user'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(profile, 'user', 'registrymodifications.xcu'),
    `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
  );
  await runProcess(
    process.env.SOFFICE_PATH || 'soffice',
    [
      `-env:UserInstallation=${new URL(`file://${profile}`).href}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      '--convert-to',
      'pdf:writer_pdf_Export',
      '--outdir',
      output,
      source,
    ],
    signal,
    undefined,
    120000,
  );
  const file = join(
    output,
    source
      .split('/')
      .at(-1)!
      .replace(/\.[^.]+$/, '.pdf'),
  );
  if (!(await stat(file)).size)
    throw new MediaError('DOCUMENT_PROCESSING_FAILED', 'Document preview unavailable');
  await pythonTranslation({ action: 'check-preview', source: file }, temp, signal);
  return file;
}
export async function pythonTranslation(
  payload: Record<string, unknown>,
  temp: string,
  signal: AbortSignal,
): Promise<any> {
  const name = `params-${hash(JSON.stringify(payload))}`;
  const result = join(temp, `${name}.result.json`),
    params = join(temp, `${name}.json`);
  await writeFile(params, JSON.stringify({ ...payload, result }));
  try {
    await runProcess(pythonBinary, [script, params], signal, undefined, 600000);
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    const text = e instanceof Error ? e.message : '';
    const code = [
      'UNSAFE_DOCUMENT',
      'DOCUMENT_LIMIT',
      'TRANSLATION_LIMIT',
      'IMAGE_LIMIT',
      'TEXT_ENCODING',
      'ENCRYPTED_PDF',
      'ENCRYPTED_DOCUMENT',
      'SIGNED_PDF',
      'FONT_UNAVAILABLE',
      'DOCUMENT_ENGINE_UNAVAILABLE',
      'DOCUMENT_STRUCTURE_FAILED',
      'INLINE_MARKERS_INVALID',
    ].find((c) => text.includes(c));
    throw new MediaError(code || 'DOCUMENT_PROCESSING_FAILED', text.slice(-1000));
  }
  return JSON.parse(await readFile(result, 'utf8'));
}
export async function updateTranslationCapabilities(tempRoot: string) {
  const temp = await mkdtemp(join(tempRoot, 'translation-check-'));
  try {
    let subtitleBurn = false,
      documentRendering = false,
      complexText = false;
    try {
      const filters = await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner',
        '-filters',
      ]);
      subtitleBurn = /\bsubtitles\s+V->V/.test(filters);
    } catch {}
    try {
      const value = await pythonTranslation({ action: 'check' }, temp, AbortSignal.timeout(30000));
      documentRendering = value.documentRendering;
      complexText = value.complexText;
    } catch {}
    const data = { subtitleBurn, documentRendering, complexText };
    await db()
      .insert(workerCapabilities)
      .values({ id: 'translation', data })
      .onConflictDoUpdate({ target: workerCapabilities.id, set: { data, updatedAt: new Date() } });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function hydrate(id: string, data: TranslationData, folder: string, signal: AbortSignal) {
  await mkdir(folder, { recursive: true });
  for (const file of new Set(
    data.pages
      .flatMap((p) => [p.originalFile, p.backgroundFile, p.previewFile])
      .filter((v): v is string => !!v),
  )) {
    if (file.includes('..') || !/^[a-zA-Z0-9._-]+$/.test(file))
      throw new MediaError('INVALID_REQUEST', 'Invalid artifact');
    await downloadToFile(`translations/${id}/files/${file}`, join(folder, file), signal);
  }
}
async function uploadPages(id: string, data: TranslationData, folder: string, signal: AbortSignal) {
  for (const file of new Set(
    data.pages
      .flatMap((p) => [p.originalFile, p.backgroundFile, p.previewFile])
      .filter((v): v is string => !!v),
  ))
    await uploadFromFile(
      `translations/${id}/files/${file}`,
      join(folder, file),
      signal,
      mimeForName(file),
    );
}
async function providerStep(
  id: string,
  stepKey: string,
  kind: 'translate' | 'ocr' | 'repair',
  signal: AbortSignal,
  fn: (route: ProviderRoute) => Promise<ProviderResult>,
  validate?: (result: Record<string, unknown>) => boolean,
) {
  const where = and(eq(translationSteps.jobId, id), eq(translationSteps.stepKey, stepKey));
  const [old] = await db().select().from(translationSteps).where(where);
  if (old?.state === 'completed') {
    if (validate && !validate(old.result!)) {
      await db()
        .update(translationSteps)
        .set({
          state: 'failed',
          error: 'AI_INVALID_RESPONSE',
          updatedAt: new Date(),
        })
        .where(where);
      throw new MediaError(
        'AI_INVALID_RESPONSE',
        'Cached translation failed structural validation',
      );
    }
    return old.result!;
  }
  if (old && ['requesting', 'uncertain'].includes(old.state))
    throw new MediaError('AI_RESULT_UNKNOWN', 'Explicit retry required for uncertain request');
  const route = old?.providerConfig || translationRoute(kind);
  await db()
    .insert(translationSteps)
    .values({ jobId: id, stepKey, state: 'waiting', providerConfig: route })
    .onConflictDoUpdate({
      target: [translationSteps.jobId, translationSteps.stepKey],
      set: { state: 'waiting', error: null, providerConfig: route, updatedAt: new Date() },
    });
  try {
    signal.throwIfAborted();
    const r = await fn({
      ...route,
      onWait: async (until) => {
        await db()
          .update(translationDocuments)
          .set({ waitingUntil: until })
          .where(eq(translationDocuments.jobId, id));
        if (until)
          await db()
            .update(translationSteps)
            .set({ state: 'waiting', updatedAt: new Date() })
            .where(where);
      },
      onSending: async () => {
        await db()
          .update(translationSteps)
          .set({ state: 'requesting', updatedAt: new Date() })
          .where(where);
      },
    });
    if (kind === 'translate' && (typeof r.result.text !== 'string' || !r.result.text.trim())) {
      await db().update(translationSteps).set({ result: r.result }).where(where);
      throw new MediaError('AI_INVALID_RESPONSE', 'Empty translation');
    }
    if (validate && !validate(r.result)) {
      await db().update(translationSteps).set({ result: r.result }).where(where);
      throw new MediaError('AI_INVALID_RESPONSE', 'Invalid structured translation');
    }
    await db()
      .update(translationSteps)
      .set({
        state: 'completed',
        result: r.result,
        requestId: r.requestId,
        usage: r.usage,
        error: null,
        updatedAt: new Date(),
      })
      .where(where);
    return r.result;
  } catch (e) {
    const code = e instanceof MediaError ? e.code : 'AI_RESULT_UNKNOWN';
    const [currentStep] = await db().select().from(translationSteps).where(where);
    await db()
      .update(translationSteps)
      .set({
        state: [
          'AI_AUTH',
          'AI_RATE_LIMIT',
          'AI_REQUEST_FAILED',
          'AI_INVALID_RESPONSE',
          'AI_NOT_CONFIGURED',
        ].includes(code)
          ? 'failed'
          : currentStep?.state === 'waiting'
            ? 'waiting'
            : 'uncertain',
        error: code,
        updatedAt: new Date(),
      })
      .where(where);
    throw e;
  }
}
interface Context {
  job: typeof jobs.$inferSelect;
  source: string;
  temp: string;
  signal: AbortSignal;
}
async function translateContent(ctx: Context, provider: TranslationProvider) {
  const { job, source, temp, signal } = ctx,
    id = job.id,
    options = translationOptionsSchema.parse(job.options),
    folder = join(temp, 'files');
  await mkdir(folder, { recursive: true });
  const active = () =>
    sql`exists(select 1 from jobs where jobs.id=${id} and jobs.attempt=${job.attempt} and jobs.state='processing' and not jobs.deleting and jobs.expires_at>now())`;
  await db()
    .insert(translationDocuments)
    .values({ jobId: id, stage: 'extract' })
    .onConflictDoNothing();
  let [doc] = await db()
    .select()
    .from(translationDocuments)
    .where(eq(translationDocuments.jobId, id));
  let data = doc.data;
  const save = async (stage: string, completed = 0, total = 0) => {
    signal.throwIfAborted();
    const saved = await db()
      .update(translationDocuments)
      .set({ data, stage, completedUnits: completed, totalUnits: total, updatedAt: new Date() })
      .where(and(eq(translationDocuments.jobId, id), active()))
      .returning();
    if (!saved.length) throw new MediaError('CANCELLED', 'Task no longer active');
    await db()
      .update(jobs)
      .set({
        progress:
          stage === 'translate'
            ? 45 + Math.round((completed / Math.max(1, total)) * 35)
            : stage === 'repair'
              ? 80 + Math.round((completed / Math.max(1, total)) * 15)
              : 10,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.attempt, job.attempt), eq(jobs.state, 'processing')));
  };
  if (!data) {
    if (job.tool === 'video-translator') {
      const media = await probeEditor(source, signal);
      const [transcript] = await db().select().from(transcripts).where(eq(transcripts.jobId, id));
      if (!transcript) throw new MediaError('NO_RESULTS', 'Transcript unavailable');
      data = {
        format: 'video',
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        durationMs: transcript.data.durationMs,
        pages: [{ index: 0, width: media.width, height: media.height, title: 'Video' }],
        blocks: transcript.data.segments.map((s) => ({
          id: s.id,
          sourceText: s.text,
          translatedText: '',
          page: 0,
          kind: 'subtitle',
          startMs: s.startMs,
          endMs: s.endMs,
          speaker: transcript.data.speakers.find((v) => v.id === s.speakerId)?.name,
          style: { fontSize: 36, color: '#ffffff', align: 'center' },
          review: [],
          stale: false,
          keepOriginal: false,
        })),
      };
    } else {
      const [asset] = await db().select().from(assets).where(eq(assets.id, job.assetId));
      data = (await pythonTranslation(
        {
          action: 'extract',
          source,
          format: extname(asset.name).slice(1).toLowerCase(),
          folder,
          sourceLanguage: options.sourceLanguage,
          targetLanguage: options.targetLanguage,
        },
        temp,
        signal,
      )) as TranslationData;
      if (data.format === 'docx') {
        const preview = await documentPreview(source, temp, signal);
        await copyFile(preview, join(folder, 'original-preview.pdf'));
        data.pages[0].previewFile = 'original-preview.pdf';
      }
      await uploadPages(id, data, folder, signal);
    }
    await save('ocr');
  } else await hydrate(id, data, folder, signal);
  if (!data) throw new MediaError('NO_RESULTS', 'Missing translation document');
  if (!doc.operation) {
    for (const page of data.pages) {
      if (!page.needsOcr || !page.originalFile) continue;
      await save('ocr', page.index, data.pages.length);
      const { tiles } = await pythonTranslation(
        { action: 'tiles', source: join(folder, page.originalFile), folder: temp },
        temp,
        signal,
      );
      for (const tile of tiles as {
        file: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }[]) {
        const stepKey = `ocr:${page.index}:${tile.x}:${tile.y}`;
        const result = await providerStep(id, stepKey, 'ocr', signal, (route) =>
          provider.ocr(join(temp, tile.file), tile.width, tile.height, signal, route),
        );
        for (const [index, raw] of (
          result.blocks as {
            text: string;
            box: TranslationBox;
            kind: TranslationBlock['kind'];
            review: string[];
          }[]
        ).entries()) {
          const box = { ...raw.box, x: raw.box.x + tile.x, y: raw.box.y + tile.y };
          // Dedupe overlap and native PDF text using both geometry and normalized text.
          if (
            data.blocks.some(
              (b) => b.page === page.index && b.box && intersection(b.box, box) > 0.45,
            )
          )
            continue;
          const b: TranslationBlock = {
            id: `ocr-${page.index}-${tile.x}-${tile.y}-${index}`,
            page: page.index,
            sourceText: raw.text,
            translatedText: '',
            kind: raw.kind,
            box,
            originalBox: { ...box },
            style: {
              fontSize: Math.max(8, Math.min(96, box.height * 0.7)),
              color: '#111111',
              align: options.targetLanguage === 'ar' ? 'right' : 'left',
            },
            review: [...(raw.review || []), 'BACKGROUND_REVIEW'],
            stale: false,
            keepOriginal: raw.kind === 'formula',
            raster: true,
          };
          if (raw.text.includes('?')) b.review.push('OCR_REVIEW');
          data.blocks.push(b);
        }
        if (
          data.blocks.reduce((n, b) => n + b.sourceText.length, 0) >
            translationLimits.maxCharacters ||
          data.blocks.length > translationLimits.maxBlocks
        )
          throw new MediaError('TRANSLATION_LIMIT', 'Text exceeds translation limits');
        await save('ocr', page.index, data.pages.length);
      }
      const prepared =
        data.format === 'pdf'
          ? { blocks: data.blocks.filter((b) => b.page === page.index && b.raster) }
          : await pythonTranslation(
              {
                action: 'ocr-layout',
                source: join(folder, page.originalFile),
                blocks: data.blocks.filter((b) => b.page === page.index && b.raster),
              },
              temp,
              signal,
            );
      data.blocks = [
        ...data.blocks.filter((b) => b.page !== page.index || !b.raster),
        ...prepared.blocks,
      ];
      page.needsOcr = false;
      await save('ocr', page.index + 1, data.pages.length);
    }
  }
  if (!data.blocks.length) throw new MediaError('NO_RESULTS', 'No readable text found');
  if (data.format === 'pdf' && !doc.operation && !data.layoutEngine) {
    data = (await pythonTranslation(
      { action: 'structure-pdf', source, folder, data },
      temp,
      signal,
    )) as TranslationData;
    await save('translate');
  }
  const targets = doc.operation
    ? data.blocks.filter((b) => doc.operation!.blockIds.includes(b.id))
    : data.blocks;
  const translate = targets.filter(
    (b) =>
      !b.hidden && !b.keepOriginal && (!doc.operation || doc.operation.operation === 'translate'),
  );
  for (const [index, b] of translate.entries()) {
    if (b.translatedText && !b.stale && !doc.operation) {
      await save('translate', index + 1, translate.length);
      continue;
    }
    // Standalone punctuation, mathematical symbols and numbers have no language to
    // translate. Preserve their original glyphs and avoid charging for empty semantics.
    if (!/\p{L}/u.test(b.sourceText)) {
      b.translatedText = b.sourceText;
      b.stale = false;
      b.keepOriginal = true;
      await save('translate', index + 1, translate.length);
      continue;
    }
    if (b.inline?.length) {
      const translated = new Map<string, string>();
      if (translationRoute('translate').provider === 'openai') {
        for (const batch of inlineBatches(b)) {
          // Whitespace, punctuation and numeric fragments belong to the local document
          // structure. Keep them byte-for-byte and send only language-bearing slots.
          const semantic = batch.filter((p) => /[\p{L}\p{N}]/u.test(p.input));
          for (const p of batch) {
            if (!/\p{L}/u.test(p.input))
              translated.set(p.id, (translated.get(p.id) || '') + p.input);
          }
          if (!semantic.length) continue;
          const keys = semantic.map((_, i) => `t${i}`);
          const input = JSON.stringify(
            Object.fromEntries(semantic.map((p, i) => [keys[i], p.input])),
          );
          const context = semantic[0].context;
          const key = `translate:${b.id}:structured-v3-${hash(input + context + options.sourceLanguage + options.targetLanguage)}`;
          const result = await providerStep(
            id,
            key,
            'translate',
            signal,
            (route) =>
              provider.translate(input, options.sourceLanguage, options.targetLanguage, signal, {
                ...route,
                fragmentContext: context,
                fragmentKeys: keys,
              }),
            (result) => parseFragmentResult(String(result.text), keys) !== null,
          );
          const values = parseFragmentResult(String(result.text), keys)!;
          for (const [i, p] of semantic.entries())
            translated.set(p.id, (translated.get(p.id) || '') + values[i]);
        }
      } else {
        for (const { input, id: spanId, part, context } of inlineRequests(b)) {
          let text = input;
          if (/\p{L}/u.test(input)) {
            // Versioned keys cannot reuse old malformed marker responses. Each response
            // has one locally owned slot; formulas and style IDs never visit the model.
            const key = `translate:${b.id}:slot-v2-${spanId}-${part}-${hash(input + context + options.sourceLanguage + options.targetLanguage)}`;
            const result = await providerStep(id, key, 'translate', signal, (route) =>
              provider.translate(input, options.sourceLanguage, options.targetLanguage, signal, {
                ...route,
                fragmentContext: context,
              }),
            );
            text = `${input.match(/^\s*/)?.[0] || ''}${String(result.text).trim()}${input.match(/\s*$/)?.[0] || ''}`;
          }
          translated.set(spanId, (translated.get(spanId) || '') + text);
        }
      }
      b.translatedInline = [...translated].map(([id, text]) => ({ id, text }));
      b.translatedText = b.inline
        .map((s) => (s.protected ? s.text : translated.get(s.id) || ''))
        .join('');
      b.review = b.review.filter((r) => r !== 'INLINE_REVIEW');
      b.stale = false;
      await save('translate', index + 1, translate.length);
      continue;
    }
    // Bound each provider input without splitting a Unicode code point.
    const chunks = splitTranslationText(b.sourceText);
    const text: string[] = [];
    for (const [part, input] of chunks.entries()) {
      const key = `translate:${b.id}:${hash(input + options.sourceLanguage + options.targetLanguage)}-${part}`;
      const result = await providerStep(id, key, 'translate', signal, (route) =>
        provider.translate(input, options.sourceLanguage, options.targetLanguage, signal, route),
      );
      text.push(String(result.text));
    }
    b.translatedText = text.join('\n');
    if (!doc.operation && b.raster && b.translatedText.trim() === b.sourceText.trim())
      b.keepOriginal = true;
    b.stale = false;
    b.review = b.review.filter((r) => r !== 'TRANSLATION_FAILED');
    await save('translate', index + 1, translate.length);
  }
  const repair = targets.filter(
    (b) =>
      !b.hidden &&
      !(data.format === 'pdf' && (data.layoutVersion || 0) >= 3) &&
      !b.keepOriginal &&
      b.box &&
      b.raster !== false &&
      (!doc.operation || doc.operation.operation === 'repair'),
  );
  // A composite is immutable per run, so old exports continue to render their saved background.
  const backgrounds = new Map<number, string>();
  for (const [index, b] of repair.entries()) {
    const page = data.pages[b.page];
    if (!page.originalFile || !page.backgroundFile) continue;
    await save('repair', index, repair.length);
    const box = b.originalBox || b.box!,
      cropFile = join(temp, 'repair-input.png');
    const crop = await pythonTranslation(
      { action: 'crop', source: join(folder, page.originalFile), box, output: cropFile },
      temp,
      signal,
    );
    const stepKey = `repair:${b.id}:${hash(JSON.stringify(box) + b.sourceText)}`;
    const result = await providerStep(id, stepKey, 'repair', signal, async (route) => {
      const file = `repair-${hash(stepKey)}-${job.attempt}.png`;
      const local = await pythonTranslation(
        {
          action: 'flat-repair',
          source: join(folder, page.originalFile!),
          box,
          crop: cropFile,
          output: join(folder, file),
        },
        temp,
        signal,
      );
      let r: import('./translation-provider').ProviderResult = { result: { local: true } };
      if (!local.local) {
        r = await provider.repair(cropFile, signal, route);
        const bytes = await provider.image(String(r.result.url), signal);
        await writeFile(join(folder, file), bytes);
      }
      await uploadFromFile(
        `translations/${id}/files/${file}`,
        join(folder, file),
        signal,
        'image/png',
      );
      return { ...r, result: { file, crop } };
    });
    const patch = String(result.file);
    await downloadToFile(`translations/${id}/files/${patch}`, join(folder, patch), signal);
    let background = backgrounds.get(b.page);
    if (!background) {
      background = `composite-${b.page}-${job.attempt}-${doc.revision}.png`;
      await copyFile(join(folder, page.backgroundFile), join(folder, background));
      backgrounds.set(b.page, background);
    }
    await pythonTranslation(
      {
        action: 'compose',
        original: join(folder, page.originalFile),
        background: join(folder, background),
        patch: join(folder, patch),
        box,
        crop:
          result.crop ||
          (await pythonTranslation(
            { action: 'crop', legacy: true, source: join(folder, page.originalFile), box },
            temp,
            signal,
          )),
        output: join(folder, background),
      },
      temp,
      signal,
    );
    await uploadFromFile(
      `translations/${id}/files/${background}`,
      join(folder, background),
      signal,
      'image/png',
    );
    page.backgroundFile = background;
    await save('repair', index + 1, repair.length);
  }
  await db()
    .update(translationDocuments)
    .set({
      data,
      stage: 'ready',
      operation: null,
      waitingUntil: null,
      revision: doc.revision + 1,
      completedUnits: data.blocks.length,
      totalUnits: data.blocks.length,
      updatedAt: new Date(),
    })
    .where(and(eq(translationDocuments.jobId, id), active()));
}
function intersection(a: TranslationBox, b: TranslationBox) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}
export function splitTranslationText(text: string): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  while (chars.length) {
    let end = Math.min(2500, chars.length);
    if (end < chars.length) {
      for (let i = end; i > Math.max(0, end - 500); i--)
        if (/[。！？.!?\n]/.test(chars[i - 1])) {
          end = i;
          break;
        }
    }
    parts.push(chars.splice(0, end).join(''));
  }
  return parts;
}
export async function processTranslation(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  provider: TranslationProvider = translationProvider,
  speech: SpeechProvider = callSpeech,
) {
  const [candidate] = await db().select().from(jobs).where(eq(jobs.id, id));
  if (candidate?.tool === 'video-translator') {
    await db()
      .insert(translationDocuments)
      .values({ jobId: id, stage: 'speech' })
      .onConflictDoNothing();
    return processTranscription(id, attempt, controllers, activeTemp, tempRoot, speech, (ctx) =>
      translateContent(ctx, provider),
    );
  }
  return runTranslationTask(id, attempt, controllers, activeTemp, tempRoot, async (ctx) =>
    translateContent(ctx, provider),
  );
}
async function runTranslationTask(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  run: (ctx: Context) => Promise<void>,
) {
  const lease = await sqlClient().reserve();
  let locked = false,
    temp: string | undefined;
  const controller = new AbortController(),
    { signal } = controller;
  let checking = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [lock] =
      await lease`select pg_try_advisory_lock(hashtextextended(${id},0)) as locked,pg_backend_pid() as pid`;
    locked = lock.locked;
    if (!locked) return;
    const [job] = await db()
      .update(jobs)
      .set({ state: 'processing', progress: 1, error: null, updatedAt: new Date() })
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
    controllers.add(controller);
    timeout = setTimeout(
      () => controller.abort(new MediaError('TIMEOUT', 'Translation timed out')),
      limits.jobTimeoutMs,
    );
    interval = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const [pid] = await lease`select pg_backend_pid() as pid`;
        const [j] = await db().select().from(jobs).where(eq(jobs.id, id));
        if (
          pid.pid !== lock.pid ||
          !j ||
          j.attempt !== attempt ||
          j.state !== 'processing' ||
          j.deleting ||
          j.expiresAt <= new Date()
        )
          controller.abort(new MediaError('CANCELLED', 'Task cancelled'));
      } catch {
        controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost task state'));
      } finally {
        checking = false;
      }
    }, 750);
    const [a] = await db()
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, job.assetId),
          eq(assets.owner, job.owner),
          eq(assets.state, 'ready'),
          sql`${assets.expiresAt}>now()`,
        ),
      );
    if (!a) throw new MediaError('ASSET_NOT_FOUND', 'Source unavailable');
    temp = await mkdtemp(join(tempRoot, 'translation-'));
    activeTemp.add(temp);
    const source = join(temp, `source${extname(a.name)}`);
    await downloadToFile(a.key, source, signal);
    await run({ job, source, temp, signal });
    signal.throwIfAborted();
    await db()
      .update(jobs)
      .set({ state: 'completed', progress: 100, error: null, updatedAt: new Date() })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.attempt, attempt),
          eq(jobs.state, 'processing'),
          eq(jobs.deleting, false),
          sql`${jobs.expiresAt}>now()`,
        ),
      );
  } catch (e) {
    const reason = signal.aborted ? signal.reason : e,
      code = reason instanceof MediaError ? reason.code : 'TRANSLATION_FAILED';
    await db()
      .update(jobs)
      .set({
        state: code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: code === 'CANCELLED' ? null : code,
        errorDetail: reason instanceof Error ? reason.message.slice(-1000) : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.attempt, attempt),
          inArray(jobs.state, ['processing', 'cancelling']),
        ),
      );
    console.error(`Translation ${id}: ${code}`);
  } finally {
    clearInterval(interval);
    clearTimeout(timeout);
    controllers.delete(controller);
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
    if (locked) await lease`select pg_advisory_unlock(hashtextextended(${id},0))`.catch(() => {});
    lease.release();
  }
}
export async function processTranslationExport(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
) {
  const lease = await sqlClient().reserve();
  let locked = false,
    temp: string | undefined,
    key: string | undefined,
    previewKey: string | undefined,
    committed = false;
  const controller = new AbortController(),
    { signal } = controller;
  let checking = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [lock] =
      await lease`select pg_try_advisory_lock(hashtextextended(${id},0)) as locked,pg_backend_pid() as pid`;
    locked = lock.locked;
    if (!locked) return;
    const [e] = await db()
      .update(translationExports)
      .set({ state: 'processing', error: null })
      .where(
        and(
          eq(translationExports.id, id),
          eq(translationExports.attempt, attempt),
          inArray(translationExports.state, ['queued', 'processing']),
          sql`${translationExports.expiresAt}>now()`,
        ),
      )
      .returning();
    if (!e) return;
    const [row] = await db()
      .select({ j: jobs, a: assets })
      .from(jobs)
      .innerJoin(assets, eq(jobs.assetId, assets.id))
      .where(and(eq(jobs.id, e.jobId), eq(jobs.deleting, false), sql`${jobs.expiresAt}>now()`));
    if (!row) throw new MediaError('EXPIRED', 'Source expired');
    controllers.add(controller);
    timeout = setTimeout(
      () => controller.abort(new MediaError('TIMEOUT', 'Export timed out')),
      limits.jobTimeoutMs,
    );
    interval = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const [pid] = await lease`select pg_backend_pid() as pid`;
        const [r] = await db()
          .select({ e: translationExports, j: jobs })
          .from(translationExports)
          .innerJoin(jobs, eq(jobs.id, translationExports.jobId))
          .where(eq(translationExports.id, id));
        if (
          pid.pid !== lock.pid ||
          !r ||
          r.e.attempt !== attempt ||
          r.e.state !== 'processing' ||
          r.j.deleting ||
          r.j.expiresAt <= new Date()
        )
          controller.abort(new MediaError('CANCELLED', 'Export cancelled'));
      } catch {
        controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost export state'));
      } finally {
        checking = false;
      }
    }, 750);
    temp = await mkdtemp(join(tempRoot, 'translation-export-'));
    activeTemp.add(temp);
    const source = join(temp, `source${extname(row.a.name)}`),
      folder = join(temp, 'files'),
      output = join(temp, `translated.${e.options.format}`);
    await downloadToFile(row.a.key, source, signal);
    let overflow: string[] = [];
    if (row.j.tool === 'video-translator')
      await exportVideoTranslation(
        e.snapshot,
        e.options,
        row.j.options,
        source,
        output,
        temp,
        signal,
      );
    else {
      await hydrate(e.jobId, e.snapshot, folder, signal);
      const result = await pythonTranslation(
        { action: 'export', data: e.snapshot, options: e.options, source, folder, output },
        temp,
        signal,
      );
      overflow = result.overflow || [];
    }
    if (overflow.length) {
      await db().transaction(async (tx) => {
        const [doc] = await tx
          .select()
          .from(translationDocuments)
          .where(eq(translationDocuments.jobId, e.jobId))
          .for('update');
        if (doc?.data && doc.revision === e.revision) {
          for (const b of doc.data.blocks)
            if (overflow.includes(b.id) && !b.review.includes('TEXT_OVERFLOW'))
              b.review.push('TEXT_OVERFLOW');
          await tx
            .update(translationDocuments)
            .set({ data: doc.data, revision: doc.revision + 1 })
            .where(eq(translationDocuments.jobId, e.jobId));
        }
      });
      throw new MediaError('TEXT_OVERFLOW', 'Adjust marked text regions before export');
    }
    if ((await stat(output)).size > 4 * 1024 ** 3)
      throw new MediaError('OUTPUT_LIMIT', 'Export too large');
    key = `translations/${e.jobId}/exports/${id}/${attempt}.${e.options.format}`;
    const mime = mimeForName(output);
    await uploadFromFile(key, output, signal, mime);
    if (e.options.format === 'docx') {
      const preview = await documentPreview(output, temp, signal);
      previewKey = `translations/${e.jobId}/exports/${id}/${attempt}-preview.pdf`;
      await uploadFromFile(previewKey, preview, signal, 'application/pdf');
    }
    signal.throwIfAborted();
    const name = `${row.a.name.replace(/\.[^.]*$/, '')}-${e.options.mode}-v${e.revision}${e.options.preview ? '-preview' : ''}.${e.options.format}`;
    const saved = await db()
      .update(translationExports)
      .set({ state: 'completed', key, name, mime })
      .where(
        and(
          eq(translationExports.id, id),
          eq(translationExports.attempt, attempt),
          eq(translationExports.state, 'processing'),
          sql`exists(select 1 from jobs where jobs.id=${e.jobId} and not jobs.deleting and jobs.expires_at>now())`,
        ),
      )
      .returning();
    committed = !!saved.length;
  } catch (error) {
    const e = signal.aborted ? signal.reason : error;
    await db()
      .update(translationExports)
      .set({
        state: e instanceof MediaError && e.code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: e instanceof MediaError ? e.code : 'EXPORT_FAILED',
      })
      .where(
        and(
          eq(translationExports.id, id),
          eq(translationExports.attempt, attempt),
          inArray(translationExports.state, ['processing', 'cancelling']),
        ),
      );
    console.error('Translation export:', e instanceof Error ? e.message : 'failed');
  } finally {
    clearInterval(interval);
    clearTimeout(timeout);
    controllers.delete(controller);
    if (!committed && key) await deleteObject(key).catch(() => {});
    if (!committed && previewKey) await deleteObject(previewKey).catch(() => {});
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
    if (locked) await lease`select pg_advisory_unlock(hashtextextended(${id},0))`.catch(() => {});
    lease.release();
  }
}
