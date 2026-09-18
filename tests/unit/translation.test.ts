import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOcr, translationProvider } from '../../apps/worker/src/translation-provider';
import { splitTranslationText } from '../../apps/worker/src/translation-worker';
import { makeAss } from '../../apps/worker/src/translation-video';
import { translationExportSchema, type TranslationData } from '@filemorph/core/translation';
vi.mock('../../apps/worker/src/ai-rate-limit', async (original) => ({
  ...(await original<object>()),
  reserveProvider: vi.fn(async () => {}),
  deferProvider: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('translation boundaries', () => {
  it('waits after an explicit rate rejection and then completes the same request', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { text: '译文' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    const onWait = vi.fn(async () => {});
    const pending = translationProvider.translate(
      'Source',
      'en',
      'zh',
      new AbortController().signal,
      { baseURL: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-mt-plus', onWait },
    );
    await vi.advanceTimersByTimeAsync(1200);
    await expect(pending).resolves.toMatchObject({ result: { text: '译文' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalled();
  });
  it('splits long multilingual paragraphs without corrupting Unicode or losing content', () => {
    const text = 'Hello世界🙂مرحبا。'.repeat(1000),
      parts = splitTranslationText(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => Array.from(p).length <= 2500)).toBe(true);
  });
  it('rejects OCR coordinates outside the supplied image', () => {
    expect(() => normalizeOcr([{ text: 'a', box: [99, 0, 500, 20] }], 100, 100)).toThrow();
    expect(normalizeOcr([{ text: 'Hello', box: [5, 5, 50, 20] }], 100, 100)[0].box.width).toBe(50);
  });
  it('uses native pixel grounding and refuses model-written coordinate guesses', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture');
    const dir = await mkdtemp(join(tmpdir(), 'filemorph-ocr-')),
      file = join(dir, 'image.png');
    await writeFile(file, 'synthetic image bytes');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  finish_reason: 'repeated',
                  message: {
                    content: [
                      {
                        text: '[{"text":"wrong","box":[1,1,2,2]}]',
                        ocr_result: {
                          words_info: [
                            {
                              text: 'Correct line',
                              location: [100, 200, 600, 200, 600, 240, 100, 240],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const route = { baseURL: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3.5-ocr' };
    try {
      const r = await translationProvider.ocr(
        file,
        2880,
        2000,
        new AbortController().signal,
        route,
      );
      expect(r.result.blocks).toMatchObject([
        { text: 'Correct line', box: { x: 100, y: 200, width: 500, height: 40 } },
      ]);
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.input.messages[0].content).toHaveLength(1);
      expect(body.parameters.ocr_options.task).toBe('advanced_recognition');
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [{ message: { content: [{ text: '[{"text":"guess","box":[1,1,2,2]}]' }] } }],
            },
          }),
        ),
      );
      await expect(
        translationProvider.ocr(file, 100, 100, new AbortController().signal, route),
      ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does not repeat an uncertain network request', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture');
    const fetch = vi.fn().mockRejectedValue(new TypeError('Connection lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      translationProvider.translate('Text', 'en', 'zh', new AbortController().signal, {
        baseURL: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'qwen-mt-plus',
      }),
    ).rejects.toMatchObject({ code: 'AI_RESULT_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('escapes editable ASS commands and preserves millisecond ordering', () => {
    const data = {
      targetLanguage: 'zh',
      blocks: [
        {
          sourceText: 'Original',
          translatedText: '{\\pos(1,1)}\n译文',
          startMs: 1234,
          endMs: 2500,
        },
      ],
    } as TranslationData;
    const ass = makeAss(
      data,
      translationExportSchema.parse({ revision: 1, format: 'ass', mode: 'bilingual' }),
    );
    expect(ass).toContain('0:00:01.23,0:00:02.50');
    expect(ass).toContain('Original\\N\\{');
    expect(ass).not.toContain(',,{\\pos');
  });
});
