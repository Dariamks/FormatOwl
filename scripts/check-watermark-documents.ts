// Real document upload, worker, preview and editable export. OCR is a fixed
// regression fixture; no external model is called by this test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { watermarkDocuments, watermarkSteps } from '@filemorph/core/schema';
import { translationRoute } from '@filemorph/core/translation';
import { downloadToFile } from '@filemorph/core/storage';
import type { WatermarkView, WatermarkSelection } from '@filemorph/core/watermark';
import { Client } from './check-watermarks';

const root = resolve('.data/watermark-documents');
const client = new Client();
const records: object[] = [];
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
await mkdir(root, { recursive: true });
execFileSync(resolve('.data/venv/bin/python'), ['scripts/watermark_document_fixtures.py', root]);
try {
  await client.call('session');
  for (const [name, labels, repair] of [
    ['compatibility.docx', ['WORD SAMPLE', 'CONFIDENTIAL'], false],
    ['image-compatibility.docx', [], true],
    ['grouped.pptx', ['GROUP SAMPLE'], true],
    ['hidden.pptx', ['GROUP SAMPLE'], false],
    ['text-state.pdf', ['PDF SAMPLE'], false],
    ['scan.pdf', [], true],
  ] as const) {
    const format = name.split('.').at(-1)!;
    const tool = { docx: 'word', pptx: 'ppt', pdf: 'pdf' }[format]!;
    const assetId = await client.upload(name, root);
    const { id } = await client.call('jobs', {
      assetId,
      requestId: randomUUID(),
      tool: tool + '-watermark-remover',
      options: {},
    });
    let view = await client.finish(id);
    const [doc] = await db()
      .select()
      .from(watermarkDocuments)
      .where(eq(watermarkDocuments.jobId, id));
    // Seed all image targets, including shared images. Only the chosen reference
    // will be edited; cached OCR also makes later browser verification offline.
    for (const target of doc.data!.targets) {
      const path = resolve(root, id + '-' + target.id + '.png');
      await downloadToFile('watermarks/' + id + '/' + target.file, path);
      const contentHash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      await db()
        .insert(watermarkSteps)
        .values({
          jobId: id,
          stepKey: 'ocr-v1-' + hash([contentHash, translationRoute('ocr')]),
          state: 'completed',
          requestId: 'offline-document-fixture',
          result: {
            blocks: [
              { text: 'SAMPLE', box: { x: 272, y: 202, width: 69, height: 22, angle: 0 } },
              { text: 'KEEP BODY', box: { x: 20, y: 20, width: 51, height: 41, angle: 0 } },
            ],
          },
        })
        .onConflictDoNothing();
    }
    const target = view.data!.targets.find((t) => t.pages.includes(0));
    const selected: WatermarkSelection = {
      candidates: labels.map((label) => {
        const candidate = view.data!.candidates.find((c) => c.label === label);
        assert.ok(candidate, name + ': missing ' + label);
        return candidate.id;
      }),
      regions: [],
    };
    if (repair) {
      assert.ok(target);
      const detected = await client.call('jobs/' + id + '/watermark/runs', {
        requestId: randomUUID(),
        revision: view.revision,
        kind: 'detect',
        targetId: target.id,
      });
      view = await client.finish(id, detected.id);
      const candidate = view.data!.candidates.find(
        (c) => c.targetId === target.id && c.label === 'SAMPLE',
      );
      assert.ok(candidate?.region);
      if (format === 'pdf') {
        // Scans retain conservative OCR bounds and protect body text. Explicitly
        // select the full plate; first verify that a body-overlapping mask fails.
        const bad = await client.call(
          'jobs/' + id + '/watermark',
          {
            revision: view.revision,
            candidates: [],
            regions: [
              {
                id: randomUUID(),
                targetId: target.id,
                kind: 'rect',
                x: 0.04,
                y: 0.04,
                width: 0.3,
                height: 0.3,
                strokes: [],
              },
            ],
          },
          'PATCH',
        );
        const rejected = await client.call('jobs/' + id + '/watermark/runs', {
          requestId: randomUUID(),
          revision: bad.revision,
          kind: 'preview',
          page: 0,
        });
        await assert.rejects(client.finish(id, rejected.id), /WATERMARK_TEXT_OVERLAP/);
        view = await client.call<WatermarkView>('jobs/' + id + '/watermark');
        selected.regions.push({
          id: randomUUID(),
          targetId: target.id,
          kind: 'rect',
          x: 252 / 360,
          y: 186 / 260,
          width: 108 / 360,
          height: 56 / 260,
          strokes: [],
        });
      } else {
        const r = candidate.region;
        assert.ok(r.x * 360 <= 258 && r.y * 260 <= 191);
        assert.ok((r.x + r.width) * 360 >= 354 && (r.y + r.height) * 260 >= 235);
        selected.candidates.push(candidate.id);
      }
    }
    const saved = await client.call(
      'jobs/' + id + '/watermark',
      { revision: view.revision, ...selected },
      'PATCH',
    );
    const preview = await client.call('jobs/' + id + '/watermark/runs', {
      requestId: randomUUID(),
      revision: saved.revision,
      kind: 'preview',
      page: 0,
    });
    view = await client.finish(id, preview.id);
    for (const [suffix, run] of [
      ['before', ''],
      ['after', '&run=' + preview.id],
    ]) {
      const media = await client.call('jobs/' + id + '/watermark/media?page=0' + run);
      await writeFile(
        resolve(root, name + '-' + suffix + '.png'),
        Buffer.from(await (await fetch(media.url)).arrayBuffer()),
      );
    }
    const exported = await client.call('jobs/' + id + '/watermark/runs', {
      requestId: randomUUID(),
      revision: saved.revision,
      kind: 'export',
      format,
    });
    view = await client.finish(id, exported.id);
    const download = await client.call('watermark-runs/' + exported.id + '/download');
    await writeFile(
      resolve(root, 'result-' + name),
      Buffer.from(await (await fetch(download.url)).arrayBuffer()),
    );
    const steps = await db().select().from(watermarkSteps).where(eq(watermarkSteps.jobId, id));
    assert.ok(
      steps.every((s) => !s.providerConfig),
      'document regression must not call a model',
    );
    records.push({
      name,
      id,
      format,
      pages: view.data!.pages.length,
      labels,
      repair,
      targetId: repair ? target!.id : undefined,
      runId: exported.id,
    });
    await writeFile(resolve(root, 'report.json'), JSON.stringify(records, null, 2));
    console.log(
      'PASS',
      name,
      'upload, native analysis, selection, preview, original-format export, no model calls',
    );
  }
  execFileSync(
    resolve('.data/venv/bin/python'),
    ['scripts/check-watermark-document-results.py', root],
    { stdio: 'inherit' },
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
} finally {
  await sqlClient().end();
}
