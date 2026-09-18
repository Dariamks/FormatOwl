import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '@filemorph/core/media';
const root = resolve('.data/fixtures');
await mkdir(root, { recursive: true });
const ff = (args: string[], name: string) =>
  runProcess('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-nostdin',
    '-y',
    ...args,
    resolve(root, name),
  ]);
await ff(
  [
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240:r=25:d=4,drawbox=x=160:y=0:w=160:h=120:c=lime:t=fill,drawbox=x=0:y=120:w=160:h=120:c=blue:t=fill,drawbox=x=160:y=120:w=160:h=120:c=yellow:t=fill',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:r=44100:d=4',
    '-f',
    'lavfi',
    '-i',
    'sine=f=880:r=48000:d=4',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=zho',
    '-disposition:a:0',
    '0',
    '-disposition:a:1',
    'default',
  ],
  'editor-multitrack.mp4',
);
await ff(
  [
    '-i',
    resolve(root, 'editor-multitrack.mp4'),
    '-map',
    '0:v',
    '-map',
    '0:a:0',
    '-vf',
    'setsar=2/1',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-c:a',
    'copy',
  ],
  'editor-sar.mp4',
);
await ff(
  [
    '-i',
    resolve(root, 'editor-multitrack.mp4'),
    '-map',
    '0:v',
    '-map',
    '0:a:0',
    '-af',
    'adelay=1000:all=1',
    '-t',
    '4',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
  ],
  'editor-delay-silence.mp4',
);
await ff(
  [
    '-i',
    resolve(root, 'editor-multitrack.mp4'),
    '-itsoffset',
    '1',
    '-i',
    resolve(root, 'editor-multitrack.mp4'),
    '-map',
    '0:v',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-t',
    '4',
  ],
  'editor-offset.mp4',
);
await ff(
  [
    '-i',
    resolve(root, 'editor-multitrack.mp4'),
    '-map',
    '0:v',
    '-map',
    '0:a:0',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-vf',
    'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc',
    '-x264-params',
    'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    '-c:a',
    'copy',
  ],
  'editor-hdr.mp4',
);
await ff(['-f', 'lavfi', '-i', 'sine=f=660:r=22050:d=3', '-c:a', 'pcm_s16le'], 'editor-low.wav');
await ff(['-i', resolve(root, 'editor-low.wav'), '-c:a', 'aac', '-f', 'ipod'], 'editor-ring.m4r');
console.log('Editor fixtures ready.');
