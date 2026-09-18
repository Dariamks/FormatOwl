import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, statfs, writeFile } from 'node:fs/promises';
import { runProcess, MediaError } from '@filemorph/core/media';
import { mimeForName, type AudioInfo } from '@filemorph/core/domain';
import {
  type ConversionTool,
  type ConversionOptions,
  type VideoConversionOptions,
  type AudioConversionOptions,
  type ImageConversionOptions,
  maxConversionOutputBytes,
} from '@filemorph/core/conversion';
import { probeEditor, videoNormalize, audioNormalize } from './editor';
import type { EditorMedia } from '@filemorph/core/editing';
import { type Processed, pythonBinary } from './index';

const flags = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,webm,mp3,wav,aac,flac,ogg',
];
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const base = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
export async function checkedEncode(
  args: string[],
  output: string,
  duration: number,
  signal: AbortSignal,
  progress: (p: number) => void,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const size = await stat(output).catch(() => null);
      const disk = await statfs(join(output, '..'));
      if (size && size.size > maxConversionOutputBytes)
        controller.abort(new MediaError('OUTPUT_TOO_LARGE', 'Output exceeds 4 GiB'));
      if (disk.bavail * disk.bsize < 64 * 1024 ** 2)
        controller.abort(new MediaError('DISK_FULL', 'Insufficient disk space'));
    } catch {
      controller.abort(new MediaError('DISK_FULL', 'Cannot inspect temporary disk'));
    } finally {
      checking = false;
    }
  }, 500);
  let buffer = '';
  try {
    await runProcess(
      ffmpeg(),
      [...base, ...args, '-progress', 'pipe:1', '-nostats', output],
      controller.signal,
      (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines)
          if (line.startsWith('out_time_us=')) {
            const t = Number(line.slice(12));
            if (Number.isFinite(t))
              progress(Math.max(10, Math.min(86, 10 + (t / 1e6 / duration) * 76)));
          }
      },
    );
    if ((await stat(output)).size > maxConversionOutputBytes)
      throw new MediaError('OUTPUT_TOO_LARGE', 'Output exceeds 4 GiB');
  } catch (e) {
    throw controller.signal.aborted ? controller.signal.reason : e;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', abort);
  }
}
async function reserve(temp: string, bytes: number) {
  if (bytes > maxConversionOutputBytes)
    throw new MediaError('OUTPUT_TOO_LARGE', 'Estimated output exceeds 4 GiB');
  const disk = await statfs(temp);
  if (disk.bavail * disk.bsize < bytes + 256 * 1024 ** 2)
    throw new MediaError('DISK_FULL', 'Insufficient processing space');
}
export async function decodeCheck(file: string, signal: AbortSignal) {
  await runProcess(
    ffmpeg(),
    [
      ...base,
      '-xerror',
      ...flags,
      '-i',
      file,
      '-map',
      '0:V:0?',
      '-map',
      '0:a:0?',
      '-f',
      'null',
      '-',
    ],
    signal,
  );
}
function dimensions(m: EditorMedia, resolution: VideoConversionOptions['resolution']) {
  const factor =
    resolution === 'original'
      ? 1
      : Math.min(
          1,
          Number(resolution) / Math.min(m.width, m.height),
          (Number(resolution) * 16) / 9 / Math.max(m.width, m.height),
        );
  return {
    width: Math.max(2, Math.floor((m.width * factor) / 2) * 2),
    height: Math.max(2, Math.floor((m.height * factor) / 2) * 2),
  };
}
async function videoEncode(
  input: string,
  output: string,
  m: EditorMedia,
  o: VideoConversionOptions,
  signal: AbortSignal,
  progress: (p: number) => void,
) {
  const d = dimensions(m, o.resolution);
  const crf = {
    h264: { high: 18, balanced: 23, small: 28 },
    h265: { high: 23, balanced: 28, small: 33 },
    vp9: { high: 26, balanced: 32, small: 38 },
  }[o.codec][o.quality];
  const args = [
    '-copyts',
    ...flags,
    '-i',
    input,
    '-map',
    `0:${m.videoIndex}`,
    '-vf',
    `${videoNormalize(m)},scale=${d.width}:${d.height},setsar=1`,
    '-c:v',
    { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9' }[o.codec],
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    ...(o.codec === 'vp9'
      ? ['-b:v', '0', '-deadline', 'good', '-cpu-used', '3']
      : ['-preset', 'medium']),
    ...(o.codec === 'h265'
      ? [
          '-x265-params',
          'pools=2:frame-threads=2',
          ...(['mp4', 'mov'].includes(o.format) ? ['-tag:v', 'hvc1'] : []),
        ]
      : []),
    ...(o.fps === 'original' ? ['-fps_mode', 'vfr'] : ['-r', o.fps, '-fps_mode', 'cfr']),
  ];
  if (m.defaultAudioIndex !== undefined)
    args.push(
      '-map',
      `0:${m.defaultAudioIndex}`,
      '-af',
      audioNormalize(m, m.defaultAudioIndex),
      '-c:a',
      o.format === 'webm' ? 'libopus' : 'aac',
      '-b:a',
      '192k',
      '-ar',
      o.format === 'webm' ? '48000' : '44100',
      '-ac',
      '2',
    );
  args.push(
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    ...(o.format === 'mp4' || o.format === 'mov' ? ['-movflags', '+faststart'] : []),
  );
  await checkedEncode(args, output, m.duration, signal, progress);
  return d;
}
async function audioPreview(input: string, output: string, signal: AbortSignal) {
  await runProcess(
    ffmpeg(),
    [
      ...base,
      ...flags,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      output,
    ],
    signal,
  );
}
export async function convertFile(
  tool: ConversionTool,
  options: ConversionOptions,
  name: string,
  input: string,
  temp: string,
  signal: AbortSignal,
  progress: (p: number) => void,
): Promise<Processed> {
  const output = join(temp, `output.${options.format}`);
  const outputName = `${name.replace(/\.[^.]*$/, '')}-formatowl.${options.format}`;
  const common = { output, name: outputName, mime: mimeForName(outputName) };
  if (tool === 'image-converter') {
    const params = join(temp, 'conversion.json');
    let imageInput = input,
      primaryOnly = false;
    if (/\.heic$/i.test(name)) {
      imageInput = join(temp, 'heic-primary.png');
      try {
        const report = await runProcess(
          pythonBinary,
          [
            fileURLToPath(new URL('../../python/convert_heic.py', import.meta.url)),
            input,
            imageInput,
          ],
          signal,
          undefined,
          120000,
        );
        primaryOnly = JSON.parse(report).pages > 1;
      } catch (e) {
        if (signal.aborted) throw e;
        throw new MediaError(
          e instanceof MediaError && e.message.includes('IMAGE_LIMIT')
            ? 'IMAGE_LIMIT'
            : 'INVALID_IMAGE',
          'Cannot convert HEIC',
        );
      }
    }
    await writeFile(
      params,
      JSON.stringify({ source: input, imageInput, primaryOnly, output, name, options, temp }),
    );
    let report: any;
    try {
      const raw = await runProcess(
        process.execPath,
        [fileURLToPath(new URL('./image-converter.mjs', import.meta.url)), params],
        signal,
        undefined,
        300000,
      );
      report = JSON.parse(raw.trim());
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof MediaError) {
        const match = e.message.match(/FM_ERROR:([A-Z_]+)/);
        if (match) throw new MediaError(match[1], match[1]);
      }
      throw e;
    }
    progress(94);
    return { ...common, ...report };
  }
  const m = await probeEditor(input, signal);
  if (tool === 'video-converter') {
    if (m.kind !== 'video') throw new MediaError('INVALID_MEDIA', 'Video required');
    if (m.hdr) throw new MediaError('HDR_UNSUPPORTED', 'HDR conversion unavailable');
    await reserve(temp, Math.min(maxConversionOutputBytes, (await stat(input)).size * 2));
    const o = options as VideoConversionOptions;
    const d = await videoEncode(input, output, m, o, signal, progress);
    const verified = await probeEditor(output, signal);
    if (
      verified.codec !== { h264: 'h264', h265: 'hevc', vp9: 'vp9' }[o.codec] ||
      verified.width !== d.width ||
      verified.height !== d.height ||
      Math.abs(verified.duration - m.duration) > Math.max(0.3, m.duration * 0.001) ||
      !!verified.tracks.length !== !!m.tracks.length
    )
      throw new MediaError('INVALID_OUTPUT', 'Video conversion verification failed');
    await decodeCheck(output, signal);
    const inputPreview = join(temp, 'source-preview.mp4'),
      outputPreview = join(temp, 'result-preview.mp4');
    const preview: VideoConversionOptions = {
      format: 'mp4',
      codec: 'h264',
      quality: 'small',
      resolution: '720',
      fps: 'original',
    };
    await videoEncode(input, inputPreview, m, preview, signal, () => {});
    await videoEncode(output, outputPreview, verified, preview, signal, () => {});
    return {
      ...common,
      media: {
        duration: verified.duration,
        width: d.width,
        height: d.height,
        codec: verified.codec,
        hasAudio: !!verified.tracks.length,
        rotation: 0,
      },
      note: (await stat(output)).size > (await stat(input)).size ? 'LARGER' : null,
      inputPreview,
      outputPreview,
      previewMime: 'video/mp4',
    };
  }
  if (m.kind !== 'audio' || !m.tracks.length)
    throw new MediaError('INVALID_AUDIO', 'Audio file required');
  const o = options as AudioConversionOptions,
    track = m.tracks.find((t) => t.index === m.defaultAudioIndex)!;
  const rate = Number(o.sampleRate),
    channels = o.channels === 'auto' ? Math.min(2, track.channels) : Number(o.channels);
  const estimate = m.duration * rate * channels * (o.bitDepth / 8);
  await reserve(
    temp,
    ['wav', 'flac'].includes(o.format)
      ? estimate
      : Math.min(maxConversionOutputBytes, m.duration * o.bitrate * 125),
  );
  const codec = {
    mp3: 'libmp3lame',
    wav: o.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le',
    aac: 'aac',
    m4a: 'aac',
    flac: 'flac',
    ogg: 'libopus',
  }[o.format];
  const args = [
    ...flags,
    '-i',
    input,
    '-map',
    `0:${track.index}`,
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-c:a',
    codec,
    '-ar',
    String(rate),
    '-ac',
    String(channels),
    '-threads',
    '2',
    ...(['wav', 'flac'].includes(o.format) ? [] : ['-b:a', `${o.bitrate}k`]),
    ...(o.format === 'flac'
      ? [
          '-sample_fmt',
          o.bitDepth === 24 ? 's32' : 's16',
          '-bits_per_raw_sample',
          String(o.bitDepth),
        ]
      : []),
    ...(o.format === 'aac' ? ['-f', 'adts'] : []),
    ...(o.format === 'm4a' ? ['-movflags', '+faststart'] : []),
  ];
  await checkedEncode(args, output, m.duration, signal, progress);
  const verified = await probeEditor(output, signal),
    v = verified.tracks[0];
  if (
    !v ||
    v.codec !==
      { mp3: 'mp3', wav: codec, aac: 'aac', m4a: 'aac', flac: 'flac', ogg: 'opus' }[o.format] ||
    v.sampleRate !== rate ||
    v.channels !== channels ||
    Math.abs(verified.duration - m.duration) > Math.max(0.3, m.duration * 0.01)
  )
    throw new MediaError('INVALID_OUTPUT', 'Audio conversion verification failed');
  await decodeCheck(output, signal);
  const inputPreview = join(temp, 'source-preview.m4a'),
    outputPreview = join(temp, 'result-preview.m4a');
  await audioPreview(input, inputPreview, signal);
  await audioPreview(output, outputPreview, signal);
  const media: AudioInfo = {
    kind: 'audio',
    duration: verified.duration,
    codec: v.codec,
    sampleRate: track.sampleRate,
    channels: track.channels,
    bitrate: 0,
    outputSampleRate: rate,
    outputChannels: channels,
    outputBitrate: Math.round(((await stat(output)).size * 8) / verified.duration / 1000),
  };
  return {
    ...common,
    media,
    note: (await stat(output)).size > (await stat(input)).size ? 'LARGER' : null,
    inputPreview,
    outputPreview,
    previewMime: 'audio/mp4',
  };
}
