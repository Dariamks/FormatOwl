// Real AI acceptance for rich summaries and immutable regeneration on synthetic files.
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
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json;
}
async function ready(jobId: string, activityId: string) {
  for (let i = 0; i < 240; i++) {
    const a = (await api(`jobs/${jobId}/reading`)).activities.find((a: any) => a.id === activityId);
    if (a.state === 'completed') return a;
    assert.ok(!['failed', 'cancelled'].includes(a.state), `${a.kind}: ${a.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out waiting for AI reading');
}
const records = JSON.parse(await readFile(resolve(root, 'end-to-end.json'), 'utf8'));
const report = [];
await mkdir(resolve(root, 'reading'), { recursive: true });
for (const record of records) {
  const view = await api(`jobs/${record.id}/translation`);
  for (const template of record.tool === 'document-translator'
    ? ['notes', 'takeaways', 'chapters']
    : ['notes']) {
    const options = { kind: 'summary', revision: view.revision, language: 'zh', template };
    const queued = await api(`jobs/${record.id}/reading`, options);
    const a = await ready(record.id, queued.id);
    validateReadingResult(a.result, view.data, 'summary');
    assert.equal(a.result.version, 2);
    assert.ok(a.result.sections.every((s: any) => s.blocks?.length));
    assert.equal((await api(`jobs/${record.id}/reading`, options)).id, a.id);
    const url = (await api(`reading-activities/${a.id}/download?format=md`)).url;
    const md = await (await fetch(url)).text();
    assert.ok(md.includes(a.result.title));
    await writeFile(resolve(root, 'reading', `${record.tool}-${template}-v2.md`), md);
    report.push({
      tool: record.tool,
      template,
      id: a.id,
      blocks: a.result.sections.flatMap((s: any) => s.blocks.map((b: any) => b.type)),
    });
    console.log('PASS real structured summary, sources and Markdown', record.tool, template);
  }
}
const doc = records.find((r: any) => r.tool === 'document-translator');
const view = await api(`jobs/${doc.id}/translation`);
const options = {
  kind: 'summary',
  revision: view.revision,
  regenerate: true,
  requestId: crypto.randomUUID(),
};
const previous = await api(`jobs/${doc.id}/reading`, { kind: 'summary', revision: view.revision });
const a = await api(`jobs/${doc.id}/reading`, options);
assert.notEqual(a.id, previous.id);
assert.equal((await api(`jobs/${doc.id}/reading`, options)).id, a.id);
await ready(doc.id, a.id);
assert.equal(
  (await fetch((await api(`reading-activities/${previous.id}/download?format=md`)).url)).status,
  200,
);
console.log('PASS real explicit regeneration and old downloadable file');
const question = await api(`jobs/${doc.id}/reading`, {
  kind: 'chat',
  revision: view.revision,
  question: '文件包含哪些信息？',
  requestId: crypto.randomUUID(),
});
await ready(doc.id, question.id);
const chat = await api(`jobs/${doc.id}/reading`, {
  kind: 'chat',
  revision: view.revision,
  regenerate: true,
  regenerateOf: question.id,
  requestId: crypto.randomUUID(),
});
assert.equal(chat.options.turnId, question.options.turnId);
assert.equal(chat.options.question, question.options.question);
validateReadingResult((await ready(doc.id, chat.id)).result, view.data, 'chat');
console.log('PASS real chat regeneration preserves the question');
await writeFile(
  resolve(root, 'reading', 'layout-acceptance.json'),
  JSON.stringify(report, null, 2),
);
