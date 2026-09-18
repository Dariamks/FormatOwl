import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { processFile } from '../apps/worker/src/processors';
import { runProcess, MediaError } from '@filemorph/core/media';
import {
  videoConversionSchema,
  audioConversionSchema,
  imageConversionSchema,
  type ConversionTool,
  type ConversionOptions,
} from '@filemorph/core/conversion';
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const sharp = require('sharp');
const root = resolve('.data/conversion-checks');
await mkdir(root, { recursive: true });
const fixture = join(root, 'fixtures');
await mkdir(fixture, { recursive: true });
const signal = new AbortController().signal;
for (const format of ['mp4', 'mov', 'mkv', 'webm'])
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=128x96:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:sample_rate=48000',
    '-t',
    '1',
    '-c:v',
    format === 'webm' ? 'libvpx-vp9' : 'libx264',
    '-c:a',
    format === 'webm' ? 'libopus' : 'aac',
    join(fixture, `video.${format}`),
  ]);
for (const format of ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'])
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:sample_rate=48000',
    '-t',
    '1',
    '-c:a',
    (
      {
        mp3: 'libmp3lame',
        wav: 'pcm_s16le',
        aac: 'aac',
        m4a: 'aac',
        flac: 'flac',
        ogg: 'libopus',
      } as Record<string, string>
    )[format],
    join(fixture, `audio.${format}`),
  ]);
for (const format of ['avif', 'png'])
  await sharp({
    create: {
      width: 21,
      height: 13,
      channels: 4,
      background: { r: 100, g: 50, b: 200, alpha: 0.3 },
    },
  })
    .toFormat(format)
    .toFile(join(fixture, `photo.${format}`));
let count = 0;
async function convert(
  tool: ConversionTool,
  options: ConversionOptions,
  input: string,
  name?: string,
) {
  const directory = join(root, String(++count));
  await mkdir(directory, { recursive: true });
  const result = await processFile(
    tool,
    options,
    name ?? input.split('/').at(-1)!,
    input,
    directory,
    signal,
    (p) => assert(Number.isFinite(p)),
  );
  assert((await stat(result.output)).size > 0);
  assert(result.name.endsWith('.' + options.format));
  console.log(`PASS ${count} ${tool} ${input.split('/').at(-1)} → ${options.format}`);
  return result;
}
for (const input of ['mp4', 'mov', 'mkv', 'webm'])
  for (const output of ['mp4', 'mov', 'mkv', 'webm'])
    await convert(
      'video-converter',
      videoConversionSchema.parse({ format: output, codec: output === 'webm' ? 'vp9' : 'h264' }),
      join(fixture, `video.${input}`),
    );
for (const output of ['mp4', 'mov', 'mkv'])
  await convert(
    'video-converter',
    videoConversionSchema.parse({ format: output, codec: 'h265', fps: '30' }),
    join(fixture, 'video.mp4'),
  );
for (const input of ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'])
  for (const output of ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'])
    await convert(
      'audio-converter',
      audioConversionSchema.parse({
        format: output,
        sampleRate: output === 'ogg' ? '48000' : '44100',
      }),
      join(fixture, `audio.${input}`),
    );
for (const input of [
  'photo.jpg',
  'photo.jpeg',
  'transparent.png',
  'photo.webp',
  'photo.heic',
  'oriented.jpg',
  'animated.gif',
  'animated.webp',
  'photo.avif',
])
  for (const output of ['jpg', 'png', 'webp', 'avif'])
    await convert(
      'image-converter',
      imageConversionSchema.parse({ format: output, firstFrame: output !== 'webp' }),
      input === 'photo.avif' ? join(fixture, input) : resolve('.data/fixtures', input),
    );
for (const input of [
  'silent.mp4',
  'rotated.mp4',
  'vfr.mp4',
  'editor-sar.mp4',
  'editor-delay-silence.mp4',
])
  await convert(
    'video-converter',
    videoConversionSchema.parse({ resolution: '480' }),
    resolve('.data/fixtures', input),
  );
for (const format of ['wav', 'flac'])
  await convert(
    'audio-converter',
    audioConversionSchema.parse({ format, bitDepth: 24, sampleRate: '96000' }),
    join(fixture, 'audio.wav'),
  );
for (const format of ['wav', 'flac']) {
  const result = await convert(
    'audio-converter',
    audioConversionSchema.parse({ format, bitDepth: 24, sampleRate: '96000' }),
    join(fixture, 'audio.wav'),
  );
  const probe = JSON.parse(
    await runProcess('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.output]),
  );
  assert.equal(
    Number(probe.streams[0].bits_per_raw_sample || probe.streams[0].bits_per_sample),
    24,
  );
}
for (const format of ['aac', 'm4a'])
  await convert(
    'audio-converter',
    audioConversionSchema.parse({ format, bitrate: 128, sampleRate: '22050' }),
    join(fixture, 'audio.wav'),
  );
for (const [size, expected] of [
  ['1200x900', [640, 480]],
  ['900x1200', [480, 640]],
  ['1001x701', [684, 480]],
] as const) {
  const source = join(fixture, `dimensions-${size}.mkv`);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=12`,
    '-t',
    '0.5',
    '-c:v',
    'ffv1',
    source,
  ]);
  const result = await convert(
    'video-converter',
    videoConversionSchema.parse({ resolution: '480' }),
    source,
  );
  const probe = JSON.parse(
    await runProcess('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_streams',
      '-of',
      'json',
      result.output,
    ]),
  );
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], expected);
}
for (const [input, tool, options, code] of [
  [
    'animated.gif',
    'image-converter',
    imageConversionSchema.parse({ format: 'png' }),
    'ANIMATION_REQUIRES_CHOICE',
  ],
  ['broken.png', 'image-converter', imageConversionSchema.parse({}), 'INVALID_IMAGE'],
  ['broken.heic', 'image-converter', imageConversionSchema.parse({}), 'INVALID_IMAGE'],
  ['broken.mp3', 'audio-converter', audioConversionSchema.parse({}), 'INVALID_MEDIA'],
  ['editor-hdr.mp4', 'video-converter', videoConversionSchema.parse({}), 'HDR_UNSUPPORTED'],
] as const) {
  const dir = join(root, `reject-${input}`);
  await mkdir(dir, { recursive: true });
  await assert.rejects(
    () =>
      processFile(tool, options, input, resolve('.data/fixtures', input), dir, signal, () => {}),
    (e: unknown) => e instanceof MediaError && e.code === code,
  );
}
await writeFile(
  join(root, 'report.json'),
  JSON.stringify({ passed: count, rejections: 5, date: new Date().toISOString() }),
);
console.log(`Converters passed ${count} real conversions and 5 rejection checks.`);
