'use client';
import type { TranslationBlock, TranslationData } from '@filemorph/core/translation';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';

// Old tasks keep their persisted IDs. Group adjacent lines only for comfortable reading.
export function readingGroups(blocks: TranslationBlock[], legacy: boolean) {
  const groups: TranslationBlock[][] = [];
  for (const b of blocks) {
    let group: TranslationBlock[] | undefined;
    if (
      legacy &&
      b.box &&
      b.kind === 'text' &&
      !/^\s*(?:[A-H][.、)]|\d+[.、)]|[一二三四五六七八九十]+、)/.test(b.sourceText)
    ) {
      group = groups
        .slice(-12)
        .reverse()
        .find((g) => {
          const last = g.at(-1)!,
            a = last.box,
            c = b.box!;
          return (
            !!a &&
            last.kind === 'text' &&
            last.page === b.page &&
            Math.abs(a.x - c.x) < b.style.fontSize * 1.5 &&
            a.width > b.style.fontSize * 12 &&
            c.y - a.y - a.height >= -2 &&
            c.y - a.y - a.height < b.style.fontSize
          );
        });
    }
    if (group) group.push(b);
    else groups.push([b]);
  }
  return groups;
}
export function TranslationText({
  data,
  blocks,
  selected,
  mode,
  onSelect,
  onEdit,
}: {
  data: TranslationData;
  blocks: TranslationBlock[];
  selected: string;
  mode: 'original' | 'translated' | 'bilingual';
  onSelect: (b: TranslationBlock) => void;
  onEdit: (b: TranslationBlock) => void;
}) {
  const copy = useTranslations('translation');

  const groups = readingGroups(blocks, data.format === 'pdf' && (data.layoutVersion || 1) < 2);
  return (
    <div className="translation-reading">
      {!groups.length && <p>{copy('no_matching_content_57d9756')}</p>}
      {groups.map((group) => {
        const first = group[0],
          chosen = group.find((b) => b.id === selected) || first;
        return (
          <article
            key={first.id}
            className={group.some((b) => b.id === selected) ? 'selected' : ''}
          >
            <div className="reading-block-meta">
              <span>
                {first.startMs !== undefined
                  ? `${Math.floor(first.startMs / 60000)}:${String(Math.floor(first.startMs / 1000) % 60).padStart(2, '0')}`
                  : data.pages[first.page]?.title ||
                    `${copy('paragraph_05058e0')} ${data.blocks.indexOf(first) + 1}`}
              </span>
              {group.some((b) => b.keepOriginal) && (
                <span>{copy('original_appearance_preserved_72fe34a')}</span>
              )}
              <button aria-label={copy('edit_paragraph_66d7592')} onClick={() => onEdit(chosen)}>
                <Pencil size={14} />
              </button>
            </div>
            <div className={`translation-reading-columns ${mode === 'bilingual' ? 'two' : ''}`}>
              {(['original', 'translated'] as const)
                .filter((which) => mode === 'bilingual' || mode === which)
                .map((which) => (
                  <p
                    key={which}
                    className={first.kind === 'heading' ? 'reading-heading' : undefined}
                    dir={
                      (which === 'translated' ? data.targetLanguage : data.sourceLanguage) === 'ar'
                        ? 'rtl'
                        : 'ltr'
                    }
                  >
                    {mode === 'bilingual' && (
                      <span className="reading-language-label">
                        {which === 'original'
                          ? copy('original_c0a8060')
                          : copy('translation_ac26a7a')}
                      </span>
                    )}
                    {group.map((b, i) => (
                      <span
                        key={b.id}
                        data-block-id={b.id}
                        className={b.id === selected ? 'reading-selected-text' : ''}
                        tabIndex={0}
                        role="button"
                        onClick={() => onSelect(b)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSelect(b);
                        }}
                      >
                        {which === 'original'
                          ? b.sourceText
                          : b.translatedText ||
                            (b.keepOriginal
                              ? b.sourceText
                              : copy('waiting_for_translation_adbd979'))}
                        {i < group.length - 1 ? ' ' : ''}
                      </span>
                    ))}
                  </p>
                ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}
