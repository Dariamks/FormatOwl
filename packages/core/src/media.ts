import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CompressionOptions, MediaInfo } from './domain';
import { MediaError } from './media-error';
export { MediaError } from './media-error';
import { startUsage, completeUsage, runtimeAllowance } from './billing-usage';
const inputFlags = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm'];
export async function runProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  onData?: (chunk: string) => void,
  timeoutMs = 3600_000,
): Promise<string> {
  const allowance = Math.max(1, (await runtimeAllowance(timeoutMs + 2000)) - 2000);
  const metered = await startUsage({
    meter: 'runtime_ms',
    stage: 'process',
    maximum: allowance + 2000,
  });
  const started = Date.now();
  let processingError: unknown;
  try {
    return await new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new MediaError('CANCELLED', 'Processing cancelled'));
        return;
      }
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let output = '',
        stderr = '',
        killTimer: ReturnType<typeof setTimeout> | undefined;
      let reason: string | undefined;
      const stop = (code: string) => {
        reason = code;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const onAbort = () => stop('CANCELLED');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(
        () => stop(allowance < timeoutMs ? 'BILLING_BUDGET_EXCEEDED' : 'TIMEOUT'),
        allowance,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      child.stdout.on('data', (data: Buffer) => {
        const value = data.toString();
        output = (output + value).slice(-2_000_000);
        onData?.(value);
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-12000);
      });
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('close', (code) => {
        cleanup();
        if (reason) reject(new MediaError(reason, reason));
        else if (code !== 0)
          reject(new MediaError('ENCODE_FAILED', stderr || `${binary} exited ${code}`));
        else resolve(output);
      });
    });
  } catch (error) {
    processingError = error;
    throw error;
  } finally {
    try {
      await completeUsage(metered, Date.now() - started, { measurement: 'subprocess_wall_ms' });
    } catch (error) {
      if (!processingError) throw error;
    }
  }
}
export async function probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  let raw: string;
  try {
    raw = await runProcess(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', ...inputFlags, '-show_streams', '-show_format', '-of', 'json', path],
      signal,
      undefined,
      30000,
    );
  } catch (error) {
    if (
      error instanceof MediaError &&
      error.code !== 'CANCELLED' &&
      !error.code.startsWith('BILLING_') &&
      error.code !== 'PRICE_UNVERIFIED'
    )
      throw new MediaError('INVALID_MEDIA', error.message);
    throw error;
  }
  const data = JSON.parse(raw);
  const video = data.streams?.find(
    (s: { codec_type: string; disposition?: { attached_pic?: number } }) =>
      s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  const duration = Number(data.format?.duration || video?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 86400 ||
    !video.width ||
    !video.height ||
    video.width > 8192 ||
    video.height > 8192
  )
    throw new MediaError('INVALID_MEDIA', 'Unsupported video dimensions or duration');
  return {
    duration,
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    hasAudio: data.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'),
    rotation: Number(
      video.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)
        ?.rotation ||
        video.tags?.rotate ||
        0,
    ),
  };
}
export function encodingPasses(
  input: string,
  output: string,
  options: CompressionOptions,
  media: MediaInfo,
  temp: string,
): string[][] {
  const threads = Math.max(1, Math.min(Number(process.env.FFMPEG_THREADS || 2), 16));
  const filter =
    options.resolution === 'original'
      ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1'
      : `scale=w='min(iw,${Math.floor((Number(options.resolution) * 16) / 9)})':h='min(ih,${options.resolution})':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
  const base = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'warning',
    ...inputFlags,
    '-i',
    input,
    '-map',
    '0:V:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-vf',
    filter,
    '-c:v',
    options.codec === 'h264' ? 'libx264' : 'libx265',
    '-preset',
    options.speed,
    '-pix_fmt',
    'yuv420p',
    '-threads',
    String(threads),
    '-filter_threads',
    '1',
  ];
  if (options.codec === 'h265') base.push('-tag:v', 'hvc1');
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
  const end = [
    '-max_muxing_queue_size',
    '1024',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
  const rate = options.maxBitrateKbps
    ? ['-maxrate', `${options.maxBitrateKbps}k`, '-bufsize', `${options.maxBitrateKbps * 2}k`]
    : [];
  if (options.targetMb !== undefined) {
    const bitrate =
      Math.floor((options.targetMb * 1024 * 1024 * 8 * 0.97) / media.duration / 1000) -
      (media.hasAudio ? 128 : 0);
    if (bitrate < 100)
      throw new MediaError(
        'TARGET_TOO_SMALL',
        'Target size cannot fit this duration. Increase the target size.',
      );
    const target = ['-b:v', `${Math.min(bitrate, options.maxBitrateKbps || bitrate)}k`, ...rate];
    const pass = (n: number) =>
      options.codec === 'h264'
        ? ['-pass', String(n), '-passlogfile', join(temp, 'pass')]
        : [
            '-x265-params',
            `pass=${n}:stats=${join(temp, 'pass')}:pools=${threads}:frame-threads=1`,
          ];
    return [
      [
        ...base,
        ...target,
        ...pass(1),
        '-an',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
      ],
      [...base, ...target, ...pass(2), ...audio, ...end],
    ];
  }
  return [
    [
      ...base,
      '-crf',
      String(options.crf ?? { light: 23, balanced: 28, strong: 34 }[options.preset]),
      ...rate,
      ...(options.codec === 'h265' ? ['-x265-params', `pools=${threads}:frame-threads=1`] : []),
      ...audio,
      ...end,
    ],
  ];
}
export async function encode(
  input: string,
  output: string,
  options: CompressionOptions,
  media: MediaInfo,
  temp: string,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  const passes = encodingPasses(input, output, options, media, temp);
  for (let index = 0; index < passes.length; index++) {
    let buffer = '';
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', passes[index], signal, (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const seconds = Number(line.slice(12)) / 1e6;
          if (Number.isFinite(seconds))
            progress(
              Math.min(
                94,
                Math.round(
                  8 + (86 * (index + Math.min(seconds / media.duration, 1))) / passes.length,
                ),
              ),
            );
        }
      }
    });
  }
}
