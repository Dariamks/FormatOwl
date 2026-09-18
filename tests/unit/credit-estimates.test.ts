import { describe, expect, it } from 'vitest';
import {
  referenceWork,
  referenceQuote,
  runtimeEstimate,
} from '../../packages/core/src/billing-estimate';
import { billingDefaults, type QuoteLine } from '../../packages/core/src/billing-model';

describe('indicative credit estimates', () => {
  const video = { bytes: 10 * 1024 ** 2, duration: 60, width: 1920, height: 1080, source: 'test' };
  it('scales with duration, output pixels and expensive encoding instead of charging a flat file fee', () => {
    const small = referenceWork('video-compressor', [video])!.credits;
    expect(
      referenceWork('video-compressor', [{ ...video, duration: 600 }])!.credits,
    ).toBeGreaterThan(small);
    expect(
      referenceWork('video-compressor', [video], { codec: 'h265', targetMb: 1 })!.credits,
    ).toBeGreaterThan(small);
    expect(referenceWork('video-compressor', [video], { resolution: 720 })!.credits).toBeLessThan(
      small,
    );
    expect(
      runtimeEstimate('video-cutter', 'job', video, { ranges: [{ startMs: 0, endMs: 10000 }] }),
    ).toBeLessThan(runtimeEstimate('video-cutter', 'job', video));
  });
  it('totals a batch before rounding and does not invent durations or page counts', () => {
    const image = { bytes: 1024, width: 100, height: 100, source: 'test' };
    const single = referenceWork('image-compressor', [image])!.credits;
    const batch = referenceWork('image-compressor', Array(20).fill(image))!.credits;
    expect(batch).toBeGreaterThan(single);
    expect(batch).toBeLessThan(20 * single);
    expect(referenceWork('pdf-compressor', [{ bytes: 100, source: 'unknown' }])).toBeNull();
    expect(referenceWork('video-compressor', [{ bytes: 100, source: 'unknown' }])).toBeNull();
    expect(referenceWork('image-compressor', [])).toBeNull();
  });
  it('uses source channels when audio settings select auto', () => {
    expect(referenceWork('audio-compressor', [video], { channels: 'auto' })).toEqual(
      referenceWork('audio-compressor', [video]),
    );
    expect(
      runtimeEstimate('audio-compressor', 'job', { ...video, channels: 6 }, { channels: 'auto' }),
    ).toBeGreaterThan(runtimeEstimate('audio-compressor', 'job', video, { channels: '2' }));
  });
  it('includes ASR but explicitly marks later translation costs as incomplete', () => {
    const asr = referenceWork('transcription', [video])!;
    expect(asr.credits).toBeGreaterThan(referenceWork('audio-compressor', [video])!.credits);
    expect(asr.incomplete).toBe(false);
    expect(referenceWork('video-translator', [video])!.incomplete).toBe(true);
  });
  it('uses price snapshot amounts, budgets missing resources, and never fills in unknown AI rates', () => {
    const line: QuoteLine = {
      label: 'test',
      meter: 'runtime_ms',
      quantity: 1000,
      maximum: 4000,
      rateId: 'runtime_ms',
      estimatedMicroCny: null,
      maximumMicroCny: null,
      verified: false,
    };
    expect(referenceQuote([line]).incomplete).toBe(false);
    expect(referenceQuote([{ ...line, estimatedMicroCny: 1000000 }]).credits).toBe(600);
    expect(referenceQuote([line, { ...line, meter: 'input_tokens' }]).incomplete).toBe(true);
    // Presentation estimates do not mutate authorization data.
    expect(line.estimatedMicroCny).toBeNull();
    expect(line.verified).toBe(false);
  });
  it('offers the reduced credit amounts consistently without changing existing ledger denominations', () => {
    expect(billingDefaults.packCredits).toEqual([900, 2900, 5900]);
    expect(billingDefaults.creditsPerCny).toBe(100);
  });
});
