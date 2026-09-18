// Explicit real-provider acceptance. Only generated synthetic images are uploaded.
import assert from 'node:assert/strict';
import { Client } from './check-watermarks';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, and, sqlClient } from '@filemorph/core/db';
import { watermarkSteps } from '@filemorph/core/schema';
const root = resolve('.data/watermark-test'),
  client = new Client();
const reportFile = resolve(root, 'live-report.json');
let record: any;
try {
  record = JSON.parse(await readFile(reportFile, 'utf8'));
  client.cookie = await readFile(resolve(root, 'live-cookie.txt'), 'utf8');
} catch {}
try {
  if (!record) {
    await client.call('session');
    const assetId = await client.upload('gradient.png');
    const { id } = await client.call('jobs', {
      assetId,
      requestId: crypto.randomUUID(),
      tool: 'image-watermark-remover',
      options: {},
    });
    record = { id };
    await writeFile(resolve(root, 'live-cookie.txt'), client.cookie, { mode: 0o600 });
    await writeFile(reportFile, JSON.stringify(record));
  }
  if (process.env.WATERMARK_LIVE_RECHECK === '1' && record.round !== 2) {
    record.previous = { previewId: record.previewId, exportId: record.exportId };
    delete record.previewId;
    delete record.exportId;
    record.round = 2;
    await writeFile(reportFile, JSON.stringify(record));
  }
  const id = record.id;
  let v = await client.finish(id);
  if (!record.detectId) {
    const r = await client.call('jobs/' + id + '/watermark/runs', {
      kind: 'detect',
      targetId: 'image',
      revision: v.revision,
      requestId: crypto.randomUUID(),
    });
    record.detectId = r.id;
    await writeFile(reportFile, JSON.stringify(record));
  }
  try {
    v = await client.finish(id, record.detectId);
    assert.ok(
      v.data!.candidates.some((c) => /SAMPLE/i.test(c.label)),
      'OCR should suggest the synthetic SAMPLE mark',
    );
    record.ocr = 'passed';
    console.log('PASS real OCR suggests the synthetic watermark');
  } catch (error) {
    v = await client.call('jobs/' + id + '/watermark');
    const failed = v.runs.find((r) => r.id === record.detectId);
    if (!['AI_QUOTA', 'AI_REQUEST_FAILED'].includes(failed?.error || '')) throw error;
    record.ocr = 'blocked: ' + failed?.error;
    console.log('OCR acceptance blocked by provider; continuing independent manual image repair');
  }
  await writeFile(reportFile, JSON.stringify(record));
  if (!record.previewId) {
    const selection = {
      candidates: [],
      regions: [
        {
          id: crypto.randomUUID(),
          targetId: 'image',
          kind: 'rect',
          x: 0.32,
          y: 0.39,
          width: 0.34,
          height: 0.21,
          strokes: [],
        },
      ],
    };
    const saved = await client.call(
      'jobs/' + id + '/watermark',
      { revision: v.revision, ...selection },
      'PATCH',
    );
    const r = await client.call('jobs/' + id + '/watermark/runs', {
      kind: 'preview',
      page: 0,
      revision: saved.revision,
      requestId: crypto.randomUUID(),
    });
    record.previewId = r.id;
    record.revision = saved.revision;
    await writeFile(reportFile, JSON.stringify(record));
  }
  v = await client.finish(id, record.previewId);
  const before = await db().select().from(watermarkSteps).where(eq(watermarkSteps.jobId, id));
  assert.equal(
    before.filter(
      (s) => s.stepKey.startsWith('repair') && s.providerConfig && s.state === 'completed',
    ).length,
    record.round === 2 ? 2 : 1,
  );
  if (!record.exportId) {
    const r = await client.call('jobs/' + id + '/watermark/runs', {
      kind: 'export',
      format: 'png',
      revision: record.revision,
      requestId: crypto.randomUUID(),
    });
    record.exportId = r.id;
    await writeFile(reportFile, JSON.stringify(record));
  }
  await client.finish(id, record.exportId);
  const after = await db().select().from(watermarkSteps).where(eq(watermarkSteps.jobId, id));
  assert.deepEqual(
    after.map((s) => [s.stepKey, s.requestId]),
    before.map((s) => [s.stepKey, s.requestId]),
  );
  const { url } = await client.call('watermark-runs/' + record.exportId + '/download');
  await writeFile(
    resolve(root, 'live-result.png'),
    Buffer.from(await (await fetch(url)).arrayBuffer()),
  );
  await writeFile(
    resolve(root, 'live-state.json'),
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
  console.log('PASS real masked AI repair, preview/export cache reuse and private PNG download');
} finally {
  await sqlClient().end();
}
