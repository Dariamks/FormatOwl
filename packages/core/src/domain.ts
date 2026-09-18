import { watermarkTools, watermarkOptionsSchema, isWatermarkTool } from './watermark';
import { translationOptionsSchema, type TranslationOptions } from './translation';
import {
  videoConversionSchema,
  audioConversionSchema,
  imageConversionSchema,
  type VideoConversionOptions,
  type AudioConversionOptions,
  type ImageConversionOptions,
  type ConversionOptions,
} from './conversion';
import { transcriptionSchema, type TranscriptionOptions } from './transcription';
import { z } from 'zod';
import {
  videoCutSchema,
  videoCropSchema,
  audioEditSchema,
  extractAudioSchema,
  type EditOptions,
  type VideoCutOptions,
  type VideoCropOptions,
  type AudioEditOptions,
  type ExtractAudioOptions,
  type EditorMedia,
  type EditResultInfo,
} from './editing';
export const compressionSchema = z
  .object({
    preset: z.enum(['light', 'balanced', 'strong']).default('balanced'),
    codec: z.enum(['h264', 'h265']).default('h264'),
    resolution: z.enum(['original', '2160', '1080', '720', '480']).default('original'),
    speed: z.enum(['fast', 'medium', 'slow']).default('medium'),
    crf: z.number().int().min(18).max(40).optional(),
    targetMb: z.number().min(0.1).max(10240).optional(),
    maxBitrateKbps: z.number().int().min(100).max(100000).optional(),
  })
  .strict();
export type CompressionOptions = z.infer<typeof compressionSchema>;
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  rotation: number;
}
export type JobState =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'expired';
interface JobCommon {
  id: string;
  name: string;
  state: JobState;
  progress: number;
  batchId: string | null;
  purpose: 'export' | 'preview';
  sourceIds: string[];
  inputMedia: { id: string; media: EditorMedia }[] | null;
  outputMedia: EditResultInfo | null;
  outputName: string | null;
  outputMime: string | null;
  note: ResultNote;
  inputSize: number;
  outputSize: number | null;
  error: string | null;
  attempt: number;
  createdAt: string;
  expiresAt: string;
}
export const terminalStates: JobState[] = ['completed', 'failed', 'cancelled', 'expired'];
export function outputFilename(name: string) {
  return `${name.replace(/\.[^.]*$/, '') || 'video'}-formatowl.mp4`;
}
export function validateVideoName(name: string) {
  return /\.(mp4|mov|mkv|webm)$/i.test(name) && name.length <= 240 && !/[\x00-\x1f]/.test(name);
}

export const toolSchema = z.enum([
  ...watermarkTools,
  'video-compressor',
  'image-compressor',
  'pdf-compressor',
  'audio-compressor',
  'video-cutter',
  'video-cropper',
  'audio-cutter',
  'video-to-mp3',
  'video-converter',
  'audio-converter',
  'image-converter',
  'transcription',
  'video-translator',
  'document-translator',
  'image-translator',
]);
export type Tool = z.infer<typeof toolSchema>;
export const batchToolSchema = z.enum([
  'image-compressor',
  'pdf-compressor',
  'audio-compressor',
  'video-converter',
  'audio-converter',
  'image-converter',
]);
export type BatchTool = z.infer<typeof batchToolSchema>;
export const imageCompressionSchema = z
  .object({ preset: z.enum(['light', 'balanced', 'strong']).default('balanced') })
  .strict();
export const pdfCompressionSchema = imageCompressionSchema;
export const audioCompressionSchema = z
  .object({
    preset: z.enum(['light', 'balanced', 'strong']).default('balanced'),
    format: z.enum(['mp3', 'm4a']).default('mp3'),
    bitrate: z
      .union([
        z.literal(32),
        z.literal(64),
        z.literal(96),
        z.literal(128),
        z.literal(192),
        z.literal(256),
        z.literal(320),
      ])
      .optional(),
    sampleRate: z.enum(['auto', '22050', '32000', '44100', '48000']).default('auto'),
    channels: z.enum(['auto', '1', '2']).default('auto'),
  })
  .strict();
export type AudioOptions = z.infer<typeof audioCompressionSchema>;
export type ImageOptions = z.infer<typeof imageCompressionSchema>;
export type ToolOptions =
  | Record<string, never>
  | CompressionOptions
  | AudioOptions
  | ImageOptions
  | EditOptions
  | ConversionOptions
  | TranscriptionOptions
  | TranslationOptions;
export const jobSpecSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('image-watermark-remover'), options: watermarkOptionsSchema }),
  z.object({ tool: z.literal('pdf-watermark-remover'), options: watermarkOptionsSchema }),
  z.object({ tool: z.literal('word-watermark-remover'), options: watermarkOptionsSchema }),
  z.object({ tool: z.literal('ppt-watermark-remover'), options: watermarkOptionsSchema }),
  z.object({ tool: z.literal('video-translator'), options: translationOptionsSchema }),
  z.object({ tool: z.literal('document-translator'), options: translationOptionsSchema }),
  z.object({ tool: z.literal('image-translator'), options: translationOptionsSchema }),
  z.object({ tool: z.literal('video-converter'), options: videoConversionSchema }),
  z.object({ tool: z.literal('audio-converter'), options: audioConversionSchema }),
  z.object({ tool: z.literal('image-converter'), options: imageConversionSchema }),
  z.object({ tool: z.literal('transcription'), options: transcriptionSchema }),
  z.object({ tool: z.literal('video-compressor'), options: compressionSchema }),
  z.object({ tool: z.literal('image-compressor'), options: imageCompressionSchema }),
  z.object({ tool: z.literal('pdf-compressor'), options: pdfCompressionSchema }),
  z.object({ tool: z.literal('audio-compressor'), options: audioCompressionSchema }),
  z.object({ tool: z.literal('video-cutter'), options: videoCutSchema }),
  z.object({ tool: z.literal('video-cropper'), options: videoCropSchema }),
  z.object({ tool: z.literal('audio-cutter'), options: audioEditSchema }),
  z.object({ tool: z.literal('video-to-mp3'), options: extractAudioSchema }),
]);
export interface AudioInfo {
  kind: 'audio';
  duration: number;
  codec: string;
  sampleRate: number;
  channels: number;
  bitrate: number;
  outputSampleRate?: number;
  outputChannels?: number;
  outputBitrate?: number;
}
export interface ImageInfo {
  kind: 'image';
  width: number;
  height: number;
  format: string;
  pages: number;
  hasAlpha: boolean;
  delay?: number[];
  loop?: number;
}
export interface PdfInfo {
  kind: 'pdf';
  pages: number;
  optimizedImages: number;
  skippedImages: number;
}
export type FileInfo = MediaInfo | AudioInfo | ImageInfo | PdfInfo;
export interface PreviewFile {
  key: string;
  mime: string;
}
export type ResultNote =
  | 'UNCHANGED'
  | 'LARGER'
  | 'PARTIAL_OPTIMIZATION'
  | 'PRIMARY_IMAGE_ONLY'
  | 'FIRST_FRAME_ONLY'
  | null;
export interface BatchView {
  id: string;
  tool: BatchTool;
  jobs: JobView[];
  expiresAt: string;
  archive: { id: string; state: string; count: number; error: string | null } | null;
}
export const formats: Record<Tool, string[]> = {
  'image-watermark-remover': ['jpg', 'jpeg', 'png', 'webp'],
  'pdf-watermark-remover': ['pdf'],
  'word-watermark-remover': ['docx'],
  'ppt-watermark-remover': ['pptx'],
  'video-translator': ['mp4', 'mov', 'mkv', 'webm'],
  'document-translator': ['pdf', 'docx', 'txt', 'epub'],
  'image-translator': ['jpg', 'jpeg', 'png', 'webp', 'svg'],
  'video-converter': ['mp4', 'mov', 'mkv', 'webm'],
  'audio-converter': ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'],
  'image-converter': ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'heic'],
  transcription: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'],
  'video-compressor': ['mp4', 'mov', 'mkv', 'webm'],
  'image-compressor': ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'],
  'pdf-compressor': ['pdf'],
  'audio-compressor': ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'],
  'video-cutter': ['mp4', 'mov', 'mkv', 'webm'],
  'video-cropper': ['mp4', 'mov', 'mkv', 'webm'],
  'video-to-mp3': ['mp4', 'mov', 'mkv', 'webm'],
  'audio-cutter': ['mp3', 'wav', 'aac', 'm4a', 'm4r', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'],
};
export function fileCategory(
  name: string,
): 'video' | 'audio' | 'image' | 'pdf' | 'document' | undefined {
  if (!name || name.length > 240 || /[\x00-\x1f/\\]/.test(name)) return;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['docx', 'pptx', 'txt', 'epub'].includes(ext)) return 'document';
  if (ext === 'svg') return 'image';
  if (formats['image-converter'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (formats['video-converter'].includes(ext)) return 'video';
  if ([...formats['audio-converter'], 'm4r'].includes(ext)) return 'audio';
}
export function fileTool(name: string): Tool | undefined {
  const kind = fileCategory(name);
  if (!kind) return;
  if (/\.pptx$/i.test(name)) return 'ppt-watermark-remover';
  if (kind === 'document') return 'document-translator';
  if (/\.svg$/i.test(name)) return 'image-translator';
  if (/\.avif$/i.test(name)) return 'image-converter';
  if (/\.m4r$/i.test(name)) return 'audio-cutter';
  return `${kind}-compressor` as Tool;
}
export function supportsInput(tool: Tool, name: string) {
  return !!fileCategory(name) && formats[tool].includes(name.split('.').pop()!.toLowerCase());
}
export function maxFileSize(tool: Tool) {
  return isWatermarkTool(tool) ||
    tool.startsWith('image-') ||
    tool === 'pdf-compressor' ||
    tool === 'document-translator'
    ? 50 * 1024 ** 2
    : 1024 ** 3;
}
export function mimeForName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return (
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        heic: 'image/heic',
        avif: 'image/avif',
        pdf: 'application/pdf',
        txt: 'text/plain; charset=utf-8',
        svg: 'image/svg+xml',
        epub: 'application/epub+zip',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        srt: 'application/x-subrip',
        vtt: 'text/vtt',
        ass: 'text/x-ssa',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        m4r: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        flac: 'audio/flac',
        ogg: 'audio/ogg',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        mkv: 'video/x-matroska',
        webm: 'video/webm',
      } as Record<string, string>
    )[ext] || 'application/octet-stream'
  );
}

type Specs = {
  'image-watermark-remover': { options: Record<string, never>; media: FileInfo | null };
  'pdf-watermark-remover': { options: Record<string, never>; media: FileInfo | null };
  'word-watermark-remover': { options: Record<string, never>; media: FileInfo | null };
  'ppt-watermark-remover': { options: Record<string, never>; media: FileInfo | null };
  'video-translator': { options: TranslationOptions; media: FileInfo | null };
  'document-translator': { options: TranslationOptions; media: FileInfo | null };
  'image-translator': { options: TranslationOptions; media: FileInfo | null };
  'video-converter': { options: VideoConversionOptions; media: MediaInfo | null };
  'audio-converter': { options: AudioConversionOptions; media: AudioInfo | null };
  'image-converter': { options: ImageConversionOptions; media: ImageInfo | null };
  transcription: { options: TranscriptionOptions; media: AudioInfo | null };
  'video-compressor': { options: CompressionOptions; media: MediaInfo | null };
  'image-compressor': { options: ImageOptions; media: ImageInfo | null };
  'pdf-compressor': { options: ImageOptions; media: PdfInfo | null };
  'audio-compressor': { options: AudioOptions; media: AudioInfo | null };
  'video-cutter': { options: VideoCutOptions; media: MediaInfo | null };
  'video-cropper': { options: VideoCropOptions; media: MediaInfo | null };
  'audio-cutter': { options: AudioEditOptions; media: AudioInfo | null };
  'video-to-mp3': { options: ExtractAudioOptions; media: AudioInfo | null };
};
export type JobView = { [T in Tool]: JobCommon & { tool: T } & Specs[T] }[Tool];
export type VideoJobView = Extract<JobView, { tool: 'video-compressor' }>;
