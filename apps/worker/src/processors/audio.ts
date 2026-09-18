import { runProcess, MediaError } from '@filemorph/core/media';
import type { AudioInfo, AudioOptions } from '@filemorph/core/domain';
const flags = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,wav,aac,mov,flac,ogg'];
export async function probeAudio(input: string, signal: AbortSignal): Promise<AudioInfo> {
  try {
    const data = JSON.parse(
      await runProcess(
        process.env.FFPROBE_PATH || 'ffprobe',
        ['-v', 'error', ...flags, '-show_streams', '-show_format', '-of', 'json', input],
        signal,
        undefined,
        30000,
      ),
    );
    const stream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
    const duration = Number(data.format?.duration || stream?.duration);
    if (
      !stream ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 86400 ||
      stream.channels > 8 ||
      !stream.sample_rate
    )
      throw new Error('Unsupported audio');
    return {
      kind: 'audio',
      duration,
      codec: stream.codec_name,
      channels: stream.channels,
      sampleRate: Number(stream.sample_rate),
      bitrate: Math.round(Number(stream.bit_rate || data.format.bit_rate || 0) / 1000),
    };
  } catch (e) {
    if (signal.aborted) throw e;
    throw new MediaError('INVALID_AUDIO', 'Cannot read audio');
  }
}
export async function encodeAudio(
  input: string,
  output: string,
  options: AudioOptions,
  media: AudioInfo,
  signal: AbortSignal,
  progress: (p: number) => void,
) {
  const rate =
    options.sampleRate === 'auto'
      ? [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]
          .filter((v) => v <= media.sampleRate)
          .pop()
      : Number(options.sampleRate);
  const bitrate = options.bitrate ?? { light: 192, balanced: 128, strong: 64 }[options.preset];
  if (!rate)
    throw new MediaError('AUDIO_SAMPLE_RATE', 'The input sample rate is below the encoder minimum');
  if (options.format === 'mp3' && bitrate > (rate < 16000 ? 64 : rate < 32000 ? 160 : 320))
    throw new MediaError(
      'AUDIO_BITRATE',
      'This MP3 bitrate is unsupported at the selected sample rate',
    );
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'warning',
    ...flags,
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '0',
    '-c:a',
    options.format === 'mp3' ? 'libmp3lame' : 'aac',
    '-b:a',
    `${bitrate}k`,
    '-ar',
    String(rate),
    '-ac',
    options.channels === 'auto' ? String(Math.min(media.channels, 2)) : options.channels,
    '-threads',
    '2',
    ...(options.format === 'm4a' ? ['-movflags', '+faststart'] : []),
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
  let buffer = '';
  await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', args, signal, (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines)
      if (line.startsWith('out_time_us='))
        progress(
          Math.min(90, 10 + Math.round((80 * Number(line.slice(12))) / 1e6 / media.duration)),
        );
  });
  const verified = await probeAudio(output, signal);
  if (
    Math.abs(verified.duration - media.duration) > Math.max(0.25, media.duration * 0.01) ||
    verified.sampleRate !== rate ||
    verified.channels !==
      (options.channels === 'auto' ? Math.min(media.channels, 2) : Number(options.channels)) ||
    (options.format === 'mp3' && verified.bitrate !== bitrate)
  )
    throw new MediaError('INVALID_OUTPUT', 'Audio output does not match the requested settings');
  return verified;
}
