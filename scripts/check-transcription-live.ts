// Explicit live acceptance command. Uses the configured provider and may incur API charges.
// Keys are read only from server environment; never printed or included in reports.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '@filemorph/core/media';
import { transcriptionConfig } from '@filemorph/core/transcription';
import type { JobView } from '@filemorph/core/domain';
import type { PreparationView } from '@filemorph/core/editing';
const config = transcriptionConfig();
if (!config.apiKey)
  throw new Error(
    `Configure ${config.kind === 'dashscope' ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY'} in local .env before live acceptance.`,
  );
const root = resolve(process.env.TRANSCRIPTION_TEST_OUTPUT || '.data/transcription-live');
await mkdir(root, { recursive: true });
const reference = JSON.parse(await readFile('tests/fixtures/transcription-reference.json', 'utf8'));
let source = process.env.TRANSCRIPTION_TEST_FILE;
if (!source) {
  if (process.platform !== 'darwin')
    throw new Error(
      'Set TRANSCRIPTION_TEST_FILE to a speech sample you may send to the configured provider.',
    );
  for (const [i, part] of reference.parts.entries())
    await runProcess('say', ['-v', part.voice, '-o', resolve(root, `${i}.aiff`), part.text]);
  source = resolve(root, 'bilingual.wav');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-i',
    resolve(root, '0.aiff'),
    '-i',
    resolve(root, '1.aiff'),
    '-filter_complex',
    '[0:a]aresample=16000,aformat=channel_layouts=mono[a];[1:a]aresample=16000,aformat=channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]',
    '-map',
    '[out]',
    '-c:a',
    'pcm_s16le',
    source,
  ]);
}
const origin = process.env.TEST_APP_URL || 'http://127.0.0.1:3000';
let cookie = '';
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${origin}/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith('fm-session=')) cookie = value.split(';')[0];
  const data = await response.json();
  assert.equal(response.status, 200, data.error || path);
  return data;
}
await api('session');
await writeFile(
  resolve(root, 'browser-state.json'),
  JSON.stringify({
    cookies: [
      {
        name: 'fm-session',
        value: cookie.slice('fm-session='.length),
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
const capability = await api<{ transcription: boolean }>('capabilities');
assert.ok(capability.transcription, 'Restart web and worker after configuring server credentials.');
const bytes = await readFile(source),
  name = source.split('/').at(-1)!;
const upload = await api<{ id: string; partSize: number }>('uploads', { name, size: bytes.length });
for (
  let offset = 0, partNumber = 1;
  offset < bytes.length;
  offset += upload.partSize, partNumber++
) {
  const { url } = await api<{ url: string }>(`uploads/${upload.id}/parts`, { partNumber });
  assert.equal(
    (await fetch(url, { method: 'PUT', body: bytes.subarray(offset, offset + upload.partSize) }))
      .status,
    200,
  );
}
await api(`uploads/${upload.id}/complete`, {});
await api(`assets/${upload.id}/prepare`, { profile: 'audio', streamIndex: -1 });
let preparation: PreparationView | undefined;
for (let tries = 0; tries < 600; tries++) {
  preparation = await api<PreparationView>(
    `assets/${upload.id}/prepare?profile=audio&streamIndex=-1`,
  );
  if (preparation.state === 'completed') break;
  if (preparation.state === 'failed') throw new Error('Audio preparation failed');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.ok(preparation?.media && preparation.state === 'completed');
const created = await api<{ id: string }>('jobs', {
  tool: 'transcription',
  assetId: upload.id,
  requestId: crypto.randomUUID(),
  options: { language: 'auto', streamIndex: preparation.media.defaultAudioIndex },
});
console.log(
  `Live acceptance submitted to ${config.provider}, model ${config.model}. Task: ${created.id}`,
);
let progress = -1;
for (let tries = 0; tries < 3600; tries++) {
  const { job } = await api<{ job: JobView }>(`jobs/${created.id}`);
  if (job.progress !== progress) {
    progress = job.progress;
    console.log(`Transcription ${job.state}: ${progress}%`);
  }
  if (job.state === 'failed' || job.state === 'cancelled')
    throw new Error(
      `Live transcription ${job.error || job.state}; retained task ${created.id}. No automatic retry.`,
    );
  if (job.state === 'completed') {
    const transcript = await api<any>(`jobs/${created.id}/transcript`);
    let next = transcript.nextOffset;
    while (next !== null) {
      const page = await api<any>(`jobs/${created.id}/transcript?offset=${next}`);
      assert.equal(page.revision, transcript.revision);
      transcript.segments.push(...page.segments);
      next = page.nextOffset;
    }
    if (process.env.TRANSCRIPTION_EXPECT_EMPTY === 'true')
      assert.equal(transcript.total, 0, 'Silent audio must not produce fabricated speech.');
    else assert.ok(transcript.total > 0, 'No speech detected; inspect the retained task.');
    assert.ok(
      transcript.segments.every(
        (s: any) => s.startMs >= 0 && s.endMs > s.startMs && s.endMs <= transcript.durationMs,
      ),
    );
    await writeFile(
      resolve(root, 'report.json'),
      JSON.stringify(
        {
          provider: config.provider,
          model: config.model,
          jobId: created.id,
          reference: process.env.TRANSCRIPTION_EXPECT_EMPTY === 'true' ? null : reference,
          sourceName: name,
          expectedEmpty: process.env.TRANSCRIPTION_EXPECT_EMPTY === 'true',
          transcript,
          manualReview:
            'Compare beginning, speaker change, and ending with the reference audio. Model-list availability alone is not acceptance.',
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS Live upload → preparation → ${process.env.TRANSCRIPTION_EXPECT_EMPTY === 'true' ? 'empty-speech result' : 'diarized transcription'}. Review ${origin}/zh/workspace/${created.id}`,
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
throw new Error(
  `Live acceptance timed out. Inspect task ${created.id}; do not automatically repeat the request.`,
);
