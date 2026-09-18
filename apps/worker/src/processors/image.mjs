import sharp from 'sharp';
import { readFile, stat, copyFile } from 'node:fs/promises';
sharp.cache(false);
sharp.concurrency(2);
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { source, output, preset, extension } = input;
try {
  const metadata = await sharp(source, {
    animated: true,
    limitInputPixels: 250_000_000,
  }).metadata();
  const height = metadata.pageHeight || metadata.height;
  const pages = metadata.pages || 1;
  if (
    !['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) ||
    (extension === 'jpg' ? 'jpeg' : extension) !== metadata.format
  )
    throw new Error('INVALID_IMAGE');
  if (
    !metadata.width ||
    !height ||
    metadata.width * height > 100_000_000 ||
    pages > 500 ||
    metadata.width * height * pages > 250_000_000
  )
    throw new Error('IMAGE_LIMIT');
  // APNG requires a distinct encoder; never silently drop animation.
  if (metadata.format === 'png' && pages > 1) throw new Error('UNSUPPORTED_ANIMATION');
  let pipeline = sharp(source, { animated: true, limitInputPixels: 250_000_000 }).withIccProfile(
    'srgb',
  );
  if (pages === 1) pipeline = pipeline.autoOrient();
  const quality = { light: 90, balanced: 80, strong: 65 }[preset];
  if (metadata.format === 'jpeg') pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  if (metadata.format === 'png')
    pipeline = pipeline.png({
      compressionLevel: 9,
      palette: preset !== 'light',
      colours: preset === 'strong' ? 128 : 256,
      quality,
    });
  if (metadata.format === 'webp')
    pipeline = pipeline.webp({
      quality,
      alphaQuality: 100,
      effort: 5,
      loop: metadata.loop,
      delay: metadata.delay,
    });
  if (metadata.format === 'gif')
    pipeline = pipeline.gif({
      colours: { light: 256, balanced: 128, strong: 64 }[preset],
      effort: 7,
      loop: metadata.loop,
      delay: metadata.delay,
      interFrameMaxError: 0,
    });
  await pipeline.toFile(output);
  let note = null;
  if ((await stat(output)).size >= (await stat(source)).size) {
    await copyFile(source, output);
    note = 'UNCHANGED';
  }
  const result = await sharp(output, { animated: true, limitInputPixels: 250_000_000 }).metadata();
  if (
    (result.pages || 1) !== pages ||
    result.format !== metadata.format ||
    (!!metadata.hasAlpha && !result.hasAlpha)
  )
    throw new Error('INVALID_OUTPUT');
  console.log(
    JSON.stringify({
      media: {
        kind: 'image',
        width: metadata.width,
        height,
        format: metadata.format,
        pages,
        hasAlpha: !!metadata.hasAlpha,
        delay: metadata.delay,
        loop: metadata.loop,
      },
      note,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      error: ['INVALID_IMAGE', 'IMAGE_LIMIT', 'UNSUPPORTED_ANIMATION', 'INVALID_OUTPUT'].includes(
        error.message,
      )
        ? error.message
        : 'INVALID_IMAGE',
    }),
  );
  process.exitCode = 1;
}
