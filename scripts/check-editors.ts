import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { processEdit, probeEditor, prepareMedia } from '../apps/worker/src/processors/editor';
import { runProcess } from '@filemorph/core/media';
import type { EditorTool, EditOptions } from '@filemorph/core/editing';
const root = resolve('.data/editor-checks');
await mkdir(root, { recursive: true });
// Exercise FFmpeg's real startup N/A progress report deterministically before encoding.
const progressWrapper = join(root, 'ffmpeg-progress');
await writeFile(progressWrapper, '#!/bin/sh\nprintf "out_time_us=N/A\\n"\nexec ffmpeg "$@"\n', {
  mode: 0o700,
});
process.env.FFMPEG_PATH = progressWrapper;
const signal = new AbortController().signal;
let count = 0;
async function source(name: string, id = '11111111-1111-4111-8111-111111111111') {
  const path = resolve('.data/fixtures', name);
  return { id, path, name, media: await probeEditor(path, signal) };
}
async function render(
  tool: EditorTool,
  options: EditOptions,
  inputs: Awaited<ReturnType<typeof source>>[],
  purpose: 'export' | 'preview' = 'export',
) {
  const temp = join(root, String(++count));
  await mkdir(temp, { recursive: true });
  const result = await processEdit(
    tool,
    options,
    inputs,
    temp,
    signal,
    (n) => assert.ok(Number.isFinite(n)),
    purpose,
  );
  console.log(`PASS ${count} ${tool}: ${inputs.map((s) => s.name).join(', ')} → ${result.name}`);
  return result;
}
for (const name of [
  'sample.mp4',
  'sample.mov',
  'sample.mkv',
  'sample.webm',
  'silent.mp4',
  'rotated.mp4',
  'vfr.mp4',
]) {
  const s = await source(name);
  const cut = await render(
    'video-cutter',
    {
      mode: 'keep',
      ranges: [
        { startMs: 1200, endMs: 2100 },
        { startMs: 200, endMs: 800 },
      ],
    },
    [s],
  );
  assert.ok(Math.abs(cut.outputMedia!.duration - 1.5) < 0.2);
  const crop = await render('video-cropper', { rect: { x: 10, y: 20, width: 200, height: 300 } }, [
    s,
  ]);
  assert.equal(crop.outputMedia!.width, 200);
  assert.equal(crop.outputMedia!.height, 300);
  if (s.media.tracks.length)
    await render(
      'video-to-mp3',
      {
        audioStreamIndex: s.media.defaultAudioIndex!,
        bitrate: 192,
        range: { startMs: 200, endMs: 1800 },
      },
      [s],
    );
}
const a = await source('editor-multitrack.mp4'),
  b = await source('editor-low.wav', '22222222-2222-4222-8222-222222222222');
assert.equal(a.media.defaultAudioIndex, 2);
const crop = await render('video-cropper', { rect: { x: 160, y: 120, width: 160, height: 120 } }, [
  a,
]);
for (const format of ['mp4', 'mkv', 'mov'] as const) {
  for (const tool of ['video-cutter', 'video-cropper'] as const) {
    const result = await render(
      tool,
      tool === 'video-cutter'
        ? { format, mode: 'keep', ranges: [{ startMs: 250, endMs: 1750 }] }
        : { format, rect: { x: 160, y: 120, width: 160, height: 120 } },
      [a],
    );
    assert.ok(result.name.endsWith(`.${format}`));
    assert.equal(
      result.mime,
      { mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime' }[format],
    );
    const probe = JSON.parse(
      await runProcess(
        'ffprobe',
        ['-v', 'error', '-show_format', '-of', 'json', result.output],
        signal,
      ),
    );
    if (format === 'mkv') assert.equal(probe.format.format_name, 'matroska,webm');
    else assert.equal(probe.format.tags.major_brand.trim(), format === 'mov' ? 'qt' : 'isom');
    assert.equal(result.outputPreview !== undefined, format !== 'mp4');
    if (result.outputPreview) {
      assert.equal(result.previewMime, 'video/mp4');
      const previewMedia = await probeEditor(result.outputPreview, signal);
      assert.equal(previewMedia.width, result.outputMedia!.width);
      assert.equal(previewMedia.height, result.outputMedia!.height);
      assert.ok(Math.abs(previewMedia.duration - result.outputMedia!.duration) < 0.15);
      await runProcess(
        'ffmpeg',
        ['-v', 'error', '-i', result.outputPreview, '-f', 'null', '-'],
        signal,
      );
    }
  }
}
const rgb = join(root, 'crop.rgb');
await runProcess(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-i',
    crop.output,
    '-vf',
    'scale=1:1',
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    rgb,
  ],
  signal,
);
const pixel = await readFile(rgb);
assert.ok(pixel[0] > 180 && pixel[1] > 180 && pixel[2] < 60, `Expected yellow, got ${pixel}`);
await render('video-cutter', { mode: 'remove', ranges: [{ startMs: 1000, endMs: 3000 }] }, [a]);
const sar = await source('editor-sar.mp4');
assert.equal(sar.media.width, 640);
await render('video-cropper', { rect: { x: 320, y: 120, width: 320, height: 120 } }, [sar]);
for (const format of ['mp3', 'wav', 'm4a', 'm4r'] as const) {
  const result = await render(
    'audio-cutter',
    {
      format,
      bitrate: 192,
      clips: [
        { assetId: b.id, streamIndex: 0, startMs: 100, endMs: 1500, fadeInMs: 300, fadeOutMs: 300 },
        { assetId: a.id, streamIndex: 2, startMs: 0, endMs: 1000, fadeInMs: 0, fadeOutMs: 0 },
      ],
    },
    [b, a],
  );
  assert.ok(Math.abs(result.outputMedia!.duration - 2.4) < 0.12);
  assert.equal(result.outputMedia!.sampleRate, 44100);
  if (format === 'wav') {
    const path = join(root, 'composition.pcm');
    await runProcess(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', result.output, '-ac', '1', '-ar', '8000', '-f', 'f32le', path],
      signal,
    );
    const data = await readFile(path);
    const energy = (start: number, end: number) => {
      let sum = 0,
        n = 0;
      for (let i = Math.floor(start * 8000); i < end * 8000; i++) {
        sum += data.readFloatLE(i * 4) ** 2;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    const tone = (start: number, hz: number) => {
      let re = 0,
        im = 0;
      for (let i = 0; i < 1600; i++) {
        const v = data.readFloatLE((Math.floor(start * 8000) + i) * 4),
          angle = (2 * Math.PI * hz * i) / 8000;
        re += v * Math.cos(angle);
        im += v * Math.sin(angle);
      }
      return Math.hypot(re, im);
    };
    assert.ok(energy(0.01, 0.06) < energy(0.5, 0.6) / 2, 'Fade-in amplitude');
    assert.ok(energy(1.34, 1.39) < energy(0.5, 0.6) / 2, 'Fade-out amplitude');
    assert.ok(tone(0.5, 660) > tone(0.5, 880) * 10, 'First clip is the 660 Hz source');
    assert.ok(tone(1.6, 880) > tone(1.6, 660) * 10, 'Second clip uses the selected 880 Hz track');
  }
}
for (const name of [
  'audio.mp3',
  'audio.wav',
  'audio.aac',
  'audio.m4a',
  'audio.flac',
  'audio.ogg',
  'editor-ring.m4r',
]) {
  const s = await source(name);
  await render(
    'audio-cutter',
    {
      format: 'mp3',
      bitrate: 128,
      clips: [
        {
          assetId: s.id,
          streamIndex: s.media.defaultAudioIndex!,
          startMs: 0,
          endMs: Math.min(2000, Math.round(s.media.duration * 1000)),
          fadeInMs: 200,
          fadeOutMs: 200,
        },
      ],
    },
    [s],
  );
}
const offset = await source('editor-offset.mp4');
const delayed = await render(
  'video-to-mp3',
  { audioStreamIndex: offset.media.defaultAudioIndex!, bitrate: 192 },
  [offset],
);
const pcm = join(root, 'offset.pcm');
await runProcess(
  'ffmpeg',
  ['-v', 'error', '-y', '-i', delayed.output, '-ac', '1', '-ar', '8000', '-f', 'f32le', pcm],
  signal,
);
const samples = await readFile(pcm);
function rms(start: number, end: number) {
  let n = 0,
    sum = 0;
  for (let i = Math.floor(start * 8000); i < Math.min(samples.length / 4, end * 8000); i++) {
    sum += samples.readFloatLE(i * 4) ** 2;
    n++;
  }
  return Math.sqrt(sum / n);
}
assert.ok(rms(0.1, 0.7) < 0.005);
assert.ok(rms(1.2, 1.8) > 0.03);
for (const [s, profile] of [
  [a, 'video'],
  [a, 'audio'],
  [b, 'audio'],
] as const) {
  const temp = join(root, `prep-${++count}`);
  await mkdir(temp, { recursive: true });
  const result = await prepareMedia(s.path, s.media, profile, -1, temp, signal, () => {});
  assert.ok((await readFile(result.preview)).length > 100);
  if (result.peaks) {
    const peaks = JSON.parse(await readFile(result.peaks, 'utf8'));
    assert.ok(peaks.peaks[0].length > 10);
    assert.ok(peaks.peaks[0].some((v: number) => v > 0.01));
  }
  if (result.thumbnails) assert.ok((await readFile(result.thumbnails)).length > 100);
  console.log(`PASS ${count} ${profile} preparation`);
}
const hdr = await source('editor-hdr.mp4');
await assert.rejects(
  () =>
    processEdit(
      'video-cropper',
      { rect: { x: 0, y: 0, width: 100, height: 100 } },
      [hdr],
      root,
      signal,
      () => {},
      'export',
    ),
  /HDR_UNSUPPORTED/,
);
await render('video-to-mp3', { audioStreamIndex: hdr.media.defaultAudioIndex!, bitrate: 192 }, [
  hdr,
]);
console.log(
  `Editor processing checks passed: ${count} successful outputs plus explicit HDR rejection.`,
);
