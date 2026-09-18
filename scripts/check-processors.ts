import assert from 'node:assert/strict';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { processFile, pythonBinary } from '../apps/worker/src/processors';
import { runProcess } from '@filemorph/core/media';
import { audioCompressionSchema, fileTool, type ToolOptions } from '@filemorph/core/domain';
import { probeAudio, encodeAudio } from '../apps/worker/src/processors/audio';
const root = resolve('.data/processor-checks');
await mkdir(root, { recursive: true });
let count = 0;
for (const name of [
  'photo.jpg',
  'photo.jpeg',
  'photo.webp',
  'transparent.png',
  'animated.gif',
  'animated.webp',
  'oriented.jpg',
  'photo.heic',
  'already.jpg',
  'document.pdf',
  'scan.pdf',
  'audio.mp3',
  'audio.wav',
  'audio.aac',
  'audio.m4a',
  'audio.flac',
  'audio.ogg',
]) {
  for (const preset of ['light', 'balanced', 'strong'] as const) {
    const tool = fileTool(name)!;
    const output = join(root, `${name}-${preset}`);
    await mkdir(output, { recursive: true });
    const options: ToolOptions =
      tool === 'audio-compressor'
        ? audioCompressionSchema.parse({ preset, format: preset === 'balanced' ? 'm4a' : 'mp3' })
        : { preset };
    const input = resolve('.data/fixtures', name);
    const result = await processFile(
      tool,
      options,
      name,
      input,
      output,
      new AbortController().signal,
      () => {},
    );
    assert((await stat(result.output)).size > 0);
    if (tool === 'image-compressor' || tool === 'pdf-compressor')
      assert((await stat(result.output)).size <= (await stat(input)).size);
    if (tool === 'pdf-compressor') {
      const report = JSON.parse(
        await runProcess(pythonBinary, [
          '-c',
          `import json,sys;from pypdf import PdfReader; a=PdfReader(sys.argv[1]);b=PdfReader(sys.argv[2]);print(json.dumps({'text': [p.extract_text() for p in a.pages]==[p.extract_text() for p in b.pages], 'pages': len(a.pages)==len(b.pages),'fields':list((a.get_fields() or {}).keys())==list((b.get_fields() or {}).keys())}))`,
          input,
          result.output,
        ]),
      );
      assert(report.text && report.pages && report.fields);
    }
    console.log(`PASS ${name} ${preset}: ${result.note || 'compressed'}`);
    count++;
  }
}
for (const [name, code] of [
  ['encrypted.pdf', 'PDF_ENCRYPTED'],
  ['signed.pdf', 'PDF_SIGNED'],
  ['broken.pdf', 'INVALID_PDF'],
  ['broken.png', 'INVALID_IMAGE'],
  ['broken.heic', 'INVALID_IMAGE'],
  ['broken.mp3', 'INVALID_AUDIO'],
]) {
  const output = join(root, name);
  await mkdir(output, { recursive: true });
  await assert.rejects(
    () =>
      processFile(
        fileTool(name)!,
        { preset: 'balanced', format: 'mp3', sampleRate: 'auto', channels: 'auto' },
        name,
        resolve('.data/fixtures', name),
        output,
        new AbortController().signal,
        () => {},
      ),
    (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === code,
  );
  console.log(`PASS ${name}: ${code}`);
  count++;
}
// FFmpeg otherwise silently clamps MP3 bitrates at low sample rates.
for (const rate of [6000, 8000, 22050]) {
  const source = join(root, `low-rate-${rate}.wav`);
  const output = join(root, `low-rate-${rate}.mp3`);
  const signal = new AbortController().signal;
  await runProcess('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=sample_rate=${rate}:duration=2`,
    source,
  ]);
  const media = await probeAudio(source, signal);
  await assert.rejects(
    () =>
      encodeAudio(
        source,
        output,
        audioCompressionSchema.parse({ preset: 'light' }),
        media,
        signal,
        () => {},
      ),
    (e: unknown) =>
      !!e &&
      typeof e === 'object' &&
      'code' in e &&
      e.code === (rate < 8000 ? 'AUDIO_SAMPLE_RATE' : 'AUDIO_BITRATE'),
  );
  console.log(`PASS ${rate} Hz rejects incompatible automatic MP3 settings`);
  count++;
  if (rate >= 8000) {
    const result = await encodeAudio(
      source,
      output,
      audioCompressionSchema.parse({ preset: 'strong' }),
      media,
      signal,
      () => {},
    );
    assert.equal(result.sampleRate, rate);
    assert.equal(result.channels, 1);
    assert.equal(result.bitrate, 64);
    console.log(`PASS ${rate} Hz preserves mono and exports the selected 64 kbps`);
    count++;
  }
}
console.log(`${count} processor checks passed`);
