import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { db, eq, and, inArray, sql, sqlClient } from '@filemorph/core/db';
import {
  jobs,
  assets,
  translationActivities,
  translationSteps,
  translationDocuments,
} from '@filemorph/core/schema';
import {
  readingBlocks,
  validateReadingResult,
  type ReadingOptions,
  type ReadingResult,
  type PreviewResult,
} from '@filemorph/core/reading';
import { translationRoute, type TranslationData } from '@filemorph/core/translation';
import { mindmapLayout, mindmapSvg } from '@filemorph/core/mindmap';
import { downloadToFile, uploadFromFile, deletePrefix } from '@filemorph/core/storage';
import { MediaError } from '@filemorph/core/media';
import { limits } from '@filemorph/core/config';
import { pythonTranslation, documentPreview } from './translation-worker';
import { callReading, type ReadingProvider } from './reading-provider';
import { readingMarkdown } from '@filemorph/core/reading-markdown';
export { readingMarkdown } from '@filemorph/core/reading-markdown';
type Activity = typeof translationActivities.$inferSelect;

export function readingChunks(data: TranslationData, max = 40000) {
  const chunks: ReturnType<typeof readingBlocks>[] = [];
  let current: ReturnType<typeof readingBlocks> = [],
    size = 0;
  for (const b of readingBlocks(data)) {
    // Keep stable IDs even if one exceptional paragraph needs several context slices.
    const slices = Math.max(1, Math.ceil(Math.max(b.source.length, b.translation.length) / 12000));
    for (let i = 0; i < slices; i++) {
      const part = {
        ...b,
        source: b.source.slice(i * 12000, (i + 1) * 12000),
        translation: b.translation.slice(i * 12000, (i + 1) * 12000),
      };
      const length = JSON.stringify(part).length;
      if (current.length && size + length > max) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(part);
      size += length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}
async function readingStep(
  a: Activity,
  key: string,
  input: unknown,
  options: ReadingOptions,
  signal: AbortSignal,
  provider: ReadingProvider,
) {
  const stepKey = `reading:${a.id}:${key}`,
    where = and(eq(translationSteps.jobId, a.jobId), eq(translationSteps.stepKey, stepKey));
  const [old] = await db().select().from(translationSteps).where(where);
  if (old?.state === 'completed')
    return validateReadingResult(old.result, a.snapshot, options.kind);
  if (old && ['requesting', 'uncertain'].includes(old.state))
    throw new MediaError('AI_RESULT_UNKNOWN', 'Explicit retry required');
  const route = old?.providerConfig || translationRoute('reading');
  await db()
    .insert(translationSteps)
    .values({ jobId: a.jobId, stepKey, state: 'waiting', providerConfig: route })
    .onConflictDoUpdate({
      target: [translationSteps.jobId, translationSteps.stepKey],
      set: { state: 'waiting', error: null, updatedAt: new Date() },
    });
  try {
    const r = await provider(input, options, signal, {
      ...route,
      onWait: async (until) => {
        await db()
          .update(translationActivities)
          .set({ waitingUntil: until })
          .where(eq(translationActivities.id, a.id));
        if (until) await db().update(translationSteps).set({ state: 'waiting' }).where(where);
      },
      onSending: async () => {
        await db()
          .update(translationSteps)
          .set({ state: 'requesting', updatedAt: new Date() })
          .where(where);
      },
    });
    let result: ReadingResult;
    try {
      result = validateReadingResult(r.result, a.snapshot, options.kind);
    } catch (e) {
      await db()
        .update(translationSteps)
        .set({ result: r.result, requestId: r.requestId, usage: r.usage })
        .where(where);
      throw new MediaError(
        'AI_INVALID_RESPONSE',
        `Reading validation: ${e instanceof Error ? e.message.slice(0, 200) : 'invalid result'}`,
      );
    }
    await db()
      .update(translationSteps)
      .set({
        state: 'completed',
        result,
        requestId: r.requestId,
        usage: r.usage,
        updatedAt: new Date(),
      })
      .where(where);
    return result;
  } catch (e) {
    const code = e instanceof MediaError ? e.code : 'AI_RESULT_UNKNOWN';
    const [current] = await db().select().from(translationSteps).where(where);
    await db()
      .update(translationSteps)
      .set({
        state:
          current?.state === 'waiting'
            ? 'waiting'
            : ['AI_AUTH', 'AI_REQUEST_FAILED', 'AI_INVALID_RESPONSE', 'AI_NOT_CONFIGURED'].includes(
                  code,
                )
              ? 'failed'
              : 'uncertain',
        error: code,
        updatedAt: new Date(),
      })
      .where(where);
    throw e;
  }
}
async function renderPreview(
  a: Activity,
  temp: string,
  source: string,
  signal: AbortSignal,
): Promise<{ result: PreviewResult; output: string; upgraded?: TranslationData }> {
  const data = a.snapshot,
    folder = join(temp, 'files');
  await mkdir(folder, { recursive: true });
  if (data.format === 'pdf' && ((data.layoutVersion || 0) >= 3 || a.options.optimizeLayout)) {
    for (const file of new Set(
      data.pages.map((p) => p.originalFile).filter((f): f is string => !!f),
    )) {
      if (!/^[a-zA-Z0-9._-]+$/.test(file) || file.includes('..'))
        throw new MediaError('INVALID_REQUEST', 'Invalid artifact');
      await downloadToFile(`translations/${a.jobId}/files/${file}`, join(folder, file), signal);
    }
    const upgraded = a.options.optimizeLayout
      ? ((await pythonTranslation(
          { action: 'structure-pdf', data, source, folder, preserve: true },
          temp,
          signal,
        )) as TranslationData)
      : undefined;
    const output = join(temp, 'preview.pdf');
    const result = await pythonTranslation(
      { action: 'reflow', data: upgraded || data, folder, output },
      temp,
      signal,
    );
    return { output, result, upgraded };
  }
  if (data.format === 'docx') {
    const docx = join(temp, 'translated.docx');
    await pythonTranslation(
      {
        action: 'export',
        data,
        folder,
        source,
        output: docx,
        options: { format: 'docx', mode: 'translated' },
      },
      temp,
      signal,
    );
    return {
      output: await documentPreview(docx, temp, signal),
      result: { format: 'pdf', overflow: [], regions: [] },
    };
  }
  const page = data.pages[a.options.page];
  for (const file of new Set(
    [page.originalFile, page.backgroundFile].filter((v): v is string => !!v),
  )) {
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) throw new MediaError('INVALID_REQUEST', 'Invalid page');
    await downloadToFile(`translations/${a.jobId}/files/${file}`, join(folder, file), signal);
  }
  const output = join(temp, 'preview.png');
  const result = await pythonTranslation(
    { action: 'preview', data, page: a.options.page, folder, output },
    temp,
    signal,
  );
  return { output, result: { ...result, format: 'png' } };
}
export async function processReading(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  provider: ReadingProvider = callReading,
) {
  const lease = await sqlClient().reserve();
  let locked = false,
    temp: string | undefined,
    prefix: string | undefined,
    committed = false;
  const controller = new AbortController(),
    { signal } = controller;
  let timer: ReturnType<typeof setInterval> | undefined,
    timeout: ReturnType<typeof setTimeout> | undefined,
    checking = false;
  try {
    const [lock] =
      await lease`select pg_try_advisory_lock(hashtextextended(${id},0)) as locked,pg_backend_pid() as pid`;
    locked = lock.locked;
    if (!locked) return;
    const [a] = await db()
      .update(translationActivities)
      .set({ state: 'processing', error: null })
      .where(
        and(
          eq(translationActivities.id, id),
          eq(translationActivities.attempt, attempt),
          inArray(translationActivities.state, ['queued', 'processing']),
          sql`${translationActivities.expiresAt}>now()`,
        ),
      )
      .returning();
    if (!a) return;
    controllers.add(controller);
    timeout = setTimeout(
      () => controller.abort(new MediaError('TIMEOUT', 'Reading timed out')),
      limits.jobTimeoutMs,
    );
    const check = async () => {
      const [pid] = await lease`select pg_backend_pid() as pid`;
      const [row] = await db()
        .select({ a: translationActivities, j: jobs })
        .from(translationActivities)
        .innerJoin(jobs, eq(jobs.id, translationActivities.jobId))
        .where(eq(translationActivities.id, id));
      if (
        pid.pid !== lock.pid ||
        !row ||
        row.a.attempt !== attempt ||
        row.a.state !== 'processing' ||
        row.j.deleting ||
        row.j.expiresAt <= new Date()
      )
        controller.abort(new MediaError('CANCELLED', 'Reading cancelled'));
    };
    await check();
    signal.throwIfAborted();
    timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        await check();
      } catch {
        controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Lost reading state'));
      } finally {
        checking = false;
      }
    }, 750);
    temp = await mkdtemp(join(tempRoot, 'reading-'));
    activeTemp.add(temp);
    prefix = `translations/${a.jobId}/reading/${id}/${attempt}/`;
    const files: Activity['files'] = {};
    let units = 0;
    let result: ReadingResult | PreviewResult;
    let upgraded: TranslationData | undefined;
    const publish = async (format: string, path: string, mime: string, name: string) => {
      const key = prefix + name;
      await uploadFromFile(key, path, signal, mime);
      files[format] = { key, mime, name };
    };
    if (a.kind === 'preview') {
      let source = '';
      if (a.snapshot.format === 'docx' || a.options.optimizeLayout) {
        const [row] = await db()
          .select({ a: assets })
          .from(jobs)
          .innerJoin(assets, eq(jobs.assetId, assets.id))
          .where(eq(jobs.id, a.jobId));
        source = join(temp, `source${extname(row.a.name)}`);
        await downloadToFile(row.a.key, source, signal);
      }
      const preview = await renderPreview(a, temp, source, signal);
      result = preview.result;
      upgraded = preview.upgraded;
      await publish(
        'preview',
        preview.output,
        result.format === 'pdf' ? 'application/pdf' : 'image/png',
        `preview.${result.format}`,
      );
    } else {
      const chunks = readingChunks(a.snapshot);
      if (!chunks.length) throw new MediaError('NO_RESULTS', 'No readable evidence');
      units = chunks.length + (chunks.length > 1 ? 1 : 0);
      await db()
        .update(translationActivities)
        .set({ totalUnits: units })
        .where(eq(translationActivities.id, id));
      const partial: ReadingResult[] = [];
      for (const [index, blocks] of chunks.entries()) {
        const options =
          chunks.length > 1 && a.kind === 'mindmap'
            ? { ...a.options, kind: 'summary' as const }
            : a.options;
        partial.push(
          await readingStep(
            a,
            `part-${index}`,
            { blocks, history: a.history },
            options,
            signal,
            provider,
          ),
        );
        await db()
          .update(translationActivities)
          .set({
            completedUnits: index + 1,
            totalUnits: units,
          })
          .where(eq(translationActivities.id, id));
      }
      result =
        partial.length === 1
          ? partial[0]
          : await readingStep(
              a,
              'combine',
              { partialAnalyses: partial, history: a.history },
              a.options,
              signal,
              provider,
            );
      const md = join(temp, 'reading.md');
      await writeFile(md, readingMarkdown(result, a.snapshot, a.options));
      await publish('md', md, 'text/markdown; charset=utf-8', `${a.kind}.md`);
      if (a.kind === 'mindmap' && result.nodes.length) {
        const svg = join(temp, 'mindmap.svg');
        await writeFile(svg, mindmapSvg(result));
        await publish('svg', svg, 'image/svg+xml', 'mindmap.svg');
        const png = join(temp, 'mindmap.png');
        await pythonTranslation(
          { action: 'mindmap', map: mindmapLayout(result.nodes), output: png },
          temp,
          signal,
        );
        await publish('png', png, 'image/png', 'mindmap.png');
      }
    }
    signal.throwIfAborted();
    const saved = await db().transaction(async (tx) => {
      if (upgraded) {
        const updated = await tx
          .update(translationDocuments)
          .set({ data: upgraded, revision: a.revision + 1, updatedAt: new Date() })
          .where(
            and(
              eq(translationDocuments.jobId, a.jobId),
              eq(translationDocuments.revision, a.revision),
              sql`exists(select 1 from jobs where id=${a.jobId} and state in ('completed','failed','cancelled') and not deleting and expires_at>now())`,
            ),
          )
          .returning();
        if (!updated.length)
          throw new MediaError(
            'TRANSLATION_CONFLICT',
            'Document changed during layout optimization',
          );
      }
      const rows = await tx
        .update(translationActivities)
        .set({ state: 'completed', result, files, waitingUntil: null, completedUnits: units })
        .where(
          and(
            eq(translationActivities.id, id),
            eq(translationActivities.attempt, attempt),
            eq(translationActivities.state, 'processing'),
            sql`exists(select 1 from jobs where id=${a.jobId} and not deleting and expires_at>now())`,
          ),
        )
        .returning();
      if (!rows.length && upgraded)
        throw new MediaError('CANCELLED', 'Layout optimization cancelled');
      return rows;
    });
    committed = !!saved.length;
  } catch (error) {
    const e = signal.aborted ? signal.reason : error,
      code = e instanceof MediaError ? e.code : 'READING_FAILED';
    await db()
      .update(translationActivities)
      .set({
        state: code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: code,
        waitingUntil: null,
      })
      .where(
        and(
          eq(translationActivities.id, id),
          eq(translationActivities.attempt, attempt),
          inArray(translationActivities.state, ['processing', 'cancelling']),
        ),
      );
    console.error(`Reading ${id}: ${code}`, e instanceof Error ? e.message.slice(0, 200) : '');
  } finally {
    clearInterval(timer);
    clearTimeout(timeout);
    controllers.delete(controller);
    if (!committed && prefix) await deletePrefix(prefix).catch(() => {});
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
    if (locked) await lease`select pg_advisory_unlock(hashtextextended(${id},0))`.catch(() => {});
    lease.release();
  }
}
