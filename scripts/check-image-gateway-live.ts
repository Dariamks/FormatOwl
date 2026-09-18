// Billable end-to-end acceptance of the configured repair gateway. Synthetic image only.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sqlClient } from '@filemorph/core/db';
import { translationRoute } from '@filemorph/core/translation';

const route = translationRoute('repair');
assert.equal(route.provider, 'openai');
assert.equal(route.gateway, 'image');
assert.equal(route.model, 'gpt-image-2');
const root = resolve('.data/image-gateway-live');
await mkdir(root, { recursive: true });
const origin = 'http://127.0.0.1:3000';
let cookie = '';
async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(origin + '/api/' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const c of r.headers.getSetCookie())
    if (c.startsWith('fm-session=')) cookie = c.split(';')[0];
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
async function wait(check: () => Promise<boolean>) {
  for (let i = 0; i < 900; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out; inspect saved job before resubmitting');
}
await api('session');
await writeFile(
  resolve(root, 'browser-state.json'),
  JSON.stringify({
    cookies: [
      {
        name: 'fm-session',
        value: cookie.slice(11),
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }),
  { mode: 0o600 },
);
const input = await readFile('.data/translation-fixtures/menu.png');
const asset = await api('uploads', { name: 'gpt-image-2-menu.png', size: input.length });
const part = await api(`uploads/${asset.id}/parts`, { partNumber: 1 });
assert.equal((await fetch(part.url, { method: 'PUT', body: input })).status, 200);
await api(`uploads/${asset.id}/complete`, {});
const { id } = await api('jobs', {
  requestId: crypto.randomUUID(),
  assetId: asset.id,
  tool: 'image-translator',
  options: { sourceLanguage: 'en', targetLanguage: 'zh' },
});
await writeFile(resolve(root, 'submitted.json'), JSON.stringify({ id, route }));
let last = '';
await wait(async () => {
  const { job } = await api(`jobs/${id}`);
  const view = await api(`jobs/${id}/translation`);
  const stage = `${view.stage} ${view.completedUnits}/${view.totalUnits}`;
  if (stage !== last) {
    console.log(stage);
    last = stage;
  }
  assert.notEqual(job.state, 'failed', job.error);
  return job.state === 'completed';
});
const db = sqlClient();
try {
  const steps =
    await db`select step_key,state,provider_config,request_id,usage from translation_steps where job_id=${id} order by step_key`;
  const repairs = steps.filter((s) => s.step_key.startsWith('repair:'));
  assert.ok(repairs.length > 0);
  for (const step of repairs) {
    assert.equal(step.state, 'completed');
    assert.deepEqual(step.provider_config, route);
    assert.equal(step.usage.images, 1);
    assert.ok(step.request_id);
  }
  async function exportFile(revision: number, name: string) {
    const e = await api(`jobs/${id}/translation/exports`, {
      revision,
      format: 'png',
      mode: 'translated',
    });
    await wait(async () => {
      const saved = (await api(`jobs/${id}/translation/exports`)).exports.find(
        (x: any) => x.id === e.id,
      );
      assert.notEqual(saved.state, 'failed', saved.error);
      return saved.state === 'completed';
    });
    const { url } = await api(`translation-exports/${e.id}/download`);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(resolve(root, name), bytes);
    return { id: e.id, hash: createHash('sha256').update(bytes).digest('hex') };
  }
  const view = await api(`jobs/${id}/translation`);
  assert.ok(view.data.blocks.some((b: any) => /[\u4e00-\u9fff]/.test(b.translatedText)));
  const first = await exportFile(view.revision, 'translated.png');
  const block = view.data.blocks.find((b: any) => !b.hidden && !b.keepOriginal);
  assert.ok(block);
  await api(
    `jobs/${id}/translation`,
    { revision: view.revision, upsert: [{ id: block.id, translatedText: '欢迎使用' }] },
    'PATCH',
  );
  const updated = await api(`jobs/${id}/translation`);
  assert.equal(updated.data.blocks.find((b: any) => b.id === block.id).translatedText, '欢迎使用');
  const second = await exportFile(updated.revision, 'corrected.png');
  assert.notEqual(second.hash, first.hash);
  const oldDownload = await api(`translation-exports/${first.id}/download`);
  const oldBytes = Buffer.from(await (await fetch(oldDownload.url)).arrayBuffer());
  assert.equal(createHash('sha256').update(oldBytes).digest('hex'), first.hash);
  const after =
    await db`select step_key,state,provider_config,request_id,usage from translation_steps where job_id=${id} order by step_key`;
  assert.deepEqual(after, steps, 'Correction/export must reuse the completed repair');
  await writeFile(
    resolve(root, 'end-to-end.json'),
    JSON.stringify([{ tool: 'image-translator', id, exportId: second.id }], null, 2),
  );
  await writeFile(
    resolve(root, 'acceptance.json'),
    JSON.stringify({ id, route, steps, first, second, passed: true }, null, 2),
  );
  console.log('PASS image gateway, correction, immutable PNG exports, cached repair', id);
} finally {
  await db.end();
}
