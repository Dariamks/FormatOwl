import { describe, expect, it } from 'vitest';
import { inlineRequests, parseFragmentResult } from '../../packages/core/src/translation-inline';
import type { TranslationBlock } from '../../packages/core/src/translation';

describe('locally owned translation slots', () => {
  it('keeps formulas and IDs out of model input and preserves Unicode across parts', () => {
    const b = {
      sourceText: 'Context with a formula and formatted text.',
      inline: [
        { id: 's0', text: 'Hello & <world> 😀'.repeat(300) },
        { id: 's1', text: 'x²', protected: true },
        { id: 's2', text: ' ending.' },
      ],
    } as TranslationBlock;
    b.sourceText = b.inline!.map((s) => s.text).join('');
    const requests = inlineRequests(b);
    expect(requests.length).toBeGreaterThan(2);
    expect(
      requests
        .filter((r) => r.id === 's0')
        .map((r) => r.input)
        .join(''),
    ).toBe(b.inline![0].text);
    expect(requests.every((r) => !r.input.includes('<fm') && r.id !== 's1')).toBe(true);
    expect(
      requests.every(
        (r) =>
          Array.from(r.input).length <= 1500 &&
          Array.from(r.context).length <= 4500 &&
          b.sourceText.includes(r.context),
      ),
    ).toBe(true);
    const responses = requests.map((r) => ({ id: r.id, text: r.input }));
    expect(responses.at(-1)).toEqual({ id: 's2', text: ' ending.' });
  });
  it('rejects duplicate local slots instead of overwriting a fragment', () => {
    expect(() =>
      inlineRequests({
        inline: [
          { id: 'a', text: 'one' },
          { id: 'a', text: 'two' },
        ],
      } as TranslationBlock),
    ).toThrow('INLINE_MARKERS_INVALID');
  });
});

describe('structured paragraph validation', () => {
  it('rejects omitted, extra, empty and non-string slots before caching success', () => {
    expect(parseFragmentResult('{\"t0\":\"First\",\"t1\":\"Last\"}', ['t0', 't1'])).toEqual([
      'First',
      'Last',
    ]);
    for (const bad of [
      '{\"t0\":\"First\"}',
      '{\"t0\":1,\"t1\":\"Last\"}',
      '{\"t0\":\"\",\"t1\":\"Last\"}',
      '{\"t0\":\"First\",\"t1\":\"Last\",\"extra\":\"bad\"}',
      'not JSON',
    ])
      expect(parseFragmentResult(bad, ['t0', 't1'])).toBeNull();
  });
});
