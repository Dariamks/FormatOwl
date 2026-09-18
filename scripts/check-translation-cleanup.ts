// Run with ordinary worker active. Uses synthetic local data; no model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  assets,
  jobs,
  jobInputs,
  translationDocuments,
  translationSteps,
  translationExports,
  translationActivities,
} from '@filemorph/core/schema';
import { uploadFromFile, headObject, deletePrefix, deleteObject } from '@filemorph/core/storage';
import { changeJob } from '@filemorph/core/jobs';
import { translationDownload, readTranslation } from '@filemorph/core/translations';
import { readingDownload } from '@filemorph/core/reading-jobs';
const root = resolve('.data/translation-cleanup');
await mkdir(root, { recursive: true });
try {
  for (const action of ['delete', 'expire']) {
    const id = randomUUID(),
      assetId = randomUUID(),
      owner = `anon:${randomUUID()}`,
      key = `inputs/${assetId}/source`,
      output = `translations/${id}/exports/fixture.txt`,
      cache = `translations/${id}/files/fixture.png`,
      exportId = randomUUID(),
      readingId = randomUUID(),
      readingKey = `translations/${id}/reading/fixture.md`,
      file = resolve('.data/translation-fixtures/sample.txt'),
      expiresAt = new Date(Date.now() + 3600000);
    try {
      await uploadFromFile(key, file);
      await uploadFromFile(output, file);
      await uploadFromFile(cache, resolve('.data/translation-fixtures/menu.png'));
      await uploadFromFile(readingKey, file);
      await db()
        .insert(assets)
        .values({
          id: assetId,
          owner,
          key,
          name: 'sample.txt',
          size: (await stat(file)).size,
          mime: 'text/plain',
          state: 'ready',
          expiresAt,
        });
      await db()
        .insert(jobs)
        .values({
          id,
          owner,
          requestId: randomUUID(),
          assetId,
          sourceIds: [assetId],
          tool: 'document-translator',
          options: { sourceLanguage: 'en', targetLanguage: 'zh', streamIndex: 0 },
          state: 'completed',
          expiresAt,
        });
      await db().insert(jobInputs).values({ jobId: id, assetId });
      const data = {
        format: 'txt',
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        pages: [],
        blocks: [],
      };
      await db().insert(translationDocuments).values({ jobId: id, data, stage: 'ready' });
      await db()
        .insert(translationActivities)
        .values({
          id: readingId,
          jobId: id,
          kind: 'chat',
          revision: 1,
          contentHash: 'cleanup-fixture',
          options: {
            kind: 'chat',
            revision: 1,
            language: 'zh',
            detail: 'brief',
            page: 0,
            question: 'What is this file?',
            requestId: randomUUID(),
          },
          snapshot: data,
          history: [],
          state: 'completed',
          result: { title: 'Fixture', insufficient: true, sections: [], nodes: [] },
          files: { md: { key: readingKey, name: 'answer.md', mime: 'text/markdown' } },
          expiresAt,
        });
      await db()
        .insert(translationSteps)
        .values({ jobId: id, stepKey: 'fixture', state: 'completed' });
      await db()
        .insert(translationExports)
        .values({
          id: exportId,
          jobId: id,
          revision: 1,
          options: {
            revision: 1,
            format: 'txt',
            mode: 'translated',
            preview: false,
            previewStartMs: 0,
            subtitle: { fontSize: 36, color: '#ffffff', position: 'bottom' },
          },
          snapshot: data,
          state: 'completed',
          key: output,
          name: 'translated.txt',
          mime: 'text/plain',
          expiresAt,
        });
      if (action === 'delete') await changeJob(id, owner, 'delete');
      else {
        await db()
          .update(jobs)
          .set({ expiresAt: new Date(0) })
          .where(eq(jobs.id, id));
        await db()
          .update(assets)
          .set({ expiresAt: new Date(0) })
          .where(eq(assets.id, assetId));
      }
      await assert.rejects(translationDownload(exportId, owner), (e: any) =>
        ['EXPIRED', 'JOB_NOT_FOUND'].includes(e.code),
      );
      await assert.rejects(readingDownload(readingId, owner, 'md'), (e: any) =>
        ['EXPIRED', 'NOT_FOUND'].includes(e.code),
      );
      for (let i = 0; i < 80; i++) {
        if (
          !(
            await db().select().from(translationDocuments).where(eq(translationDocuments.jobId, id))
          ).length
        )
          break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(
        (await db().select().from(translationDocuments).where(eq(translationDocuments.jobId, id)))
          .length,
        0,
      );
      assert.equal(
        (await db().select().from(translationSteps).where(eq(translationSteps.jobId, id))).length,
        0,
      );
      await assert.rejects(headObject(output));
      await assert.rejects(headObject(cache));
      await assert.rejects(headObject(readingKey));
      assert.equal(
        (await db().select().from(translationActivities).where(eq(translationActivities.jobId, id)))
          .length,
        0,
      );
      console.log(
        'PASS',
        action,
        'revokes exports and removes translation data, reading snapshots, chat history and intermediates',
      );
    } finally {
      await deletePrefix(`translations/${id}/`);
      await db().delete(jobs).where(eq(jobs.id, id));
      await deleteObject(key);
      await db().delete(assets).where(eq(assets.id, assetId));
    }
  }
} finally {
  await sqlClient().end();
}
