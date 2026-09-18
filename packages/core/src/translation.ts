import { z } from 'zod';

export const translationTools = [
  'video-translator',
  'document-translator',
  'image-translator',
] as const;
export type TranslationTool = (typeof translationTools)[number];
export function isTranslationTool(tool: string): tool is TranslationTool {
  return (translationTools as readonly string[]).includes(tool);
}
export const translationLanguages = [
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'ru',
  'ar',
] as const;
export const languageNames: Record<string, [string, string]> = {
  auto: ['Detect automatically', '自动检测'],
  zh: ['Chinese', '简体中文'],
  en: ['English', '英语'],
  ja: ['Japanese', '日语'],
  ko: ['Korean', '韩语'],
  fr: ['French', '法语'],
  de: ['German', '德语'],
  es: ['Spanish', '西班牙语'],
  pt: ['Portuguese', '葡萄牙语'],
  it: ['Italian', '意大利语'],
  ru: ['Russian', '俄语'],
  ar: ['Arabic', '阿拉伯语'],
};
export const translationOptionsSchema = z
  .object({
    sourceLanguage: z.enum(['auto', ...translationLanguages]).default('auto'),
    targetLanguage: z.enum(translationLanguages),
    streamIndex: z.number().int().min(0).max(128).default(0),
  })
  .strict();
export type TranslationOptions = z.infer<typeof translationOptionsSchema>;
const text = z
  .string()
  .max(300000)
  .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/);
export const translationBoxSchema = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    angle: z.number().finite().min(-180).max(180).default(0),
  })
  .strict();
export const translationStyleSchema = z
  .object({
    fontSize: z.number().finite().min(4).max(500),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    align: z.enum(['left', 'center', 'right']),
    fontFamily: z.enum(['serif', 'sans']).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
  })
  .strict();
export type TranslationBox = z.infer<typeof translationBoxSchema>;
export type TranslationStyle = z.infer<typeof translationStyleSchema>;
export interface TranslationBlock {
  id: string;
  sourceText: string;
  translatedText: string;
  page: number;
  kind: 'text' | 'heading' | 'table' | 'formula' | 'subtitle' | 'figure' | 'caption' | 'list';
  box?: TranslationBox;
  originalBox?: TranslationBox;
  style: TranslationStyle;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  locator?: { part: string; index: number; path?: string };
  review: string[];
  stale: boolean;
  keepOriginal: boolean;
  hidden?: boolean;
  raster?: boolean;
  localRepair?: boolean; // Worker-detected flat background; never client supplied.
  layoutEdited?: boolean;
  order?: number;
  inline?: {
    id: string;
    text: string;
    protected?: boolean;
    math?: string;
    box?: TranslationBox;
    bold?: boolean;
    italic?: boolean;
    superscript?: boolean;
    subscript?: boolean;
  }[];
  translatedInline?: { id: string; text: string }[];
  table?: {
    id: string;
    row: number;
    column: number;
    rowSpan: number;
    columnSpan: number;
    header: boolean;
    rows: number;
    columns: number;
  };
  figureId?: string;
  structureId?: string;
  layoutRole?: 'header' | 'footer';
  attachment?: {
    parentId: string;
    token: string;
    occurrence: number;
    count: number;
    script: 'subscript' | 'superscript';
  };
}
export interface TranslationPage {
  index: number;
  width: number;
  height: number;
  title: string;
  originalFile?: string;
  backgroundFile?: string;
  previewFile?: string;
  needsOcr?: boolean;
  textSource?: 'native' | 'mixed' | 'ocr';
  scale?: number;
}
export interface TranslationData {
  layoutVersion?: number;
  layoutEngine?: string;
  inlineVersion?: number;
  extractionVersion?: number;
  format: string;
  pages: TranslationPage[];
  blocks: TranslationBlock[];
  durationMs?: number;
  width?: number;
  height?: number;
  sourceLanguage: string;
  targetLanguage: string;
}
export const translationPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    upsert: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            sourceText: text.optional(),
            translatedText: text.optional(),
            box: translationBoxSchema.optional(),
            style: translationStyleSchema.optional(),
            startMs: z.number().int().nonnegative().optional(),
            endMs: z.number().int().positive().optional(),
            keepOriginal: z.boolean().optional(),
            reviewed: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    add: z
      .array(
        z
          .object({
            page: z.number().int().nonnegative(),
            box: translationBoxSchema,
            sourceText: text,
          })
          .strict(),
      )
      .max(10)
      .default([]),
    remove: z.array(z.string().max(100)).max(20).default([]),
  })
  .strict();
export const translationRetrySchema = z
  .object({
    revision: z.number().int().positive(),
    blockIds: z.array(z.string().min(1).max(100)).min(1).max(100),
    operation: z.enum(['translate', 'repair']),
  })
  .strict();
export const translationExportSchema = z
  .object({
    revision: z.number().int().positive(),
    format: z.enum([
      'txt',
      'docx',
      'pdf',
      'epub',
      'srt',
      'vtt',
      'ass',
      'mp4',
      'png',
      'jpg',
      'webp',
    ]),
    mode: z.enum(['original', 'translated', 'bilingual']).default('translated'),
    preview: z.boolean().default(false),
    previewStartMs: z.number().int().nonnegative().default(0),
    subtitle: z
      .object({
        fontSize: z.number().int().min(12).max(120).default(36),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#ffffff'),
        position: z.enum(['top', 'bottom']).default('bottom'),
      })
      .strict()
      .default({ fontSize: 36, color: '#ffffff', position: 'bottom' }),
  })
  .strict();
// Server-owned cache version. Existing generated files remain immutable after renderer fixes.
export const translationRenderVersion = 9;
export type TranslationExportOptions = z.infer<typeof translationExportSchema> & {
  rendererVersion?: number;
};
export interface TranslationView {
  waitingUntil?: string | null;
  revision: number;
  stage: string;
  completedUnits: number;
  totalUnits: number;
  data: TranslationData | null;
}
export const translationLimits = {
  maxPages: 100,
  maxCharacters: 100000,
  maxBlocks: 20000,
  maxImagePixels: 100000000,
};
export function translationConfig() {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  const baseURL = new URL(
    process.env.TRANSLATION_BASE_URL ||
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope.aliyuncs.com/api/v1',
  );
  if (
    baseURL.protocol !== 'https:' ||
    !baseURL.hostname.endsWith('.aliyuncs.com') ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw new Error('Invalid translation endpoint');
  const models = {
    translate: process.env.TRANSLATION_MODEL || 'qwen-mt-plus',
    ocr: process.env.TRANSLATION_OCR_MODEL || 'qwen3.5-ocr',
    repair: process.env.TRANSLATION_IMAGE_MODEL || 'qwen-image-2.0-pro-2026-06-22',
    reading: process.env.AI_READING_MODEL || 'qwen3.7-plus',
  };
  for (const model of Object.values(models))
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model))
      throw new Error('Invalid translation model');
  return { apiKey, baseURL: baseURL.href.replace(/\/$/, ''), models };
}
export interface TranslationRoute {
  // Older saved steps have no provider and continue to use DashScope credentials.
  provider?: 'dashscope' | 'openai';
  // Image editing can use a different account from text translation and reading.
  gateway?: 'image';
  baseURL: string;
  model: string;
}
export function aiGatewayConfig() {
  const base = new URL(process.env.AI_GATEWAY_BASE_URL || 'https://ai.ctaigw.cn/v1');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Invalid AI gateway endpoint');
  return {
    baseURL: base.href.replace(/\/$/, ''),
    apiKey: process.env.AI_GATEWAY_API_KEY?.trim(),
  };
}
export function imageGatewayConfig() {
  const base = new URL(process.env.AI_IMAGE_GATEWAY_BASE_URL || 'https://pdhlzy.art/v1');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Invalid image gateway endpoint');
  return {
    baseURL: base.href.replace(/\/$/, ''),
    apiKey: process.env.AI_IMAGE_GATEWAY_API_KEY?.trim(),
  };
}
export function translationRoute(
  kind: keyof ReturnType<typeof translationConfig>['models'],
): TranslationRoute {
  const config = translationConfig();
  const provider =
    kind === 'translate'
      ? process.env.TRANSLATION_TEXT_PROVIDER || 'dashscope'
      : kind === 'reading'
        ? process.env.AI_READING_PROVIDER || 'dashscope'
        : kind === 'repair'
          ? process.env.TRANSLATION_IMAGE_PROVIDER || 'dashscope'
          : 'dashscope';
  if (provider !== 'dashscope' && provider !== 'openai') throw new Error('Invalid AI provider');
  return {
    provider,
    ...(kind === 'repair' && provider === 'openai' ? { gateway: 'image' as const } : {}),
    baseURL:
      provider === 'openai'
        ? (kind === 'repair' ? imageGatewayConfig() : aiGatewayConfig()).baseURL
        : config.baseURL,
    model: config.models[kind],
  };
}
export function translationEnabled() {
  try {
    return (
      !!translationConfig().apiKey &&
      (['translate', 'reading', 'repair'] as const).every(
        (kind) =>
          translationRoute(kind).provider !== 'openai' ||
          !!(kind === 'repair' ? imageGatewayConfig() : aiGatewayConfig()).apiKey,
      )
    );
  } catch {
    return false;
  }
}
export function translationFormats(tool: TranslationTool, source: string) {
  if (tool === 'video-translator') return ['srt', 'vtt', 'ass', 'mp4', 'txt', 'docx', 'pdf'];
  if (tool === 'image-translator') return ['png', 'jpg', 'webp', 'txt'];
  return [source];
}
