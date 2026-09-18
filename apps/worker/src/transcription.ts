import { startUsage, completeUsage, unknownUsage } from '@filemorph/core/billing-usage';
import { translationOptionsSchema } from '@filemorph/core/translation';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, eq, and, inArray, sql, sqlClient } from '@filemorph/core/db';
import { jobs, assets, transcripts, transcriptionChunks } from '@filemorph/core/schema';
import { downloadToFile } from '@filemorph/core/storage';
import { runProcess, MediaError } from '@filemorph/core/media';
import {
  chunkRanges,
  mergeChunkSegments,
  transcriptionSchema,
  transcriptionConfig,
  maxTranscriptDurationMs,
  type TranscriptSegment,
  type TranscriptSpeaker,
  type ChunkRange,
  type TranscriptData,
} from '@filemorph/core/transcription';
import { limits } from '@filemorph/core/config';
import { probeEditor, audioNormalize } from './processors/editor';
import { z } from 'zod';
import { callDashScope, type SpeechContext } from './dashscope';

const responseSchema = z.object({
  segments: z
    .array(
      z.object({
        id: z.string().optional(),
        start: z.number().finite().nonnegative(),
        end: z.number().finite().nonnegative(),
        text: z
          .string()
          .max(6000)
          .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/),
        speaker: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[^\x00-\x1f]*$/)
          .nullable(),
      }),
    )
    .max(10000),
  usage: z.record(z.string(), z.unknown()).optional(),
});
export type SpeechProvider = (
  file: string,
  language: string,
  signal: AbortSignal,
  context?: SpeechContext,
) => Promise<{ body: unknown; requestId: string | null }>;
export const callOpenAI: SpeechProvider = async (file, language, signal, context) => {
  let config;
  try {
    config = transcriptionConfig(context?.config);
  } catch {
    throw new MediaError('AI_NOT_CONFIGURED', 'Invalid transcription configuration');
  }
  if (config.kind !== 'openai' || !config.apiKey)
    throw new MediaError('AI_NOT_CONFIGURED', 'Missing transcription API key');
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: 240000,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await client.audio.transcriptions
        .create(
          {
            file: createReadStream(file),
            model: config.model,
            response_format: 'diarized_json',
            chunking_strategy: 'auto',
            ...(language === 'auto' ? {} : { language }),
          },
          { signal },
        )
        .withResponse();
      return { body: result.data, requestId: result.response.headers.get('x-request-id') };
    } catch (e) {
      if (
        e instanceof OpenAI.APIError &&
        e.status === 429 &&
        e.code !== 'insufficient_quota' &&
        attempt < 2
      ) {
        const header = Number(e.headers?.get('retry-after'));
        const delay = Math.min(
          60000,
          Math.max(
            1000,
            Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** attempt,
          ),
        );
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
          };
          const abort = () => {
            done();
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            done();
            resolve();
          }, delay);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        continue;
      }
      if (
        e instanceof OpenAI.APIError &&
        [400, 401, 403, 404, 413, 422, 429].includes(e.status ?? 0)
      )
        throw new MediaError(
          e.status === 429
            ? 'AI_RATE_LIMIT'
            : e.status === 401 || e.status === 403
              ? 'AI_AUTH'
              : 'AI_REQUEST_FAILED',
          'OpenAI rejected the request',
        );
      throw new MediaError(
        'AI_RESULT_UNKNOWN',
        'OpenAI request outcome is uncertain; retry may incur another charge',
      );
    }
  }
};
export const callSpeech: SpeechProvider = async (file, language, signal, context) => {
  if (!context) throw new MediaError('AI_NOT_CONFIGURED', 'Missing transcription context');
  return context.config.kind === 'dashscope'
    ? callDashScope(file, language, signal, context)
    : callOpenAI(file, language, signal, context);
};
export function normalizeSpeech(body: unknown, range: ChunkRange, durationMs: number) {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new MediaError('AI_INVALID_RESPONSE', 'Invalid transcript response');
  const speakers = new Map<string, TranscriptSpeaker>();
  const segments: TranscriptSegment[] = [];
  for (const [index, s] of parsed.data.segments.entries()) {
    if (!s.text.trim()) continue;
    if (s.end <= s.start || s.end * 1000 > range.endMs - range.startMs + 1500)
      throw new MediaError('AI_INVALID_RESPONSE', 'Invalid segment timing');
    const speakerId = s.speaker ? `chunk-${range.index}-${s.speaker}` : null;
    if (speakerId && !speakers.has(speakerId))
      speakers.set(speakerId, {
        id: speakerId,
        name: `${range.index + 1} · ${s.speaker}`,
        needsReview: range.index > 0,
      });
    const startMs = Math.max(0, Math.round(range.startMs + s.start * 1000)),
      endMs = Math.min(durationMs, range.endMs, Math.round(range.startMs + s.end * 1000));
    if (endMs > startMs)
      segments.push({
        id: `chunk-${range.index}-segment-${index}`,
        startMs,
        endMs,
        text: s.text,
        speakerId,
      });
  }
  if (speakers.size > 32) throw new MediaError('AI_INVALID_RESPONSE', 'Too many speaker labels');
  return { result: { segments, speakers: [...speakers.values()] }, usage: parsed.data.usage ?? {} };
}
type AfterSpeech = (ctx: {
  job: typeof jobs.$inferSelect;
  source: string;
  temp: string;
  signal: AbortSignal;
}) => Promise<void>;
export async function processTranscription(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  provider: SpeechProvider = callSpeech,
  afterSpeech?: AfterSpeech,
) {
  // A session lock survives short transactions and is released by PostgreSQL on worker exit.
  // Duplicate deliveries leave the live run alone; a recovered run checks uncertain chunks.
  const lease = await sqlClient().reserve();
  let locked = false;
  try {
    const [row] =
      await lease`select pg_try_advisory_lock(hashtextextended(${id}, 0)) as locked, pg_backend_pid() as pid`;
    locked = row.locked;
    if (!locked) return;
    await runTranscription(
      id,
      attempt,
      controllers,
      activeTemp,
      tempRoot,
      provider,
      async () => {
        const [current] = await lease`select pg_backend_pid() as pid`;
        if (current.pid !== row.pid)
          throw new MediaError('SERVICE_UNAVAILABLE', 'Transcription lease lost');
      },
      afterSpeech,
    );
  } finally {
    if (locked) await lease`select pg_advisory_unlock(hashtextextended(${id}, 0))`.catch(() => {});
    lease.release();
  }
}
async function runTranscription(
  id: string,
  attempt: number,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
  tempRoot: string,
  provider: SpeechProvider,
  checkLease: () => Promise<void>,
  afterSpeech?: AfterSpeech,
) {
  const [job] = await db()
    .update(jobs)
    .set({ state: 'processing', progress: 1, error: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.attempt, attempt),
        eq(jobs.deleting, false),
        inArray(jobs.state, ['queued', 'processing']),
        sql`${jobs.expiresAt}>now()`,
      ),
    )
    .returning();
  if (!job || (job.tool !== 'transcription' && job.tool !== 'video-translator')) return;
  const controller = new AbortController();
  controllers.add(controller);
  const { signal } = controller;
  let temp: string | undefined,
    checking = false;
  const timeout = setTimeout(
    () => controller.abort(new MediaError('TIMEOUT', 'Transcription timed out')),
    limits.jobTimeoutMs,
  );
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await checkLease();
      const [current] = await db().select().from(jobs).where(eq(jobs.id, id));
      if (
        !current ||
        current.state !== 'processing' ||
        current.attempt !== attempt ||
        current.deleting ||
        current.expiresAt <= new Date()
      )
        controller.abort(new MediaError('CANCELLED', 'Cancelled'));
    } catch {
      controller.abort(new MediaError('SERVICE_UNAVAILABLE', 'Cannot read task state'));
    } finally {
      checking = false;
    }
  }, 750);
  const activeJob = () =>
    and(
      eq(jobs.id, id),
      eq(jobs.attempt, attempt),
      eq(jobs.state, 'processing'),
      eq(jobs.deleting, false),
      sql`${jobs.expiresAt}>now()`,
    );
  try {
    const [asset] = await db()
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, job.assetId),
          eq(assets.owner, job.owner),
          eq(assets.state, 'ready'),
          sql`${assets.expiresAt}>now()`,
        ),
      );
    if (!asset) throw new MediaError('ASSET_NOT_FOUND', 'Source unavailable');
    temp = await mkdtemp(join(tempRoot, 'speech-'));
    activeTemp.add(temp);
    const disk = await statfs(temp);
    if (disk.bavail * disk.bsize < asset.size + 512 * 1024 ** 2)
      throw new MediaError('DISK_FULL', 'Insufficient space');
    const source = join(temp, 'input'),
      audio = join(temp, 'audio.wav');
    await downloadToFile(asset.key, source, signal);
    const media = await probeEditor(source, signal),
      options =
        job.tool === 'video-translator'
          ? (() => {
              const o = translationOptionsSchema.parse(job.options);
              return { language: o.sourceLanguage, streamIndex: o.streamIndex };
            })()
          : transcriptionSchema.parse(job.options);
    if (media.duration * 1000 > maxTranscriptDurationMs)
      throw new MediaError('TRANSCRIPTION_LIMIT', 'Maximum duration is two hours');
    if (!media.tracks.some((t) => t.index === options.streamIndex))
      throw new MediaError('NO_AUDIO', 'No selected audio track');
    const durationMs = Math.round(media.duration * 1000);
    let chunks = await db()
      .select()
      .from(transcriptionChunks)
      .where(eq(transcriptionChunks.jobId, id))
      .orderBy(transcriptionChunks.index);
    // A prior worker may have sent a request without persisting its response. Never replay it automatically.
    if (
      chunks.some((c) => (c.state === 'requesting' || c.state === 'uncertain') && !c.providerTaskId)
    )
      throw new MediaError('AI_RESULT_UNKNOWN', 'A prior request requires an explicit retry');
    const binary = process.env.FFMPEG_PATH || 'ffmpeg';
    await runProcess(
      binary,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-copyts',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'mov,matroska,webm,mp3,wav,aac,flac,ogg',
        '-i',
        source,
        '-map',
        `0:${options.streamIndex}`,
        '-vn',
        '-af',
        `${audioNormalize(media, options.streamIndex)},aresample=16000`,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        audio,
      ],
      signal,
    );
    if (!chunks.length) {
      const silence = join(temp, 'silence.txt');
      await runProcess(
        binary,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          audio,
          '-af',
          `silencedetect=noise=-35dB:d=0.4,ametadata=mode=print:file=${silence}`,
          '-f',
          'null',
          '-',
        ],
        signal,
      );
      const silenceText = await readFile(silence, 'utf8');
      const ends = [...silenceText.matchAll(/lavfi\.silence_end=([\d.]+)/g)].map((m) =>
        Math.max(0, Math.round(Number(m[1]) * 1000) - 100),
      );
      const ranges = chunkRanges(durationMs, ends);
      await db()
        .insert(transcriptionChunks)
        .values(ranges.map((range) => ({ id: randomUUID(), jobId: id, index: range.index, range })))
        .onConflictDoNothing();
      chunks = await db()
        .select()
        .from(transcriptionChunks)
        .where(eq(transcriptionChunks.jobId, id))
        .orderBy(transcriptionChunks.index);
    }
    for (const chunk of chunks) {
      signal.throwIfAborted();
      if (chunk.state === 'completed') continue;
      const file = join(temp, `chunk-${chunk.index}.mp3`);
      await runProcess(
        binary,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-ss',
          String(chunk.range.startMs / 1000),
          '-i',
          audio,
          '-t',
          String((chunk.range.endMs - chunk.range.startMs) / 1000),
          '-c:a',
          'libmp3lame',
          '-b:a',
          '64k',
          '-ar',
          '16000',
          '-ac',
          '1',
          file,
        ],
        signal,
      );
      if ((await stat(file)).size > 24_000_000)
        throw new MediaError('TRANSCRIPTION_LIMIT', 'Chunk too large');
      const claim = randomUUID();
      const configured = transcriptionConfig(chunk.providerConfig ?? undefined);
      const providerConfig = {
        kind: configured.kind,
        baseURL: configured.baseURL,
        model: configured.model,
      };
      const [claimed] = await db()
        .update(transcriptionChunks)
        .set({ state: 'requesting', claim, attempt, providerConfig, updatedAt: new Date() })
        .where(
          and(
            eq(transcriptionChunks.id, chunk.id),
            chunk.providerTaskId
              ? inArray(transcriptionChunks.state, ['pending', 'requesting', 'uncertain', 'failed'])
              : eq(transcriptionChunks.state, 'pending'),
            sql`exists(select 1 from jobs where jobs.id=${id} and jobs.attempt=${attempt} and jobs.state='processing' and not jobs.deleting and jobs.expires_at>now())`,
          ),
        )
        .returning();
      if (!claimed) throw new MediaError('AI_RESULT_UNKNOWN', 'Chunk already claimed');
      let usageId: string | null = null;
      try {
        signal.throwIfAborted();
        usageId = await startUsage({
          meter: 'asr_seconds',
          stage: 'asr',
          maximum: Math.ceil((chunk.range.endMs - chunk.range.startMs) / 1000),
          route: providerConfig.baseURL,
          model: providerConfig.model,
          eventKey: `asr:${chunk.id}:${chunk.attempt || attempt}`,
        });
        const response = await provider(file, options.language, signal, {
          config: providerConfig,
          taskId: chunk.providerTaskId,
          submitted: async (taskId, requestId) => {
            const saved = await db()
              .update(transcriptionChunks)
              .set({ providerTaskId: taskId, requestId, updatedAt: new Date() })
              .where(
                and(eq(transcriptionChunks.id, chunk.id), eq(transcriptionChunks.claim, claim)),
              )
              .returning();
            if (!saved.length)
              throw new MediaError('AI_RESULT_UNKNOWN', 'Cannot persist submitted task');
          },
        });
        const normalized = normalizeSpeech(response.body, chunk.range, durationMs);
        const providerSeconds = Number(normalized.usage.duration ?? normalized.usage.seconds);
        await completeUsage(
          usageId,
          Number.isFinite(providerSeconds) && providerSeconds >= 0
            ? providerSeconds
            : Math.ceil((chunk.range.endMs - chunk.range.startMs) / 1000),
          {
            ...normalized.usage,
            durationSource: Number.isFinite(providerSeconds)
              ? 'provider'
              : 'submitted_audio_seconds',
          },
          response.requestId,
        );
        await db()
          .update(transcriptionChunks)
          .set({
            state: 'completed',
            result: normalized.result,
            usage: normalized.usage,
            requestId: response.requestId,
            error: null,
            updatedAt: new Date(),
          })
          .where(and(eq(transcriptionChunks.id, chunk.id), eq(transcriptionChunks.claim, claim)));
      } catch (e) {
        const code = e instanceof MediaError ? e.code : 'AI_RESULT_UNKNOWN';
        if (['AI_AUTH', 'AI_RATE_LIMIT', 'AI_REQUEST_FAILED'].includes(code))
          await completeUsage(usageId, 0);
        else await unknownUsage([usageId], code);
        await db()
          .update(transcriptionChunks)
          .set({
            state:
              usageId === null ||
              [
                'AI_AUTH',
                'AI_RATE_LIMIT',
                'AI_REQUEST_FAILED',
                'AI_INVALID_RESPONSE',
                'AI_TASK_FAILED',
                'AI_TASK_EXPIRED',
                'AI_UPLOAD_FAILED',
                'AI_NOT_CONFIGURED',
              ].includes(code)
                ? 'failed'
                : 'uncertain',
            error: code,
            updatedAt: new Date(),
          })
          .where(and(eq(transcriptionChunks.id, chunk.id), eq(transcriptionChunks.claim, claim)));
        throw e;
      }
      await publishTranscript(id, attempt, durationMs, chunks.length);
    }
    await publishTranscript(id, attempt, durationMs, chunks.length);
    signal.throwIfAborted();
    if (afterSpeech) await afterSpeech({ job, source, temp, signal });
    await db()
      .update(jobs)
      .set({
        state: 'completed',
        progress: 100,
        media: {
          kind: 'audio',
          duration: media.duration,
          codec: 'transcript',
          sampleRate: 16000,
          channels: 1,
          bitrate: 0,
        },
        updatedAt: new Date(),
      })
      .where(activeJob());
  } catch (e) {
    const uncertain = e instanceof MediaError && e.code === 'AI_RESULT_UNKNOWN';
    const reason = signal.aborted ? signal.reason : e;
    const code = reason instanceof MediaError ? reason.code : 'TRANSCRIPTION_FAILED';
    await db()
      .update(jobs)
      .set({
        state: code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: uncertain ? 'AI_RESULT_UNKNOWN' : code === 'CANCELLED' ? null : code,
        errorDetail: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.attempt, attempt),
          inArray(jobs.state, ['processing', 'cancelling']),
        ),
      );
  } finally {
    clearInterval(timer);
    clearTimeout(timeout);
    controllers.delete(controller);
    if (temp) {
      activeTemp.delete(temp);
      await rm(temp, { recursive: true, force: true });
    }
  }
}
async function publishTranscript(id: string, attempt: number, durationMs: number, total: number) {
  await db().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.attempt, attempt),
          eq(jobs.state, 'processing'),
          eq(jobs.deleting, false),
          sql`${jobs.expiresAt}>now()`,
        ),
      )
      .for('update');
    if (!job) return;
    const chunks = await tx
      .select()
      .from(transcriptionChunks)
      .where(and(eq(transcriptionChunks.jobId, id), eq(transcriptionChunks.state, 'completed')))
      .orderBy(transcriptionChunks.index);
    const data: TranscriptData = {
      durationMs,
      segments: mergeChunkSegments(
        chunks.map((c) => ({ range: c.range, segments: c.result!.segments })),
      ),
      speakers: chunks.flatMap((c) => c.result!.speakers),
    };
    if (data.segments.length > 20000 || data.speakers.length > 256)
      throw new MediaError('TRANSCRIPTION_LIMIT', 'Transcript exceeds editor limits');
    await tx
      .insert(transcripts)
      .values({ jobId: id, data, revision: 1 })
      .onConflictDoUpdate({
        target: transcripts.jobId,
        set: { data, revision: sql`${transcripts.revision}+1`, updatedAt: new Date() },
      });
    await tx
      .update(jobs)
      .set({
        progress: Math.min(
          job.tool === 'video-translator' ? 44 : 96,
          10 + Math.round((chunks.length / total) * (job.tool === 'video-translator' ? 34 : 86)),
        ),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));
  });
}
