import { creditsForMicroCny, microCny, type BillingFacts, type QuoteLine } from './billing-model';

/** Planning assumptions, NOT a verified price book. Never used to authorize or settle charges.
 * 300 CNY/month, 30 days, 20% effective processing occupancy; storage/traffic budgets
 * include a conservative currency allowance. See docs/credit-estimates.md.
 */
export const estimateRates = {
  runtime_ms: 300 / (30 * 86400 * 0.2 * 1000),
  storage_gib_day: 0.004,
  storage_read: 0.000003,
  storage_write: 0.000033,
  transfer_gib: 0.1,
} as const;

export function referenceQuote(lines: QuoteLine[]) {
  let cost = 0,
    incomplete = false;
  for (const line of lines) {
    const fallback = estimateRates[line.meter as keyof typeof estimateRates];
    if (line.estimatedMicroCny !== null) cost += line.estimatedMicroCny;
    else if (fallback !== undefined) cost += microCny(line.quantity, fallback);
    else incomplete = true;
  }
  return { credits: creditsForMicroCny(cost), incomplete };
}

/** A browser preview of local work. Document structure and unknown AI routes require a server quote. */
export function referenceWork(tool: string, facts: BillingFacts[], options: any = {}) {
  if (!facts.length) return null;
  const timed = tool.startsWith('video-') || tool.startsWith('audio-') || tool === 'transcription';
  if (
    facts.some((f) =>
      timed ? !f.duration : tool.startsWith('image-') ? !f.width : !f.pages && !f.characters,
    )
  )
    return null;
  let cost = 0;
  for (const f of facts) {
    cost += microCny(runtimeEstimate(tool, 'job', f, options) * 1000, estimateRates.runtime_ms);
    cost += microCny((f.bytes / 1024 ** 3) * 3, estimateRates.storage_gib_day);
    cost += microCny((f.bytes / 1024 ** 3) * 2, estimateRates.transfer_gib);
    cost += microCny(3, estimateRates.storage_read) + microCny(3, estimateRates.storage_write);
    if (tool === 'transcription' || tool === 'video-translator')
      cost += microCny(f.duration || 0, 0.00022);
  }
  return {
    credits: creditsForMicroCny(cost),
    incomplete: tool.endsWith('translator') || tool.endsWith('watermark-remover'),
  };
}

function durationFor(f: BillingFacts, options: any) {
  const sum = (ranges: any[]) =>
    ranges.reduce(
      (n: number, r: any) => n + Math.max(0, Number(r.endMs) - Number(r.startMs)) / 1000,
      0,
    );
  if (Array.isArray(options.clips)) return sum(options.clips);
  if (Array.isArray(options.ranges)) {
    const selected = sum(options.ranges);
    return options.mode === 'remove' ? Math.max(0, (f.duration || 0) - selected) : selected;
  }
  if (options.range) return sum([options.range]);
  return f.duration || 0;
}
/** Workload estimates are intentionally provisional until a production benchmark price book is published. */
export function runtimeEstimate(tool: string, kind: string, f: BillingFacts, options: any = {}) {
  if (kind === 'archive') return 2 + (f.bytes / 1024 ** 3) * 15;
  const video = tool.startsWith('video-') && tool !== 'video-to-mp3';
  if (video) {
    const res = Number(options.resolution),
      h = Math.min(options.rect?.height || f.height || 1080, res > 0 ? res : Infinity),
      w = options.rect?.width || ((f.width || 1920) * h) / (f.height || 1080);
    const pixels = Math.max(0.1, (w * h) / (1920 * 1080)),
      fps = Math.max(1, (f.fps || 30) / 30);
    const codec = String(options.codec || options.format || '');
    const encoding = /265|hevc|webm|vp9/i.test(codec) ? 3 : 1;
    const speed = options.speed === 'slow' ? 3 : options.speed === 'fast' ? 0.6 : 1;
    return (
      2 +
      durationFor(f, options) *
        pixels *
        fps *
        encoding *
        speed *
        (options.mode === 'size' || options.targetMb ? 2 : 1) *
        0.4
    );
  }
  if (tool.startsWith('audio-') || tool === 'video-to-mp3' || tool === 'transcription')
    return (
      2 +
      durationFor(f, options) *
        0.025 *
        Math.max(1, (Number(options.channels) || f.channels || 2) / 2)
    );
  if (f.frames || tool.startsWith('image-'))
    return (
      1 +
      ((f.imagePixels || (f.width || 1000) * (f.height || 1000) * (f.frames || 1)) / 1e6) *
        (options.format === 'avif' ? 2 : 0.12)
    );
  return 2 + (f.pages || 1) * 0.4 + (f.characters || 0) / 20000;
}
