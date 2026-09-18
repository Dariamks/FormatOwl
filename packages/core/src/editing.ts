import { z } from 'zod';

export const editorToolSchema = z.enum([
  'video-cutter',
  'video-cropper',
  'audio-cutter',
  'video-to-mp3',
]);
export type EditorTool = z.infer<typeof editorToolSchema>;
export const isEditorTool = (tool: string): tool is EditorTool =>
  editorToolSchema.safeParse(tool).success;
const ms = z.number().int().min(0).max(86400_000);
const track = z.number().int().min(0).max(255);
export const rangeSchema = z
  .object({ startMs: ms, endMs: ms })
  .strict()
  .refine((v) => v.endMs > v.startMs);
export type TimeRange = z.infer<typeof rangeSchema>;
export const rectSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(2),
    height: z.number().int().min(2),
  })
  .strict();
export type CropRect = z.infer<typeof rectSchema>;
export const videoExportFormatSchema = z.enum(['mp4', 'mkv', 'mov']);
export type VideoExportFormat = z.infer<typeof videoExportFormatSchema>;
export const videoCutSchema = z
  .object({
    mode: z.enum(['keep', 'remove']).default('keep'),
    ranges: z.array(rangeSchema).min(1).max(50),
    format: videoExportFormatSchema.optional(),
    audioStreamIndex: track.optional(),
  })
  .strict();
export const videoCropSchema = z
  .object({
    rect: rectSchema,
    audioStreamIndex: track.optional(),
    format: videoExportFormatSchema.optional(),
  })
  .strict();
const bitrate = z.union([z.literal(128), z.literal(192), z.literal(320)]).default(192);
export const clipSchema = z
  .object({
    assetId: z.string().uuid(),
    streamIndex: track,
    startMs: ms,
    endMs: ms,
    fadeInMs: ms.default(0),
    fadeOutMs: ms.default(0),
  })
  .strict()
  .refine((v) => v.endMs > v.startMs && v.fadeInMs + v.fadeOutMs <= v.endMs - v.startMs);
export const audioEditSchema = z
  .object({
    clips: z.array(clipSchema).min(1).max(50),
    format: z.enum(['mp3', 'wav', 'm4a', 'm4r']).default('mp3'),
    bitrate,
  })
  .strict();
export const extractAudioSchema = z
  .object({ audioStreamIndex: track, range: rangeSchema.optional(), bitrate })
  .strict();
export type VideoCutOptions = z.infer<typeof videoCutSchema>;
export type VideoCropOptions = z.infer<typeof videoCropSchema>;
export type AudioEditOptions = z.infer<typeof audioEditSchema>;
export type ExtractAudioOptions = z.infer<typeof extractAudioSchema>;
export type AudioClip = z.infer<typeof clipSchema>;
export type EditOptions =
  | VideoCutOptions
  | VideoCropOptions
  | AudioEditOptions
  | ExtractAudioOptions;
export interface AudioTrack {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  start: number;
  duration: number;
  language?: string;
  title?: string;
  default: boolean;
}
export interface EditorMedia {
  kind: 'video' | 'audio';
  duration: number;
  origin: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  sar: number;
  hdr: boolean;
  videoIndex?: number;
  videoStart?: number;
  codec: string;
  tracks: AudioTrack[];
  defaultAudioIndex?: number;
}
export interface PreparationView {
  id: string;
  assetId: string;
  name: string;
  size: number;
  profile: 'video' | 'audio';
  streamIndex: number;
  state: string;
  progress: number;
  error: string | null;
  media: EditorMedia | null;
  expiresAt: string;
  previewUrl?: string;
  peaksUrl?: string;
  thumbnailsUrl?: string;
}
export interface EditResultInfo {
  kind: 'video' | 'audio';
  duration: number;
  width?: number;
  height?: number;
  codec: string;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}
export function keptRanges(
  ranges: TimeRange[],
  mode: 'keep' | 'remove',
  durationMs: number,
): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  if (mode === 'keep') return merged;
  const result: TimeRange[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.startMs > cursor) result.push({ startMs: cursor, endMs: range.startMs });
    cursor = range.endMs;
  }
  if (cursor < durationMs) result.push({ startMs: cursor, endMs: durationMs });
  return result;
}
export function evenRect(rect: CropRect): CropRect {
  return {
    x: Math.floor(rect.x / 2) * 2,
    y: Math.floor(rect.y / 2) * 2,
    width: Math.max(2, Math.floor(rect.width / 2) * 2),
    height: Math.max(2, Math.floor(rect.height / 2) * 2),
  };
}
// Runs on both API and worker using server-probed metadata. Returns a public error code.
export function editValidation(
  tool: EditorTool,
  options: EditOptions,
  sources: { id: string; media: EditorMedia }[],
): string | null {
  const media = sources[0]?.media;
  if (!media) return 'NOT_READY';
  const rangeOK = (r: TimeRange, m: EditorMedia) =>
    r.startMs >= 0 && r.endMs > r.startMs && r.endMs <= Math.round(m.duration * 1000);
  if (tool !== 'audio-cutter' && (sources.length !== 1 || media.kind !== 'video'))
    return 'INVALID_MEDIA';
  if (tool === 'video-cutter' || tool === 'video-cropper') {
    if (media.hdr) return 'HDR_UNSUPPORTED';
    const index = (options as VideoCutOptions).audioStreamIndex;
    if (index !== undefined && !media.tracks.some((t) => t.index === index))
      return 'AUDIO_TRACK_NOT_FOUND';
  }
  if (tool === 'video-cutter') {
    const o = options as VideoCutOptions;
    if (
      !o.ranges.every((r) => rangeOK(r, media)) ||
      !keptRanges(o.ranges, o.mode, Math.round(media.duration * 1000)).length
    )
      return 'INVALID_RANGE';
  } else if (tool === 'video-cropper') {
    const r = (options as VideoCropOptions).rect;
    if (
      r.x + r.width > media.width ||
      r.y + r.height > media.height ||
      Object.values(r).some((n) => n % 2)
    )
      return 'INVALID_CROP';
  } else if (tool === 'video-to-mp3') {
    const o = options as ExtractAudioOptions;
    if (!media.tracks.length) return 'NO_AUDIO';
    if (!media.tracks.some((t) => t.index === o.audioStreamIndex)) return 'AUDIO_TRACK_NOT_FOUND';
    if (o.range && !rangeOK(o.range, media)) return 'INVALID_RANGE';
  } else {
    const o = options as AudioEditOptions;
    const referenced = new Set(o.clips.map((c) => c.assetId));
    if (sources.length !== referenced.size || sources.some((s) => !referenced.has(s.id)))
      return 'INVALID_SOURCES';
    for (const clip of o.clips) {
      const source = sources.find((s) => s.id === clip.assetId)?.media;
      if (!source) return 'INVALID_SOURCES';
      if (!source.tracks.some((t) => t.index === clip.streamIndex)) return 'AUDIO_TRACK_NOT_FOUND';
      if (!rangeOK(clip, source)) return 'INVALID_RANGE';
    }
    const total = o.clips.reduce((sum, c) => sum + c.endMs - c.startMs, 0);
    if (total > 86400_000) return 'EDIT_LIMIT';
    if (o.format === 'm4r' && total > 30000) return 'RINGTONE_TOO_LONG';
  }
  return null;
}
