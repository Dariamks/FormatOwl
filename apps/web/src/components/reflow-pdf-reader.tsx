'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLanguageName } from '@/i18n/language-name';
import { useTranslations } from 'next-intl';

import { errorMessage, request } from '@/lib/client-api';
import type { PreviewResult, ReadingActivity } from '@filemorph/core/reading';
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
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import type { PdfReaderProps } from './pdf-translation-reader';

type Side = 'original' | 'translated';
type RenderPage = NonNullable<PreviewResult['pages']>[number];
type Anchor = { id: string; fraction: number };

function anchorAt(element: HTMLElement): Anchor | null {
  const top = element.getBoundingClientRect().top + Math.min(100, element.clientHeight / 4);
  const items = [...element.querySelectorAll<HTMLElement>('[data-block-id]')].filter(
    (n) => n.dataset.syncAlias !== 'true',
  );
  const visible = items
    .filter((n) => n.getBoundingClientRect().bottom > top)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const item = visible[0] || items.at(-1);
  if (!item) return null;
  const id = item.dataset.blockId!;
  const fragments = items.filter((n) => n.dataset.blockId === id);
  const total = fragments.reduce((n, e) => n + e.getBoundingClientRect().height, 0);
  let offset = 0;
  for (const fragment of fragments) {
    const r = fragment.getBoundingClientRect();
    if (fragment === item) {
      offset += Math.max(0, Math.min(r.height, top - r.top));
      break;
    }
    offset += r.height;
  }
  return { id, fraction: total ? offset / total : 0 };
}

function anchorTop(element: HTMLElement, anchor: Anchor) {
  const fragments = [...element.querySelectorAll<HTMLElement>('[data-block-id]')].filter((n) =>
    (n.dataset.memberIds || n.dataset.blockId || '').split(' ').includes(anchor.id),
  );
  if (!fragments.length) return null;
  let offset =
    fragments.reduce((n, e) => n + e.getBoundingClientRect().height, 0) * anchor.fraction;
  let item = fragments[0];
  for (const fragment of fragments) {
    item = fragment;
    if (offset <= fragment.getBoundingClientRect().height) break;
    offset -= fragment.getBoundingClientRect().height;
  }
  return (
    element.scrollTop +
    item.getBoundingClientRect().top -
    element.getBoundingClientRect().top +
    offset -
    Math.min(100, element.clientHeight / 4)
  );
}

function Page({
  page,
  side,
  document,
  syncAnchors,
  ...props
}: Omit<PdfReaderProps, 'page'> & {
  page: RenderPage;
  side: Side;
  document: PDFDocumentProxy | null;
  syncAnchors: ReadonlySet<string>;
}) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(page.index === 0),
    [url, setUrl] = useState(''),
    [error, setError] = useState('');
  const blocks = props.view.data!.blocks.filter((b) => b.page === page.sourcePage && !b.hidden);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: container.current?.closest('.pdf-document-scroll'),
      rootMargin: '800px',
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near || side !== 'original' || url) return;
    let active = true;
    void request<{ url: string }>(
      `jobs/${props.id}/translation/media?page=${page.sourcePage}&kind=original`,
    )
      .then((r) => {
        if (active) setUrl(r.url);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, translateError));
      });
    return () => {
      active = false;
    };
  }, [near, side, url, props.id, page.sourcePage, locale]);
  useEffect(() => {
    if (!near || side !== 'translated' || !document || props.readerView === 'text') return;
    setError('');
    let active = true;
    let rendering:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>
      | undefined;
    void document
      .getPage(page.index + 1)
      .then((p) => {
        if (!active || !canvas.current) return;
        const size = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({ scale: Math.min(2, 1200 / size.width) });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        rendering = p.render({ canvas: canvas.current, viewport });
        return rendering.promise;
      })
      .catch((e) => {
        if (active && e.name !== 'RenderingCancelledException')
          setError(errorMessage(e, translateError));
      });
    return () => {
      active = false;
      rendering?.cancel();
    };
  }, [near, side, document, page.index, props.readerView]);
  return (
    <div
      ref={container}
      className="pdf-document-page"
      data-page-index={page.index}
      data-source-page={page.sourcePage}
    >
      <div
        className={`pdf-page-paper ${props.readerView === 'text' ? 'is-text' : ''}`}
        style={{ aspectRatio: `${page.width}/${page.height}` }}
      >
        {props.readerView === 'text' ? (
          <div
            className="pdf-page-text"
            dir={side === 'translated' && props.view.data!.targetLanguage === 'ar' ? 'rtl' : 'ltr'}
          >
            {blocks.map((b) => (
              <button
                key={b.id}
                data-block-id={b.id}
                className={b.kind === 'heading' ? 'is-heading' : ''}
                onClick={() => props.onSelect(b.id)}
              >
                {side === 'original' || b.keepOriginal ? b.sourceText : b.translatedText || '…'}
              </button>
            ))}
          </div>
        ) : (
          <>
            {side === 'original' ? (
              url ? (
                <img
                  className="pdf-original-page"
                  src={url}
                  alt={`Original ${page.index + 1}`}
                  draggable={false}
                />
              ) : null
            ) : (
              <canvas
                className="pdf-reflow-canvas"
                ref={canvas}
                aria-label={`Translation ${page.index + 1}`}
              />
            )}
            {page.regions.map((region, index) => (
              <button
                key={`${region.id}-${index}`}
                data-block-id={region.id}
                data-member-ids={region.memberIds.join(' ')}
                data-sync-alias={
                  side === 'original' && syncAnchors.size > 0 && !syncAnchors.has(region.id)
                    ? 'true'
                    : undefined
                }
                aria-label={`${copy('edit_region_703e051')} ${region.id}`}
                className={`rendered-region ${region.memberIds.includes(props.selected || '') ? 'selected' : ''}`}
                style={{
                  left: `${(region.box.x / page.width) * 100}%`,
                  top: `${(region.box.y / page.height) * 100}%`,
                  width: `${(region.box.width / page.width) * 100}%`,
                  height: `${(region.box.height / page.height) * 100}%`,
                }}
                onClick={() => props.onSelect(region.id)}
              />
            ))}
            {error && (
              <div className="pdf-page-placeholder" role="alert">
                {error}
              </div>
            )}
          </>
        )}
      </div>
      <div className="pdf-page-number">{page.index + 1}</div>
    </div>
  );
}

export function ReflowPdfReader(props: PdfReaderProps) {
  const languageName = useLanguageName();

  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale();
  const data = props.view.data!;
  const [preview, setPreview] = useState<PreviewResult | null>(null),
    [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const [mobileSide, setMobileSide] = useState<Side>('translated'),
    [current, setCurrent] = useState({ original: 0, translated: 0 });
  const panes = useRef<Partial<Record<Side, HTMLDivElement | null>>>({}),
    programmatic = useRef(new Map<HTMLElement, number>()),
    position = useRef<Anchor | null>(null),
    reported = useRef(-1);
  const callbacks = useRef(props);
  callbacks.current = props;
  const fingerprint = JSON.stringify(data);
  useEffect(() => {
    if (!props.enabled) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>,
      task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    setLoading(true);
    setDocument(null);
    setError('');
    const poll = async (a: ReadingActivity) => {
      if (!active) return;
      if (a.state === 'completed') {
        const result = a.result as PreviewResult;
        const link = await request<{ url: string }>(
          `reading-activities/${a.id}/download?format=preview`,
        );
        const pdfjs = await import('pdfjs-dist');
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        task = pdfjs.getDocument({ url: link.url });
        const pdf = await task.promise;
        if (active) {
          setDocument(pdf);
          setPreview(result);
          setLoading(false);
          callbacks.current.onIssues(result.review || []);
        }
      } else if (['failed', 'cancelled'].includes(a.state))
        throw new Error(a.error || 'PREVIEW_FAILED');
      else
        timer = setTimeout(
          () =>
            void request<{ activities: ReadingActivity[] }>(`jobs/${props.id}/reading`)
              .then((r) => poll(r.activities.find((v) => v.id === a.id) || a))
              .catch(fail),
          1200,
        );
    };
    const fail = (e: unknown) => {
      if (active) {
        setError(errorMessage(e, translateError));
        setLoading(false);
      }
    };
    timer = setTimeout(
      () =>
        void request<ReadingActivity>(`jobs/${props.id}/reading`, {
          kind: 'preview',
          revision: props.view.revision,
          page: 0,
        })
          .then(poll)
          .catch(fail),
      400,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      void task?.destroy();
    };
  }, [props.id, props.view.revision, fingerprint, props.enabled, retry, locale]);
  const originals: RenderPage[] = data.pages.map((p, index) => ({
    index,
    sourcePage: index,
    width: p.width,
    height: p.height,
    regions: data.blocks
      .filter((b) => b.page === index && !b.hidden && b.box)
      .map((b) => ({ id: b.id, memberIds: [b.id], box: b.originalBox || b.box! })),
  }));
  const pages = {
    original: originals,
    translated: props.readerView === 'text' ? originals : preview?.pages || [],
  };
  const syncAnchors = new Set(preview?.pages?.flatMap((p) => p.regions.map((r) => r.id)) || []);
  const dual = props.mode === 'bilingual' && !props.hasPanel;
  const sides: Side[] = dual ? ['original', 'translated'] : ['translated'];
  const track = (element: HTMLElement, side: Side) => {
    const top = element.getBoundingClientRect().top + Math.min(100, element.clientHeight / 4);
    const p = [...element.querySelectorAll<HTMLElement>('[data-page-index]')].find(
      (n) => n.getBoundingClientRect().bottom > top,
    );
    const index = Number(p?.dataset.pageIndex || 0);
    setCurrent((c) => (c[side] === index ? c : { ...c, [side]: index }));
    const source = pages[side][index]?.sourcePage || 0;
    reported.current = source;
    props.onPageChange(source);
  };
  const move = (side: Side, anchor: Anchor) => {
    const el = panes.current[side];
    if (!el) return;
    const top = anchorTop(el, anchor);
    if (top === null) return;
    const target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, top));
    programmatic.current.set(el, target);
    el.scrollTop = target;
  };
  const sync = (element: HTMLDivElement, side: Side) => {
    track(element, side);
    const expected = programmatic.current.get(element);
    programmatic.current.delete(element);
    if (expected !== undefined && Math.abs(element.scrollTop - expected) < 2) return;
    const anchor = anchorAt(element);
    position.current = anchor;
    if (anchor) move(side === 'original' ? 'translated' : 'original', anchor);
  };
  const go = (side: Side, index: number) => {
    const el = panes.current[side],
      page = el?.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (!el || !page) return;
    el.scrollTop += page.getBoundingClientRect().top - el.getBoundingClientRect().top;
    sync(el, side);
  };
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (position.current) for (const side of sides) move(side, position.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.zoom, dual, mobileSide, props.readerView, preview]);
  useEffect(() => {
    if (!props.selected) return;
    position.current = { id: props.selected, fraction: 0 };
    for (const side of sides) move(side, position.current);
  }, [props.selected, preview, dual, mobileSide]);
  useEffect(() => {
    if (reported.current === props.page) return;
    const block = data.blocks.find((b) => b.page === props.page && !b.hidden);
    if (block) {
      position.current = { id: block.id, fraction: 0 };
      for (const side of sides) move(side, position.current);
    }
  }, [props.page]);
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
      {languageName(data.targetLanguage)}
    </span>
  );
  return (
    <div
      className={`pdf-reader reader-file-column ${dual ? 'is-bilingual' : ''}`}
      data-mobile-side={mobileSide}
    >
      {dual && (
        <div className="pdf-mobile-tabs" role="tablist">
          {sides.map((side) => (
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
            {side === 'translated' && !loading && !!preview?.review?.length && (
              <button
                className="pdf-review-notice"
                onClick={() => props.onSelect(preview.review![0])}
              >
                {copy('needs_review_33a506c')} · {preview.review.length}
              </button>
            )}
            <div
              className="pdf-document-scroll"
              ref={(el) => {
                panes.current[side] = el;
              }}
              tabIndex={0}
              aria-label={
                side === 'original'
                  ? copy('scroll_original_92e387c')
                  : copy('scroll_translation_2c23caa')
              }
              onScroll={(e) => sync(e.currentTarget, side)}
            >
              <div className="pdf-page-stack" style={{ width: `${props.zoom * 100}%` }}>
                {pages[side].map((page) => (
                  <Page
                    {...props}
                    key={`${side}-${page.index}`}
                    page={page}
                    side={side}
                    document={document}
                    syncAnchors={syncAnchors}
                  />
                ))}
              </div>
            </div>
            {side === 'translated' && (error || loading) && (
              <div
                className={preview ? 'pdf-reflow-status' : 'pdf-page-placeholder'}
                role={error ? 'alert' : 'status'}
              >
                {error || copy('preparing_readable_pages_d04fce5')}
                {error && (
                  <button onClick={() => setRetry((v) => v + 1)}>{copy('retry_9f5cd8a')}</button>
                )}
              </div>
            )}
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
                disabled={current[side] === 0}
                onClick={() => go(side, current[side] - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              <label className="pdf-page-input">
                <input
                  type="number"
                  aria-label={copy('page_number_8b08ca4')}
                  min={1}
                  max={pages[side].length || 1}
                  value={current[side] + 1}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (n >= 1 && n <= pages[side].length) go(side, n - 1);
                  }}
                />
                <span>/ {pages[side].length || '—'}</span>
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
                disabled={current[side] >= pages[side].length - 1}
                onClick={() => go(side, current[side] + 1)}
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
