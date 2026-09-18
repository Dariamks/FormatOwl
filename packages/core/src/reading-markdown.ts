import type { ReadingResult, ReadingOptions } from './reading';
import type { TranslationData } from './translation';

export function readingMarkdown(
  result: ReadingResult,
  data: TranslationData,
  options: ReadingOptions,
  citationTimes: Record<string, number> = {},
) {
  const escape = (text: string) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_{}\[\]|])/g, '\\$1');
  const label = (id: string) => {
    const b = data.blocks.find((b) => b.id === id);
    const time = citationTimes[id];
    if (time !== undefined)
      return `${Math.floor(time / 60000)}:${String(Math.floor(time / 1000) % 60).padStart(2, '0')}`;
    if (!b) return `#${id}`;
    return b.startMs !== undefined
      ? `${Math.floor(b.startMs / 60000)}:${String(Math.floor(b.startMs / 1000) % 60).padStart(2, '0')}`
      : ['docx', 'txt'].includes(data.format)
        ? `¶ ${data.blocks.indexOf(b) + 1}`
        : `p. ${b.page + 1}`;
  };
  const cites = (cs: ReadingResult['sections'][number]['citations']) =>
    cs.map((c) => `> ${label(c.blockId)} — ${escape(c.quote.replace(/\n/g, ' '))}`).join('\n');
  const sections = result.sections
    .map(
      (s) =>
        `## ${escape(s.heading)}\n\n${s.text ? `${escape(s.text)}\n\n${cites(s.citations)}\n\n` : ''}${(
          s.blocks || []
        )
          .map((b) => {
            if (b.type === 'paragraph') return `${escape(b.text)}\n\n${cites(b.citations)}`;
            if (b.type === 'list')
              return b.items
                .map(
                  (item) =>
                    `- ${escape(item.text)}\n${cites(item.citations)
                      .split('\n')
                      .map((line) => `  ${line}`)
                      .join('\n')}`,
                )
                .join('\n');
            const cell = (value: string) => escape(value).replace(/\r?\n/g, ' ');
            return `| ${b.columns.map(cell).join(' | ')} | Sources |\n| ${[...b.columns, 'Sources'].map(() => '---').join(' | ')} |\n${b.rows.map((row) => `| ${row.cells.map(cell).join(' | ')} | ${row.citations.map((c) => `${label(c.blockId)} — ${cell(c.quote)}`).join('; ')} |`).join('\n')}`;
          })
          .join('\n\n')}`,
    )
    .join('\n\n');
  const tree = (parent: string | null, depth = 0): string =>
    result.nodes
      .filter((n) => n.parentId === parent)
      .map(
        (n) =>
          `${'  '.repeat(depth)}- ${escape(n.label)}${n.citations.length ? ` (${n.citations.map((c) => label(c.blockId)).join(', ')})` : ''}\n${tree(n.id, depth + 1)}`,
      )
      .join('');
  const insufficientText = {
    zh: '文件未提供足够信息，无法据此完整回答。',
    en: 'The file does not provide enough evidence for a complete answer.',
    ja: 'ファイルには、完全な回答に必要な情報がありません。',
    ko: '파일에 완전한 답변에 필요한 정보가 충분하지 않습니다.',
    fr: 'Le fichier ne fournit pas assez d’informations pour une réponse complète.',
    de: 'Die Datei enthält nicht genügend Informationen für eine vollständige Antwort.',
    es: 'El archivo no aporta información suficiente para una respuesta completa.',
    pt: 'O arquivo não fornece informações suficientes para uma resposta completa.',
    it: 'Il file non contiene informazioni sufficienti per una risposta completa.',
    ru: 'В файле недостаточно информации для полного ответа.',
    ar: 'لا يوفر الملف معلومات كافية لتقديم إجابة كاملة.',
  }[options.language];
  return `# ${escape(result.title)}\n\n${options.question ? `${escape(options.question)}\n\n` : ''}${result.insufficient ? `${insufficientText}\n\n` : ''}${sections}${tree(null)}`;
}
