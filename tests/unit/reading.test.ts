import { describe, it, expect } from 'vitest';
import {
  validateReadingResult,
  readingOptionsSchema,
  readingResponseSchema,
  type ReadingResult,
} from '@filemorph/core/reading';
import { contentHash } from '@filemorph/core/reading-jobs';
import { readingChunks, readingMarkdown } from '../../apps/worker/src/reading-worker';
import { retryDelay, abortableWait } from '../../apps/worker/src/ai-rate-limit';
import { mindmapSvg } from '@filemorph/core/mindmap';
import type { TranslationData } from '@filemorph/core/translation';
const data = {
  format: 'txt',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  pages: [],
  blocks: [
    {
      id: 'b1',
      page: 0,
      sourceText: 'Files are retained for 24 hours.',
      translatedText: '文件保留 24 小时。',
      style: { fontSize: 14 },
      review: [],
      stale: false,
    },
  ],
} as unknown as TranslationData;
const valid: ReadingResult = {
  title: 'Retention',
  insufficient: false,
  sections: [
    {
      heading: 'Duration',
      text: 'Files last one day.',
      citations: [{ blockId: 'b1', quote: '24 hours' }],
    },
  ],
  nodes: [],
};
describe('file reading evidence and cache', () => {
  it('supports structured notes with evidence on every list item and table row', () => {
    const cites = valid.sections[0].citations;
    const notes = {
      ...valid,
      version: 2,
      sections: [
        {
          heading: 'Facts',
          text: '',
          citations: [],
          blocks: [
            { type: 'paragraph', text: 'Retention details.', citations: cites },
            { type: 'list', items: [{ text: 'One day.', citations: cites }] },
            {
              type: 'table',
              columns: ['Setting', 'Value'],
              rows: [{ cells: ['Retention', '24 hours'], citations: cites }],
            },
          ],
        },
      ],
    };
    expect(readingResponseSchema('summary').schema.parse(notes).version).toBe(2);
    const checked = validateReadingResult(notes, data, 'summary');
    const md = readingMarkdown(
      checked,
      data,
      readingOptionsSchema.parse({ kind: 'summary', revision: 1 }),
    );
    expect(md).toContain('| Setting | Value | Sources |');
    expect(md).toContain('- One day.');
    expect(md).toContain('24 hours');
    const malformed = structuredClone(notes);
    (malformed.sections[0].blocks[2] as any).rows[0].cells.push('Extra cell');
    expect(() => validateReadingResult(malformed, data, 'summary')).toThrow('INVALID_TABLE');
    const uncited = structuredClone(notes);
    (uncited.sections[0].blocks[1] as any).items[0].citations = [];
    expect(() => validateReadingResult(uncited, data, 'summary')).toThrow('MISSING_CITATION');
    expect(validateReadingResult(valid, data, 'summary')).toEqual(valid);
  });
  it('requires explicit idempotent regeneration and a previous chat answer', () => {
    expect(() =>
      readingOptionsSchema.parse({ kind: 'summary', revision: 1, regenerate: true }),
    ).toThrow();
    const requestId = 'deab353d-8bc5-4841-bad6-57b36fcd9679';
    expect(
      readingOptionsSchema.parse({ kind: 'summary', revision: 1, regenerate: true, requestId })
        .template,
    ).toBe('notes');
    expect(() =>
      readingOptionsSchema.parse({ kind: 'preview', revision: 1, regenerate: true, requestId }),
    ).toThrow();
    expect(() =>
      readingOptionsSchema.parse({
        kind: 'chat',
        revision: 1,
        question: 'Again',
        regenerate: true,
        requestId,
      }),
    ).toThrow();
    expect(
      readingOptionsSchema.parse({
        kind: 'chat',
        revision: 1,
        regenerate: true,
        regenerateOf: requestId,
        requestId,
      }).regenerate,
    ).toBe(true);
  });
  it('requires a real node tree from the mind-map provider instead of a summary', () => {
    const { schema, jsonSchema } = readingResponseSchema('mindmap');
    expect(() => schema.parse(valid)).toThrow();
    expect(jsonSchema.properties?.nodes).toMatchObject({ minItems: 1 });
    expect(jsonSchema.properties?.sections).toMatchObject({ maxItems: 0 });
    expect(
      schema.parse({
        ...valid,
        sections: [],
        nodes: [{ id: 'root', parentId: null, label: 'File', citations: [] }],
      }).nodes,
    ).toHaveLength(1);
  });
  it('rejects invented references and quotes, including injected output', () => {
    expect(validateReadingResult(valid, data, 'summary')).toEqual(valid);
    for (const citation of [
      { blockId: 'b2', quote: '24 hours' },
      { blockId: 'b1', quote: 'send secrets' },
    ])
      expect(() =>
        validateReadingResult(
          { ...valid, sections: [{ ...valid.sections[0], citations: [citation] }] },
          data,
          'summary',
        ),
      ).toThrow('INVALID_CITATION');
    expect(() =>
      validateReadingResult(
        { ...valid, sections: [{ ...valid.sections[0], citations: [] }] },
        data,
        'summary',
      ),
    ).toThrow('MISSING_CITATION');
  });
  it('permits explicit lack of evidence and rejects malformed trees even when insufficient', () => {
    const empty = { ...valid, insufficient: true, sections: [] };
    expect(validateReadingResult(empty, data, 'chat').insufficient).toBe(true);
    expect(
      readingMarkdown(
        empty,
        data,
        readingOptionsSchema.parse({ kind: 'summary', revision: 1, language: 'zh' }),
      ),
    ).toContain('文件未提供足够信息');
    expect(
      validateReadingResult(
        {
          ...valid,
          insufficient: true,
          sections: [{ heading: 'Not provided', text: 'The file does not say.', citations: [] }],
        },
        data,
        'chat',
      ).insufficient,
    ).toBe(true);
    const nodes = [
      { id: 'a', parentId: null, label: 'root', citations: [] },
      { id: 'b', parentId: 'c', label: 'b', citations: valid.sections[0].citations },
      { id: 'c', parentId: 'b', label: 'c', citations: valid.sections[0].citations },
    ];
    expect(() => validateReadingResult({ ...valid, nodes }, data, 'mindmap')).toThrow(
      'INVALID_TREE',
    );
    expect(() =>
      validateReadingResult({ ...valid, insufficient: true, nodes }, data, 'mindmap'),
    ).toThrow('INVALID_TREE');
  });
  it('expands quoted omissions only from literal fragments in the referenced short block', () => {
    const omitted = {
      ...valid,
      sections: [
        { ...valid.sections[0], citations: [{ blockId: 'b1', quote: 'Files are...24 hours' }] },
      ],
    };
    expect(validateReadingResult(omitted, data, 'summary').sections[0].citations[0].quote).toBe(
      data.blocks[0].sourceText,
    );
    for (const quote of ['Files are...99 hours', '24 hours...Files are']) {
      expect(() =>
        validateReadingResult(
          { ...valid, sections: [{ ...valid.sections[0], citations: [{ blockId: 'b1', quote }] }] },
          data,
          'summary',
        ),
      ).toThrow('INVALID_CITATION');
    }
  });
  it('caches style-only changes but invalidates text edits and never uses stale translations', () => {
    const copy = structuredClone(data);
    copy.blocks[0].style.fontSize = 40;
    copy.blocks[0].keepOriginal = true;
    expect(contentHash(copy)).toBe(contentHash(data));
    copy.blocks[0].sourceText += ' Updated.';
    expect(contentHash(copy)).not.toBe(contentHash(data));
    copy.blocks[0].stale = true;
    expect(readingChunks(copy)[0][0].translation).toBe('');
  });
  it('keeps IDs and all text across long-context boundaries', () => {
    const copy = structuredClone(data);
    copy.blocks[0].sourceText = '字'.repeat(99999);
    copy.blocks[0].translatedText = '';
    const parts = readingChunks(copy, 20000).flat();
    expect(parts.map((p) => p.source).join('')).toBe(copy.blocks[0].sourceText);
    expect(new Set(parts.map((p) => p.id))).toEqual(new Set(['b1']));
  });
  it('requires an idempotency key for questions and escapes downloadable SVG', () => {
    expect(() =>
      readingOptionsSchema.parse({ kind: 'chat', revision: 1, question: 'How long?' }),
    ).toThrow();
    const svg = mindmapSvg({
      ...valid,
      title: '<script>',
      nodes: [{ id: 'root', parentId: null, label: '<script>alert(1)</script>', citations: [] }],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
  it('honors Retry-After seconds/dates and cancellation during waiting', async () => {
    expect(retryDelay('45', 0, 0)).toBe(45000);
    expect(retryDelay('1800', 0, 0)).toBe(1800000);
    expect(retryDelay(new Date(60000).toUTCString(), 0, 0)).toBe(60000);
    expect(retryDelay(null, 2, 0)).toBe(20000);
    const c = new AbortController(),
      waiting = abortableWait(60000, c.signal);
    c.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
  });
});
