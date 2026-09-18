import {
  scanTextIsProtected,
  mergeDetectedCandidates,
} from '../../apps/worker/src/watermark-worker';
import { describe, it, expect } from 'vitest';
import {
  watermarkPatchSchema,
  watermarkRegionSchema,
  validateWatermarkSelection,
  type WatermarkData,
  type WatermarkCandidate,
} from '@filemorph/core/watermark';
import { jobSpecSchema, supportsInput, maxFileSize, fileTool } from '@filemorph/core/domain';
const uuid = '3ca17c66-f84a-4e41-88c5-ad09945d353c';
const region = {
  id: uuid,
  targetId: 'image',
  kind: 'rect',
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.4,
  strokes: [],
} as const;
describe('Watermark input boundaries', () => {
  it('rejects raw object locations and commands', () => {
    expect(() =>
      watermarkPatchSchema.parse({
        revision: 1,
        candidates: [],
        regions: [],
        locator: { part: 'word/document.xml' },
      }),
    ).toThrow();
    expect(() =>
      jobSpecSchema.parse({ tool: 'pdf-watermark-remover', options: { command: 'rm' } }),
    ).toThrow();
  });
  it('rejects out of bounds masks and non-finite strokes', () => {
    for (const patch of [
      { x: 0.9 },
      { width: 0 },
      { y: Infinity },
      { kind: 'brush', strokes: [] },
      { kind: 'brush', strokes: [{ erase: false, radius: 0.02, points: [[NaN, 0.1]] }] },
    ])
      expect(() => watermarkRegionSchema.parse({ ...region, ...patch })).toThrow();
  });
  it('rejects unknown objects, duplicate selections, and removal/repair conflicts', () => {
    const data: WatermarkData = {
      format: 'pdf',
      pages: [],
      targets: [
        { id: 'image', label: 'x', pages: [0], file: 'x.png', width: 10, height: 10, strict: true },
      ],
      candidates: [
        {
          id: 'image',
          label: 'x',
          reason: 'object',
          pages: [0],
          boxes: [],
          scope: 'page 1',
          group: 'x',
        },
      ],
      warnings: [],
      detected: [],
    };
    expect(validateWatermarkSelection(data, { candidates: ['missing'], regions: [] })).toBe(
      'INVALID_REGION',
    );
    expect(validateWatermarkSelection(data, { candidates: ['image', 'image'], regions: [] })).toBe(
      'INVALID_REGION',
    );
    expect(
      validateWatermarkSelection(data, {
        candidates: ['image'],
        regions: [watermarkRegionSchema.parse(region)],
      }),
    ).toBe('WATERMARK_SELECTION_CONFLICT');
  });
  it('limits new document uploads without exposing old or macro formats', () => {
    expect(supportsInput('ppt-watermark-remover', 'deck.pptx')).toBe(true);
    expect(supportsInput('word-watermark-remover', 'letter.docm')).toBe(false);
    expect(supportsInput('image-watermark-remover', 'animation.gif')).toBe(false);
    expect(maxFileSize('ppt-watermark-remover')).toBe(50 * 1024 ** 2);
    expect(fileTool('deck.pptx')).toBe('ppt-watermark-remover');
  });
});

it('protects scanned paragraphs even when rotated or containing watermark keywords', () => {
  const box = { x: 1, y: 2, width: 30, height: 10, angle: 30 };
  expect(scanTextIsProtected({ text: 'This draft contains important body text.', box })).toBe(true);
  expect(scanTextIsProtected({ text: 'Rotated body', box })).toBe(true);
  expect(scanTextIsProtected({ text: 'SAMPLE', box, review: ['uncertain'] })).toBe(true);
  expect(scanTextIsProtected({ text: 'SAMPLE', box })).toBe(false);
});

it('re-detects without losing checked watermarks or hand-painted masks and is idempotent', () => {
  const candidate = (id: string, label: string, x: number): WatermarkCandidate => ({
    id,
    label,
    reason: 'ocr',
    pages: [0],
    boxes: [],
    scope: 'Image',
    group: label,
    targetId: 'image',
    region: { ...watermarkRegionSchema.parse(region), id, x, y: 0.8, width: 0.15, height: 0.1 },
  });
  const first = candidate('old-logo', 'Logo', 0.1),
    second = candidate('old-account', 'Account', 0.5);
  const data: WatermarkData = {
    format: 'png',
    pages: [],
    targets: [],
    warnings: [],
    detected: ['image'],
    candidates: [first, second],
  };
  const selection = { candidates: ['old-logo'], regions: [watermarkRegionSchema.parse(region)] };
  const expanded = candidate('new-logo', 'Logo', 0.09);
  expanded.region!.width = 0.17;
  // Provider order changes; a brand-new detection must not become checked.
  const next = [
    candidate('new-account', 'Account', 0.5),
    expanded,
    candidate('new-extra', 'Extra', 0.75),
  ];
  const merged = mergeDetectedCandidates(data, selection, 'image', next);
  expect(merged.changed).toBe(true);
  expect(merged.selection).toEqual(selection);
  expect(merged.data.candidates.map((c) => c.id)).toEqual(['old-account', 'old-logo', 'new-extra']);
  expect(merged.data.candidates[1].region).toMatchObject({ id: 'old-logo', width: 0.17 });
  expect(data.candidates[0].region!.width).toBe(0.15);
  expect(mergeDetectedCandidates(merged.data, merged.selection, 'image', next).changed).toBe(false);
  const removed = mergeDetectedCandidates(merged.data, merged.selection, 'image', next.slice(0, 1));
  expect(removed.selection.candidates).toEqual([]);
  expect(removed.selection.regions).toEqual(selection.regions);
});
