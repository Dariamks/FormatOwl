import { describe, it, expect } from 'vitest';
import {
  initialPriceBook,
  findRate,
  microCny,
  creditsForMicroCny,
  pricingScenario,
  chargeablePath,
} from '../../packages/core/src/billing-model';
import { runtimeEstimate } from '../../packages/core/src/billing-quotes';
describe('credit economics', () => {
  it('uses seconds rather than bytes for speech, with integer-safe rounding', () => {
    const rate = findRate(
      initialPriceBook,
      'asr_seconds',
      'https://dashscope.aliyuncs.com/api/v1',
      'fun-asr',
    )!;
    expect(creditsForMicroCny(microCny(600, rate.cnyPerUnit!))).toBe(80);
    expect(creditsForMicroCny(microCny(7200, rate.cnyPerUnit!))).toBe(951);
    expect(creditsForMicroCny(5000)).toBe(3);
    expect(creditsForMicroCny(0)).toBe(1);
    expect(creditsForMicroCny(0, false)).toBe(0);
    expect(() => creditsForMicroCny(-1)).toThrow();
    expect(() => microCny(Infinity, 1)).toThrow();
  });
  it('keeps station quota and unknown gateway prices unverified', () => {
    expect(
      findRate(initialPriceBook, 'repair_images', 'https://pdhlzy.art/v1', 'gpt-image-2')?.verified,
    ).toBe(false);
    expect(
      findRate(initialPriceBook, 'input_tokens', 'https://ai.ctaigw.cn/v1', 'qwen3.6-plus')
        ?.cnyPerUnit,
    ).toBeNull();
    expect(
      findRate(initialPriceBook, 'asr_seconds', 'https://example.com/v1', 'fun-asr'),
    ).toBeUndefined();
  });
  it('applies the whole-request tier at the 256K boundary', () => {
    expect(
      findRate(
        initialPriceBook,
        'input_tokens',
        'https://dashscope.aliyuncs.com/api/v1',
        'qwen3.7-plus',
        256000,
      )?.cnyPerUnit,
    ).toBe(2e-6);
    expect(
      findRate(
        initialPriceBook,
        'input_tokens',
        'https://dashscope.aliyuncs.com/api/v1',
        'qwen3.7-plus',
        256001,
      )?.cnyPerUnit,
    ).toBe(6e-6);
    expect(
      findRate(
        initialPriceBook,
        'input_tokens',
        'https://dashscope.aliyuncs.com/api/v1',
        'qwen3.7-plus',
        1000001,
      ),
    ).toBeUndefined();
  });
  it('allocates the 300 monthly fixed expense once', () => {
    expect(pricingScenario(3000)).toEqual({ revenueCny: 3000, profitCny: 1800, margin: 0.6 });
    expect(pricingScenario(0).profitCny).toBe(-300);
    expect(pricingScenario(0).margin).toBeNull();
  });
});
describe('workload and operation coverage', () => {
  const f = { bytes: 100e6, duration: 600, width: 1920, height: 1080, fps: 30, source: 'test' };
  it('distinguishes same-sized long media, 4K, frame rate, codecs and two passes', () => {
    const base = runtimeEstimate('video-compressor', 'job', f);
    expect(runtimeEstimate('video-compressor', 'job', { ...f, duration: 7200 })).toBeGreaterThan(
      base * 10,
    );
    expect(
      runtimeEstimate('video-compressor', 'job', { ...f, width: 3840, height: 2160 }),
    ).toBeGreaterThan(base * 3);
    expect(runtimeEstimate('video-compressor', 'job', { ...f, fps: 60 })).toBeGreaterThan(base);
    expect(runtimeEstimate('video-compressor', 'job', f, { codec: 'h265' })).toBeGreaterThan(base);
    expect(runtimeEstimate('video-compressor', 'job', f, { targetMb: 5 })).toBeGreaterThan(base);
  });
  it('covers every processing mutation but not cancellation, upload or download', () => {
    const id = 'abc-123';
    for (const p of [
      'jobs',
      'batches',
      `assets/${id}/prepare`,
      `jobs/${id}/reading`,
      `jobs/${id}/translation/retry`,
      `jobs/${id}/translation/exports`,
      `jobs/${id}/transcript/exports`,
      `jobs/${id}/watermark/runs`,
      ...[
        'jobs',
        'batches',
        'reading-activities',
        'watermark-runs',
        'translation-exports',
        'transcript-exports',
      ].map((x) => `${x}/${id}/retry`),
      `batches/${id}/archive`,
    ])
      expect(chargeablePath(p), p).toBe(true);
    for (const p of ['uploads', `jobs/${id}/cancel`, `jobs/${id}/download`, 'billing', 'quote'])
      expect(chargeablePath(p), p).toBe(false);
  });
});
