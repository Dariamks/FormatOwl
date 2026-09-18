import { mkdir, writeFile, copyFile, truncate } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '@filemorph/core/media';
const directory = resolve('.data/fixtures');
await mkdir(directory, { recursive: true });
const base = resolve(directory, 'sample.mp4');
await runProcess('ffmpeg', [
  '-hide_banner',
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=960x540:rate=25',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '5',
  '-c:v',
  'libx264',
  '-threads',
  '2',
  '-crf',
  '14',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  base,
]);
for (const [name, args] of [
  ['sample.mov', ['-c', 'copy']],
  ['sample.mkv', ['-c', 'copy']],
  [
    'sample.webm',
    [
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-threads',
      '2',
      '-c:a',
      'libopus',
    ],
  ],
  ['silent.mp4', ['-c:v', 'copy', '-an']],
  ['rotated.mp4', ['-c', 'copy']],
  [
    'vfr.mp4',
    [
      '-vf',
      "select='not(mod(n,3))+not(mod(n,5))'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-crf',
      '18',
      '-c:a',
      'copy',
    ],
  ],
] as [string, string[]][])
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    ...(name === 'rotated.mp4' ? ['-display_rotation:v:0', '90'] : []),
    '-i',
    base,
    ...args,
    resolve(directory, name),
  ]);
await copyFile(base, resolve(directory, 'multipart.mp4'));
await truncate(resolve(directory, 'multipart.mp4'), 34 * 1024 * 1024);
await writeFile(resolve(directory, 'broken.mp4'), 'This is a deliberately invalid media fixture.');
console.log(`Created synthetic test videos in ${directory}`);
