import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { processFile, pythonBinary } from '../apps/worker/src/processors';
import { runProcess } from '@filemorph/core/media';
import { compressionSchema } from '@filemorph/core/domain';
import { imageConversionSchema } from '@filemorph/core/conversion';
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const sharp = require('sharp');
const root = resolve('.data/seo-examples');
await mkdir(root, { recursive: true });
const signal = AbortSignal.timeout(120000);
await runProcess(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24:duration=10',
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    join(root, 'motion.mp4'),
  ],
  signal,
);
await sharp({
  create: { width: 240, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="240" height="160"><rect x="60" y="40" width="120" height="80" fill="#263bc4"/></svg>',
      ),
    },
  ])
  .webp({ lossless: true })
  .toFile(join(root, 'transparent.webp'));
await runProcess(
  pythonBinary,
  [
    '-c',
    `
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import sys
root=Path(sys.argv[1])
c=canvas.Canvas(str(root/'text.pdf'),pagesize=(600,800),pageCompression=1,invariant=1)
for i in range(28): c.drawString(50,750-i*22,'FormatOwl synthetic text document: line '+str(i+1))
c.save()
im=Image.new('RGB',(1200,1600)); im.putdata([((x*17+y*3)%256,(x*2+y*11)%256,(x+y*7)%256) for y in range(1600) for x in range(1200)])
c=canvas.Canvas(str(root/'scan.pdf'),pagesize=(600,800),pageCompression=1,invariant=1)
c.drawImage(ImageReader(im),0,0,width=600,height=800); c.save()
`,
    root,
  ],
  signal,
);
const scenarios = [
  {
    id: 'video',
    tool: 'video-compressor' as const,
    file: 'motion.mp4',
    options: compressionSchema.parse({ targetMb: 0.3, codec: 'h264' }),
  },
  {
    id: 'transparent',
    tool: 'image-converter' as const,
    file: 'transparent.webp',
    options: imageConversionSchema.parse({ format: 'jpg', background: '#ffffff', quality: 85 }),
  },
  {
    id: 'text',
    tool: 'pdf-compressor' as const,
    file: 'text.pdf',
    options: { preset: 'strong' as const },
  },
  {
    id: 'scan',
    tool: 'pdf-compressor' as const,
    file: 'scan.pdf',
    options: { preset: 'strong' as const },
  },
];
const report = [];
for (const s of scenarios) {
  const dir = join(root, s.id);
  await mkdir(dir, { recursive: true });
  const result = await processFile(
    s.tool,
    s.options,
    s.file,
    join(root, s.file),
    dir,
    signal,
    () => {},
  );
  const inputBytes = (await stat(join(root, s.file))).size;
  const outputBytes = (await stat(result.output)).size;
  let corner: number[] | undefined;
  if (s.id === 'transparent') {
    const decoded = await sharp(result.output).raw().toBuffer({ resolveWithObject: true });
    corner = Array.from(decoded.data.subarray(0, 3));
    assert(corner.every((v) => v >= 250));
    assert.equal((await sharp(result.output).metadata()).hasAlpha, false);
  }
  report.push({
    id: s.id,
    inputBytes,
    outputBytes,
    options: s.options,
    note: result.note,
    ...(corner ? { cornerRGB: corner } : {}),
  });
}
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
