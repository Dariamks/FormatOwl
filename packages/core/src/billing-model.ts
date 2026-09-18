/** Money is stored in micro-CNY; credits are integers. This module is safe for the browser. */
export const billingDefaults = {
  version: '2026-09-16.1',
  monthlyFixedCny: 300,
  creditsPerCny: 100,
  contributionMargin: 0.7,
  paymentReserve: 0.1,
  riskMultiplier: 1.2,
  quoteMinutes: 15,
  packs: [29, 99, 299],
  // Proposed storefront grants; separate from legacy CNY accounting denominations.
  packCredits: [900, 2900, 5900],
  // Proposed USD storefront prices. Sales remain closed; CNY cost accounting is unchanged.
  packDisplayUsd: [9, 29, 59],
} as const;
export const billingPackIds = ['basic', 'pro', 'premium'] as const;
export type BillingPackId = (typeof billingPackIds)[number];
export function isBillingPackId(value: unknown): value is BillingPackId {
  return typeof value === 'string' && (billingPackIds as readonly string[]).includes(value);
}
export function billingPack(id: BillingPackId) {
  const index = billingPackIds.indexOf(id);
  return {
    id,
    cny: billingDefaults.packs[index],
    credits: billingDefaults.packCredits[index],
    displayUsd: billingDefaults.packDisplayUsd[index],
  };
}
export type BillingMode = 'shadow' | 'enforced';
export type Meter =
  | 'runtime_ms'
  | 'storage_gib_day'
  | 'storage_read'
  | 'storage_write'
  | 'transfer_gib'
  | 'asr_seconds'
  | 'input_tokens'
  | 'output_tokens'
  | 'repair_images';
export interface PriceRate {
  id: string;
  meter: Meter;
  cnyPerUnit: number | null;
  verified: boolean;
  evidence: string;
  route?: string;
  model?: string;
  purpose?: string;
  minInputTokens?: number;
  maxInputTokens?: number;
  category: 'variable' | 'allocated';
}
export interface PriceBook {
  version: string;
  rates: PriceRate[];
  effectiveAt: string;
}
export interface BillingFacts {
  bytes: number;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  frames?: number;
  pages?: number;
  characters?: number;
  scanPages?: number;
  imagePixels?: number;
  source: string;
  warnings?: string[];
}
export interface QuoteLine {
  label: string;
  meter: Meter;
  quantity: number;
  maximum: number;
  rateId: string;
  estimatedMicroCny: number | null;
  maximumMicroCny: number | null;
  verified: boolean;
}
export interface QuoteView {
  id: string;
  mode: BillingMode;
  state: 'probing' | 'ready' | 'unpriced' | 'failed';
  estimatedCredits: number | null;
  maximumCredits: number | null;
  knownCredits: number;
  currency: 'credits';
  priceVersion: string;
  expiresAt: string;
  balance: number;
  lines: QuoteLine[];
  missingPrices: string[];
  stage: string;
  warnings: string[];
  operation: { path: string; body: Record<string, unknown> };
}
export function creditsForMicroCny(value: number, minimum = true) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid micro-CNY amount');
  // 600 credits / CNY. Integer arithmetic avoids floating point rounding at exact boundaries.
  return Math.max(minimum ? 1 : 0, Number((BigInt(value) * 3n + 4999n) / 5000n));
}
export function microCny(quantity: number, rate: number) {
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(rate) || rate < 0)
    throw new Error('Invalid cost');
  const result = Math.ceil(quantity * rate * 1_000_000 - 1e-8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Cost exceeds safe range');
  return result;
}
export function chargeablePath(path: string) {
  return (
    /^(jobs|batches)$/.test(path) ||
    /^assets\/[\w-]+\/prepare$/.test(path) ||
    /^(jobs|batches)\/[\w-]+\/(retry|archive)$/.test(path) ||
    /^jobs\/[\w-]+\/(reading|translation\/retry|translation\/exports|transcript\/exports|watermark\/runs)$/.test(
      path,
    ) ||
    /^(reading-activities|translation-exports|transcript-exports|watermark-runs)\/[\w-]+\/retry$/.test(
      path,
    )
  );
}
const official = 'https://help.aliyun.com/zh/model-studio/model-pricing';
export const initialPriceBook: PriceBook = {
  version: billingDefaults.version,
  effectiveAt: '2026-09-16T00:00:00Z',
  rates: [
    ...(
      ['runtime_ms', 'storage_gib_day', 'storage_read', 'storage_write', 'transfer_gib'] as const
    ).map((meter) => ({
      id: meter,
      meter,
      cnyPerUnit: null,
      verified: false,
      evidence:
        meter === 'runtime_ms'
          ? 'Target production benchmark and capacity allocation required'
          : 'Production storage/traffic invoice and currency conversion required',
      category: meter === 'runtime_ms' ? ('allocated' as const) : ('variable' as const),
    })),
    {
      id: 'fun-asr-beijing',
      meter: 'asr_seconds',
      cnyPerUnit: 0.00022,
      verified: true,
      route: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'fun-asr',
      evidence: official,
      category: 'variable',
    },
    ...(['input_tokens', 'output_tokens'] as const).map((meter, i) => ({
      id: `qwen3.5-ocr-${meter}`,
      meter,
      cnyPerUnit: [0.5, 2][i] / 1e6,
      verified: true,
      route: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen3.5-ocr',
      evidence: official,
      category: 'variable' as const,
    })),
    ...([0, 256000] as const).flatMap((min, tier) =>
      (['input_tokens', 'output_tokens'] as const).map((meter, i) => ({
        id: `qwen3.7-plus-${tier}-${meter}`,
        meter,
        cnyPerUnit: (tier ? [6, 24] : [2, 8])[i] / 1e6,
        minInputTokens: min,
        maxInputTokens: tier ? 1000000 : 256000,
        verified: true,
        route: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'qwen3.7-plus',
        evidence: official,
        category: 'variable' as const,
      })),
    ),
    ...(['input_tokens', 'output_tokens'] as const).map((meter) => ({
      id: `gateway-translation-${meter}`,
      meter,
      cnyPerUnit: null,
      verified: false,
      route: 'https://ai.ctaigw.cn/v1',
      model: 'qwen3.6-plus',
      evidence: 'Gateway cash settlement not verified',
      category: 'variable' as const,
    })),
    {
      id: 'gateway-image-repair',
      meter: 'repair_images',
      cnyPerUnit: 0.03,
      verified: false,
      route: 'https://pdhlzy.art/v1',
      model: 'gpt-image-2',
      evidence: 'Local account quota observation; cash conversion pending',
      category: 'variable',
    },
  ],
};
export function findRate(
  book: PriceBook,
  meter: Meter,
  route?: string,
  model?: string,
  inputTokens = 0,
) {
  return book.rates.find(
    (r) =>
      r.meter === meter &&
      r.route === route &&
      r.model === model &&
      (r.minInputTokens === undefined ||
        inputTokens > r.minInputTokens ||
        (inputTokens === 0 && r.minInputTokens === 0)) &&
      (r.maxInputTokens === undefined || inputTokens <= r.maxInputTokens),
  );
}
export function pricingScenario(revenueCny: number) {
  const profit = revenueCny * billingDefaults.contributionMargin - billingDefaults.monthlyFixedCny;
  return { revenueCny, profitCny: profit, margin: revenueCny ? profit / revenueCny : null };
}
