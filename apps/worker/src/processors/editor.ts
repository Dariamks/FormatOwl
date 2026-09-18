import { join } from 'node:path';
import { open, writeFile } from 'node:fs/promises';
import { runProcess, MediaError } from '@filemorph/core/media';
import { mimeForName, type FileInfo } from '@filemorph/core/domain';
import {
  editValidation,
  keptRanges,
  type EditorMedia,
  type EditorTool,
  type EditOptions,
  type VideoCutOptions,
  type VideoCropOptions,
  type AudioEditOptions,
  type ExtractAudioOptions,
  type EditResultInfo,
} from '@filemorph/core/editing';
import type { Processed } from './index';

const inputFlags = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,webm,mp3,wav,aac,flac,ogg',
];
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const base = ['-hide_banner', '-nostdin', '-y', '-v', 'warning', '-copyts'];
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
export async function probeEditor(input: string, signal: AbortSignal): Promise<EditorMedia> {
  try {
    const data = JSON.parse(
      await runProcess(
        process.env.FFPROBE_PATH || 'ffprobe',
        ['-v', 'error', ...inputFlags, '-show_streams', '-show_format', '-of', 'json', input],
        signal,
        undefined,
        30000,
      ),
    );
    const streams = data.streams || [];
    const video = streams.find(
      (s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic,
    );
    const audio = streams.filter((s: any) => s.codec_type === 'audio');
    const origin = Number(
      video?.start_time ?? data.format?.start_time ?? audio[0]?.start_time ?? 0,
    );
    const duration = Number(
      video?.duration ??
        Number(data.format?.duration) + Number(data.format?.start_time || 0) - origin,
    );
    if (
      (!video && !audio.length) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 86400 ||
      (video && (!video.width || !video.height || video.width > 8192 || video.height > 8192)) ||
      audio.length > 32 ||
      audio.some((s: any) => !s.sample_rate || !s.channels || s.channels > 8)
    )
      throw new Error('Unsupported media');
    const [sarN, sarD] = String(video?.sample_aspect_ratio || '1:1')
      .split(':')
      .map(Number);
    const sar = sarN > 0 && sarD > 0 ? sarN / sarD : 1;
    const rotation = Number(
      video?.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ??
        video?.tags?.rotate ??
        0,
    );
    if (video && Math.abs(rotation / 90 - Math.round(rotation / 90)) > 0.001)
      throw new Error('Unsupported rotation');
    const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const width = video ? even(quarterTurn ? video.height : video.width * sar) : 0;
    const height = video ? even(quarterTurn ? video.width * sar : video.height) : 0;
    if (width > 16384 || height > 16384) throw new Error('Invalid aspect ratio');
    const tracks = audio.map((s: any) => ({
      index: s.index,
      codec: s.codec_name,
      sampleRate: Number(s.sample_rate),
      channels: Number(s.channels),
      start: Number(s.start_time ?? origin),
      duration: Number(s.duration ?? duration),
      language: s.tags?.language,
      title: s.tags?.title,
      default: !!s.disposition?.default,
    }));
    return {
      kind: video ? 'video' : 'audio',
      duration,
      origin,
      width,
      height,
      codedWidth: video?.width || 0,
      codedHeight: video?.height || 0,
      rotation,
      sar,
      hdr:
        ['smpte2084', 'arib-std-b67'].includes(video?.color_transfer) ||
        !!video?.side_data_list?.some((s: any) =>
          /DOVI|Mastering display|Content light/.test(s.side_data_type),
        ),
      videoIndex: video?.index,
      videoStart: Number(video?.start_time ?? origin),
      codec: video?.codec_name || tracks[0].codec,
      tracks,
      defaultAudioIndex: (tracks.find((t: any) => t.default) || tracks[0])?.index,
    };
  } catch (e) {
    if (
      signal.aborted ||
      (e instanceof MediaError && (e.code.startsWith('BILLING_') || e.code === 'PRICE_UNVERIFIED'))
    )
      throw e;
    throw new MediaError('INVALID_MEDIA', 'Cannot analyze this media');
  }
}
export const videoNormalize = (m: EditorMedia) =>
  `setpts=PTS-${m.videoStart}/TB,scale=${m.width}:${m.height},setsar=1`;
// ffprobe supplies the real stream offset. Normalize audio samples, then place them on the video timeline.
export function audioNormalize(m: EditorMedia, index: number) {
  const track = m.tracks.find((t) => t.index === index);
  if (!track) throw new MediaError('AUDIO_TRACK_NOT_FOUND', 'Missing audio track');
  const offset = track.start - m.origin;
  return `asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${offset < 0 ? `atrim=start=${-offset},asetpts=PTS-STARTPTS,` : offset > 0 ? `adelay=${Math.round(offset * 1000)}:all=1,` : ''}apad,atrim=duration=${m.duration},asetpts=PTS-STARTPTS`;
}
async function encodeGraph(
  args: string[],
  duration: number,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  let buffer = '';
  await runProcess(ffmpeg(), args, signal, (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines)
      if (line.startsWith('out_time_us=')) {
        // FFmpeg can report N/A before the first encoded timestamp is available.
        const time = Number(line.slice(12));
        if (Number.isFinite(time) && time >= 0)
          progress(Math.min(94, 10 + Math.round((time / 1e6 / duration) * 84)));
      }
  });
}
const videoEncoding = [
  '-c:v',
  'libx264',
  '-crf',
  '20',
  '-preset',
  'medium',
  '-pix_fmt',
  'yuv420p',
  '-threads',
  '2',
  '-fps_mode',
  'vfr',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-ar',
  '44100',
  '-ac',
  '2',
];
export interface EditorInput {
  id: string;
  path: string;
  name: string;
  media: EditorMedia;
}
export async function processEdit(
  tool: EditorTool,
  options: EditOptions,
  inputs: EditorInput[],
  temp: string,
  signal: AbortSignal,
  progress: (n: number) => void,
  purpose: 'export' | 'preview',
): Promise<Processed> {
  const error = editValidation(
    tool,
    options,
    inputs.map((i) => ({ id: i.id, media: i.media })),
  );
  if (error) throw new MediaError(error, error);
  const first = inputs[0],
    m = first.media;
  const isVideo = tool === 'video-cutter' || tool === 'video-cropper';
  const format = isVideo
    ? ((options as VideoCutOptions | VideoCropOptions).format ?? 'mp4')
    : purpose === 'preview'
      ? 'm4a'
      : tool === 'audio-cutter'
        ? (options as AudioEditOptions).format
        : 'mp3';
  const output = join(temp, `result.${format}`);
  const name = `${first.name.replace(/\.[^.]*$/, '')}-formatowl.${format}`;
  const filters: string[] = [],
    maps: string[] = [];
  let duration = m.duration;
  if (isVideo) {
    const index = (options as VideoCutOptions).audioStreamIndex ?? m.defaultAudioIndex;
    filters.push(`[0:${m.videoIndex}]${videoNormalize(m)}[vbase]`);
    if (index !== undefined) filters.push(`[0:${index}]${audioNormalize(m, index)}[abase]`);
    if (tool === 'video-cropper') {
      const r = (options as VideoCropOptions).rect;
      filters.push(`[vbase]crop=${r.width}:${r.height}:${r.x}:${r.y}[vout]`);
      maps.push('-map', '[vout]');
      if (index !== undefined) maps.push('-map', '[abase]');
    } else {
      const o = options as VideoCutOptions;
      const ranges = keptRanges(o.ranges, o.mode, Math.round(m.duration * 1000));
      duration = ranges.reduce((n, r) => n + (r.endMs - r.startMs) / 1000, 0);
      filters.push(`[vbase]split=${ranges.length}${ranges.map((_, i) => `[vs${i}]`).join('')}`);
      if (index !== undefined)
        filters.push(`[abase]asplit=${ranges.length}${ranges.map((_, i) => `[as${i}]`).join('')}`);
      ranges.forEach((r, i) => {
        filters.push(
          `[vs${i}]trim=start=${r.startMs / 1000}:end=${r.endMs / 1000},setpts=PTS-STARTPTS[v${i}]`,
        );
        if (index !== undefined)
          filters.push(
            `[as${i}]atrim=start=${r.startMs / 1000}:end=${r.endMs / 1000},asetpts=PTS-STARTPTS[a${i}]`,
          );
      });
      filters.push(
        `${ranges.map((_, i) => `[v${i}]${index !== undefined ? `[a${i}]` : ''}`).join('')}concat=n=${ranges.length}:v=1:a=${index === undefined ? 0 : 1}[vout]${index === undefined ? '' : '[aout]'}`,
      );
      maps.push('-map', '[vout]');
      if (index !== undefined) maps.push('-map', '[aout]');
    }
  } else {
    const clips =
      tool === 'audio-cutter'
        ? (options as AudioEditOptions).clips
        : [
            {
              assetId: first.id,
              streamIndex: (options as ExtractAudioOptions).audioStreamIndex,
              ...((options as ExtractAudioOptions).range || {
                startMs: 0,
                endMs: Math.round(m.duration * 1000),
              }),
              fadeInMs: 0,
              fadeOutMs: 0,
            },
          ];
    duration = clips.reduce((n, c) => n + (c.endMs - c.startMs) / 1000, 0);
    clips.forEach((c, i) => {
      const source = inputs.findIndex((s) => s.id === c.assetId),
        info = inputs[source].media;
      const length = (c.endMs - c.startMs) / 1000;
      filters.push(
        `[${source}:${c.streamIndex}]${audioNormalize(info, c.streamIndex)},atrim=start=${c.startMs / 1000}:end=${c.endMs / 1000},asetpts=PTS-STARTPTS${c.fadeInMs ? `,afade=t=in:d=${c.fadeInMs / 1000}` : ''}${c.fadeOutMs ? `,afade=t=out:st=${length - c.fadeOutMs / 1000}:d=${c.fadeOutMs / 1000}` : ''}[a${i}]`,
      );
    });
    filters.push(
      `${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[aout]`,
    );
    maps.push('-map', '[aout]');
  }
  const rate = 'bitrate' in options ? options.bitrate : 192;
  const encoding = isVideo
    ? videoEncoding
    : [
        '-vn',
        '-c:a',
        format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s16le' : 'aac',
        ...(format !== 'wav' ? ['-b:a', `${purpose === 'preview' ? 128 : rate}k`] : []),
        '-ar',
        '44100',
        '-ac',
        '2',
        '-threads',
        '2',
      ];
  await encodeGraph(
    [
      ...base,
      ...inputs.flatMap((s) => [...inputFlags, '-i', s.path]),
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      ...maps,
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      ...encoding,
      '-t',
      String(duration),
      ...(['mp4', 'mov', 'm4a', 'm4r'].includes(format)
        ? ['-movflags', '+faststart', '-f', isVideo ? format : 'ipod']
        : format === 'mkv'
          ? ['-f', 'matroska']
          : []),
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    ],
    duration,
    signal,
    progress,
  );
  // The download keeps its chosen container. Remux a browser-compatible preview without re-encoding.
  let outputPreview: string | undefined;
  if (isVideo && format !== 'mp4') {
    outputPreview = join(temp, 'output-preview.mp4');
    await runProcess(
      ffmpeg(),
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-v',
        'warning',
        ...inputFlags,
        '-i',
        output,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        outputPreview,
      ],
      signal,
    );
  }
  const verified = await probeEditor(output, signal);
  if (Math.abs(verified.duration - duration) > Math.max(0.25, duration * 0.001))
    throw new MediaError('INVALID_OUTPUT', 'Output duration mismatch');
  const outputMedia: EditResultInfo = {
    kind: isVideo ? 'video' : 'audio',
    duration: verified.duration,
    codec: verified.codec,
    ...(isVideo
      ? { width: verified.width, height: verified.height }
      : {
          sampleRate: verified.tracks[0].sampleRate,
          channels: verified.tracks[0].channels,
          bitrate: format === 'wav' ? 1411 : purpose === 'preview' ? 128 : rate,
        }),
  };
  const media: FileInfo = isVideo
    ? {
        duration: m.duration,
        width: m.width,
        height: m.height,
        rotation: m.rotation,
        hasAudio: !!m.tracks.length,
        codec: m.codec,
      }
    : {
        kind: 'audio',
        duration: verified.duration,
        codec: verified.codec,
        sampleRate: 44100,
        channels: 2,
        bitrate: outputMedia.bitrate!,
      };
  return {
    output,
    ...(outputPreview ? { outputPreview, previewMime: 'video/mp4' } : {}),
    name,
    mime: mimeForName(name),
    media,
    note: null,
    outputMedia,
    inputMedia: inputs.map((s) => ({ id: s.id, media: s.media })),
  };
}

export async function prepareMedia(
  input: string,
  media: EditorMedia,
  profile: 'video' | 'audio',
  requestedTrack: number,
  temp: string,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  const index = requestedTrack === -1 ? media.defaultAudioIndex : requestedTrack;
  if (requestedTrack !== -1 && !media.tracks.some((t) => t.index === index))
    throw new MediaError('AUDIO_TRACK_NOT_FOUND', 'Missing track');
  if (profile === 'video' && (media.kind !== 'video' || media.hdr))
    throw new MediaError(
      media.hdr ? 'HDR_UNSUPPORTED' : 'INVALID_MEDIA',
      'Unsupported video preview',
    );
  if (profile === 'audio' && index === undefined)
    throw new MediaError('NO_AUDIO', 'No audio track');
  const preview = join(temp, profile === 'video' ? 'preview.mp4' : 'preview.m4a');
  const filters: string[] = [],
    maps: string[] = [];
  if (profile === 'video') {
    const ratio = Math.min(1, 1280 / Math.max(media.width, media.height));
    filters.push(
      `[0:${media.videoIndex}]${videoNormalize(media)},scale=${even(media.width * ratio)}:${even(media.height * ratio)}[v]`,
    );
    maps.push('-map', '[v]');
  }
  if (index !== undefined) {
    filters.push(`[0:${index}]${audioNormalize(media, index)}[a]`);
    maps.push('-map', '[a]');
  }
  await encodeGraph(
    [
      ...base,
      ...inputFlags,
      '-i',
      input,
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      ...maps,
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-sn',
      '-dn',
      ...(profile === 'video'
        ? [
            '-c:v',
            'libx264',
            '-crf',
            '28',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-force_key_frames',
            'expr:gte(t,n_forced*1)',
            '-fps_mode',
            'vfr',
          ]
        : ['-vn']),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-threads',
      '2',
      '-t',
      String(media.duration),
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      preview,
    ],
    media.duration,
    signal,
    (n) => progress(Math.round(n * 0.7)),
  );
  let peaks: string | undefined, thumbnails: string | undefined;
  if (profile === 'audio') {
    const pcm = join(temp, 'waveform.pcm');
    await runProcess(
      ffmpeg(),
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        ...inputFlags,
        '-i',
        preview,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        pcm,
      ],
      signal,
    );
    // Stream PCM from disk; memory does not grow with the decoded recording length.
    const file = await open(pcm, 'r'),
      bins = Math.min(120000, Math.max(1, Math.ceil(media.duration * 100))),
      count = (await file.stat()).size / 2,
      stride = Math.max(1, Math.ceil(count / bins));
    const values: number[] = [];
    let sample = 0,
      max = 0;
    try {
      const buffer = Buffer.alloc(65536);
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        for (let i = 0; i + 1 < bytesRead; i += 2) {
          max = Math.max(max, Math.abs(buffer.readInt16LE(i)) / 32768);
          if (++sample % stride === 0) {
            values.push(Math.round(max * 10000) / 10000);
            max = 0;
          }
        }
      }
      if (sample % stride) values.push(Math.round(max * 10000) / 10000);
    } finally {
      await file.close();
    }
    peaks = join(temp, 'peaks.json');
    await writeFile(peaks, JSON.stringify({ duration: media.duration, peaks: [values] }));
  } else {
    thumbnails = join(temp, 'thumbnails.jpg');
    await runProcess(
      ffmpeg(),
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        ...inputFlags,
        '-i',
        preview,
        '-vf',
        `fps=12/${media.duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=12x1`,
        '-frames:v',
        '1',
        '-update',
        '1',
        thumbnails,
      ],
      signal,
    );
  }
  progress(95);
  return { preview, peaks, thumbnails };
}
