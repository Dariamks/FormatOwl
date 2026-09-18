import { z } from 'zod';

export const conversionTools = ['video-converter', 'audio-converter', 'image-converter'] as const;
export type ConversionTool = (typeof conversionTools)[number];
export function isConversionTool(tool: string): tool is ConversionTool {
  return (conversionTools as readonly string[]).includes(tool);
}
export const videoConversionSchema = z
  .object({
    format: z.enum(['mp4', 'mov', 'mkv', 'webm']).default('mp4'),
    codec: z.enum(['h264', 'h265', 'vp9']).default('h264'),
    quality: z.enum(['high', 'balanced', 'small']).default('balanced'),
    resolution: z.enum(['original', '480', '720', '1080', '2160']).default('original'),
    fps: z.enum(['original', '24', '25', '30', '50', '60']).default('original'),
  })
  .strict()
  .refine((o) => (o.format === 'webm') === (o.codec === 'vp9'), 'Incompatible container and codec');
export const audioConversionSchema = z
  .object({
    format: z.enum(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg']).default('mp3'),
    bitrate: z
      .union([
        z.literal(64),
        z.literal(96),
        z.literal(128),
        z.literal(192),
        z.literal(256),
        z.literal(320),
      ])
      .default(192),
    sampleRate: z.enum(['22050', '32000', '44100', '48000', '96000']).default('44100'),
    channels: z.enum(['auto', '1', '2']).default('auto'),
    bitDepth: z.union([z.literal(16), z.literal(24)]).default(16),
  })
  .strict()
  .superRefine((o, c) => {
    if (
      (o.format === 'ogg' && o.sampleRate !== '48000') ||
      (o.sampleRate === '96000' && !['wav', 'flac'].includes(o.format)) ||
      !supportedAudioBitrates(o).includes(o.bitrate)
    )
      c.addIssue({ code: 'custom', message: 'Incompatible audio settings' });
  });
export const imageConversionSchema = z
  .object({
    format: z.enum(['jpg', 'png', 'webp', 'avif']).default('png'),
    quality: z.number().int().min(1).max(100).optional(),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#ffffff'),
    firstFrame: z.boolean().default(false),
  })
  .strict();
export type VideoConversionOptions = z.infer<typeof videoConversionSchema>;
export type AudioConversionOptions = z.infer<typeof audioConversionSchema>;
export function supportedAudioBitrates(
  o: Pick<AudioConversionOptions, 'format' | 'sampleRate' | 'channels'>,
) {
  const maximum =
    o.format === 'mp3' && o.sampleRate === '22050'
      ? 160
      : ['aac', 'm4a'].includes(o.format)
        ? (Number(o.sampleRate) * 6 * (o.channels === '2' ? 2 : 1)) / 1000
        : 320;
  return ([64, 96, 128, 192, 256, 320] as const).filter((v) => v <= maximum);
}
export type ImageConversionOptions = z.infer<typeof imageConversionSchema>;
export type ConversionOptions =
  | VideoConversionOptions
  | AudioConversionOptions
  | ImageConversionOptions;
export function defaultConversionOptions(tool: ConversionTool): ConversionOptions {
  return tool === 'video-converter'
    ? videoConversionSchema.parse({})
    : tool === 'audio-converter'
      ? audioConversionSchema.parse({})
      : imageConversionSchema.parse({});
}
export const maxConversionOutputBytes = 4 * 1024 ** 3;
