// Stop the ordinary worker. This test uses saved text and must never call a provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  jobInputs,
  translationDocuments,
  translationSteps,
} from '@filemorph/core/schema';
import { uploadFromFile, deletePrefix, deleteObject } from '@filemorph/core/storage';
import {
  readTranslation,
  patchTranslation,
  createTranslationExport,
  translationDownload,
} from '@filemorph/core/translations';
import {
  createReading,
  readingDownload,
  readingForOwner,
  changeReading,
} from '@filemorph/core/reading-jobs';
import { pythonTranslation, processTranslationExport } from '../apps/worker/src/translation-worker';
import { processReading } from '../apps/worker/src/reading-worker';
import type { TranslationData } from '@filemorph/core/translation';

const root = resolve('.data/document-layout-checks'),
  folder = join(root, 'files');
await mkdir(folder, { recursive: true });
const owner = `anon:${randomUUID()}`,
  id = randomUUID(),
  aid = randomUUID(),
  key = `inputs/${aid}/source`;
const source = resolve('.data/translation-fixtures/sample.pdf'),
  expiresAt = new Date(Date.now() + 3600000);
const controllers = new Set<AbortController>(),
  temps = new Set<string>();
const run = async (activityId: string) =>
  processReading(activityId, 1, controllers, temps, root, async () => {
    throw new Error('Layout optimization must not call AI');
  });
try {
  const data = (await pythonTranslation(
    {
      action: 'extract',
      source,
      folder,
      format: 'pdf',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    },
    root,
    AbortSignal.timeout(60000),
  )) as TranslationData;
  for (const b of data.blocks) if (!b.keepOriginal) b.translatedText = '已保存';
  data.blocks[0].layoutEdited = true;
  data.blocks[0].style.bold = true;
  await uploadFromFile(key, source);
  for (const page of data.pages)
    for (const name of new Set(
      [page.originalFile, page.backgroundFile].filter((n): n is string => !!n),
    ))
      await uploadFromFile(`translations/${id}/files/${name}`, join(folder, name));
  await db()
    .insert(assets)
    .values({
      id: aid,
      owner,
      key,
      name: 'saved-layout.pdf',
      mime: 'application/pdf',
      size: (await stat(source)).size,
      state: 'ready',
      expiresAt,
    });
  await db()
    .insert(jobs)
    .values({
      id,
      assetId: aid,
      owner,
      requestId: randomUUID(),
      sourceIds: [aid],
      tool: 'document-translator',
      options: { sourceLanguage: 'en', targetLanguage: 'zh', streamIndex: 0 },
      state: 'completed',
      expiresAt,
    });
  await db().insert(jobInputs).values({ jobId: id, assetId: aid });
  await db().insert(translationDocuments).values({ jobId: id, data, revision: 1, stage: 'ready' });
  const oldExport = await createTranslationExport(id, owner, { revision: 1, format: 'pdf' });
  await processTranslationExport(oldExport.id, 1, controllers, temps, root);
  const oldLink = await translationDownload(oldExport.id, owner),
    oldBytes = Buffer.from(await (await fetch(oldLink.url)).arrayBuffer());
  let view = await readTranslation(id, owner);
  const activity = await createReading(id, owner, {
    kind: 'preview',
    revision: view.revision,
    optimizeLayout: true,
  });
  await assert.rejects(readingForOwner(activity.id, 'anon:other'));
  await run(activity.id);
  assert.equal((await readingForOwner(activity.id, owner)).state, 'completed');
  view = await readTranslation(id, owner);
  assert.equal(view.data!.layoutVersion, 3);
  for (const old of data.blocks) {
    const b = view.data!.blocks.find((b) => b.id === old.id)!;
    assert.ok(b);
    assert.equal(b.sourceText, old.sourceText);
    assert.equal(b.translatedText, old.translatedText);
    if (old.layoutEdited) assert.deepEqual(b.style, old.style);
  }
  assert.equal(
    (await db().select().from(translationSteps).where(eq(translationSteps.jobId, id))).length,
    0,
  );
  const preview = await createReading(id, owner, { kind: 'preview', revision: view.revision });
  await run(preview.id);
  const link = await readingDownload(preview.id, owner, 'preview');
  const previewBytes = Buffer.from(await (await fetch(link.url)).arrayBuffer());
  const exp = await createTranslationExport(id, owner, { revision: view.revision, format: 'pdf' });
  await processTranslationExport(exp.id, 1, controllers, temps, root);
  assert.deepEqual(
    Buffer.from(await (await fetch((await translationDownload(exp.id, owner)).url)).arrayBuffer()),
    previewBytes,
  );
  assert.deepEqual(
    Buffer.from(
      await (await fetch((await translationDownload(oldExport.id, owner)).url)).arrayBuffer(),
    ),
    oldBytes,
  );
  await assert.rejects(
    patchTranslation(id, owner, {
      revision: view.revision,
      upsert: [{ id: data.blocks[0].id, box: { x: 1, y: 1, width: 100, height: 100, angle: 0 } }],
    }),
  );
  const pending = await createReading(id, owner, {
    kind: 'preview',
    revision: view.revision,
    optimizeLayout: true,
  });
  await patchTranslation(id, owner, {
    revision: view.revision,
    upsert: [{ id: data.blocks[0].id, style: { ...view.data!.blocks[0].style, fontSize: 40 } }],
  });
  await run(pending.id);
  assert.equal((await readingForOwner(pending.id, owner)).state, 'failed');
  view = await readTranslation(id, owner);
  assert.equal(view.data!.blocks[0].style.fontSize, 40);
  const cancelled = await createReading(id, owner, {
    kind: 'preview',
    revision: view.revision,
    optimizeLayout: true,
  });
  await changeReading(cancelled.id, owner, 'cancel');
  await run(cancelled.id);
  assert.equal((await readingForOwner(cancelled.id, owner)).state, 'cancelled');
  assert.equal((await readTranslation(id, owner)).revision, view.revision);
  console.log(
    'PASS PDF upgrade: ownership, saved IDs/text/style, zero AI calls, same preview/download bytes, old downloads, edit conflict and cancellation.',
  );
} finally {
  await db().delete(jobs).where(eq(jobs.id, id));
  await db().delete(assets).where(eq(assets.id, aid));
  await deletePrefix(`translations/${id}/`);
  await deleteObject(key);
  await sqlClient().end();
}
