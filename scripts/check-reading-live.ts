// Real reading acceptance against the synthetic, translated fixtures. Requires web + worker.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateReadingResult } from '@filemorph/core/reading';
const root = resolve('.data/translation-live'),
  origin = 'http://127.0.0.1:3000';
const state = JSON.parse(await readFile(resolve(root, 'browser-state.json'), 'utf8'));
const cookie = `fm-session=${state.cookies.find((c: any) => c.name === 'fm-session').value}`;
async function api(path: string, body?: unknown) {
  const r = await fetch(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
async function ready(id: string, activityId: string) {
  for (let i = 0; i < 240; i++) {
    const { activities } = await api(`jobs/${id}/reading`),
      a = activities.find((a: any) => a.id === activityId);
    if (a?.state === 'completed') return a;
    if (['failed', 'cancelled'].includes(a?.state)) throw new Error(`${a.kind}: ${a.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Reading timeout');
}
const records = JSON.parse(await readFile(resolve(root, 'end-to-end.json'), 'utf8')),
  report = [];
await mkdir(resolve(root, 'reading'), { recursive: true });
for (const record of records) {
  const view = await api(`jobs/${record.id}/translation`);
  for (const kind of ['summary', 'mindmap', 'chat']) {
    const options = {
      kind,
      revision: view.revision,
      language: 'zh',
      ...(kind === 'chat'
        ? { question: '请根据文件说明它的主要用途，并给出出处。', requestId: crypto.randomUUID() }
        : {}),
    };
    const queued = await api(`jobs/${record.id}/reading`, options);
    if (['failed', 'cancelled'].includes(queued.state))
      await api(`reading-activities/${queued.id}/retry`, {});
    const a = await ready(record.id, queued.id);
    validateReadingResult(a.result, view.data, kind);
    assert.equal(
      (await api(`jobs/${record.id}/reading`, options)).id,
      a.id,
      'Reading should be cached',
    );
    for (const format of a.formats) {
      const { url } = await api(`reading-activities/${a.id}/download?format=${format}`),
        r = await fetch(url);
      assert.equal(r.status, 200);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.ok(bytes.length > 20);
      await writeFile(resolve(root, 'reading', `${record.tool}-${kind}.${format}`), bytes);
    }
    report.push({
      tool: record.tool,
      kind,
      id: a.id,
      sections: a.result.sections.length,
      nodes: a.result.nodes.length,
    });
    console.log('PASS', record.tool, kind, a.id);
  }
  const q = await api(`jobs/${record.id}/reading`, {
    kind: 'chat',
    revision: view.revision,
    language: 'en',
    question: 'What is the exact temperature at the North Pole right now?',
    requestId: crypto.randomUUID(),
  });
  const noAnswer = await ready(record.id, q.id);
  assert.equal(noAnswer.result.insufficient, true);
  console.log('PASS', record.tool, 'cross-language absent evidence');
}
await writeFile(resolve(root, 'reading', 'acceptance.json'), JSON.stringify(report, null, 2));
