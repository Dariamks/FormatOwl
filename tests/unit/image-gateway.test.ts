import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translationEnabled, translationRoute } from '@filemorph/core/translation';
import {
  call,
  fetchProviderImage,
  translationProvider,
} from '../../apps/worker/src/translation-provider';
import { reserveProvider } from '../../apps/worker/src/ai-rate-limit';

vi.mock('../../apps/worker/src/ai-rate-limit', () => ({
  reserveProvider: vi.fn(async () => {}),
  deferProvider: vi.fn(async () => {}),
  abortableWait: vi.fn(async () => {}),
  retryDelay: () => 1000,
}));
const imageBase = 'https://pdhlzy.art/v1';
const textBase = 'https://ai.ctaigw.cn/v1';
const nativeBase = 'https://dashscope.aliyuncs.com/api/v1';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const uri = 'data:image/png;base64,' + png.toString('base64');
const signal = () => new AbortController().signal;
let folder: string, source: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'filemorph-image-gateway-'));
  source = join(folder, 'input.png');
  await writeFile(source, png);
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function configure() {
  vi.stubEnv('DASHSCOPE_API_KEY', 'native-secret');
  vi.stubEnv('AI_GATEWAY_API_KEY', 'text-secret');
  vi.stubEnv('AI_GATEWAY_BASE_URL', textBase);
  vi.stubEnv('AI_IMAGE_GATEWAY_API_KEY', 'image-secret');
  vi.stubEnv('AI_IMAGE_GATEWAY_BASE_URL', imageBase);
  vi.stubEnv('TRANSLATION_IMAGE_PROVIDER', 'openai');
  vi.stubEnv('TRANSLATION_IMAGE_MODEL', 'gpt-image-2');
  vi.stubEnv('TRANSLATION_TEXT_PROVIDER', 'openai');
  vi.stubEnv('TRANSLATION_MODEL', 'qwen3.6-plus');
  vi.stubEnv('AI_READING_PROVIDER', 'dashscope');
}
function response(text = `![image](${uri})`, finish = 'stop') {
  return new Response(
    JSON.stringify({
      id: 'repair-1',
      usage: { total_tokens: 2300 },
      choices: [{ finish_reason: finish, message: { content: text } }],
    }),
  );
}
describe('independent image repair gateway', () => {
  it('selects the image account without changing text, OCR or reading routes', () => {
    configure();
    expect(translationRoute('repair')).toEqual({
      provider: 'openai',
      gateway: 'image',
      model: 'gpt-image-2',
      baseURL: imageBase,
    });
    expect(translationRoute('translate')).toEqual({
      provider: 'openai',
      model: 'qwen3.6-plus',
      baseURL: textBase,
    });
    for (const kind of ['ocr', 'reading'] as const)
      expect(translationRoute(kind).baseURL).toBe(nativeBase);
    expect(translationEnabled()).toBe(true);
    vi.stubEnv('AI_IMAGE_GATEWAY_API_KEY', '');
    expect(translationEnabled()).toBe(false);
  });
  it('uses the tested chat-image protocol and decodes the inline PNG without a network download', async () => {
    configure();
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const r = await translationProvider.repair(source, signal(), translationRoute('repair'));
    expect(r).toEqual({
      result: { url: uri },
      requestId: 'repair-1',
      usage: { total_tokens: 2300, images: 1 },
    });
    expect(await translationProvider.image(String(r.result.url), signal())).toEqual(png);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(imageBase + '/chat/completions');
    expect(request.redirect).toBe('error');
    expect(request.headers).toMatchObject({ authorization: 'Bearer image-secret' });
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe('gpt-image-2');
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: uri } });
    expect(reserveProvider).toHaveBeenCalledWith(
      'gpt-image-2',
      4000,
      expect.anything(),
      expect.anything(),
      imageBase + ':image-secret',
      'repair',
    );
  });
  it('keeps the native route and credential for an already saved repair step', async () => {
    configure();
    const url = 'https://result.oss.aliyuncs.com/image.png';
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ output: { choices: [{ message: { content: [{ image: url }] } }] } }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      translationProvider.repair(source, signal(), {
        baseURL: nativeBase,
        model: 'qwen-image-2.0-pro-2026-06-22',
      }),
    ).resolves.toMatchObject({ result: { url } });
    const [endpoint, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe(nativeBase + '/services/aigc/multimodal-generation/generation');
    expect(request.headers).toMatchObject({ authorization: 'Bearer native-secret' });
  });
  it('never sends the image key to text, native or unconfigured routes', async () => {
    configure();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const route of [
      {
        provider: 'openai' as const,
        gateway: 'image' as const,
        baseURL: textBase,
        model: 'gpt-image-2',
      },
      {
        provider: 'openai' as const,
        gateway: 'image' as const,
        baseURL: 'https://other.example/v1',
        model: 'gpt-image-2',
      },
      {
        provider: 'dashscope' as const,
        gateway: 'image' as const,
        baseURL: nativeBase,
        model: 'gpt-image-2',
      },
      { provider: 'openai' as const, baseURL: imageBase, model: 'gpt-image-2' },
    ])
      await expect(call(route, '/chat/completions', {}, signal(), 'repair')).rejects.toMatchObject({
        code: 'AI_NOT_CONFIGURED',
      });
    await expect(
      call(translationRoute('repair'), '/chat/completions', {}, signal(), 'reading'),
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    '![image](https://other.example/secret.png)',
    `![one](${uri})\n![two](${uri})`,
    '<script>alert(1)</script>',
  ])('rejects unexpected model output %s', async (text) => {
    configure();
    const fetch = vi.fn(async () => response(text));
    vi.stubGlobal('fetch', fetch);
    await expect(
      translationProvider.repair(source, signal(), translationRoute('repair')),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid inline images, remote hosts and cancelled decoding', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const url of [
      'data:image/png;base64,notapng=',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'https://other.example/image.png',
      uri + ' junk',
    ])
      await expect(fetchProviderImage(url, signal())).rejects.toMatchObject({
        code: 'AI_INVALID_RESPONSE',
      });
    const c = new AbortController();
    c.abort();
    await expect(fetchProviderImage(uri, c.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds responses and rejects truncated output without resubmitting', async () => {
    configure();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(`![image](${uri})`, 'length'))
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'content-length': String(13 * 1024 ** 2) } }),
      );
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 2; i++)
      await expect(
        translationProvider.repair(source, signal(), translationRoute('repair')),
      ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves uncertain network outcomes and respects explicit rate-limit recovery', async () => {
    configure();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost connection'))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('lost body'));
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 2; i++)
      await expect(
        translationProvider.repair(source, signal(), translationRoute('repair')),
      ).rejects.toMatchObject({ code: 'AI_RESULT_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      translationProvider.repair(source, signal(), translationRoute('repair')),
    ).resolves.toMatchObject({ result: { url: uri } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
