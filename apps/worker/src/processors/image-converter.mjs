import sharp from 'sharp';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
sharp.cache(false);
sharp.concurrency(2);
const {
  source,
  imageInput,
  primaryOnly,
  output,
  name,
  options: o,
  temp,
} = JSON.parse(await readFile(process.argv[2], 'utf8'));
try {
  const input = imageInput,
    ext = name.split('.').pop().toLowerCase();
  // libvips versions differ in APNG metadata; inspect the PNG chunk table as well.
  if (ext === 'png') {
    const buffer = await readFile(source);
    let at = 8;
    while (at + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(at),
        type = buffer.toString('ascii', at + 4, at + 8);
      if (type === 'acTL') throw new Error('UNSUPPORTED_ANIMATION');
      if (type === 'IEND') break;
      at += length + 12;
    }
  }
  const meta = await sharp(input, { animated: true, limitInputPixels: 250000000 }).metadata();
  const expected = { jpg: 'jpeg', jpeg: 'jpeg', heic: 'png', avif: 'heif' }[ext] || ext;
  if (meta.format !== expected || (ext === 'avif' && meta.compression !== 'av1'))
    throw new Error('INVALID_IMAGE');
  const pages = meta.pages || 1,
    h = meta.pageHeight || meta.height;
  if (
    !meta.width ||
    !h ||
    meta.width * h > 100000000 ||
    pages > 500 ||
    meta.width * h * pages > 250000000
  )
    throw new Error('IMAGE_LIMIT');
  if (pages > 1 && o.format !== 'webp' && !o.firstFrame)
    throw new Error('ANIMATION_REQUIRES_CHOICE');
  const animated = pages > 1 && !o.firstFrame;
  let pipe = sharp(input, { animated, limitInputPixels: 250000000 }).withIccProfile('srgb');
  if (!animated) pipe = pipe.autoOrient();
  const quality = o.quality ?? { jpg: 85, png: 100, webp: 80, avif: 50 }[o.format];
  if (o.format === 'jpg') pipe = pipe.flatten({ background: o.background }).jpeg({ quality });
  if (o.format === 'png') pipe = pipe.png({ compressionLevel: 9 });
  if (o.format === 'webp')
    pipe = pipe.webp({
      quality,
      alphaQuality: 100,
      effort: 4,
      ...(animated ? { loop: meta.loop, delay: meta.delay } : {}),
    });
  if (o.format === 'avif') pipe = pipe.avif({ quality, effort: 4, bitdepth: 8 });
  await pipe.toFile(output);
  if ((await stat(output)).size > 4 * 1024 ** 3) throw new Error('OUTPUT_TOO_LARGE');
  const actual = await sharp(output, { animated: true, limitInputPixels: 250000000 }).metadata();
  const expectedOutput = o.format === 'jpg' ? 'jpeg' : o.format === 'avif' ? 'heif' : o.format;
  if (
    actual.format !== expectedOutput ||
    (o.format === 'avif' && actual.compression !== 'av1') ||
    (actual.pages || 1) !== (animated ? pages : 1) ||
    (meta.hasAlpha && o.format !== 'jpg' && !actual.hasAlpha) ||
    actual.exif
  )
    throw new Error('INVALID_OUTPUT');
  // Force pixel decoding too; metadata alone cannot prove a complete file.
  await sharp(output, { animated: true, limitInputPixels: 250000000 }).stats();
  const inputPreview = join(temp, 'original-preview.png'),
    outputPreview = join(temp, 'output-preview.png');
  // WebP previews preserve animation and alpha on both sides.
  const previewExt = animated ? 'webp' : 'png';
  const a = join(temp, `original-preview.${previewExt}`),
    b = join(temp, `output-preview.${previewExt}`);
  await (
    animated
      ? sharp(input, { animated: true, limitInputPixels: 250000000 })
      : sharp(input, { limitInputPixels: 250000000 }).autoOrient()
  )
    .resize({ width: 1400, withoutEnlargement: true })
    .toFormat(previewExt)
    .toFile(a);
  await sharp(output, { animated, limitInputPixels: 250000000 })
    .resize({ width: 1400, withoutEnlargement: true })
    .toFormat(previewExt)
    .toFile(b);
  console.log(
    JSON.stringify({
      media: {
        kind: 'image',
        width: actual.width,
        height: actual.pageHeight || actual.height,
        format: o.format,
        pages: actual.pages || 1,
        hasAlpha: !!actual.hasAlpha,
        delay: actual.delay,
        loop: actual.loop,
      },
      note: primaryOnly
        ? 'PRIMARY_IMAGE_ONLY'
        : pages > 1 && o.firstFrame
          ? 'FIRST_FRAME_ONLY'
          : (await stat(output)).size > (await stat(source)).size
            ? 'LARGER'
            : null,
      inputPreview: a,
      outputPreview: b,
      previewMime: `image/${previewExt}`,
    }),
  );
} catch (e) {
  console.error(
    `FM_ERROR:${['INVALID_IMAGE', 'IMAGE_LIMIT', 'UNSUPPORTED_ANIMATION', 'ANIMATION_REQUIRES_CHOICE', 'INVALID_OUTPUT', 'OUTPUT_TOO_LARGE'].includes(e.message) ? e.message : 'INVALID_IMAGE'}`,
  );
  process.exitCode = 1;
}
