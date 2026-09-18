import { z } from 'zod';

export const watermarkTools = [
  'image-watermark-remover',
  'pdf-watermark-remover',
  'word-watermark-remover',
  'ppt-watermark-remover',
] as const;
export type WatermarkTool = (typeof watermarkTools)[number];
export const isWatermarkTool = (tool: string): tool is WatermarkTool =>
  (watermarkTools as readonly string[]).includes(tool);
export const watermarkOptionsSchema = z.object({}).strict();
const unit = z.number().finite().min(0).max(1);
export const watermarkRegionSchema = z
  .object({
    id: z.string().uuid(),
    targetId: z.string().max(100),
    kind: z.enum(['rect', 'brush']),
    x: unit,
    y: unit,
    width: unit,
    height: unit,
    strokes: z
      .array(
        z
          .object({
            erase: z.boolean(),
            radius: unit.positive().max(0.2),
            points: z
              .array(z.tuple([unit, unit]))
              .min(1)
              .max(2000),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .refine(
    (r) =>
      r.width > 0 &&
      r.height > 0 &&
      r.x + r.width <= 1.000001 &&
      r.y + r.height <= 1.000001 &&
      (r.kind === 'rect' || r.strokes.some((s) => !s.erase)),
    'INVALID_REGION',
  );
export type WatermarkRegion = z.infer<typeof watermarkRegionSchema>;
export const watermarkSelectionSchema = z
  .object({
    candidates: z.array(z.string().max(100)).max(500),
    regions: z.array(watermarkRegionSchema).max(200),
  })
  .strict();
export type WatermarkSelection = z.infer<typeof watermarkSelectionSchema>;
export const watermarkPatchSchema = watermarkSelectionSchema.extend({
  revision: z.number().int().positive(),
});
export const watermarkRunSchema = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().positive(),
    kind: z.enum(['detect', 'preview', 'export']),
    page: z.number().int().min(0).max(99).optional(),
    targetId: z.string().max(100).optional(),
    format: z.enum(['png', 'jpg', 'webp', 'pdf', 'docx', 'pptx']).optional(),
  })
  .strict();
export type WatermarkRunOptions = z.infer<typeof watermarkRunSchema>;
export interface WatermarkPage {
  index: number;
  width: number;
  height: number;
  file: string;
}
export interface WatermarkCandidate {
  id: string;
  label: string;
  reason: 'object' | 'header' | 'master' | 'repeated' | 'rotated' | 'transparent' | 'ocr';
  pages: number[];
  boxes: { page: number; x: number; y: number; width: number; height: number }[];
  scope: string;
  group: string;
  targetId?: string;
  region?: WatermarkRegion;
  locator?: Record<string, unknown>;
}
export interface WatermarkTarget {
  id: string;
  label: string;
  pages: number[];
  width: number;
  height: number;
  file: string;
  strict: boolean;
  locator?: Record<string, unknown>;
}
export interface WatermarkData {
  format: string;
  pages: WatermarkPage[];
  candidates: WatermarkCandidate[];
  targets: WatermarkTarget[];
  detected: string[];
  warnings: string[];
}
export interface WatermarkView {
  revision: number;
  data: WatermarkData | null;
  selection: WatermarkSelection;
  runs: {
    id: string;
    revision: number;
    state: string;
    error: string | null;
    progress: number;
    options: WatermarkRunOptions;
    pages: number[];
  }[];
  capabilities: { ocr: boolean; repair: boolean };
}
export function validateWatermarkSelection(data: WatermarkData, selection: WatermarkSelection) {
  if (
    new Set(selection.candidates).size !== selection.candidates.length ||
    new Set(selection.regions.map((r) => r.id)).size !== selection.regions.length
  )
    return 'INVALID_REGION';
  if (selection.candidates.some((id) => !data.candidates.some((c) => c.id === id)))
    return 'INVALID_REGION';
  if (selection.regions.some((r) => !data.targets.some((t) => t.id === r.targetId)))
    return 'INVALID_REGION';
  const removed = new Set(
    selection.candidates.filter((id) => !data.candidates.find((c) => c.id === id)?.targetId),
  );
  if (
    selection.regions.some((r) => removed.has(r.targetId)) ||
    selection.candidates.some((id) => {
      const c = data.candidates.find((c) => c.id === id);
      return c?.targetId && removed.has(c.targetId);
    })
  )
    return 'WATERMARK_SELECTION_CONFLICT';
  return null;
}
