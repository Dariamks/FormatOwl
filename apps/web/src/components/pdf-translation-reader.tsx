'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLanguageName } from '@/i18n/language-name';
import { useTranslations } from 'next-intl';

import { errorMessage, request } from '@/lib/client-api';
import { type TranslationView } from '@filemorph/core/translation';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Languages,
  Minus,
  Plus,
} from 'lucide-react';
import { useLocale } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ReflowPdfReader } from './reflow-pdf-reader';
import { TranslationRendered } from './translation-rendered';

type Side = 'original' | 'translated';
export type PdfReaderProps = {
  id: string;
  view: TranslationView;
  mode: 'original' | 'translated' | 'bilingual';
  onModeChange: (mode: 'translated' | 'bilingual') => void;
  readerView: 'layout' | 'text';
  page: number;
  onPageChange: (page: number) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  enabled: boolean;
  selected: string;
  onSelect: (id: string) => void;
  onIssues: (ids: string[]) => void;
  onDownload: () => void;
  hasPanel: boolean;
};
type Props = PdfReaderProps;

function DocumentPage({ side, index, ...props }: Props & { side: Side; index: number }) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale();
  const element = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(index === props.page);
  const [original, setOriginal] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const page = props.view.data!.pages[index];
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      root: element.current?.closest('.pdf-document-scroll'),
      rootMargin: '600px 0px',
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!nearby || side !== 'original' || original || props.readerView !== 'layout') return;
    let live = true;
    setError('');
    void request<{ url: string }>(`jobs/${props.id}/translation/media?page=${index}&kind=original`)
      .then((result) => {
        if (live) setOriginal(result.url);
      })
      .catch((error) => {
        if (live) setError(errorMessage(error, translateError));
      });
    return () => {
      live = false;
    };
  }, [nearby, side, original, props.id, index, props.readerView, locale, retry]);
  const blocks = props.view.data!.blocks.filter((block) => block.page === index && !block.hidden);
  return (
    <div className="pdf-document-page" data-page-index={index} ref={element}>
      <div
        className={`pdf-page-paper ${props.readerView === 'text' ? 'is-text' : ''}`}
        style={{ aspectRatio: `${page.width} / ${page.height}` }}
      >
        {props.readerView === 'text' ? (
          <div
            className="pdf-page-text"
            dir={
              side === 'original'
                ? 'auto'
                : props.view.data!.targetLanguage === 'ar'
                  ? 'rtl'
                  : 'ltr'
            }
          >
            {blocks.map((block) => (
              <button
                key={block.id}
                data-block-id={block.id}
                dir={side === 'original' || block.keepOriginal ? 'auto' : undefined}
                className={`${block.kind === 'heading' ? 'is-heading' : ''} ${props.selected === block.id ? 'selected' : ''}`}
                onClick={() => props.onSelect(block.id)}
              >
                {side === 'original' || block.keepOriginal
                  ? block.sourceText
                  : block.translatedText || copy('translating_ae47b9e')}
              </button>
            ))}
          </div>
        ) : side === 'original' ? (
          original ? (
            <img
              className="pdf-original-page"
              src={original}
              alt={copy('originalPageNumber', { number: index + 1 })}
              draggable={false}
            />
          ) : (
            <div className="pdf-page-placeholder" role="status">
              {error || copy('loading_original_bad0974')}
              {error && (
                <button onClick={() => setRetry((value) => value + 1)}>
                  {copy('retry_9f5cd8a')}
                </button>
              )}
            </div>
          )
        ) : nearby ? (
          <TranslationRendered
            id={props.id}
            view={props.view}
            page={index}
            zoom={1}
            enabled={props.enabled}
            selected={props.selected}
            onSelect={props.onSelect}
            onIssues={props.onIssues}
            quiet
          />
        ) : null}
      </div>
      <div className="pdf-page-number">
        {index + 1} / {props.view.data!.pages.length}
      </div>
    </div>
  );
}

export function PdfTranslationReader(props: Props) {
  return (props.view.data?.layoutVersion || 0) >= 3 ? (
    <ReflowPdfReader {...props} />
  ) : (
    <LegacyPdfReader {...props} />
  );
}

function LegacyPdfReader(props: Props) {
  const languageName = useLanguageName();

  const copy = useTranslations('translation');

  const panes = useRef<Partial<Record<Side, HTMLDivElement | null>>>({});
  const programmatic = useRef(new Map<HTMLElement, number>());
  const reportedPage = useRef<number | null>(null);
  const progress = useRef(0);
  const [mobileSide, setMobileSide] = useState<Side>('translated');
  const pages = props.view.data!.pages;
  const [currentPages, setCurrentPages] = useState({
    original: props.page,
    translated: props.page,
  });
  const dual = props.mode === 'bilingual' && !props.hasPanel;
  const sides: Side[] = dual ? ['original', 'translated'] : ['translated'];

  function trackPage(element: HTMLElement, side: Side) {
    const children = [...element.querySelectorAll<HTMLElement>('[data-page-index]')];
    const top = element.getBoundingClientRect().top + Math.min(100, element.clientHeight / 4);
    const current = children.find((child) => child.getBoundingClientRect().bottom > top);
    const index = Number(current?.dataset.pageIndex || 0);
    setCurrentPages((values) => (values[side] === index ? values : { ...values, [side]: index }));
    return index;
  }
  function syncScroll(element: HTMLDivElement, side: Side) {
    const index = trackPage(element, side);
    const expected = programmatic.current.get(element);
    if (expected !== undefined) {
      programmatic.current.delete(element);
      if (Math.abs(element.scrollTop - expected) < 2) return;
    }
    const max = element.scrollHeight - element.clientHeight;
    progress.current = max > 0 ? element.scrollTop / max : 0;
    reportedPage.current = index;
    props.onPageChange(index);
    const other = panes.current[side === 'original' ? 'translated' : 'original'];
    if (other && other.clientHeight > 0) {
      const target = progress.current * (other.scrollHeight - other.clientHeight);
      programmatic.current.set(other, target);
      other.scrollTop = target;
    }
  }
  function goTo(index: number, side: Side) {
    const element = panes.current[side];
    const target = element?.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (!element || !target) return;
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    syncScroll(element, side);
  }
  useEffect(() => {
    if (reportedPage.current === props.page) return;
    reportedPage.current = props.page;
    goTo(props.page, dual ? 'original' : 'translated');
  }, [props.page]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const side of sides) {
        const element = panes.current[side];
        if (!element || !element.clientHeight) continue;
        const top = progress.current * (element.scrollHeight - element.clientHeight);
        programmatic.current.set(element, top);
        element.scrollTop = top;
        trackPage(element, side);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.zoom, dual, props.readerView, mobileSide]);

  const modes = (
    <div className="pdf-mode-switch" role="group" aria-label={copy('document_display_0f861ca')}>
      <button
        className={props.mode === 'translated' ? 'active' : ''}
        aria-pressed={props.mode === 'translated'}
        onClick={() => props.onModeChange('translated')}
      >
        <FileText size={16} />
        {copy('translated_only_6510c06')}
      </button>
      <button
        className={props.mode === 'bilingual' ? 'active' : ''}
        aria-pressed={props.mode === 'bilingual'}
        onClick={() => props.onModeChange('bilingual')}
      >
        <BookOpen size={16} />
        {copy('bilingual_7870ebe')}
      </button>
    </div>
  );
  const language = (
    <span className="pdf-language reader-target-language">
      <Languages size={17} />
      {languageName(props.view.data!.targetLanguage)}
    </span>
  );
  return (
    <div
      className={`pdf-reader reader-file-column ${dual ? 'is-bilingual' : ''}`}
      data-mobile-side={mobileSide}
    >
      {dual && (
        <div
          className="pdf-mobile-tabs"
          role="tablist"
          aria-label={copy('bilingual_document_e703fb7')}
        >
          {(['original', 'translated'] as const).map((side) => (
            <button
              key={side}
              role="tab"
              aria-selected={mobileSide === side}
              onClick={() => setMobileSide(side)}
            >
              {side === 'original' ? copy('original_c0a8060') : copy('translation_ac26a7a')}
            </button>
          ))}
        </div>
      )}
      {sides.map((side) => (
        <section
          className={`pdf-reader-pane pdf-pane-${side}`}
          key={side}
          aria-label={
            side === 'original'
              ? copy('original_document_2965922')
              : copy('translated_document_98b003d')
          }
        >
          <header className="pdf-pane-header">
            {side === 'original' || !dual ? modes : language}
            {!dual && language}
            {side === 'translated' && (
              <button
                className="pdf-download"
                aria-label={copy('download_file_774025d')}
                onClick={props.onDownload}
              >
                <Download size={18} />
              </button>
            )}
          </header>
          <div className="pdf-pane-body">
            <div
              className="pdf-document-scroll"
              ref={(element) => {
                panes.current[side] = element;
              }}
              tabIndex={0}
              aria-label={
                side === 'original'
                  ? copy('scroll_original_92e387c')
                  : copy('scroll_translation_2c23caa')
              }
              onScroll={(event) => syncScroll(event.currentTarget, side)}
            >
              <div className="pdf-page-stack" style={{ width: `${props.zoom * 100}%` }}>
                {pages.map((page, index) => (
                  <DocumentPage {...props} key={page.index} side={side} index={index} />
                ))}
              </div>
            </div>
            <div
              className="pdf-floating-controls"
              role="group"
              aria-label={
                side === 'original'
                  ? copy('original_page_and_zoom_dce7ea0')
                  : copy('translation_page_and_zoom_2f7856c')
              }
            >
              <button
                aria-label={copy('previous_page_81f5471')}
                disabled={currentPages[side] === 0}
                onClick={() => goTo(currentPages[side] - 1, side)}
              >
                <ChevronLeft size={18} />
              </button>
              <label className="pdf-page-input">
                <input
                  aria-label={copy('page_number_8b08ca4')}
                  type="number"
                  min={1}
                  max={pages.length}
                  value={currentPages[side] + 1}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (value >= 1 && value <= pages.length) goTo(value - 1, side);
                  }}
                />
                <span>/ {pages.length}</span>
              </label>
              <span className="pdf-control-divider" />
              <button
                aria-label={copy('zoom_out_a4ae4b2')}
                disabled={props.zoom <= 0.5}
                onClick={() => props.onZoomChange(Math.max(0.5, props.zoom - 0.25))}
              >
                <Minus size={18} />
              </button>
              <button
                className="pdf-zoom-value"
                aria-label={copy('reset_zoom_e573797')}
                onClick={() => props.onZoomChange(1)}
              >
                {Math.round(props.zoom * 100)}%
              </button>
              <button
                aria-label={copy('zoom_in_4fc05f2')}
                disabled={props.zoom >= 3}
                onClick={() => props.onZoomChange(Math.min(3, props.zoom + 0.25))}
              >
                <Plus size={18} />
              </button>
              <button
                aria-label={copy('next_page_4bfc194')}
                disabled={currentPages[side] === pages.length - 1}
                onClick={() => goTo(currentPages[side] + 1, side)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
