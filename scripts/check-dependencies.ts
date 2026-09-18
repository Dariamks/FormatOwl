import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '@filemorph/core/media';
import { pythonBinary } from '../apps/worker/src/processors';
const encoders = await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-hide_banner',
  '-encoders',
]);
for (const codec of ['libx264', 'libx265', 'libmp3lame', 'aac', 'libvpx-vp9', 'libopus', 'flac'])
  if (!encoders.includes(codec)) throw new Error(`FFmpeg is missing ${codec}`);
await runProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-version']);
const filters = await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-filters']);
if (!/\bsubtitles\s+V->V/.test(filters))
  throw new Error('Translation requires FFmpeg with libass (subtitles filter)');
await runProcess(process.env.SOFFICE_PATH || 'soffice', ['--headless', '--version']);
await runProcess(pythonBinary, [
  '-c',
  `
import sys,tempfile,pathlib
assert sys.version_info[:2] >= (3,12), 'Python 3.12+ is required'
from PIL import Image,features
assert features.check('raqm'), 'Pillow requires Raqm for Arabic and complex text shaping'
import os
if sys.platform=='darwin':os.environ.setdefault('DYLD_FALLBACK_LIBRARY_PATH','/opt/homebrew/lib:/usr/local/lib:/usr/lib')
import pdfplumber,pypdfium2,uharfbuzz,cairosvg
from PIL import ImageFont
for name in ['SC','JP','KR','Arabic']:
 ImageFont.truetype('apps/worker/assets/NotoSans'+name+'-Regular.ttf',16)
import pikepdf,pillow_heif,docx,reportlab
with tempfile.TemporaryDirectory() as directory:
 path=pathlib.Path(directory)/'test.heic'
 pillow_heif.from_pillow(Image.new('RGB',(16,16),'red')).save(path,quality=80)
 assert pillow_heif.open_heif(path).size == (16,16)
 with pikepdf.Pdf.new() as pdf:
  pdf.add_blank_page();pdf.save(path.with_suffix('.pdf'))
print('Python, PDF and HEIC encode/decode ready')
`,
]);
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
await runProcess(process.execPath, [
  '--input-type=module',
  '-e',
  `import sharp from ${JSON.stringify(pathToFileURL(require.resolve('sharp')).href)};for(const format of ['png','webp','avif']) { const buffer=await sharp({create:{width:16,height:16,channels:4,background:'#fff0'}}).toFormat(format).toBuffer();await sharp(buffer).stats(); }`,
]);
console.log('FFmpeg, ffprobe, Sharp, Python 3.12, pikepdf, Pillow and HEIC: ready');

await runProcess(
  process.env.DOCLING_PYTHON_PATH ||
    resolve(
      '.data/docling-venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    ),
  [
    '-c',
    `
import os,json
from pathlib import Path
from importlib.metadata import version
import cv2,torch
from docling.document_converter import DocumentConverter
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
manifest=json.loads(Path('apps/worker/python/document-models.json').read_text())
assert version('docling-slim')==manifest['docling']
root=Path(os.environ.get('DOCLING_ARTIFACTS_PATH','.data/docling-models'))
for path in ['docling-project--docling-layout-heron/model.safetensors','docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors']:
 assert (root/path).is_file(), 'Run pnpm setup:documents to install local models'
print('Pinned Docling, Heron and TableFormer Accurate: ready')
`,
  ],
);
