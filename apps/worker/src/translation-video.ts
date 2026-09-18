import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  translationOptionsSchema,
  type TranslationData,
  type TranslationExportOptions,
} from '@filemorph/core/translation';
import { runProcess, MediaError } from '@filemorph/core/media';
import { pythonBinary } from './processors';
import { probeEditor, videoNormalize, audioNormalize } from './processors/editor';
function timestamp(ms: number, ass = false) {
  const time = Math.max(0, Math.round(ms));
  const h = Math.floor(time / 3600000),
    m = Math.floor(time / 60000) % 60,
    s = Math.floor(time / 1000) % 60;
  return `${ass ? h : String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${ass ? '.' : ','}${String(ass ? Math.floor((time % 1000) / 10) : time % 1000).padStart(ass ? 2 : 3, '0')}`;
}
export function subtitleText(data: TranslationData, options: TranslationExportOptions) {
  return data.blocks
    .filter((b) => !b.hidden)
    .map((b) => ({
      id: b.id,
      startMs: b.startMs!,
      endMs: b.endMs!,
      speakerId: null,
      text:
        options.mode === 'original' || b.keepOriginal
          ? b.sourceText
          : options.mode === 'bilingual'
            ? `${b.sourceText}\n${b.translatedText}`
            : b.translatedText,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}
export function makeAss(
  data: TranslationData,
  options: TranslationExportOptions,
  width = 1920,
  height = 1080,
) {
  const color = options.subtitle.color.slice(1);
  const assColor = `&H00${color.slice(4, 6)}${color.slice(2, 4)}${color.slice(0, 2)}`;
  const font =
    data.targetLanguage === 'ar'
      ? 'Noto Sans Arabic'
      : data.targetLanguage === 'ko'
        ? 'Noto Sans KR'
        : data.targetLanguage === 'ja'
          ? 'Noto Sans JP'
          : 'Noto Sans SC';
  // libass sizes against the font's ascender/descender span; CSS uses units per em.
  // These ratios come from the bundled Noto fonts, keeping preview and burn sizes close.
  const metricScale = data.targetLanguage === 'ar' ? 2.112 : 1.448;
  const text = (v: string) =>
    v.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r?\n/g, '\\N');
  const lines = subtitleText(data, options).map(
    (b) =>
      `Dialogue: 0,${timestamp(b.startMs, true)},${timestamp(b.endMs, true)},Default,,0,0,0,,${text(b.text)}`,
  );
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${(options.subtitle.fontSize * height * metricScale) / 1080},${assColor},&H000000FF,&H00111111,&H80000000,0,0,0,0,100,100,0,0,1,2,1,${options.subtitle.position === 'top' ? 8 : 2},${width * 0.04},${width * 0.04},${height * 0.04},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;
}
export async function exportVideoTranslation(
  data: TranslationData,
  options: TranslationExportOptions,
  jobOptions: unknown,
  source: string,
  output: string,
  temp: string,
  signal: AbortSignal,
) {
  const format = options.format;
  if (format === 'ass') {
    await writeFile(output, makeAss(data, options));
    return;
  }
  if (format !== 'mp4') {
    const params = join(temp, 'transcript.json');
    await writeFile(
      params,
      JSON.stringify({
        data: { durationMs: data.durationMs, segments: subtitleText(data, options), speakers: [] },
        options: { format, includeSpeakers: false, includeTimestamps: false },
        output,
      }),
    );
    await runProcess(
      pythonBinary,
      [fileURLToPath(new URL('../python/export_transcript.py', import.meta.url)), params],
      signal,
      undefined,
      300000,
    );
    return;
  }
  const media = await probeEditor(source, signal);
  if (!media.width || !media.height) throw new MediaError('NO_VIDEO', 'Missing video stream');
  if (media.hdr) throw new MediaError('HDR_UNSUPPORTED', 'HDR subtitle burn is not supported');
  const cfg = translationOptionsSchema.parse(jobOptions),
    ass = join(temp, 'subtitles.ass');
  await writeFile(ass, makeAss(data, options, media.width, media.height));
  const escapeFilter = (path: string) =>
    path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  const fonts = fileURLToPath(new URL('../assets/', import.meta.url));
  const args = [
    '-hide_banner',
    '-nostdin',
    '-copyts',
    '-y',
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    source,
    '-map',
    '0:v:0',
    '-map',
    `0:${cfg.streamIndex}`,
    '-vf',
    `${videoNormalize(media)},subtitles=filename='${escapeFilter(ass)}':fontsdir='${escapeFilter(fonts)}',format=yuv420p`,
    '-af',
    audioNormalize(media, cfg.streamIndex),
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'fast',
    '-threads',
    process.env.FFMPEG_THREADS || '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
  ];
  if (options.preview) args.push('-ss', String(options.previewStartMs / 1000), '-t', '15');
  args.push(output);
  await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', args, signal, undefined, 3600000);
  const result = await probeEditor(output, signal);
  if (!result.width || !result.duration || !result.tracks.length)
    throw new MediaError('OUTPUT_INVALID', 'Invalid subtitle video');
}
