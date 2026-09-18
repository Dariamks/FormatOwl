import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MediaError } from '@filemorph/core/media';
import {
  transcriptionConfig,
  type TranscriptionProviderConfig,
} from '@filemorph/core/transcription';
export interface SpeechContext {
  config: TranscriptionProviderConfig;
  taskId: string | null;
  submitted: (taskId: string, requestId: string | null) => Promise<void>;
}
const taskIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const policySchema = z.object({
  data: z.object({
    upload_host: z.string(),
    upload_dir: z.string().min(1),
    oss_access_key_id: z.string(),
    signature: z.string(),
    policy: z.string(),
    x_oss_object_acl: z.string(),
    x_oss_forbid_overwrite: z.union([z.string(), z.boolean()]),
  }),
});
const taskSchema = z.object({
  request_id: z.string().optional(),
  output: z.object({
    task_id: taskIdSchema,
    task_status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN']),
    code: z.string().optional(),
    results: z
      .array(
        z.object({
          subtask_status: z.string(),
          transcription_url: z.string().optional(),
          code: z.string().optional(),
        }),
      )
      .optional(),
  }),
  usage: z.record(z.string(), z.unknown()).optional(),
});
const resultSchema = z.object({
  transcripts: z
    .array(
      z.object({
        channel_id: z.literal(0),
        sentences: z
          .array(
            z.object({
              begin_time: z.number().int().nonnegative(),
              end_time: z.number().int().nonnegative(),
              text: z.string().max(6000),
              speaker_id: z.number().int().nonnegative().nullable(),
            }),
          )
          .max(10000),
      }),
    )
    .max(1),
});
function aliUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.aliyuncs.com') ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new MediaError('AI_INVALID_RESPONSE', 'Untrusted provider URL');
  return url;
}
async function json(response: Response) {
  if (Number(response.headers.get('content-length')) > 20_000_000)
    throw new MediaError('AI_INVALID_RESPONSE', 'Response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new MediaError('AI_INVALID_RESPONSE', 'Empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 20_000_000) {
      await reader.cancel();
      throw new MediaError('AI_INVALID_RESPONSE', 'Response too large');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new MediaError('AI_INVALID_RESPONSE', 'Invalid JSON response');
  }
}
function rejectStatus(response: Response, polling = false) {
  if (response.ok) return;
  throw new MediaError(
    response.status === 401 || response.status === 403
      ? 'AI_AUTH'
      : response.status === 429
        ? 'AI_RATE_LIMIT'
        : polling && response.status === 404
          ? 'AI_TASK_EXPIRED'
          : polling
            ? 'AI_TASK_PENDING'
            : 'AI_REQUEST_FAILED',
    'Speech provider rejected the request',
  );
}
async function request(
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
  phase: 'prepare' | 'submit' | 'query' = 'query',
) {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
  } catch {
    throw new MediaError(
      phase === 'submit'
        ? 'AI_RESULT_UNKNOWN'
        : phase === 'prepare'
          ? 'AI_UPLOAD_FAILED'
          : 'AI_TASK_PENDING',
      phase === 'submit'
        ? 'Cloud submission outcome is uncertain'
        : 'Provider connection interrupted',
    );
  }
}
async function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function normalizeDashScope(body: unknown) {
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success)
    throw new MediaError('AI_INVALID_RESPONSE', 'Missing timestamp or speaker fields');
  return {
    segments: parsed.data.transcripts.flatMap((t) =>
      t.sentences.map((s) => ({
        start: s.begin_time / 1000,
        end: s.end_time / 1000,
        text: s.text,
        speaker: s.speaker_id === null ? null : String(s.speaker_id),
      })),
    ),
  };
}
export async function callDashScope(
  file: string,
  language: string,
  signal: AbortSignal,
  context: SpeechContext,
) {
  const config = transcriptionConfig(context.config);
  if (config.kind !== 'dashscope' || !config.apiKey)
    throw new MediaError('AI_NOT_CONFIGURED', 'Missing DashScope API key');
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  let taskId = context.taskId,
    requestId: string | null = null;
  if (!taskId) {
    const policyUrl = new URL(`${config.baseURL}/uploads`);
    policyUrl.searchParams.set('action', 'getPolicy');
    policyUrl.searchParams.set('model', config.model);
    const policyResponse = await request(policyUrl, { headers }, signal, 'prepare');
    rejectStatus(policyResponse);
    const parsed = policySchema.safeParse(await json(policyResponse));
    if (!parsed.success) throw new MediaError('AI_INVALID_RESPONSE', 'Invalid upload policy');
    const p = parsed.data.data,
      key = `${p.upload_dir}/${randomUUID()}.mp3`;
    const form = new FormData();
    for (const [name, value] of Object.entries({
      OSSAccessKeyId: p.oss_access_key_id,
      Signature: p.signature,
      policy: p.policy,
      'x-oss-object-acl': p.x_oss_object_acl,
      'x-oss-forbid-overwrite': String(p.x_oss_forbid_overwrite),
      key,
      success_action_status: '200',
    }))
      form.append(name, value);
    form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), 'speech.mp3');
    const upload = await request(
      aliUrl(p.upload_host),
      { method: 'POST', body: form },
      signal,
      'prepare',
    );
    rejectStatus(upload);
    const submitted = await request(
      `${config.baseURL}/services/audio/asr/transcription`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-DashScope-Async': 'enable',
          'X-DashScope-OssResourceResolve': 'enable',
        },
        body: JSON.stringify({
          model: config.model,
          input: { file_urls: [`oss://${key}`] },
          parameters: {
            channel_id: [0],
            diarization_enabled: true,
            ...(language === 'auto' ? {} : { language_hints: [language] }),
          },
        }),
      },
      signal,
      'submit',
    );
    // Server errors can occur after accepting a task. Do not automatically submit again.
    if (submitted.status >= 500)
      throw new MediaError('AI_RESULT_UNKNOWN', 'Submission outcome is uncertain');
    rejectStatus(submitted);
    const data = taskSchema.safeParse(
      await json(submitted).catch(() => {
        throw new MediaError('AI_RESULT_UNKNOWN', 'Submission did not return a readable task ID');
      }),
    );
    if (!data.success)
      throw new MediaError('AI_RESULT_UNKNOWN', 'Submission did not return a durable task ID');
    taskId = data.data.output.task_id;
    requestId = data.data.request_id ?? null;
    await context.submitted(taskId, requestId);
  }
  taskIdSchema.parse(taskId);
  for (let poll = 0; poll < 1200; poll++) {
    signal.throwIfAborted();
    const response = await request(
      `${config.baseURL}/tasks/${encodeURIComponent(taskId)}`,
      { headers },
      signal,
    );
    if (response.status === 429 || response.status >= 500) {
      await wait(Math.min(15000, 2000 + poll * 200), signal);
      continue;
    }
    rejectStatus(response, true);
    const result = taskSchema.safeParse(await json(response));
    if (!result.success) throw new MediaError('AI_INVALID_RESPONSE', 'Invalid task response');
    if (result.data.output.task_id !== taskId)
      throw new MediaError('AI_INVALID_RESPONSE', 'Task ID mismatch');
    const output = result.data.output;
    const item = output.results?.[0];
    // DashScope reports silence as a failed subtask; these documented codes mean
    // a valid empty recognition result, not an upload, decode or service failure.
    const noSpeech = new Set(['ASR_RESPONSE_HAVE_NO_WORDS', 'SUCCESS_WITH_NO_VALID_FRAGMENT']);
    if (
      ['FAILED', 'SUCCEEDED'].includes(output.task_status) &&
      output.results?.length === 1 &&
      item?.subtask_status === 'FAILED' &&
      noSpeech.has(item.code ?? '') &&
      (!output.code || noSpeech.has(output.code))
    )
      return {
        body: { segments: [], usage: result.data.usage ?? {} },
        requestId: result.data.request_id ?? requestId,
      };
    if (output.task_status === 'FAILED' || output.task_status === 'CANCELED')
      throw new MediaError('AI_TASK_FAILED', 'Cloud transcription failed');
    if (output.task_status === 'UNKNOWN')
      throw new MediaError('AI_TASK_EXPIRED', 'Cloud task unavailable');
    if (output.task_status === 'SUCCEEDED') {
      if (
        output.results?.length !== 1 ||
        item?.subtask_status !== 'SUCCEEDED' ||
        !item.transcription_url
      )
        throw new MediaError('AI_TASK_FAILED', 'Cloud file transcription failed');
      const transcriptResponse = await request(aliUrl(item.transcription_url), {}, signal);
      rejectStatus(transcriptResponse, true);
      return {
        body: {
          ...normalizeDashScope(await json(transcriptResponse)),
          usage: result.data.usage ?? {},
        },
        requestId: result.data.request_id ?? requestId,
      };
    }
    await wait(Math.min(5000, 1000 + poll * 250), signal);
  }
  throw new MediaError('AI_TASK_PENDING', 'Cloud task is still pending; resume by task ID');
}
