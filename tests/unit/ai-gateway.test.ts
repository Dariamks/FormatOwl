import { afterEach, describe, expect, it, vi } from 'vitest';
import { translationRoute } from '@filemorph/core/translation';
import { translationProvider, call } from '../../apps/worker/src/translation-provider';
import { reserveProvider } from '../../apps/worker/src/ai-rate-limit';
import { callReading, parseReadingJson } from '../../apps/worker/src/reading-provider';
import { readingOptionsSchema, validateReadingResult } from '@filemorph/core/reading';
vi.mock('../../apps/worker/src/ai-rate-limit', async (original) => ({
  ...(await original<object>()),
  reserveProvider: vi.fn(async () => {}),
  deferProvider: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const nativeURL = 'https://dashscope.aliyuncs.com/api/v1',
  gatewayURL = 'https://ai.ctaigw.cn/v1';
function configure() {
  vi.stubEnv('DASHSCOPE_API_KEY', 'native-test');
  vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test');
  vi.stubEnv('AI_GATEWAY_BASE_URL', gatewayURL);
  vi.stubEnv('TRANSLATION_TEXT_PROVIDER', 'openai');
  vi.stubEnv('TRANSLATION_MODEL', 'qwen3.6-plus');
}
describe('gateway routing and reliable translation', () => {
  it('unwraps only complete JSON code fences without repairing the content', () => {
    expect(parseReadingJson('```json\n{"value":1}\n```', true)).toEqual({ value: 1 });
    expect(() => parseReadingJson('Here is the result: ```json\n{"value":1}\n```', true)).toThrow();
    expect(() => parseReadingJson('```json\n{"value":1}\n```', false)).toThrow();
  });
  it('adapts reading requests independently and keeps evidence validation strict', async () => {
    configure();
    vi.stubEnv('AI_READING_PROVIDER', 'openai');
    vi.stubEnv('AI_READING_MODEL', 'glm-5.1');
    const result = {
      title: 'Retention',
      insufficient: false,
      sections: [
        {
          heading: 'Duration',
          text: 'One day.',
          citations: [{ blockId: 'b1', quote: '24 hours' }],
        },
      ],
      nodes: [],
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'reading-1',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: '```json\n' + JSON.stringify(result) + '\n```' },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const options = readingOptionsSchema.parse({
      kind: 'chat',
      revision: 1,
      question: 'How long?',
      requestId: crypto.randomUUID(),
    });
    const r = await callReading(
      { blocks: [{ id: 'b1', source: '24 hours' }] },
      options,
      new AbortController().signal,
      translationRoute('reading'),
    );
    expect(r.result).toEqual(result);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(gatewayURL + '/chat/completions');
    expect(JSON.parse(String(request.body)).messages[0].content).toContain('Required JSON schema');
    expect(() =>
      validateReadingResult(
        result,
        { blocks: [{ id: 'b1', sourceText: '12 hours', translatedText: '', stale: false }] } as any,
        'chat',
      ),
    ).toThrow('INVALID_CITATION');
  });
  it('routes only new text translations to the gateway; OCR, repairs and reading stay native', () => {
    configure();
    expect(translationRoute('translate')).toEqual({
      provider: 'openai',
      baseURL: gatewayURL,
      model: 'qwen3.6-plus',
    });
    for (const kind of ['ocr', 'repair', 'reading'] as const)
      expect(translationRoute(kind)).toMatchObject({ provider: 'dashscope', baseURL: nativeURL });
  });
  it('keeps the original key and protocol for a saved pre-migration step', async () => {
    configure();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ output: { text: '原任务译文' } })),
    );
    vi.stubGlobal('fetch', fetch);
    await translationProvider.translate('Original', 'en', 'zh', new AbortController().signal, {
      baseURL: nativeURL,
      model: 'qwen-mt-plus',
    });
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(nativeURL + '/services/aigc/text-generation/generation');
    expect(request.headers).toMatchObject({ authorization: 'Bearer native-test' });
    expect(JSON.parse(String(request.body)).parameters.translation_options.target_lang).toBe('zh');
  });
  it('uses chat messages, captures gateway usage and isolates quota identity', async () => {
    configure();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'chat-1',
            choices: [{ finish_reason: 'stop', message: { content: '保留 FM-2048。' } }],
            usage: { total_tokens: 42 },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const r = await translationProvider.translate(
      'Keep FM-2048.',
      'en',
      'zh',
      new AbortController().signal,
      translationRoute('translate'),
    );
    expect(r).toEqual({
      result: { text: '保留 FM-2048。' },
      requestId: 'chat-1',
      usage: { total_tokens: 42 },
    });
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(gatewayURL + '/chat/completions');
    expect(request.headers).toMatchObject({ authorization: 'Bearer gateway-test' });
    expect(request.redirect).toBe('error');
    const body = JSON.parse(String(request.body));
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Keep FM-2048.' });
    expect(body.input).toBeUndefined();
    expect(body.thinking.type).toBe('disabled');
    expect(reserveProvider).toHaveBeenCalledWith(
      'qwen3.6-plus',
      expect.any(Number),
      expect.any(AbortSignal),
      expect.any(Object),
      gatewayURL + ':gateway-test',
      'translate',
    );
  });
  it('never sends either credential to an unconfigured or mismatched host', async () => {
    configure();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const route of [
      { provider: 'openai' as const, baseURL: 'https://other.example/v1', model: 'qwen3.6-plus' },
      { baseURL: gatewayURL, model: 'qwen3.6-plus' },
    ])
      await expect(
        call(route, '/chat/completions', {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects truncated completions and never retries uncertain paid requests', async () => {
    configure();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: 'Partial' } }],
          }),
        ),
      )
      .mockRejectedValueOnce(new TypeError('lost connection'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      translationProvider.translate(
        'Original',
        'en',
        'zh',
        new AbortController().signal,
        translationRoute('translate'),
      ),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    await expect(
      translationProvider.translate(
        'Original',
        'en',
        'zh',
        new AbortController().signal,
        translationRoute('translate'),
      ),
    ).rejects.toMatchObject({ code: 'AI_RESULT_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
