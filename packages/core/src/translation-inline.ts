import type { TranslationBlock } from './translation';

/** IDs and protected content stay local: an API response belongs to exactly one slot. */
export function inlineRequests(block: TranslationBlock) {
  const requests: { input: string; id: string; part: number; context: string }[] = [];
  const ids = new Set<string>();
  const source = Array.from(block.sourceText || '');
  let offset = 0;
  for (const span of block.inline || []) {
    if (ids.has(span.id)) throw new Error('INLINE_MARKERS_INVALID');
    ids.add(span.id);
    const chars = Array.from(span.text);
    const start = offset;
    offset += chars.length;
    if (span.protected) continue;
    for (let i = 0; i < chars.length || i === 0; i += 1500) {
      requests.push({
        input: chars.slice(i, i + 1500).join(''),
        id: span.id,
        part: i / 1500,
        context: source.slice(Math.max(0, start + i - 1500), start + i + 3000).join(''),
      });
    }
  }
  return requests;
}

/** Translate related slots together so sentence grammar can be distributed across them. */
export function inlineBatches(block: TranslationBlock) {
  const batches: ReturnType<typeof inlineRequests>[] = [];
  let current: ReturnType<typeof inlineRequests> = [],
    length = 0;
  for (const request of inlineRequests(block)) {
    if (current.length && length + request.input.length > 3000) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(request);
    length += request.input.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function parseFragmentResult(text: string, keys: string[]) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.keys(value).length !== keys.length ||
      keys.some((k) => typeof value[k] !== 'string' || !value[k].trim())
    )
      return null;
    return keys.map((k) => value[k] as string);
  } catch {
    return null;
  }
}
