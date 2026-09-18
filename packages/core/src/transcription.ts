import { z } from 'zod';

export const transcriptionSchema = z
  .object({
    language: z
      .enum(['auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'ar', 'hi'])
      .default('auto'),
    streamIndex: z.number().int().min(0).max(128),
  })
  .strict();
export type TranscriptionOptions = z.infer<typeof transcriptionSchema>;
export const segmentSchema = z
  .object({
    id: z.string().min(1).max(100),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z
      .string()
      .max(6000)
      .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/),
    speakerId: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .refine((s) => s.endMs > s.startMs);
export type TranscriptSegment = z.infer<typeof segmentSchema>;
export const speakerSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f]*$/),
    needsReview: z.boolean(),
  })
  .strict();
export type TranscriptSpeaker = z.infer<typeof speakerSchema>;
export interface TranscriptData {
  durationMs: number;
  segments: TranscriptSegment[];
  speakers: TranscriptSpeaker[];
}
export const transcriptPatchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    upsert: z.array(segmentSchema).max(20).default([]),
    remove: z.array(z.string().max(100)).max(20).default([]),
    speakerUpsert: z.array(speakerSchema).max(20).default([]),
    mergeSpeaker: z
      .object({ from: z.string().max(100), to: z.string().max(100) })
      .strict()
      .optional(),
  })
  .strict();
export const transcriptExportSchema = z
  .object({
    revision: z.number().int().positive(),
    format: z.enum(['txt', 'docx', 'pdf', 'srt', 'vtt']),
    includeSpeakers: z.boolean(),
    includeTimestamps: z.boolean(),
  })
  .strict();
export type TranscriptExportOptions = z.infer<typeof transcriptExportSchema>;
export interface TranscriptView extends TranscriptData {
  revision: number;
  total: number;
  nextOffset: number | null;
  completedChunks: number;
  totalChunks: number;
}
export interface TranscriptExportView {
  id: string;
  revision: number;
  format: string;
  state: string;
  error: string | null;
  includeSpeakers: boolean;
  includeTimestamps: boolean;
}
export const transcriptionModel = 'gpt-4o-transcribe-diarize';
export const maxTranscriptDurationMs = 2 * 3600_000;
export interface TranscriptionProviderConfig {
  kind: 'openai' | 'dashscope';
  baseURL: string;
  model: string;
}
// Stored snapshots contain routing only, never credentials. Pending cloud tasks keep their original route.
export function transcriptionConfig(
  stored?: TranscriptionProviderConfig,
): TranscriptionProviderConfig & { apiKey: string | undefined; provider: string } {
  const kind = stored?.kind || process.env.TRANSCRIPTION_PROVIDER || 'openai';
  if (kind !== 'openai' && kind !== 'dashscope') throw new Error('Invalid transcription provider');
  const apiKey = (
    kind === 'dashscope' ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY
  )?.trim();
  const baseURL = new URL(
    stored?.baseURL ||
      (kind === 'dashscope'
        ? process.env.DASHSCOPE_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/api/v1'
        : process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'),
  );
  if (
    baseURL.protocol !== 'https:' ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw new Error('Invalid transcription endpoint');
  if (kind === 'dashscope' && !baseURL.hostname.endsWith('.aliyuncs.com'))
    throw new Error('Invalid DashScope endpoint');
  const model =
    stored?.model ||
    process.env.TRANSCRIPTION_MODEL?.trim() ||
    (kind === 'dashscope' ? 'fun-asr' : transcriptionModel);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model))
    throw new Error('Invalid transcription model');
  return {
    kind,
    apiKey,
    baseURL: baseURL.href.replace(/\/$/, ''),
    model,
    provider: baseURL.hostname,
  };
}
export function transcriptEnabled() {
  try {
    return !!transcriptionConfig().apiKey;
  } catch {
    return false;
  }
}

export interface ChunkRange {
  index: number;
  startMs: number;
  endMs: number;
  boundaryMs: number;
}
// Keep each request below ten minutes including its one-second leading context.
export function chunkRanges(durationMs: number, silenceEnds: number[] = []): ChunkRange[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maxTranscriptDurationMs)
    throw new Error('TRANSCRIPTION_LIMIT');
  const result: ChunkRange[] = [];
  let boundary = 0;
  while (boundary < durationMs) {
    const startMs = Math.max(0, boundary - (result.length ? 1000 : 0));
    const maxEnd = Math.min(durationMs, startMs + 600000);
    const quiet = silenceEnds.filter((t) => t > maxEnd - 30000 && t <= maxEnd && t > boundary);
    const endMs = maxEnd === durationMs ? durationMs : (quiet.at(-1) ?? maxEnd);
    result.push({ index: result.length, startMs, endMs, boundaryMs: boundary });
    boundary = endMs;
  }
  return result;
}
export function mergeChunkSegments(
  parts: { range: ChunkRange; segments: TranscriptSegment[] }[],
): TranscriptSegment[] {
  const result: TranscriptSegment[] = [];
  for (const { range, segments } of parts) {
    for (const s of segments) {
      if (s.endMs <= range.boundaryMs) continue;
      const previous = result.at(-1);
      const normalized = (text: string) => text.replace(/[\s\p{P}]/gu, '').toLowerCase();
      if (
        previous &&
        s.startMs < range.boundaryMs &&
        s.startMs < previous.endMs &&
        normalized(s.text) === normalized(previous.text)
      ) {
        previous.endMs = Math.max(previous.endMs, s.endMs);
        continue;
      }
      let text = s.text;
      if (previous && s.startMs < range.boundaryMs && s.startMs < previous.endMs) {
        // Trim only a substantial exact phrase repeated in the shared source interval.
        // Raw provider results remain stored; timing stays at segment granularity.
        const prior = normalized(previous.text).slice(-512);
        const chars = [...s.text];
        let prefix = '',
          cut = 0;
        for (let i = 0; i < Math.min(chars.length, 512); i++) {
          prefix += normalized(chars[i]);
          const substantial = /[\p{Script=Han}]{4}/u.test(prefix) || prefix.length >= 12;
          const wordBoundary =
            i + 1 === chars.length || /[\s\p{P}\p{Script=Han}]/u.test(chars[i + 1]);
          if (substantial && wordBoundary && prior.endsWith(prefix)) cut = i + 1;
        }
        if (cut)
          text = chars
            .slice(cut)
            .join('')
            .replace(/^[\s\p{P}]+/u, '');
      }
      if (text.trim()) result.push({ ...s, text, startMs: Math.max(range.boundaryMs, s.startMs) });
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
