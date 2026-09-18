// Real upload/worker/repair/export; seed only OCR to keep this regression offline.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { watermarkDocuments, watermarkSteps, watermarkRuns } from '@filemorph/core/schema';
import { translationRoute } from '@filemorph/core/translation';
import { downloadToFile } from '@filemorph/core/storage';
import type { WatermarkView } from '@filemorph/core/watermark';
import { Client } from './check-watermarks';

const root = resolve('.data/watermark-test/detection');
const client = new Client();
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
await mkdir(root, { recursive: true });
try {
  await client.call('session');
  const assetId = await client.upload('badge.png');
  const { id } = await client.call('jobs', {
    assetId,
    requestId: randomUUID(),
    tool: 'image-watermark-remover',
    options: {},
  });
  let view = await client.finish(id);
  const [doc] = await db()
    .select()
    .from(watermarkDocuments)
    .where(eq(watermarkDocuments.jobId, id));
  await downloadToFile(
    'watermarks/' + id + '/' + doc.data!.targets[0].file,
    resolve(root, 'source.png'),
  );
  const contentHash = createHash('sha256')
    .update(await readFile(resolve(root, 'source.png')))
    .digest('hex');
  const stepKey = 'ocr-v1-' + hash([contentHash, translationRoute('ocr')]);
  await db()
    .insert(watermarkSteps)
    .values({
      jobId: id,
      stepKey,
      state: 'completed',
      requestId: 'offline-detection-fixture',
      result: {
        blocks: [{ text: 'SAMPLE', box: { x: 272, y: 202, width: 69, height: 22, angle: 0 } }],
      },
    });
  const detect = async () => {
    const run = await client.call('jobs/' + id + '/watermark/runs', {
      requestId: randomUUID(),
      revision: view.revision,
      kind: 'detect',
      targetId: 'image',
    });
    view = await client.finish(id, run.id);
  };
  await detect();
  assert.equal(view.data!.candidates.length, 1);
  const candidate = view.data!.candidates[0],
    region = candidate.region!;
  assert.ok(region.x * 360 <= 258 && region.y * 260 <= 191);
  assert.ok((region.x + region.width) * 360 >= 354 && (region.y + region.height) * 260 >= 235);
  const selection = {
    candidates: [candidate.id],
    regions: [
      {
        id: randomUUID(),
        targetId: 'image',
        kind: 'rect',
        x: 0.02,
        y: 0.5,
        width: 0.1,
        height: 0.1,
        strokes: [],
      },
    ],
  };
  await client.call(
    'jobs/' + id + '/watermark',
    { revision: view.revision, ...selection },
    'PATCH',
  );
  view = await client.call<WatermarkView>('jobs/' + id + '/watermark');
  const preview = await client.call('jobs/' + id + '/watermark/runs', {
    requestId: randomUUID(),
    revision: view.revision,
    kind: 'preview',
    page: 0,
  });
  view = await client.finish(id, preview.id);
  const oldRevision = view.revision;
  // Simulate the old text-only detector on this synthetic task. A new detection
  // must invalidate the old revision but leave its frozen preview intact.
  const [current] = await db()
    .select()
    .from(watermarkDocuments)
    .where(eq(watermarkDocuments.jobId, id));
  const oldData = structuredClone(current.data!);
  Object.assign(oldData.candidates[0].region!, {
    x: 270 / 360,
    y: 200 / 260,
    width: 73 / 360,
    height: 26 / 260,
  });
  await db()
    .update(watermarkDocuments)
    .set({ data: oldData })
    .where(eq(watermarkDocuments.jobId, id));
  await detect();
  assert.equal(view.revision, oldRevision + 1);
  assert.deepEqual(view.selection, selection);
  assert.equal(view.data!.candidates[0].id, candidate.id);
  assert.deepEqual(view.data!.candidates[0].region, region);
  const [frozen] = await db().select().from(watermarkRuns).where(eq(watermarkRuns.id, preview.id));
  assert.equal(frozen.revision, oldRevision);
  const newRevision = view.revision;
  await detect();
  assert.equal(view.revision, newRevision, 'unchanged detection must be idempotent');
  assert.equal(view.data!.candidates.length, 1, 'no duplicate candidates');
  const run = await client.call('jobs/' + id + '/watermark/runs', {
    requestId: randomUUID(),
    revision: view.revision,
    kind: 'export',
    format: 'png',
  });
  view = await client.finish(id, run.id);
  const download = await client.call('watermark-runs/' + run.id + '/download');
  await writeFile(
    resolve(root, 'result.png'),
    Buffer.from(await (await fetch(download.url)).arrayBuffer()),
  );
  const steps = await db().select().from(watermarkSteps).where(eq(watermarkSteps.jobId, id));
  assert.equal(steps.filter((s) => s.stepKey.startsWith('ocr-')).length, 1);
  assert.ok(
    steps.every((s) => !s.providerConfig),
    'all processing must stay local / use seeded OCR',
  );
  await writeFile(
    resolve(root, 'report.json'),
    JSON.stringify({ id, region, revision: view.revision }, null, 2),
  );
  await writeFile(
    resolve(root, 'browser-state.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'fm-session',
          value: client.cookie.slice('fm-session='.length),
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
      origins: [],
    }),
  );
  console.log(
    'PASS complete backplate, re-detection, checked/manual selections, revision, immutable snapshots, OCR cache, preview/export',
  );
} finally {
  await sqlClient().end();
}
