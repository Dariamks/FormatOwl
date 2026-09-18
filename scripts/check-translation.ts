// Stop the ordinary worker before this test. Provider responses are deterministic fixtures.
// Storage, extraction, fonts, LibreOffice, FFmpeg, persistence and exports are real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  jobInputs,
  outbox,
  translationDocuments,
  translationSteps,
  translationExports,
} from '@filemorph/core/schema';
import { uploadFromFile, deletePrefix, deleteObject } from '@filemorph/core/storage';
import {
  readTranslation,
  patchTranslation,
  retryTranslationBlocks,
  createTranslationExport,
  translationDownload,
  changeTranslationExport,
} from '@filemorph/core/translations';
import { changeJob } from '@filemorph/core/jobs';
import { MediaError, runProcess } from '@filemorph/core/media';
import {
  processTranslation,
  processTranslationExport,
  updateTranslationCapabilities,
} from '../apps/worker/src/translation-worker';
import type { TranslationProvider } from '../apps/worker/src/translation-provider';
import { probeEditor } from '../apps/worker/src/processors/editor';
const root = resolve('.data/translation-checks');
await mkdir(root, { recursive: true });
process.env.DASHSCOPE_API_KEY = 'fixture-no-network';
process.env.TRANSCRIPTION_PROVIDER = 'openai';
process.env.TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';
process.env.OPENAI_API_KEY = 'fixture-no-network';
process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
const owner = `anon:${randomUUID()}`,
  seeded: { id: string; assetId: string; key: string }[] = [],
  controllers = new Set<AbortController>(),
  temps = new Set<string>();
let translateCalls = 0,
  ocrCalls = 0,
  repairCalls = 0,
  speechCalls = 0,
  child: ChildProcess | undefined;
const provider: TranslationProvider = {
  translate: async (text) => {
    translateCalls++;
    return {
      result: {
        text: text.startsWith('{"t0":')
          ? JSON.stringify(
              Object.fromEntries(
                Object.entries(JSON.parse(text)).map(([k, v]) => [
                  k,
                  /\p{L}/u.test(String(v)) ? '你好世界' : v,
                ]),
              ),
            )
          : text === 'Price'
            ? '价格'
            : /^[\d\s.$€¥%+-]+$/.test(text)
              ? text
              : '你好世界',
      },
      requestId: 'fixture-t',
    };
  },
  ocr: async () => {
    ocrCalls++;
    return {
      result: {
        blocks: [
          {
            text: 'Welcome',
            box: { x: 100, y: 100, width: 350, height: 60, angle: 0 },
            kind: 'text',
            review: [],
          },
        ],
      },
      requestId: 'fixture-o',
    };
  },
  repair: async () => {
    repairCalls++;
    return { result: { url: 'fixture' }, requestId: 'fixture-r' };
  },
  image: async () => readFile(resolve('.data/translation-fixtures/menu.png')),
};
const speech = async () => {
  speechCalls++;
  return {
    body: { segments: [{ start: 0.2, end: 1.8, text: 'Hello world', speaker: 'A' }] },
    requestId: 'fixture-s',
  };
};
const run = (id: string, attempt = 1, p = provider) =>
  processTranslation(id, attempt, controllers, temps, root, p, speech);
const record = async (id: string) => (await db().select().from(jobs).where(eq(jobs.id, id)))[0];
if (process.argv[2] === '--child') {
  await run(process.argv[3], 1, {
    ...provider,
    translate: async (_text, _source, _target, _signal, route) => {
      await route?.onSending?.();
      process.stdout.write('REQUEST_IN_FLIGHT\n');
      return new Promise(() => {});
    },
  });
  await sqlClient().end();
  process.exit(0);
}
async function seed(
  name: string,
  tool: 'document-translator' | 'image-translator' | 'video-translator' = 'document-translator',
  streamIndex = 0,
) {
  const file = resolve(name),
    id = randomUUID(),
    assetId = randomUUID(),
    key = `inputs/${assetId}/source`,
    expiresAt = new Date(Date.now() + 3600000);
  seeded.push({ id, assetId, key });
  await uploadFromFile(key, file);
  await db().transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId,
      owner,
      key,
      name: basename(file),
      size: (await stat(file)).size,
      mime: 'application/octet-stream',
      state: 'ready',
      expiresAt,
    });
    await tx.insert(jobs).values({
      id,
      owner,
      requestId: randomUUID(),
      assetId,
      sourceIds: [assetId],
      tool,
      options: { sourceLanguage: 'en', targetLanguage: 'zh', streamIndex },
      state: 'queued',
      expiresAt,
    });
    await tx.insert(jobInputs).values({ jobId: id, assetId });
  });
  return id;
}
async function exported(id: string, format: string, mode = 'translated') {
  const d = await readTranslation(id, owner);
  const e = await createTranslationExport(id, owner, { revision: d.revision, format, mode });
  await processTranslationExport(e.id, 1, controllers, temps, root);
  const [r] = await db().select().from(translationExports).where(eq(translationExports.id, e.id));
  assert.equal(r.state, 'completed', r.error || '');
  const { url } = await translationDownload(e.id, owner);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.ok(bytes.length > 0);
  const file = resolve(root, `${id}-${mode}.${format}`);
  await writeFile(file, bytes);
  return { e: r, file, bytes };
}
function pass(v: string) {
  console.log('PASS', v);
}
try {
  await updateTranslationCapabilities(root);
  for (const ext of ['txt', 'docx', 'epub', 'pdf']) {
    const id = await seed(`.data/translation-fixtures/sample.${ext}`);
    await run(id);
    assert.equal((await record(id)).state, 'completed', (await record(id)).error || '');
    await exported(id, ext);
    await exported(id, ext, 'bilingual');
    await assert.rejects(readTranslation(id, 'anon:other'), (e: any) => e.code === 'JOB_NOT_FOUND');
    pass(
      `${ext}: parse, translate, persisted editing data, original-format and bilingual downloads`,
    );
  }
  const marked = await seed('.data/translation-fixtures/sample.docx');
  await run(marked, 1, {
    ...provider,
    translate: async () => ({ result: { text: '{"unexpected":"nonempty but invalid"}' } }),
  });
  assert.equal((await record(marked)).error, 'AI_INVALID_RESPONSE');
  let markedView = await readTranslation(marked, owner);
  const markedBlock = markedView.data!.blocks.find((b) => b.inline?.length && !b.translatedText)!;
  assert.ok(markedBlock);
  assert.equal(markedBlock.translatedText, '');
  const rejected = await db()
    .select()
    .from(translationSteps)
    .where(eq(translationSteps.jobId, marked));
  assert.ok(rejected.some((s) => s.state === 'failed' && s.error === 'AI_INVALID_RESPONSE'));
  // A historical incorrectly completed response is invalidated on read as well.
  await db()
    .update(translationSteps)
    .set({ state: 'completed', error: null })
    .where(eq(translationSteps.jobId, marked));
  await changeJob(marked, owner, 'retry');
  await db().delete(outbox).where(eq(outbox.jobId, marked));
  await run(marked, 2);
  assert.equal((await record(marked)).error, 'AI_INVALID_RESPONSE');
  const cached = await db()
    .select()
    .from(translationSteps)
    .where(eq(translationSteps.jobId, marked));
  assert.ok(cached.some((s) => s.state === 'failed' && s.error === 'AI_INVALID_RESPONSE'));
  // A plain job retry must request the rejected slot again, not reuse invalid cache.
  await changeJob(marked, owner, 'retry');
  await db().delete(outbox).where(eq(outbox.jobId, marked));
  await run(marked, 3);
  assert.equal((await record(marked)).state, 'completed');
  markedView = await readTranslation(marked, owner);
  await patchTranslation(marked, owner, {
    revision: markedView.revision,
    upsert: [{ id: markedBlock.id, sourceText: 'Corrected source for translation.' }],
  });
  markedView = await readTranslation(marked, owner);
  assert.equal(markedView.data!.blocks.find((b) => b.id === markedBlock.id)!.inline, undefined);
  await retryTranslationBlocks(marked, owner, {
    revision: markedView.revision,
    blockIds: [markedBlock.id],
    operation: 'translate',
  });
  await db().delete(outbox).where(eq(outbox.jobId, marked));
  let received = '';
  await run(marked, 4, {
    ...provider,
    translate: async (...args) => {
      received = args[0];
      return provider.translate(...args);
    },
  });
  assert.equal(received, 'Corrected source for translation.');
  assert.equal(
    (await readTranslation(marked, owner)).data!.blocks.find((b) => b.id === markedBlock.id)!.stale,
    false,
  );
  pass(
    'Invalid responses never enter completed cache; ordinary retry recovers; corrected source replaces fragment input',
  );
  const image = await seed('.data/translation-fixtures/menu.png', 'image-translator');
  await run(image);
  assert.equal((await record(image)).state, 'completed');
  let d = await readTranslation(image, owner);
  const block = d.data!.blocks[0];
  const first = await exported(image, 'png');
  const beforeRepair = repairCalls,
    beforeOcr = ocrCalls;
  const saved = await patchTranslation(image, owner, {
    revision: d.revision,
    upsert: [{ id: block.id, translatedText: '已校正', style: { ...block.style, fontSize: 24 } }],
  });
  await assert.rejects(
    patchTranslation(image, owner, {
      revision: d.revision,
      upsert: [{ id: block.id, translatedText: '冲突' }],
    }),
    (e: any) => e.code === 'TRANSLATION_CONFLICT',
  );
  assert.equal((await readTranslation(image, owner)).data!.blocks[0].translatedText, '已校正');
  const changed = await exported(image, 'png');
  assert.notDeepEqual(changed.bytes, first.bytes);
  assert.equal(repairCalls, beforeRepair);
  assert.equal(ocrCalls, beforeOcr);
  assert.equal(first.e.snapshot.blocks[0].translatedText, '你好世界');
  pass(
    'Edits survive reload; revision conflicts rejected; exports freeze content and reuse repaired backgrounds',
  );
  d = await readTranslation(image, owner);
  await patchTranslation(image, owner, {
    revision: d.revision,
    upsert: [{ id: block.id, sourceText: 'New original' }],
  });
  d = await readTranslation(image, owner);
  assert.ok(d.data!.blocks[0].stale);
  await assert.rejects(
    createTranslationExport(image, owner, { revision: d.revision, format: 'png' }),
    (e: any) => e.code === 'TRANSLATION_NEEDS_REVIEW',
  );
  await retryTranslationBlocks(image, owner, {
    revision: d.revision,
    blockIds: [block.id],
    operation: 'translate',
  });
  await db().delete(outbox).where(eq(outbox.jobId, image));
  await run(image, 2);
  assert.equal(repairCalls, beforeRepair);
  assert.equal(ocrCalls, beforeOcr);
  pass('Local retranslation clears stale text and does not repeat OCR or repair');
  await exported(image, 'jpg');
  await exported(image, 'webp');
  await exported(image, 'txt');
  const bad = await seed('.data/translation-fixtures/sample.txt');
  let count = 0;
  await run(bad, 1, {
    ...provider,
    translate: async (...a) => {
      if (++count === 2) throw new MediaError('AI_RESULT_UNKNOWN', 'Fixture uncertain response');
      return provider.translate(...a);
    },
  });
  assert.equal((await record(bad)).error, 'AI_RESULT_UNKNOWN');
  const completed = (
    await db().select().from(translationSteps).where(eq(translationSteps.jobId, bad))
  ).filter((s) => s.state === 'completed').length;
  await run(bad);
  assert.equal(count, 2);
  await changeJob(bad, owner, 'retry');
  await db().delete(outbox).where(eq(outbox.jobId, bad));
  const calls = translateCalls;
  await run(bad, 2);
  assert.equal((await record(bad)).state, 'completed');
  assert.equal(
    translateCalls - calls,
    (await readTranslation(bad, owner)).data!.blocks.length - completed,
  );
  pass('Uncertain calls require explicit retry; completed paragraphs are retained');
  const videoFile = resolve(root, 'two-tracks.mp4');
  await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=navy:s=640x360:r=25:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=3',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    videoFile,
  ]);
  const video = await seed(videoFile, 'video-translator', 2);
  await run(video);
  assert.equal((await record(video)).state, 'completed', (await record(video)).error || '');
  for (const format of ['srt', 'vtt', 'ass', 'txt', 'docx', 'pdf', 'mp4']) {
    const r = await exported(video, format, 'bilingual');
    if (format === 'mp4') {
      const p = await probeEditor(r.file, AbortSignal.timeout(30000));
      assert.equal(p.tracks.length, 1);
      assert.equal(p.width, 640);
    }
  }
  d = await readTranslation(video, owner);
  await retryTranslationBlocks(video, owner, {
    revision: d.revision,
    blockIds: [d.data!.blocks[0].id],
    operation: 'translate',
  });
  await db().delete(outbox).where(eq(outbox.jobId, video));
  const beforeSpeech = speechCalls;
  await run(video, 2);
  assert.equal(speechCalls, beforeSpeech);
  pass(
    'Video selected track, bilingual SRT/VTT/ASS/documents and real MP4 burn; translation retry reuses ASR',
  );
  const crash = await seed('.data/translation-fixtures/sample.txt');
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--env-file=.env', 'scripts/check-translation.ts', '--child', crash],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child timeout')), 20000);
    child!.stdout!.on('data', (b) => {
      if (b.toString().includes('REQUEST_IN_FLIGHT')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child!.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Child exited early'));
    });
  });
  const exited = new Promise<void>((r) => child!.once('exit', () => r()));
  process.kill(-child.pid!, 'SIGKILL');
  await exited;
  child = undefined;
  let repeated = 0;
  await run(crash, 1, {
    ...provider,
    translate: async (...a) => {
      repeated++;
      return provider.translate(...a);
    },
  });
  assert.equal(repeated, 0);
  assert.equal((await record(crash)).error, 'AI_RESULT_UNKNOWN');
  pass('Worker process exit preserves uncertain request and prevents automatic paid duplication');
  const cancelled = await seed('.data/translation-fixtures/sample.txt');
  await run(cancelled, 1, {
    ...provider,
    translate: async (_a, _b, _c, signal) => {
      await changeJob(cancelled, owner, 'cancel');
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      throw new Error('unreachable');
    },
  });
  assert.equal((await record(cancelled)).state, 'cancelled');
  pass('Cancellation aborts in-flight provider work and prevents publication');
  d = await readTranslation(image, owner);
  const pending = await createTranslationExport(image, owner, {
    revision: d.revision,
    format: 'png',
    mode: 'original',
  });
  await changeTranslationExport(pending.id, owner, 'cancel');
  await processTranslationExport(pending.id, 1, controllers, temps, root);
  assert.equal(
    (await db().select().from(translationExports).where(eq(translationExports.id, pending.id)))[0]
      .state,
    'cancelled',
  );
  pass('Cancelled exports stay cancelled');
} finally {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  for (const item of seeded) {
    await deletePrefix(`translations/${item.id}/`);
    await deletePrefix(`transcripts/${item.id}/`);
    await db().delete(outbox).where(eq(outbox.jobId, item.id));
    await db().delete(jobs).where(eq(jobs.id, item.id));
    await deleteObject(item.key);
    await db().delete(assets).where(eq(assets.id, item.assetId));
  }
  await sqlClient().end();
}
