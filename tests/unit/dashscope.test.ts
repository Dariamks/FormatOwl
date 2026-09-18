import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callDashScope,
  normalizeDashScope,
  type SpeechContext,
} from '../../apps/worker/src/dashscope';
const config = {
  kind: 'dashscope',
  baseURL: 'https://dashscope.aliyuncs.com/api/v1',
  model: 'fun-asr',
} as const;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('DashScope asynchronous transcription', () => {
  it('returns empty text for documented no-speech outcomes without masking other failures', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-dashscope-key');
    let code = 'ASR_RESPONSE_HAVE_NO_WORDS';
    let state = 'FAILED';
    const fetcher = vi.fn(async () =>
      Response.json({
        output: {
          task_id: 'silent-task',
          task_status: state,
          code,
          results: [{ subtask_status: 'FAILED', code }],
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const context: SpeechContext = {
      config,
      taskId: 'silent-task',
      submitted: async () => {
        throw new Error('Must not submit');
      },
    };
    for (const c of ['ASR_RESPONSE_HAVE_NO_WORDS', 'SUCCESS_WITH_NO_VALID_FRAGMENT']) {
      code = c;
      for (const s of ['FAILED', 'SUCCEEDED']) {
        state = s;
        expect(
          (await callDashScope('unused', 'auto', new AbortController().signal, context)).body
            .segments,
        ).toEqual([]);
      }
    }
    code = 'FILE_DOWNLOAD_FAILED';
    await expect(
      callDashScope('unused', 'auto', new AbortController().signal, context),
    ).rejects.toMatchObject({ code: 'AI_TASK_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('does not describe a failed pre-upload connection as an existing cloud task', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-dashscope-key');
    const fetcher = vi.fn(async () => {
      throw new TypeError('Offline');
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      callDashScope('unused', 'auto', new AbortController().signal, {
        config,
        taskId: null,
        submitted: async () => {
          throw new Error('Nothing was submitted');
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_UPLOAD_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires speaker IDs and maps real millisecond sentence times', () => {
    expect(
      normalizeDashScope({
        transcripts: [
          {
            channel_id: 0,
            sentences: [{ begin_time: 100, end_time: 900, text: '你好', speaker_id: 0 }],
          },
        ],
      }),
    ).toEqual({ segments: [{ start: 0.1, end: 0.9, text: '你好', speaker: '0' }] });
    expect(() =>
      normalizeDashScope({
        transcripts: [
          { channel_id: 0, sentences: [{ begin_time: 0, end_time: 10, text: 'no speaker' }] },
        ],
      }),
    ).toThrow();
  });
  it('uploads with the model, persists the cloud task before polling, and resumes without uploading', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-dashscope-key');
    const dir = await mkdtemp(join(tmpdir(), 'dashscope-test-'));
    const file = join(dir, 'sample.mp3');
    await writeFile(file, 'fixture');
    let stored: string | null = null;
    const seen: string[] = [];
    const context: SpeechContext = {
      config,
      taskId: null,
      submitted: async (id) => {
        stored = id;
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL, init?: RequestInit) => {
        const url = String(raw);
        seen.push(url);
        if (url.includes('/uploads?')) {
          expect(new URL(url).searchParams.get('model')).toBe('fun-asr');
          return Response.json({
            data: {
              upload_host: 'https://test.oss-cn-beijing.aliyuncs.com',
              upload_dir: 'test/dir',
              oss_access_key_id: 'temporary',
              signature: 'signature',
              policy: 'policy',
              x_oss_object_acl: 'private',
              x_oss_forbid_overwrite: 'true',
            },
          });
        }
        if (url === 'https://test.oss-cn-beijing.aliyuncs.com/') {
          const form = init!.body as FormData;
          expect(form.get('file')).toBeInstanceOf(Blob);
          expect(init?.headers).toBeUndefined();
          return new Response('', { status: 200 });
        }
        if (url.endsWith('/services/audio/asr/transcription')) {
          const body = JSON.parse(init!.body as string);
          expect(body.parameters.diarization_enabled).toBe(true);
          expect(body.parameters.channel_id).toEqual([0]);
          expect(body.input.file_urls[0]).toMatch(/^oss:\/\/test\/dir\//);
          return Response.json({
            request_id: 'submit-request',
            output: { task_id: 'task-123', task_status: 'PENDING' },
          });
        }
        if (url.endsWith('/tasks/task-123')) {
          expect(stored).toBe('task-123');
          return Response.json({
            request_id: 'result-request',
            output: {
              task_id: 'task-123',
              task_status: 'SUCCEEDED',
              results: [
                {
                  subtask_status: 'SUCCEEDED',
                  transcription_url: 'https://result.oss-cn-beijing.aliyuncs.com/result.json',
                },
              ],
            },
            usage: { duration: 1 },
          });
        }
        if (url.endsWith('/result.json')) {
          expect(init?.headers).toBeUndefined();
          return Response.json({
            transcripts: [
              {
                channel_id: 0,
                sentences: [{ begin_time: 100, end_time: 900, text: '你好', speaker_id: 0 }],
              },
            ],
          });
        }
        throw new Error('Unexpected URL');
      }),
    );
    try {
      const first = await callDashScope(file, 'auto', new AbortController().signal, context);
      expect(first.body.segments[0].speaker).toBe('0');
      expect(seen).toHaveLength(5);
      seen.length = 0;
      await callDashScope('/not-read-on-resume', 'auto', new AbortController().signal, {
        ...context,
        taskId: stored,
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toContain('/tasks/task-123');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('keeps task identity after an interrupted query and rejects an untrusted result URL', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-dashscope-key');
    const context: SpeechContext = {
      config,
      taskId: 'task-123',
      submitted: async () => {
        throw new Error('Must not resubmit');
      },
    };
    const network = vi.fn(async () => {
      throw new TypeError('Interrupted');
    });
    vi.stubGlobal('fetch', network);
    await expect(
      callDashScope('unused', 'auto', new AbortController().signal, context),
    ).rejects.toMatchObject({ code: 'AI_TASK_PENDING' });
    expect(network).toHaveBeenCalledTimes(1);
    network.mockImplementation(async () =>
      Response.json({
        output: {
          task_id: 'task-123',
          task_status: 'SUCCEEDED',
          results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'http://127.0.0.1/private' }],
        },
      }),
    );
    await expect(
      callDashScope('unused', 'auto', new AbortController().signal, context),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    expect(network).toHaveBeenCalledTimes(2);
  });
});
