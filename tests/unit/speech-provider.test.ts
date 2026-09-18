import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callOpenAI, normalizeSpeech } from '../../apps/worker/src/transcription';
import { transcriptionConfig, transcriptEnabled } from '@filemorph/core/transcription';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const range = { index: 1, startMs: 599000, endMs: 1199000, boundaryMs: 600000 };
describe('Speech provider contract', () => {
  it('requires real timing and speaker fields instead of accepting chat or text-only responses', () => {
    for (const body of [
      { text: 'Hello' },
      { segments: [{ start: 0, end: 1, text: 'Hello' }] },
      { segments: [{ start: 2, end: 1, text: 'Hello', speaker: 'A' }] },
    ])
      expect(() => normalizeSpeech(body, range, 1200000)).toThrow();
    const result = normalizeSpeech(
      { segments: [{ start: 1, end: 3, text: '你好 Hello', speaker: 'A' }] },
      range,
      1200000,
    ).result;
    expect(result.segments[0]).toMatchObject({
      startMs: 600000,
      endMs: 602000,
      speakerId: 'chunk-1-A',
    });
    expect(result.speakers[0].needsReview).toBe(true);
  });
  it('validates server endpoint and uses only explicit server model configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret');
    vi.stubEnv('OPENAI_BASE_URL', 'https://relay.example/v1/');
    vi.stubEnv('TRANSCRIPTION_MODEL', 'speech-alias');
    expect(transcriptionConfig()).toMatchObject({
      baseURL: 'https://relay.example/v1',
      model: 'speech-alias',
      provider: 'relay.example',
    });
    for (const url of [
      'http://relay.example/v1',
      'https://key@relay.example/v1',
      'https://relay.example/v1?key=secret',
    ]) {
      vi.stubEnv('OPENAI_BASE_URL', url);
      expect(transcriptEnabled()).toBe(false);
    }
  });
  it('sends multipart diarization to the configured relay and never retries uncertain requests', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret');
    vi.stubEnv('OPENAI_BASE_URL', 'https://relay.example/v1');
    vi.stubEnv('TRANSCRIPTION_MODEL', 'gpt-4o-transcribe-diarize');
    const dir = await mkdtemp(join(tmpdir(), 'speech-contract-'));
    try {
      const file = join(dir, 'sample.mp3');
      await writeFile(file, 'synthetic-test-bytes');
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('https://relay.example/v1/audio/transcriptions');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer test-secret');
        const form = await new Request(url, { ...init, duplex: 'half' } as RequestInit).formData();
        expect(form.get('model')).toBe('gpt-4o-transcribe-diarize');
        expect(form.get('response_format')).toBe('diarized_json');
        expect(form.get('chunking_strategy')).toBe('auto');
        expect(form.get('language')).toBe('zh');
        return Response.json({ segments: [] }, { headers: { 'x-request-id': 'test-request' } });
      });
      Object.assign(fetch, { Response });
      vi.stubGlobal('fetch', fetch);
      expect(await callOpenAI(file, 'zh', new AbortController().signal)).toEqual({
        body: { segments: [] },
        requestId: 'test-request',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      fetch.mockImplementation(async () => {
        throw new TypeError('network interrupted');
      });
      await expect(callOpenAI(file, 'auto', new AbortController().signal)).rejects.toMatchObject({
        code: 'AI_RESULT_UNKNOWN',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
