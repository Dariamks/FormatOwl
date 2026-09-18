import { z } from 'zod';
import { translationLanguages, type TranslationData, type TranslationBox } from './translation';

export const readingOptionsSchema = z
  .object({
    kind: z.enum(['summary', 'mindmap', 'chat', 'preview']),
    revision: z.number().int().positive(),
    language: z.enum(translationLanguages).default('zh'),
    detail: z.enum(['brief', 'detailed', 'comprehensive']).default('brief'),
    page: z.number().int().min(0).max(99).default(0),
    question: z.string().trim().max(2000).default(''),
    requestId: z.string().uuid().optional(),
    template: z
      .enum(['notes', 'takeaways', 'chapters', 'summary', 'meeting', 'analysis', 'review'])
      .default('notes'),
    regenerate: z.boolean().default(false),
    regenerateOf: z.string().uuid().optional(),
    optimizeLayout: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.optimizeLayout && v.kind !== 'preview')
      ctx.addIssue({ code: 'custom', message: 'Layout optimization requires preview' });
    if (v.kind === 'chat' && ((!v.question && !v.regenerateOf) || !v.requestId))
      ctx.addIssue({ code: 'custom', message: 'Question and requestId required' });
    if (v.regenerate && (!v.requestId || v.kind === 'preview'))
      ctx.addIssue({ code: 'custom', message: 'Regeneration requires requestId and an AI task' });
    if (v.regenerateOf && (v.kind !== 'chat' || !v.regenerate))
      ctx.addIssue({ code: 'custom', message: 'Only chat regeneration accepts regenerateOf' });
    if (v.kind === 'chat' && v.regenerate && !v.regenerateOf)
      ctx.addIssue({ code: 'custom', message: 'Chat regeneration requires a previous answer' });
    if (v.kind !== 'chat' && v.question)
      ctx.addIssue({ code: 'custom', message: 'Unexpected question' });
  });
export const readingResultVersion = 2;
export type ReadingOptions = z.infer<typeof readingOptionsSchema> & {
  resultVersion?: number;
  turnId?: string;
};
export const citationSchema = z
  .object({ blockId: z.string().min(1).max(100), quote: z.string().min(1).max(240) })
  .strict();
export const readingContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('paragraph'),
      text: z.string().min(1).max(6000),
      citations: z.array(citationSchema).max(12),
    })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      items: z
        .array(
          z
            .object({
              text: z.string().min(1).max(2000),
              citations: z.array(citationSchema).max(12),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      columns: z.array(z.string().min(1).max(120)).min(2).max(6),
      rows: z
        .array(
          z
            .object({
              cells: z.array(z.string().max(2000)).min(2).max(6),
              citations: z.array(citationSchema).max(12),
            })
            .strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
]);
export const readingResultSchema = z
  .object({
    version: z.literal(2).optional(),
    title: z.string().min(1).max(200),
    insufficient: z.boolean(),
    sections: z
      .array(
        z
          .object({
            heading: z.string().max(200),
            text: z.string().max(6000),
            blocks: z.array(readingContentSchema).max(12).optional(),
            citations: z.array(citationSchema).max(12),
          })
          .strict(),
      )
      .max(30),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            parentId: z.string().nullable(),
            label: z.string().min(1).max(200),
            citations: z.array(citationSchema).max(5),
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export type ReadingResult = z.infer<typeof readingResultSchema>;
export function readingResponseSchema(kind: string) {
  const schema =
    kind === 'mindmap'
      ? readingResultSchema.extend({
          sections: readingResultSchema.shape.sections.max(0),
          nodes: readingResultSchema.shape.nodes.min(1),
        })
      : kind === 'summary'
        ? readingResultSchema.extend({
            version: z.literal(2),
            sections: z
              .array(
                z
                  .object({
                    heading: z.string().max(200),
                    text: z.literal(''),
                    citations: z.array(citationSchema).max(0),
                    blocks: z.array(readingContentSchema).min(1).max(12),
                  })
                  .strict(),
              )
              .max(30),
            nodes: readingResultSchema.shape.nodes.max(0),
          })
        : readingResultSchema.extend({ nodes: readingResultSchema.shape.nodes.max(0) });
  return { schema, jsonSchema: z.toJSONSchema(schema) };
}
export interface PreviewResult {
  overflow: string[];
  regions: { id: string; memberIds: string[]; box: TranslationBox }[];
  format: 'png' | 'pdf';
  pages?: {
    index: number;
    sourcePage: number;
    width: number;
    height: number;
    regions: { id: string; memberIds: string[]; box: TranslationBox }[];
  }[];
  review?: string[];
}
export interface ReadingActivity {
  citationTimes?: Record<string, number>;
  id: string;
  kind: ReadingOptions['kind'];
  revision: number;
  contentHash: string;
  options: ReadingOptions;
  state: string;
  error: string | null;
  result: ReadingResult | PreviewResult | null;
  formats: string[];
  completedUnits: number;
  totalUnits: number;
  waitingUntil: string | null;
  createdAt: string;
}
export function readingBlocks(data: TranslationData) {
  return data.blocks
    .filter((b) => !b.hidden && b.sourceText.trim())
    .map((b) => ({
      id: b.id,
      page: b.page,
      startMs: b.startMs,
      ...(b.speaker ? { speaker: b.speaker } : {}),
      source: b.sourceText,
      translation: !b.stale ? b.translatedText : '',
    }));
}
export function validateReadingResult(
  raw: unknown,
  data: TranslationData,
  kind: string,
): ReadingResult {
  const result = readingResultSchema.parse(raw);
  const blocks = new Map(readingBlocks(data).map((b) => [b.id, b]));
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const evidence = result.sections.flatMap((s) => {
    if (!s.text.trim() && !s.blocks?.length) throw new Error('EMPTY_SECTION');
    return [
      ...(s.text.trim() ? [s] : []),
      ...(s.blocks || []).flatMap<{ citations: z.infer<typeof citationSchema>[] }>((b) => {
        if (b.type === 'table') {
          if (b.rows.some((r) => r.cells.length !== b.columns.length))
            throw new Error('INVALID_TABLE');
          return b.rows;
        }
        return b.type === 'list' ? b.items : [b];
      }),
    ];
  });
  for (const item of [...evidence, ...result.nodes]) {
    for (const c of item.citations) {
      const b = blocks.get(c.blockId),
        quote = normalize(c.quote);
      // Expand an omitted middle only when every literal fragment occurs, in order,
      // in this same short block. The published quote is the actual complete source,
      // never a model paraphrase or a guessed reference to another block.
      if (
        b &&
        ![b.source, b.translation].some((t) => normalize(t).includes(quote)) &&
        /\.{3,}|…/.test(c.quote)
      ) {
        const fragments = c.quote
          .split(/\.{3,}|…+/)
          .map(normalize)
          .filter(Boolean);
        const exact = [b.source, b.translation].find((text) => {
          if (text.length > 240 || fragments.length < 2 || fragments.some((f) => f.length < 3))
            return false;
          const normalized = normalize(text);
          let end = 0;
          for (const fragment of fragments) {
            const at = normalized.indexOf(fragment, end);
            if (at < 0) return false;
            end = at + fragment.length;
          }
          return true;
        });
        if (exact) c.quote = exact;
      }
      if (
        !b ||
        !quote ||
        ![b.source, b.translation].some((t) => normalize(t).includes(normalize(c.quote)))
      )
        throw new Error('INVALID_CITATION');
    }
  }
  if (!result.insufficient && evidence.some((s) => !s.citations.length))
    throw new Error('MISSING_CITATION');
  if (kind !== 'mindmap' && !result.sections.length && !result.insufficient)
    throw new Error('EMPTY_READING');
  if (result.nodes.length || (kind === 'mindmap' && !result.insufficient)) {
    const nodes = new Map(result.nodes.map((n) => [n.id, n]));
    if (
      !nodes.size ||
      nodes.size !== result.nodes.length ||
      result.nodes.filter((n) => n.parentId === null).length !== 1
    )
      throw new Error('INVALID_TREE');
    for (const n of result.nodes) {
      const seen = new Set([n.id]);
      let p = n.parentId;
      while (p) {
        if (seen.has(p) || !nodes.has(p) || seen.size > 6) throw new Error('INVALID_TREE');
        seen.add(p);
        p = nodes.get(p)!.parentId;
      }
    }
    // Structural branches inherit verified evidence from their descendants. Leaf claims
    // still require their own citations; no references or quotes are invented here.
    const evidence = (id: string): z.infer<typeof citationSchema>[] => {
      const node = nodes.get(id)!;
      if (node.citations.length) return node.citations;
      const citations = result.nodes
        .filter((n) => n.parentId === id)
        .flatMap((n) => evidence(n.id));
      node.citations = [
        ...new Map(citations.map((c) => [`${c.blockId}:${c.quote}`, c])).values(),
      ].slice(0, 5);
      if (node.parentId && !node.citations.length) throw new Error('MISSING_CITATION');
      return node.citations;
    };
    for (const n of result.nodes) evidence(n.id);
  }
  return result;
}
