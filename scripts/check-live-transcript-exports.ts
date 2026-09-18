// Reuses a completed live-acceptance task; never submits another speech request.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { jobs } from '@filemorph/core/schema';
import { signSession } from '@filemorph/core/session';
import { sessionSecret } from '@filemorph/core/config';
import { runProcess } from '@filemorph/core/media';
const root = resolve(process.argv[2] || '.data/transcription-live');
const report = JSON.parse(await readFile(resolve(root, 'report.json'), 'utf8'));
const [job] = await db().select().from(jobs).where(eq(jobs.id, report.jobId));
assert.ok(
  job?.owner.startsWith('anon:') && job.tool === 'transcription' && job.state === 'completed',
);
const token = signSession(job.owner.slice(5), sessionSecret());
const origin = process.env.TEST_APP_URL || 'http://127.0.0.1:3000';
await writeFile(
  resolve(root, 'browser-state.json'),
  JSON.stringify({
    cookies: [
      {
        name: 'fm-session',
        value: token,
        domain: new URL(origin).hostname,
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
async function api(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${origin}/api/${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { Origin: origin, Cookie: `fm-session=${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, 200, data.error || path);
  return data;
}
try {
  const document = await api(`jobs/${job.id}/transcript`);
  const first = document.segments[0];
  assert.ok(first);
  const editedText = first.text.endsWith('（已校对）') ? first.text : first.text + '（已校对）';
  const saved = await api(
    `jobs/${job.id}/transcript`,
    { revision: document.revision, upsert: [{ ...first, text: editedText }] },
    'PATCH',
  );
  const outputs: { format: string; revision: number; bytes: number }[] = [];
  for (const format of ['txt', 'docx', 'pdf', 'srt', 'vtt']) {
    const created = await api(`jobs/${job.id}/transcript/exports`, {
      revision: saved.revision,
      format,
      includeSpeakers: !['srt', 'vtt'].includes(format),
      includeTimestamps: true,
    });
    let done = false;
    for (let i = 0; i < 600; i++) {
      const { exports } = await api(`jobs/${job.id}/transcript/exports`);
      const e = exports.find((x: any) => x.id === created.id);
      assert.ok(!['failed', 'cancelled'].includes(e.state), e.error || e.state);
      if (e.state === 'completed') {
        done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(done, `Export ${format} timed out`);
    const { url } = await api(`transcript-exports/${created.id}/download`);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length);
    await writeFile(resolve(root, `accepted.${format}`), bytes);
    outputs.push({ format, revision: saved.revision, bytes: bytes.length });
  }
  await writeFile(resolve(root, 'export-reference.json'), JSON.stringify({ editedText, outputs }));
  await runProcess(resolve('.data/venv/bin/python'), [
    '-c',
    `
import json,sys,re,html
from pathlib import Path
from docx import Document
from pypdf import PdfReader
p=Path(sys.argv[1]); expected=json.loads((p/'export-reference.json').read_text())['editedText']
texts={f:(p/('accepted.'+f)).read_text() for f in ['txt','srt','vtt']}
texts['docx']='\\n'.join(x.text for x in Document(p/'accepted.docx').paragraphs)
texts['pdf']=''.join(page.extract_text() for page in PdfReader(p/'accepted.pdf').pages)
for fmt,text in texts.items():
 assert re.sub(r'\\s','',expected) in re.sub(r'\\s','',html.unescape(text)),fmt+' lost saved text'
for fmt in ['srt','vtt']:
 assert '-->' in texts[fmt]
assert texts['vtt'].startswith('WEBVTT')
`,
    root,
  ]);
  report.exports = { revision: saved.revision, editedText, outputs, contentVerified: true };
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    'PASS Live recognition → saved correction → five downloads; Chinese/English content read back from every format.',
  );
} finally {
  await sqlClient().end();
}
