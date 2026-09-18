/** Rebuild original, public demo assets with the same processors as real jobs. */
import { mkdir, copyFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { processFile, pythonBinary } from '../apps/worker/src/processors';
import { runProcess } from '@filemorph/core/media';
import { compressionSchema } from '@filemorph/core/domain';
import { imageConversionSchema } from '@filemorph/core/conversion';
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const sharp = require('sharp');
const root = resolve('.data/public-examples');
const out = resolve('apps/web/public/examples');
await mkdir(root, { recursive: true });
await mkdir(out, { recursive: true });
const signal = AbortSignal.timeout(180000);
const artwork = `<svg width="1440" height="810" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="paper" x2="1" y2="1"><stop stop-color="#edede5"/><stop offset="1" stop-color="#d8dfd1"/></linearGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#b8c4ae" stroke-opacity=".3"/></pattern></defs>
<rect width="1440" height="810" fill="url(#paper)"/><rect width="1440" height="810" fill="url(#grid)"/>
<text x="88" y="100" font-family="Arial" font-size="24" fill="#394737">FORMATOWL / FIELD NOTES</text>
<text x="88" y="310" font-family="Arial" font-weight="bold" font-size="106" letter-spacing="-4" fill="#253425">Less file.</text><text x="88" y="420" font-family="Arial" font-weight="bold" font-size="106" letter-spacing="-4" fill="#253425">More room.</text>
<text x="92" y="490" font-family="Arial" font-size="26" fill="#55634e">Make space for what matters.</text>
<g transform="translate(890 190) rotate(9 175 220)"><rect x="-12" y="14" width="355" height="440" rx="24" fill="#53624f" opacity=".13"/><rect width="340" height="440" rx="24" fill="#fcfaf5"/><rect x="28" y="28" width="284" height="270" rx="12" fill="#273fc0"/><circle cx="172" cy="150" r="86" fill="#cdd8a9"/><path d="M86 235L173 67L258 235Z" fill="#f7f3e4"/><circle cx="173" cy="194" r="34" fill="#263bc4"/><rect x="28" y="331" width="180" height="12" rx="6" fill="#263528"/><rect x="28" y="360" width="238" height="9" rx="4" fill="#c6cbbf"/><text x="28" y="407" font-family="Arial" font-size="17" fill="#65715d">A LITTLE SPACE GOES A LONG WAY</text></g>
<path d="M90 671H1350" stroke="#aeb8a2"/><text x="90" y="721" font-family="Arial" font-size="18" fill="#65715d">ORIGINAL MOTION STUDY</text><text x="1235" y="721" font-family="Arial" font-size="18" fill="#65715d">08 SEC.</text></svg>`;
await sharp(Buffer.from(artwork)).png().toFile(join(root, 'scene.png'));
await sharp(Buffer.from(artwork))
  .resize(960, 540)
  .webp({ quality: 88 })
  .toFile(join(out, 'video-poster.webp'));
await runProcess(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-loop',
    '1',
    '-i',
    join(root, 'scene.png'),
    '-vf',
    "zoompan=z='1.0+0.0003*on':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=960x540:fps=24",
    '-t',
    '8',
    '-c:v',
    'libx264',
    '-crf',
    '8',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    join(out, 'studio-original.mp4'),
  ],
  signal,
);
const transparent = `<svg width="960" height="600" xmlns="http://www.w3.org/2000/svg"><g transform="translate(225 78) rotate(-8 250 220)"><rect width="470" height="390" rx="24" fill="#263bc4"/><circle cx="235" cy="163" r="112" fill="#ccd8aa"/><path d="M132 263L236 53L340 263Z" fill="#f7f5ec"/><circle cx="236" cy="220" r="42" fill="#263bc4"/><text x="42" y="338" font-family="Arial" font-size="33" font-weight="bold" fill="white">A little more room.</text></g></svg>`;
await sharp(Buffer.from(transparent))
  .webp({ lossless: true })
  .toFile(join(out, 'studio-transparent.webp'));
await runProcess(
  pythonBinary,
  [
    '-c',
    `
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image
import sys
root=Path(sys.argv[1]); out=Path(sys.argv[2])
im=Image.open(root/'scene.png').convert('RGB').resize((2400,1350))
# A raster-rich document deliberately demonstrates what PDF compression can reduce.
noise=Image.effect_noise(im.size,18).convert('RGB')
im=Image.blend(im,noise,.025)
c=canvas.Canvas(str(out/'studio-original.pdf'),pagesize=(600,800),invariant=1)
c.setTitle('A little more room — FormatOwl sample'); c.setAuthor('FormatOwl')
c.setFillColorRGB(.97,.96,.94); c.rect(0,0,600,800,fill=1,stroke=0)
c.setFillColorRGB(.13,.14,.12); c.setFont('Helvetica-Bold',14); c.drawString(42,744,'FormatOwl / Studio notes')
c.setFont('Helvetica-Bold',34); c.drawString(42,663,'A little more room.')
c.setFont('Helvetica',12); c.drawString(42,633,'A small collection of ideas, ready to share.')
c.drawImage(ImageReader(im),42,294,width=516,height=290.25)
c.setFillColorRGB(.15,.23,.77); c.setFont('Helvetica-Bold',11); c.drawString(42,247,'01 / KEEP THE ESSENTIALS')
c.setFillColorRGB(.35,.38,.32); c.setFont('Helvetica',12)
for i,line in enumerate(['A document can be lighter and still carry the same idea.', 'This original sample combines an illustration with selectable text.', 'Compare both versions, then try your own settings.']): c.drawString(42,218-i*22,line)
c.setStrokeColorRGB(.82,.83,.8); c.line(42,95,558,95)
c.setFont('Helvetica',10); c.drawString(42,70,'PUBLIC DEMO / Created by FormatOwl'); c.drawRightString(558,70,'01')
c.save()
`,
    root,
    out,
  ],
  signal,
);
const scenarios = [
  {
    id: 'video',
    tool: 'video-compressor' as const,
    input: 'studio-original.mp4',
    output: 'studio-compressed.mp4',
    options: compressionSchema.parse({
      preset: 'balanced',
      codec: 'h264',
      resolution: 'original',
      speed: 'medium',
    }),
  },
  {
    id: 'image',
    tool: 'image-converter' as const,
    input: 'studio-transparent.webp',
    output: 'studio-white.jpg',
    options: imageConversionSchema.parse({ format: 'jpg', background: '#ffffff', quality: 85 }),
  },
  {
    id: 'pdf',
    tool: 'pdf-compressor' as const,
    input: 'studio-original.pdf',
    output: 'studio-compressed.pdf',
    options: { preset: 'strong' as const },
  },
];
const report: Record<string, { inputBytes: number; outputBytes: number }> = {};
for (const s of scenarios) {
  const dir = join(root, s.id);
  await mkdir(dir, { recursive: true });
  const result = await processFile(
    s.tool,
    s.options,
    s.input,
    join(out, s.input),
    dir,
    signal,
    () => {},
  );
  await copyFile(result.output, join(out, s.output));
  report[s.id] = {
    inputBytes: (await stat(join(out, s.input))).size,
    outputBytes: (await stat(join(out, s.output))).size,
  };
}
await runProcess(
  pythonBinary,
  [
    '-c',
    `
import pypdfium2 as pdfium, sys
from pathlib import Path
out=Path(sys.argv[1])
for name in ['original', 'compressed']:
    doc=pdfium.PdfDocument(str(out/('studio-'+name+'.pdf')))
    page=doc[0]
    bitmap=page.render(scale=1.3)
    bitmap.to_pil().save(str(out/('pdf-'+name+'.png')))
    bitmap.close(); page.close(); doc.close()
`,
    out,
  ],
  signal,
);
for (const name of ['original', 'compressed'])
  await sharp(join(out, `pdf-${name}.png`))
    .webp({ quality: 85 })
    .toFile(join(out, `pdf-${name}.webp`));
const { unlink } = await import('node:fs/promises');
for (const name of ['original', 'compressed']) await unlink(join(out, `pdf-${name}.png`));
await writeFile(join(out, 'sizes.json'), JSON.stringify(report, null, 2) + '\n');
console.log(report);
