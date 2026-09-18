// Explicit real-model acceptance using synthetic files only. Requires ordinary web and worker.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { runProcess } from '@filemorph/core/media';
const root = resolve('.data/translation-live');
await mkdir(root, { recursive: true });
const origin = 'http://127.0.0.1:3000';
let cookie = '';
async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(`${origin}/api/${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const c of r.headers.getSetCookie())
    if (c.startsWith('fm-session=')) cookie = c.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  return d;
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
const video = resolve(root, 'synthetic.mp4');
await runProcess('say', [
  '-v',
  'Samantha',
  '-o',
  resolve(root, 'speech.aiff'),
  'Welcome to FormatOwl. This is a short translation test. Please keep the original voice and translate the subtitles.',
]);
await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x14242e:s=640x360:r=25',
  '-i',
  resolve(root, 'speech.aiff'),
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libx264',
  '-c:a',
  'aac',
  '-shortest',
  video,
]);
const report: any[] = [];
for (const [tool, file, format] of [
  ['document-translator', resolve('.data/translation-fixtures/sample.docx'), 'docx'],
  ['video-translator', video, 'mp4'],
  ['image-translator', resolve('.data/translation-fixtures/menu.png'), 'png'],
]) {
  const bytes = await readFile(file);
  const a = await api('uploads', { name: basename(file), size: bytes.length });
  for (let start = 0, n = 1; start < bytes.length; start += a.partSize, n++) {
    const { url } = await api(`uploads/${a.id}/parts`, { partNumber: n });
    assert.equal(
      (await fetch(url, { method: 'PUT', body: bytes.subarray(start, start + a.partSize) })).status,
      200,
    );
  }
  await api(`uploads/${a.id}/complete`, {});
  let streamIndex = 0;
  if (tool === 'video-translator') {
    await api(`assets/${a.id}/prepare`, { profile: 'audio', streamIndex: -1 });
    await api(`assets/${a.id}/prepare`, { profile: 'video', streamIndex: -1 });
    for (let i = 0; i < 120; i++) {
      const p = await api(`assets/${a.id}/prepare?profile=audio&streamIndex=-1`);
      if (p.state === 'completed') {
        streamIndex = p.media.defaultAudioIndex;
        break;
      }
      if (p.state === 'failed') throw new Error(p.error);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const { id } = await api('jobs', {
    requestId: crypto.randomUUID(),
    assetId: a.id,
    tool,
    options: { sourceLanguage: 'en', targetLanguage: 'zh', streamIndex },
  });
  let last = '';
  for (let i = 0; i < 900; i++) {
    const { job } = await api(`jobs/${id}`),
      d = await api(`jobs/${id}/translation`);
    if (d.stage !== last) {
      console.log(tool, d.stage);
      last = d.stage;
    }
    if (job.state === 'failed') throw new Error(`${tool} ${job.error}`);
    if (job.state === 'completed') break;
    if (i === 899) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const d = await api(`jobs/${id}/translation`);
  assert.ok(d.data.blocks.some((b: any) => /[\u4e00-\u9fff]/.test(b.translatedText)));
  const e = await api(`jobs/${id}/translation/exports`, {
    revision: d.revision,
    format,
    mode: 'translated',
  });
  for (let i = 0; i < 180; i++) {
    const r = (await api(`jobs/${id}/translation/exports`)).exports.find((x: any) => x.id === e.id);
    if (r.state === 'completed') break;
    if (r.state === 'failed') throw new Error(`${tool} export ${r.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const { url } = await api(`translation-exports/${e.id}/download`);
  await writeFile(
    resolve(root, `accepted.${format}`),
    Buffer.from(await (await fetch(url)).arrayBuffer()),
  );
  report.push({ tool, id, exportId: e.id, blocks: d.data.blocks.length });
  await writeFile(resolve(root, 'end-to-end.json'), JSON.stringify(report, null, 2));
  console.log('PASS', tool, id);
}
