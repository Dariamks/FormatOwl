// Run with the ordinary worker stopped; all data and mocked calls belong to this test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { assets, jobs, transcripts, translationDocuments } from '@filemorph/core/schema';
import {
  createReading,
  listReading,
  readingForOwner,
  readingDownload,
  changeReading,
} from '@filemorph/core/reading-jobs';
import { patchTranscript } from '@filemorph/core/transcripts';
import { deletePrefix } from '@filemorph/core/storage';
import { processReading } from '../apps/worker/src/reading-worker';
import type { ReadingProvider } from '../apps/worker/src/reading-provider';
process.env.DASHSCOPE_API_KEY = 'transcript-reading-fixture';
const owner = `anon:${randomUUID()}`,
  id = randomUUID(),
  assetId = randomUUID();
const root = resolve('.data/transcript-reading-checks');
const expiresAt = new Date(Date.now() + 3600000);
const controllers = new Set<AbortController>(),
  temps = new Set<string>();
let calls = 0;
const provider: ReadingProvider = async (input, options, _signal, route) => {
  calls++;
  await route.onSending?.();
  assert.ok(JSON.stringify(input).includes('We review the prototype on Friday.'));
  return {
    result: {
      version: 2,
      title: 'Review plan',
      insufficient: false,
      sections:
        options.kind === 'mindmap'
          ? []
          : [
              {
                heading: 'Next step',
                text: '',
                citations: [],
                blocks: [
                  {
                    type: 'paragraph',
                    text: 'Review on Friday.',
                    citations: [{ blockId: 's104', quote: 'Friday' }],
                  },
                ],
              },
            ],
      nodes:
        options.kind === 'mindmap'
          ? [
              {
                id: 'root',
                parentId: null,
                label: 'Friday review',
                citations: [{ blockId: 's104', quote: 'Friday' }],
              },
            ]
          : [],
    },
  };
};
await mkdir(root, { recursive: true });
try {
  await db()
    .insert(assets)
    .values({
      id: assetId,
      owner,
      key: `transcript-reading-tests/${assetId}`,
      name: 'meeting.m4a',
      size: 100,
      mime: 'audio/mp4',
      state: 'ready',
      expiresAt,
    });
  await db()
    .insert(jobs)
    .values({
      id,
      owner,
      assetId,
      sourceIds: [assetId],
      requestId: randomUUID(),
      tool: 'transcription',
      options: { language: 'en', streamIndex: 0 },
      state: 'completed',
      expiresAt,
    });
  const segments = Array.from({ length: 105 }, (_, i) => ({
    id: `s${i}`,
    text: i === 104 ? 'We review the prototype on Friday.' : `Discussion ${i}.`,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    speakerId: 'alice',
  }));
  await db()
    .insert(transcripts)
    .values({
      jobId: id,
      revision: 1,
      data: {
        durationMs: 110000,
        segments,
        speakers: [{ id: 'alice', name: 'Alice', needsReview: false }],
      },
    });
  const options = { kind: 'summary', revision: 1, language: 'en', requestId: randomUUID() };
  const [a, duplicate] = await Promise.all([
    createReading(id, owner, options),
    createReading(id, owner, options),
  ]);
  assert.equal(a.id, duplicate.id);
  const snapshot = (await readingForOwner(a.id, owner)).snapshot;
  assert.equal(snapshot.blocks.length, 105, 'Summary includes the entire saved transcript');
  assert.equal(snapshot.blocks[104].speaker, 'Alice');
  assert.equal(snapshot.blocks[104].startMs, 104000);
  assert.equal(
    (await db().select().from(translationDocuments).where(eq(translationDocuments.jobId, id)))
      .length,
    0,
    'No duplicate editable document',
  );
  await assert.rejects(createReading(id, 'anon:other', options));
  await assert.rejects(createReading(id, owner, { kind: 'preview', revision: 1 }));
  await assert.rejects(createReading(id, owner, { kind: 'summary', revision: 2 }));
  await processReading(a.id, 1, controllers, temps, root, provider);
  assert.equal((await readingForOwner(a.id, owner)).state, 'completed');
  assert.equal(
    (await createReading(id, owner, { kind: 'summary', revision: 1, language: 'en' })).id,
    a.id,
  );
  assert.equal((await listReading(id, owner)).activities[0].citationTimes?.s104, 104000);
  const download = await readingDownload(a.id, owner, 'md');
  const markdown = await (await fetch(download.url)).text();
  assert.ok(markdown.includes('01:44') || markdown.includes('1:44'), markdown);
  await assert.rejects(readingDownload(a.id, 'anon:other', 'md'));
  await patchTranscript(id, owner, {
    revision: 1,
    speakerUpsert: [{ id: 'alice', name: 'Alice Chen', needsReview: false }],
  });
  assert.notEqual(
    (await listReading(id, owner)).contentHash,
    a.contentHash,
    'Speaker edits invalidate summary',
  );
  assert.equal(
    (await readingForOwner(a.id, owner)).snapshot.blocks[104].speaker,
    'Alice',
    'Old summary retains immutable snapshot',
  );
  const updated = await createReading(id, owner, { kind: 'summary', revision: 2, language: 'en' });
  await changeReading(updated.id, owner, 'cancel');
  const map = await createReading(id, owner, { kind: 'mindmap', revision: 2, language: 'en' });
  await processReading(map.id, 1, controllers, temps, root, provider);
  assert.equal((await readingForOwner(map.id, owner)).state, 'completed');
  const chat = await createReading(id, owner, {
    kind: 'chat',
    question: 'When is the review?',
    requestId: randomUUID(),
    revision: 2,
    language: 'en',
  });
  await processReading(chat.id, 1, controllers, temps, root, provider);
  assert.equal((await readingForOwner(chat.id, owner)).state, 'completed');
  await db().update(jobs).set({ state: 'processing' }).where(eq(jobs.id, id));
  await assert.rejects(createReading(id, owner, { kind: 'summary', revision: 2, language: 'zh' }));
  await db()
    .update(jobs)
    .set({ state: 'completed', expiresAt: new Date(0) })
    .where(eq(jobs.id, id));
  await assert.rejects(listReading(id, owner));
  await assert.rejects(readingDownload(a.id, owner, 'md'));
  assert.equal(calls, 3);
  console.log(
    'PASS transcript reading: ownership, full saved snapshot, idempotency, citations, export, revision invalidation, cancellation, mind map, chat and expiry',
  );
} finally {
  await deletePrefix(`translations/${id}/`);
  await db().delete(jobs).where(eq(jobs.id, id));
  await db().delete(assets).where(eq(assets.id, assetId));
  await sqlClient().end();
}
