'use client';
import { LocaleSelect } from './locale-select';
import { useErrorTranslator } from '@/i18n/errors';
import { useLanguageName } from '@/i18n/language-name';
import { isLocaleUnloadAllowed, useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import type { JobView } from '@filemorph/core/domain';
import type { PreparationView } from '@filemorph/core/editing';
import type { ReadingActivity } from '@filemorph/core/reading';
import {
  isTranslationTool,
  translationFormats,
  type TranslationBlock,
  type TranslationExportOptions,
  type TranslationView,
} from '@filemorph/core/translation';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Languages,
  List,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  SquarePen,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import { CostEstimate } from './cost-estimate';
import { PdfPreview } from './pdf-preview';
import { PdfTranslationReader } from './pdf-translation-reader';
import './pdf-translation-reader.css';
import { ReadingPanel } from './reading-panel';
import { TranslationRendered } from './translation-rendered';
import { TranslationText } from './translation-text';
import './translation-workspace.css';
import { Button } from './ui/button';
import { SelectField, SelectItem } from './ui/select';
import { WorkspaceDialog } from './workspace-dialog';
type Change = Partial<
  Pick<
    TranslationBlock,
    'sourceText' | 'translatedText' | 'box' | 'style' | 'startMs' | 'endMs' | 'keepOriginal'
  >
> & { id: string; reviewed?: boolean };
type Export = {
  id: string;
  revision: number;
  state: string;
  error: string | null;
  name: string | null;
  options: TranslationExportOptions;
};
const stageNames: Record<string, string> = {
  speech: 'recognizing_speech_804e7a3',
  queued: 'queued_6a59987',
  extract: 'reading_file_75fb2b1',
  ocr: 'recognizing_text_a98ccf4',
  translate: 'translating_text_15f5c61',
  repair: 'restoring_background_a2e025b',
  ready: 'translation_ready_754455f',
};
const reviewNames: Record<string, string> = {
  OCR_REVIEW: 'check_recognition_f570597',
  BACKGROUND_REVIEW: 'check_background_78d141f',
  TEXT_OVERFLOW: 'text_overflows_d0a95bf',
  TRANSLATION_FAILED: 'retry_translation_0bd43a9',
  INLINE_REVIEW: 'check_inline_formatting_6aca275',
  STRUCTURE_REVIEW: 'check_reading_order_cbba198',
  FIGURE_REVIEW: 'check_text_in_figure_5c4b12c',
};
export default function TranslationEditor({ id }: { id: string }) {
  const languageName = useLanguageName();

  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale();
  const [job, setJob] = useState<JobView | null>(null),
    [view, setView] = useState<TranslationView | null>(null),
    [exports, setExports] = useState<Export[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saveState, setSaveState] = useState('saved'),
    [selected, setSelected] = useState(''),
    [page, setPage] = useState(0),
    [zoom, setZoom] = useState(1),
    [canvasWidth, setCanvasWidth] = useState(450),
    [mode, setMode] = useState<'original' | 'translated' | 'bilingual'>('translated'),
    [outputMode, setOutputMode] = useState<'original' | 'translated' | 'bilingual'>('translated'),
    [original, setOriginal] = useState(''),
    [background, setBackground] = useState(''),
    [videoUrl, setVideoUrl] = useState(''),
    [time, setTime] = useState(0),
    [format, setFormat] = useState(''),
    [preview, setPreview] = useState<{ url: string; format: string } | null>(null),
    [filter, setFilter] = useState(false),
    [subtitle, setSubtitle] = useState({
      fontSize: 36,
      color: '#ffffff',
      position: 'bottom' as 'top' | 'bottom',
    }),
    [copied, setCopied] = useState(false);
  const [readerView, setReaderView] = useState<'layout' | 'text'>('layout'),
    [panel, setPanelState] = useState<'edit' | 'ai' | null>('ai'),
    [downloadOpen, setDownloadOpen] = useState(false),
    [search, setSearch] = useState(''),
    [outline, setOutline] = useState(false),
    [slider, setSlider] = useState(false),
    [previewIssues, setPreviewIssues] = useState<string[]>([]),
    [autoDownload, setAutoDownload] = useState(''),
    [docxOriginal, setDocxOriginal] = useState(''),
    [docxPage, setDocxPage] = useState(1),
    [mobileSurface, setMobileSurface] = useState<'file' | 'ai'>('file'),
    [compact, setCompact] = useState(false);
  const [readingTab, setReadingTab] = useState<'summary' | 'mindmap' | 'chat'>('summary');
  const initializedReader = useRef(false);
  const previousPanel = useRef<'ai' | null>('ai');
  function setPanel(value: 'ai' | 'edit' | null) {
    if (value === 'edit' && panel !== 'edit') previousPanel.current = panel;
    if (view?.data?.format === 'pdf' && value !== 'edit') {
      setMode(value === 'ai' ? 'translated' : 'bilingual');
    }
    setPanelState(value);
    if (value) setMobileSurface('ai');
  }
  function closeCorrection() {
    setPanelState(previousPanel.current);
    setMobileSurface('file');
    if (view?.data?.format === 'pdf') {
      setMode(previousPanel.current === 'ai' ? 'translated' : 'bilingual');
    }
  }
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const player = useRef<HTMLVideoElement>(null),
    canvasArea = useRef<HTMLDivElement>(null),
    previewArea = useRef<HTMLDivElement>(null),
    dirty = useRef(new Map<string, Change>()),
    revision = useRef(0),
    saving = useRef<Promise<void> | null>(null),
    alive = useRef(true);
  const load = useCallback(
    async (force = false) => {
      const [j, v, e] = await Promise.all([
        request<{ job: JobView }>(`jobs/${id}`),
        request<TranslationView>(`jobs/${id}/translation`),
        request<{ exports: Export[] }>(`jobs/${id}/translation/exports`),
      ]);
      if (!alive.current) return;
      setJob(j.job);
      setExports(e.exports);
      if (v.data && !initializedReader.current) {
        initializedReader.current = true;
        if (v.data.format === 'pdf') {
          setMode('bilingual');
          setPanelState(null);
          previousPanel.current = null;
        }
      }
      if (force || (!dirty.current.size && !saving.current)) {
        setView(v);
        revision.current = v.revision;
      }
    },
    [id],
  );
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => setError(errorMessage(e, translateError)));
    const timer = setInterval(
      () => void load().catch((e) => setError(errorMessage(e, translateError))),
      2000,
    );
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, locale]);
  const save = useCallback(async () => {
    if (saving.current) await saving.current;
    if (!dirty.current.size) return;
    const batch: Change[] = [];
    let bytes = 0;
    for (const change of dirty.current.values()) {
      const size = new TextEncoder().encode(JSON.stringify(change)).length;
      if (batch.length && (batch.length >= 20 || bytes + size > 1500000)) break;
      batch.push(change);
      bytes += size;
    }
    for (const b of batch) dirty.current.delete(b.id);
    setSaveState('saving');
    const task = (async () => {
      try {
        const r = await request<{ revision: number }>(
          `jobs/${id}/translation`,
          { revision: revision.current, upsert: batch },
          'PATCH',
        );
        revision.current = r.revision;
        if (alive.current) {
          setView((v) => (v ? { ...v, revision: r.revision } : v));
          setSaveState(dirty.current.size ? 'pending' : 'saved');
        }
      } catch (e) {
        for (const b of batch) dirty.current.set(b.id, { ...b, ...dirty.current.get(b.id) });
        setSaveState('failed');
        setError(errorMessage(e, translateError));
        throw e;
      }
    })();
    saving.current = task;
    try {
      await task;
    } finally {
      saving.current = null;
    }
  }, [id, locale]);
  async function saveAll() {
    if (saving.current) await saving.current;
    while (dirty.current.size) await save();
  }
  useEffect(() => {
    if (saveState !== 'pending') return;
    const timer = setTimeout(() => void save().catch(() => {}), 900);
    return () => clearTimeout(timer);
  }, [view, saveState, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!isLocaleUnloadAllowed() && (dirty.current.size || saving.current)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const data = view?.data,
    video = job?.tool === 'video-translator',
    image = job?.tool === 'image-translator',
    pdf = data?.format === 'pdf',
    reflowPdf = pdf && (data?.layoutVersion || 0) >= 3,
    fixed = image || data?.format === 'pdf',
    current = data?.pages[page];
  useEffect(() => {
    if (!fixed || !canvasArea.current) return;
    const panes = [
      ...canvasArea.current.querySelectorAll<HTMLElement>('.translation-canvas-scroll'),
    ];
    const measure = () => {
      const pane = panes.find((p) => p.clientWidth > 0);
      if (pane) setCanvasWidth(Math.max(40, pane.clientWidth - 36));
    };
    const observer = new ResizeObserver(measure);
    panes.forEach((p) => observer.observe(p));
    measure();
    return () => observer.disconnect();
  }, [fixed, !!data, mode, panel, readerView]);
  useEffect(() => {
    if (!preview || !previewArea.current) return;
    const before = document.activeElement as HTMLElement | null;
    const area = previewArea.current;
    const controls = () => [
      ...area.querySelectorAll<HTMLElement>('button:not(:disabled),a,video,[tabindex="0"]'),
    ];
    controls()[0]?.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null);
      if (e.key !== 'Tab') return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    area.addEventListener('keydown', keys);
    return () => {
      area.removeEventListener('keydown', keys);
      before?.focus();
    };
  }, [preview]);
  const blocks = (data?.blocks || []).filter((b) => !b.hidden),
    b = blocks.find((b) => b.id === selected),
    editable = !!job && ['completed', 'failed', 'cancelled'].includes(job.state) && !busy;
  const readingMode = mode;
  const readingScroll = useRef(new Map<string, number[]>());
  const [selectionRequest, setSelectionRequest] = useState(0);
  const documentArea = useRef<HTMLElement>(null);
  const scrollKey = `${readerView}:${mode}:${page}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      const values = readingScroll.current.get(scrollKey);
      if (!values) return;
      documentArea.current
        ?.querySelectorAll<HTMLElement>(
          '.translation-canvases,.translation-canvas-scroll,.translation-reading,.video-reading-subtitles',
        )
        .forEach((el, index) => {
          el.scrollTop = values[index] || 0;
        });
    }, 0);
    return () => clearTimeout(timer);
  }, [scrollKey]);
  const issues = blocks.filter((b) => b.review.length || b.stale || previewIssues.includes(b.id));
  const layoutIssues = blocks.filter((b) => !b.keepOriginal && b.review.includes('TEXT_OVERFLOW'));
  useEffect(() => {
    if (!autoDownload) return;
    const e = exports.find((e) => e.id === autoDownload);
    if (e?.state === 'completed') {
      setAutoDownload('');
      void openExport(e, !!e.options.preview);
    } else if (e && ['failed', 'cancelled'].includes(e.state)) setAutoDownload('');
  }, [exports, autoDownload]);
  useEffect(() => {
    if (data?.format !== 'docx') return;
    let live = true;
    void request<{ url: string }>(`jobs/${id}/translation/media?page=0&kind=preview`)
      .then((r) => {
        if (live) setDocxOriginal(r.url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, data?.format, view?.stage]);
  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => {
      const root = canvasArea.current || document.querySelector('.translation-document-area');
      root
        ?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 100);
    return () => clearTimeout(timer);
  }, [selected, page, selectionRequest]);
  useEffect(() => {
    if (!data || !job || !isTranslationTool(job.tool)) return;
    setFormat((f) => f || translationFormats(job.tool as 'video-translator', data.format)[0]);
    if (!selected && blocks.length) setSelected(blocks[0].id);
  }, [data, job, selected]);
  useEffect(() => {
    if (!fixed || !data || (pdf && panel !== 'edit')) return;
    let active = true;
    Promise.all([
      request<{ url: string }>(`jobs/${id}/translation/media?page=${page}&kind=original`),
      request<{ url: string }>(`jobs/${id}/translation/media?page=${page}&kind=background`),
    ])
      .then(([a, b]) => {
        if (active) {
          setOriginal(a.url);
          setBackground(b.url);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [fixed, page, id, view?.revision, view?.stage, pdf, panel]);
  useEffect(() => {
    if (!video || !job) return;
    let active = true;
    const options = job.options as { streamIndex: number };
    request<PreparationView>(
      `assets/${job.sourceIds[0]}/prepare?profile=video&streamIndex=${options.streamIndex}`,
    )
      .catch(() =>
        request<PreparationView>(`assets/${job.sourceIds[0]}/prepare?profile=video&streamIndex=-1`),
      )
      .then((p) => {
        if (active && p.previewUrl) setVideoUrl(p.previewUrl);
      })
      .catch(() =>
        request<{ url: string }>(`jobs/${id}/download?original=1&inline=1`).then((r) => {
          if (active) setVideoUrl(r.url);
        }),
      );
    return () => {
      active = false;
    };
  }, [video, job?.id]);
  function change(id: string, values: Omit<Change, 'id'>) {
    dirty.current.set(id, { ...dirty.current.get(id), id, ...values });
    setSaveState('pending');
    setView((v) =>
      v?.data
        ? {
            ...v,
            data: {
              ...v.data,
              blocks: v.data.blocks.map((b) =>
                b.id === id
                  ? {
                      ...b,
                      ...values,
                      ...(values.sourceText !== undefined && values.sourceText !== b.sourceText
                        ? { stale: true }
                        : {}),
                      ...(values.translatedText !== undefined ? { stale: false } : {}),
                      ...(values.reviewed ? { review: [] } : {}),
                    }
                  : b,
              ),
            },
          }
        : v,
    );
  }
  function select(b: TranslationBlock) {
    setSelectionRequest((request) => request + 1);
    setSelected(b.id);
    setPage(b.page);
    if (video && b.startMs !== undefined) {
      if (player.current) player.current.currentTime = b.startMs / 1000;
      setTime(b.startMs / 1000);
    }
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await saveAll();
      await fn();
      await load(true);
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  async function retry(operation: 'translate' | 'repair', ids: string[]) {
    await act(() =>
      request(`jobs/${id}/translation/retry`, {
        revision: revision.current,
        blockIds: ids,
        operation,
      }),
    );
  }
  async function optimizeLayout() {
    await act(async () => {
      let activity = await request<ReadingActivity>(`jobs/${id}/reading`, {
        kind: 'preview',
        revision: revision.current,
        optimizeLayout: true,
      });
      while (alive.current && ['queued', 'processing', 'cancelling'].includes(activity.state)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const list = await request<{ activities: ReadingActivity[] }>(`jobs/${id}/reading`);
        activity = list.activities.find((a) => a.id === activity.id) || activity;
      }
      if (activity.state !== 'completed')
        throw new Error(activity.error || 'DOCUMENT_PROCESSING_FAILED');
    });
  }
  async function generate(isPreview = false) {
    await act(async () => {
      const result = await request<Export>(`jobs/${id}/translation/exports`, {
        revision: revision.current,
        format: isPreview ? 'mp4' : format,
        mode: outputMode,
        preview: isPreview,
        previewStartMs: isPreview ? Math.round(time * 1000) : 0,
        subtitle,
      });
      if (result.state === 'completed') await openExport(result, isPreview);
      else setAutoDownload(result.id);
    });
  }
  async function openExport(e: Export, inline: boolean) {
    try {
      const r = await request<{ url: string }>(
        `translation-exports/${e.id}/download${inline ? '?inline=1' : ''}`,
      );
      if (inline) {
        setDownloadOpen(false);
        setPreview({ url: r.url, format: e.options.format === 'docx' ? 'pdf' : e.options.format });
      } else {
        const a = document.createElement('a');
        a.href = r.url;
        a.download = e.name || 'translation';
        a.click();
      }
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  const pending = job && ['queued', 'processing', 'cancelling'].includes(job.state),
    shown = blocks.filter(
      (b) =>
        (video || b.page === page || !!search) &&
        (!filter || issues.some((i) => i.id === b.id)) &&
        (!search ||
          `${b.sourceText}\n${b.translatedText}`.toLowerCase().includes(search.toLowerCase())),
    );
  const active = blocks.find(
    (b) =>
      b.startMs !== undefined &&
      b.endMs !== undefined &&
      time * 1000 >= b.startMs &&
      time * 1000 < b.endMs,
  );
  useEffect(() => {
    if (video && player.current && !player.current.paused && active) {
      document
        .querySelector<HTMLElement>(
          `.video-reading-subtitles [data-block-id="${CSS.escape(active.id)}"]`,
        )
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [active?.id, video]);
  const ratio = current ? (Math.min(canvasWidth, current.width) / current.width) * zoom : 1;
  const canvas = (which: 'original' | 'translated') => (
    <div className="translation-canvas-side">
      <div className="translation-pane-heading">
        {which === 'original' ? copy('original_c0a8060') : copy('translation_ac26a7a')}
        {which === 'translated' && panel === 'edit' && (
          <span> · {copy('editing_preview_reflows_before_export_c92424b')}</span>
        )}
      </div>
      <div className="translation-canvas-scroll">
        {which === 'original' && panel !== 'edit' && (
          <div className="rendered-status">{copy('original_file_9139c8d')}</div>
        )}
        <div
          className="translation-canvas"
          style={{
            width: (current?.width || 800) * ratio,
            height: (current?.height || 1000) * ratio,
          }}
        >
          {(which === 'original' ? original : background) && (
            <img
              className="translation-page-image"
              src={which === 'original' ? original : background}
              alt={
                which === 'original'
                  ? copy('original_page_3652330')
                  : copy('restored_background_6a53379')
              }
              draggable={false}
            />
          )}
          {which === 'translated' &&
            blocks
              .filter((b) => b.page === page && b.box)
              .map((block) => {
                const box = block.box!;
                return (
                  <Rnd
                    key={block.id}
                    bounds="parent"
                    minWidth={8}
                    minHeight={8}
                    size={{ width: box.width * ratio, height: box.height * ratio }}
                    position={{ x: box.x * ratio, y: box.y * ratio }}
                    disableDragging={!editable}
                    enableResizing={editable && selected === block.id}
                    onMouseDown={() => {
                      setSelected(block.id);
                      setPanel('edit');
                    }}
                    onDragStop={(_, d) =>
                      change(block.id, { box: { ...box, x: d.x / ratio, y: d.y / ratio } })
                    }
                    onResizeStop={(_e, _direction, ref, _delta, pos) =>
                      change(block.id, {
                        box: {
                          ...box,
                          x: pos.x / ratio,
                          y: pos.y / ratio,
                          width: ref.offsetWidth / ratio,
                          height: ref.offsetHeight / ratio,
                        },
                      })
                    }
                    className={`translation-region ${selected === block.id ? 'selected' : ''} ${block.review.length || block.stale ? 'needs-review' : ''}`}
                  >
                    <button
                      disabled={!editable}
                      className="translation-region-text"
                      onClick={() => setSelected(block.id)}
                      style={{
                        fontSize: block.style.fontSize * ratio,
                        color: block.style.color,
                        textAlign: block.style.align,
                        transform: `rotate(${box.angle}deg)`,
                        direction: block.keepOriginal
                          ? undefined
                          : data?.targetLanguage === 'ar'
                            ? 'rtl'
                            : 'ltr',
                        unicodeBidi: block.keepOriginal ? 'plaintext' : 'isolate',
                        fontFamily:
                          data?.targetLanguage === 'ar'
                            ? 'FormatOwlArabic'
                            : data?.targetLanguage === 'ja'
                              ? 'FormatOwlJP'
                              : data?.targetLanguage === 'ko'
                                ? 'FormatOwlKR'
                                : 'FormatOwlSC',
                      }}
                    >
                      {block.keepOriginal ? block.sourceText : block.translatedText || '…'}
                    </button>
                  </Rnd>
                );
              })}
        </div>
      </div>
    </div>
  );
  useLocaleGuard({ busy: saveState === 'saving' || busy, dirty: saveState !== 'saved' });
  return (
    <div
      className={`translation-editor reader-workspace ${pdf ? 'pdf-workspace' : ''} ${panel === 'edit' ? 'is-correcting' : ''}`}
      data-mobile-surface={mobileSurface}
    >
      <header className="translation-editor-heading">
        <Link
          href={`/${locale}/workspace`}
          className="back-link"
          aria-label={copy('back_to_workspace_1d99bfb')}
        >
          {pdf ? (
            <>
              <ChevronLeft size={18} />
              {copy('back_b52b36b')}
            </>
          ) : (
            <>
              <ArrowLeft size={15} />
              <img
                src="/icon.png"
                className="brand-artwork"
                width={26}
                height={26}
                alt="FormatOwl"
              />
            </>
          )}
        </Link>
        <div className="workspace-file-heading">
          <h1>{job?.name || copy('loading_33ce417')}</h1>
          {!pdf && (
            <p>
              {data
                ? `${languageName(data.sourceLanguage) || data.sourceLanguage} → ${languageName(data.targetLanguage) || data.targetLanguage}`
                : ''}
            </p>
          )}
        </div>
        <div className="action-row">
          <LocaleSelect />
          {(!pdf || panel === 'edit') && (
            <>
              <span className="translation-save-state" role="status">
                {saveState === 'saved' ? <Check size={14} /> : <LoaderCircle size={14} />}{' '}
                {saveState === 'saved'
                  ? copy('saved_c0ae8f6')
                  : saveState === 'failed'
                    ? copy('save_failed_0a44446')
                    : copy('saving_56a2285')}
              </span>
              <Button
                variant="outline"
                disabled={!editable || saveState === 'saved'}
                onClick={() => void saveAll().catch(() => {})}
              >
                <Save size={15} />
                {copy('save_efc007a')}
              </Button>
            </>
          )}
          {pdf && !pending && (
            <Button variant="outline" disabled={busy} onClick={optimizeLayout}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              {busy ? copy('optimizing_layout_0fbd08e') : copy('optimize_layout_e5df148')}
            </Button>
          )}
          {pending ? (
            <Button variant="outline" onClick={() => act(() => request(`jobs/${id}/cancel`, {}))}>
              {copy('cancel_77dfd21')}
            </Button>
          ) : job && ['failed', 'cancelled'].includes(job.state) ? (
            <Button variant="outline" onClick={() => act(() => request(`jobs/${id}/retry`, {}))}>
              <RefreshCw size={15} />
              {copy('retry_task_1c8f1b7')}
            </Button>
          ) : null}
          <Button
            asChild
            variant={pdf ? 'default' : 'outline'}
            size="sm"
            className={pdf ? 'pdf-new-file' : undefined}
          >
            <Link href={`/${locale}/tools/${job?.tool || 'document-translator'}`}>
              <Plus size={15} />
              {copy('new_file_3cb7ea0')}
            </Link>
          </Button>
          {!pdf && (
            <Button size="sm" disabled={!data} onClick={() => setDownloadOpen(true)}>
              <Download size={15} />
              {copy('download_a479c9c')}
            </Button>
          )}
        </div>
      </header>
      {error && !downloadOpen && (
        <div className="error-banner" role="alert">
          {error}
          {saveState === 'failed' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                dirty.current.clear();
                setSaveState('saved');
                setError('');
                void load(true);
              }}
            >
              {copy('reload_saved_version_83688d3')}
            </Button>
          )}
        </div>
      )}
      {job?.error && (
        <div className="error-banner" role="alert">
          {errorMessage(job.error, translateError)}
          {view?.totalUnits
            ? ` · ${copy('completed_1798b3b')} ${view.completedUnits}/${view.totalUnits} · ${copy(stageNames[view.stage]) || view.stage}`
            : ''}
        </div>
      )}
      {pending && (
        <section className="panel translation-status" role="status">
          <LoaderCircle className="spin" size={20} />
          <div>
            <strong>
              {view?.waitingUntil && new Date(view.waitingUntil) > new Date()
                ? copy('waiting_for_capacity_resumes_automatically_a88ab43')
                : stageNames[view?.stage || 'queued']
                  ? copy(stageNames[view?.stage || 'queued'])
                  : view?.stage}
            </strong>
            <span>{view?.totalUnits ? `${view.completedUnits} / ${view.totalUnits}` : ''}</span>
            <progress value={job.progress} max={100} />
          </div>
          <p>{copy('processing_continues_after_you_leave_7425281')}</p>
        </section>
      )}
      {data && (
        <>
          {pdf && (
            <div className="pdf-workspace-toolbar">
              <div
                className="pdf-view-tabs"
                role="tablist"
                aria-label={copy('reader_view_3663eec')}
              >
                {(['layout', 'text'] as const).map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={readerView === value}
                    className={readerView === value ? 'active' : ''}
                    onClick={() => {
                      setReaderView(value);
                      setMobileSurface('file');
                    }}
                  >
                    {value === 'layout' ? copy('viewer_dbad9f1') : copy('transcript_5bcd602')}
                  </button>
                ))}
              </div>
              <div className="pdf-ai-tabs" role="tablist" aria-label={copy('ai_features_59f0c68')}>
                {(['summary', 'mindmap', 'chat'] as const).map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={panel === 'ai' && readingTab === value}
                    className={panel === 'ai' && readingTab === value ? 'active' : ''}
                    onClick={() => {
                      setReadingTab(value);
                      setPanel('ai');
                    }}
                  >
                    {value === 'summary'
                      ? copy('summary_12b71c3')
                      : value === 'mindmap'
                        ? copy('mindmap_6a6b61f')
                        : copy('ai_chat_81cefba')}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            className="workspace-mobile-switch"
            role="tablist"
            aria-label={copy('workspace_4ca0a75')}
          >
            <button
              role="tab"
              aria-selected={mobileSurface === 'file'}
              onClick={() => setMobileSurface('file')}
            >
              {copy('file_2c3cafa')}
            </button>
            <button
              role="tab"
              aria-selected={mobileSurface === 'ai'}
              onClick={() => {
                setMobileSurface('ai');
                if (!panel) setPanelState('ai');
              }}
            >
              {panel === 'edit' ? copy('correction_7f26406') : copy('ai_reading_9f127e6')}
            </button>
          </div>
          <div
            className={`translation-workarea ${video ? 'is-video' : ''} ${panel ? 'has-panel' : ''}`}
          >
            {pdf && (panel !== 'edit' || reflowPdf) ? (
              <PdfTranslationReader
                id={id}
                view={view!}
                mode={mode}
                onModeChange={(value) => {
                  setMode(value);
                  setPanelState(value === 'translated' ? 'ai' : null);
                  setMobileSurface('file');
                }}
                readerView={readerView}
                page={page}
                onPageChange={setPage}
                zoom={zoom}
                onZoomChange={setZoom}
                enabled={saveState === 'saved'}
                selected={panel === 'edit' || readerView === 'text' ? selected : ''}
                onIssues={setPreviewIssues}
                onSelect={(id) => {
                  const block = blocks.find((block) => block.id === id);
                  if (block) select(block);
                  setPanel('edit');
                }}
                onDownload={() => setDownloadOpen(true)}
                hasPanel={!!panel && (!compact || mobileSurface === 'ai')}
              />
            ) : (
              <div className="reader-column reader-file-column">
                <header className="reader-column-toolbar translation-toolbar">
                  <div className="translation-segmented">
                    {(['layout', 'text'] as const).map((v) => (
                      <button
                        key={v}
                        className={readerView === v ? 'active' : ''}
                        onClick={() => setReaderView(v)}
                      >
                        {v === 'layout' ? copy('layout_972ad8d') : copy('text_c3328c3')}
                      </button>
                    ))}
                  </div>
                  <div className="reader-tools">
                    <Button
                      size="sm"
                      variant={panel === 'edit' ? 'default' : 'outline'}
                      onClick={() => (panel === 'edit' ? closeCorrection() : setPanel('edit'))}
                    >
                      <Pencil size={15} />
                      {copy('edit_5301648')}
                    </Button>
                    <Button
                      size="sm"
                      variant={panel === 'ai' ? 'default' : 'outline'}
                      onClick={() => setPanel(panel === 'ai' ? null : 'ai')}
                    >
                      <Sparkles size={15} />
                      {copy('ai_reading_9f127e6')}
                    </Button>
                  </div>
                </header>
                <div className="reader-file-card">
                  <div className="reader-view-controls">
                    <div className="translation-segmented">
                      {(['original', 'translated', 'bilingual'] as const).map((v) => (
                        <button
                          key={v}
                          className={readingMode === v ? 'active' : ''}
                          onClick={() => setMode(v)}
                        >
                          {v === 'original'
                            ? copy('original_c0a8060')
                            : v === 'translated'
                              ? copy('translated_c86099d')
                              : copy('bilingual_7870ebe')}
                        </button>
                      ))}
                    </div>
                    <span className="reader-target-language">
                      <Languages size={15} />
                      {languageName(data.targetLanguage)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={copy('download_file_774025d')}
                      onClick={() => setDownloadOpen(true)}
                    >
                      <Download size={16} />
                    </Button>
                  </div>
                  <div className="reader-navigation">
                    {' '}
                    <div className="action-row">
                      {(fixed || data.format === 'docx') && readerView === 'layout' && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={copy('zoom_out_a4ae4b2')}
                            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                          >
                            <ZoomOut size={16} />
                          </Button>
                          <span>{Math.round(zoom * 100)}%</span>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={copy('zoom_in_4fc05f2')}
                            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                          >
                            <ZoomIn size={16} />
                          </Button>
                        </>
                      )}
                    </div>
                    {!image && !video && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOutline(!outline)}
                        aria-label={copy('outline_cdd6290')}
                      >
                        <List size={16} />
                      </Button>
                    )}
                    {!video && data.pages.length > 1 && (
                      <>
                        <button
                          aria-label={copy('previous_page_81f5471')}
                          disabled={!page}
                          onClick={() => setPage(page - 1)}
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <label>
                          <input
                            aria-label={copy('page_number_8b08ca4')}
                            type="number"
                            min={1}
                            max={data.pages.length}
                            value={page + 1}
                            onChange={(e) =>
                              setPage(
                                Math.min(
                                  data.pages.length - 1,
                                  Math.max(0, Number(e.target.value) - 1),
                                ),
                              )
                            }
                          />
                          <span>/ {data.pages.length}</span>
                        </label>
                        <button
                          aria-label={copy('next_page_4bfc194')}
                          disabled={page === data.pages.length - 1}
                          onClick={() => setPage(page + 1)}
                        >
                          <ChevronRight size={16} />
                        </button>
                      </>
                    )}
                    <label className="reader-search">
                      <Search size={15} />
                      <input
                        aria-label={copy('search_file_text_5314c00')}
                        placeholder={copy('search_source_or_translation_95db189')}
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          if (e.target.value) setReaderView('text');
                        }}
                      />
                    </label>
                    <button
                      className={filter ? 'active' : ''}
                      onClick={() => {
                        setFilter(!filter);
                        setReaderView('text');
                      }}
                    >
                      {copy('needs_review_33a506c')} {issues.length}
                    </button>
                    <button
                      disabled={!issues.length}
                      onClick={() => {
                        const index = issues.findIndex((b) => b.id === selected);
                        const next = issues[(index + 1) % issues.length];
                        select(next);
                        setPanel('edit');
                      }}
                    >
                      {copy('next_issue_0039d72')} →
                    </button>
                    {image && readerView === 'layout' && (
                      <button className={slider ? 'active' : ''} onClick={() => setSlider(!slider)}>
                        {copy('slide_to_compare_bde7dd1')}
                      </button>
                    )}
                  </div>
                  <div className="reader-file-content">
                    {!video && !image && outline && (
                      <nav
                        className="translation-page-list"
                        aria-label={copy('document_outline_12ebeb9')}
                      >
                        {data.pages.map((p) => (
                          <button
                            key={p.index}
                            className={page === p.index ? 'active' : ''}
                            onClick={() => setPage(p.index)}
                          >
                            <span>{p.index + 1}</span>
                            {p.title}
                          </button>
                        ))}
                      </nav>
                    )}
                    <section
                      className="translation-document-area"
                      ref={documentArea}
                      onScrollCapture={() => {
                        readingScroll.current.set(
                          scrollKey,
                          [
                            ...(documentArea.current?.querySelectorAll<HTMLElement>(
                              '.translation-canvases,.translation-canvas-scroll,.translation-reading,.video-reading-subtitles',
                            ) || []),
                          ].map((el) => el.scrollTop),
                        );
                      }}
                    >
                      {video && readerView === 'layout' ? (
                        <>
                          <div
                            className="translation-player"
                            style={{ maxWidth: (520 * data.pages[0].width) / data.pages[0].height }}
                          >
                            <video
                              ref={player}
                              src={videoUrl || undefined}
                              controls
                              onLoadedMetadata={(e) => {
                                e.currentTarget.currentTime = time;
                              }}
                              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                            />
                            {active && (
                              <div
                                className={`translation-subtitle ${subtitle.position}`}
                                style={{
                                  fontSize: `${(subtitle.fontSize * 100 * data.pages[0].height) / data.pages[0].width / 1080}cqw`,
                                  color: subtitle.color,
                                }}
                                dir={data.targetLanguage === 'ar' ? 'rtl' : 'ltr'}
                              >
                                {mode === 'original' || active.keepOriginal
                                  ? active.sourceText
                                  : mode === 'bilingual'
                                    ? `${active.sourceText}\n${active.translatedText}`
                                    : active.translatedText}
                              </div>
                            )}
                          </div>
                          <div className="translation-timeline">
                            <input
                              aria-label={copy('subtitle_timeline_20f5bf2')}
                              type="range"
                              min={0}
                              max={(data.durationMs || 1) / 1000}
                              step={0.01}
                              value={time}
                              onChange={(e) => {
                                setTime(Number(e.target.value));
                                if (player.current)
                                  player.current.currentTime = Number(e.target.value);
                              }}
                            />
                            <div>
                              {blocks.map((s) => (
                                <button
                                  key={s.id}
                                  title={s.sourceText}
                                  aria-label={`${(s.startMs || 0) / 1000}s`}
                                  onClick={() => select(s)}
                                  style={{
                                    left: `${((s.startMs || 0) / (data.durationMs || 1)) * 100}%`,
                                    width: `${Math.max(0.3, (((s.endMs || 0) - (s.startMs || 0)) / (data.durationMs || 1)) * 100)}%`,
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                          <div className="video-reading-subtitles">
                            {shown.map((s) => (
                              <button
                                key={s.id}
                                data-block-id={s.id}
                                className={active?.id === s.id ? 'active' : ''}
                                onClick={() => select(s)}
                              >
                                <time>
                                  {Math.floor((s.startMs || 0) / 60000)}:
                                  {String(Math.floor((s.startMs || 0) / 1000) % 60).padStart(
                                    2,
                                    '0',
                                  )}
                                </time>
                                <span>
                                  {readingMode !== 'translated' && <span>{s.sourceText}</span>}
                                  {readingMode !== 'original' && (
                                    <span dir={data.targetLanguage === 'ar' ? 'rtl' : 'ltr'}>
                                      {s.keepOriginal ? s.sourceText : s.translatedText}
                                    </span>
                                  )}
                                </span>
                              </button>
                            ))}
                          </div>
                        </>
                      ) : fixed && readerView === 'layout' ? (
                        <div
                          ref={canvasArea}
                          className={`translation-canvases ${readingMode === 'bilingual' && !slider ? 'two' : ''}`}
                          onScrollCapture={(e) => {
                            const el = e.target as HTMLElement;
                            if (!el.classList.contains('translation-canvas-scroll')) return;
                            const other = [
                              ...canvasArea.current!.querySelectorAll<HTMLElement>(
                                '.translation-canvas-scroll',
                              ),
                            ].find((p) => p !== el);
                            if (other && Math.abs(other.scrollTop - el.scrollTop) > 2)
                              other.scrollTop = el.scrollTop;
                          }}
                        >
                          {readingMode !== 'translated' && !slider && canvas('original')}
                          {(readingMode !== 'original' || slider) &&
                            (panel === 'edit' ? (
                              canvas('translated')
                            ) : (
                              <div className="translation-canvas-side">
                                <div className="translation-pane-heading">
                                  {copy('translation_ac26a7a')}
                                </div>
                                <div className="translation-canvas-scroll">
                                  <TranslationRendered
                                    id={id}
                                    view={view!}
                                    page={page}
                                    zoom={zoom}
                                    enabled={saveState === 'saved'}
                                    selected={selected}
                                    onIssues={setPreviewIssues}
                                    onSelect={(id) => {
                                      setSelected(id);
                                      setPanel('edit');
                                    }}
                                    original={original}
                                    slider={slider}
                                  />
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : data.format === 'docx' && readerView === 'layout' ? (
                        <div
                          className={`translation-canvases ${readingMode === 'bilingual' ? 'two' : ''}`}
                        >
                          {readingMode !== 'translated' && (
                            <div className="translation-canvas-side">
                              <div className="translation-pane-heading">
                                {copy('original_c0a8060')}
                              </div>
                              <div className="translation-canvas-scroll">
                                <div className="rendered-status">
                                  {copy('original_file_9139c8d')}
                                </div>
                                {docxOriginal ? (
                                  <PdfPreview
                                    url={docxOriginal}
                                    zoom={zoom}
                                    page={docxPage}
                                    onPageChange={setDocxPage}
                                  />
                                ) : (
                                  <p>{copy('preparing_original_layout_6de30f4')}</p>
                                )}
                              </div>
                            </div>
                          )}
                          {readingMode !== 'original' && (
                            <div className="translation-canvas-side">
                              <div className="translation-pane-heading">
                                {copy('translation_ac26a7a')}
                              </div>
                              <div className="translation-canvas-scroll">
                                <TranslationRendered
                                  id={id}
                                  view={view!}
                                  page={0}
                                  enabled={saveState === 'saved'}
                                  selected={selected}
                                  onSelect={setSelected}
                                  onIssues={setPreviewIssues}
                                  zoom={zoom}
                                  documentPage={docxPage}
                                  onDocumentPageChange={setDocxPage}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <TranslationText
                          data={data}
                          blocks={shown}
                          selected={selected}
                          mode={readingMode}
                          onSelect={select}
                          onEdit={(b) => {
                            select(b);
                            setPanel('edit');
                          }}
                        />
                      )}
                    </section>
                  </div>
                </div>
              </div>
            )}
            {panel === 'edit' && (
              <aside
                className="translation-edit-panel reader-column"
                aria-label={copy('correction_panel_2d37ffc')}
              >
                <div className="translation-panel-title">
                  <h2>{copy('edit_selection_5228e02')}</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={copy('close_correction_3c2a77b')}
                    onClick={closeCorrection}
                  >
                    <X size={16} />
                  </Button>
                  {image && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!editable}
                      aria-label={copy('add_text_region_ea15fee')}
                      onClick={() =>
                        act(() =>
                          request(
                            `jobs/${id}/translation`,
                            {
                              revision: revision.current,
                              add: [
                                {
                                  page,
                                  box: {
                                    x: 20,
                                    y: 20,
                                    width: Math.min(240, (current?.width || 300) - 20),
                                    height: Math.min(80, (current?.height || 120) - 20),
                                    angle: 0,
                                  },
                                  sourceText: copy('enter_source_text_80c64fc'),
                                },
                              ],
                            },
                            'PATCH',
                          ),
                        )
                      }
                    >
                      <Plus size={16} />
                    </Button>
                  )}
                </div>
                <details className="translation-region-picker">
                  <summary>
                    {copy('choose_text_region_14c4799')} · {shown.length}
                  </summary>
                  <div className="translation-block-list">
                    {shown.map((block) => (
                      <button
                        key={block.id}
                        className={selected === block.id ? 'active' : ''}
                        onClick={() => select(block)}
                      >
                        {video && <time>{((block.startMs || 0) / 1000).toFixed(1)}s</time>}
                        <span>{block.sourceText.slice(0, 90)}</span>
                        {(block.review.length > 0 || block.stale) && <AlertCircle size={14} />}
                      </button>
                    ))}
                  </div>
                </details>
                {b && (
                  <div className="translation-block-fields">
                    <div className="translation-review-tags">
                      {b.stale && <span>{copy('source_changed_update_translation_46e1c80')}</span>}
                      {b.review.map((r) => (
                        <span key={r}>{copy(reviewNames[r]) || r}</span>
                      ))}
                    </div>
                    <label>
                      {copy('source_text_6f377d2')}
                      <textarea
                        dir="auto"
                        disabled={!editable}
                        value={b.sourceText}
                        onChange={(e) => change(b.id, { sourceText: e.target.value })}
                      />
                    </label>
                    <label>
                      {copy('translation_ac26a7a')}
                      <textarea
                        dir={data.targetLanguage === 'ar' ? 'rtl' : 'ltr'}
                        disabled={!editable}
                        value={b.translatedText}
                        onChange={(e) => change(b.id, { translatedText: e.target.value })}
                      />
                    </label>
                    {video && (
                      <div className="translation-field-pair">
                        <label>
                          {copy('start_s_a40a4e6')}
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            disabled={!editable}
                            value={(b.startMs || 0) / 1000}
                            onChange={(e) =>
                              change(b.id, { startMs: Math.round(Number(e.target.value) * 1000) })
                            }
                          />
                        </label>
                        <label>
                          {copy('end_s_731a0d4')}
                          <input
                            type="number"
                            step="0.01"
                            disabled={!editable}
                            value={(b.endMs || 0) / 1000}
                            onChange={(e) =>
                              change(b.id, { endMs: Math.round(Number(e.target.value) * 1000) })
                            }
                          />
                        </label>
                      </div>
                    )}
                    {b.box && (
                      <>
                        <div className="translation-field-pair">
                          <label>
                            {copy('font_size_83ca9e4')}
                            <input
                              type="number"
                              min={reflowPdf ? 10 : 4}
                              max={reflowPdf ? 32 : 500}
                              disabled={!editable}
                              value={
                                reflowPdf
                                  ? Math.round(
                                      (b.style.fontSize / (data.pages[b.page]?.scale || 1)) * 10,
                                    ) / 10
                                  : b.style.fontSize
                              }
                              onChange={(e) =>
                                change(b.id, {
                                  style: {
                                    ...b.style,
                                    fontSize:
                                      Number(e.target.value) *
                                      (reflowPdf ? data.pages[b.page]?.scale || 1 : 1),
                                  },
                                })
                              }
                            />
                          </label>
                          <label>
                            {copy('text_color_1c7a30e')}
                            <input
                              type="color"
                              disabled={!editable}
                              value={b.style.color}
                              onChange={(e) =>
                                change(b.id, { style: { ...b.style, color: e.target.value } })
                              }
                            />
                          </label>
                        </div>
                        <div className="translation-field-pair">
                          {!reflowPdf && (
                            <label>
                              {copy('rotation_906fe50')}
                              <input
                                type="number"
                                min={-180}
                                max={180}
                                disabled={!editable}
                                value={b.box.angle}
                                onChange={(e) =>
                                  change(b.id, {
                                    box: { ...b.box!, angle: Number(e.target.value) },
                                  })
                                }
                              />
                            </label>
                          )}
                          <label>
                            {copy('alignment_7f8c517')}
                            <SelectField
                              disabled={!editable}
                              value={b.style.align}
                              onValueChange={(nextValue) =>
                                change(b.id, {
                                  style: { ...b.style, align: nextValue as 'left' },
                                })
                              }
                            >
                              <SelectItem value="left">{copy('left_8ae1c34')}</SelectItem>
                              <SelectItem value="center">{copy('center_a239111')}</SelectItem>
                              <SelectItem value="right">{copy('right_954daa8')}</SelectItem>
                            </SelectField>
                          </label>
                        </div>
                        {!reflowPdf && (
                          <details>
                            <summary>{copy('position_size_0fd38d9')}</summary>
                            <div className="translation-field-pair">
                              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                                <label key={k}>
                                  {k}
                                  <input
                                    type="number"
                                    min={0}
                                    disabled={!editable}
                                    value={Math.round(b.box![k])}
                                    onChange={(e) =>
                                      change(b.id, {
                                        box: { ...b.box!, [k]: Number(e.target.value) },
                                      })
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                          </details>
                        )}
                        {reflowPdf && (
                          <div className="translation-field-pair">
                            <label>
                              {copy('font_b97c4d4')}
                              <SelectField
                                value={b.style.fontFamily || 'serif'}
                                disabled={!editable}
                                onValueChange={(value) =>
                                  change(b.id, {
                                    style: { ...b.style, fontFamily: value as 'serif' | 'sans' },
                                  })
                                }
                              >
                                <SelectItem value="serif">{copy('serif_a5c78a8')}</SelectItem>
                                <SelectItem value="sans">{copy('sans_serif_ecc39dc')}</SelectItem>
                              </SelectField>
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                disabled={!editable}
                                checked={!!b.style.bold}
                                onChange={(e) =>
                                  change(b.id, { style: { ...b.style, bold: e.target.checked } })
                                }
                              />
                              {copy('bold_19e0743')}
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                disabled={!editable}
                                checked={!!b.style.italic}
                                onChange={(e) =>
                                  change(b.id, { style: { ...b.style, italic: e.target.checked } })
                                }
                              />
                              {copy('italic_1616e2e')}
                            </label>
                          </div>
                        )}
                      </>
                    )}
                    <label className="translation-check">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={b.keepOriginal}
                        onChange={(e) => change(b.id, { keepOriginal: e.target.checked })}
                      />
                      {copy('keep_original_text_in_this_region_0d263dd')}
                    </label>
                    <div className="translation-block-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable}
                        onClick={() => retry('translate', [b.id])}
                      >
                        <RefreshCw size={14} />
                        {copy('retranslate_9eb3938')}
                      </Button>
                      {b.box && b.raster !== false && !reflowPdf && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!editable}
                          onClick={() => retry('repair', [b.id])}
                        >
                          {copy('repair_background_091c9d6')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable}
                        onClick={() => change(b.id, { reviewed: true })}
                      >
                        <Check size={14} />
                        {copy('reviewed_31ef859')}
                      </Button>
                      {image && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          aria-label={copy('remove_region_64cb2bb')}
                          onClick={() =>
                            act(() =>
                              request(
                                `jobs/${id}/translation`,
                                { revision: revision.current, remove: [b.id] },
                                'PATCH',
                              ),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </aside>
            )}
            <ReadingPanel
              id={id}
              revision={view?.revision || 0}
              data={data}
              open={panel === 'ai' && (!compact || mobileSurface === 'ai')}
              ready={editable}
              activeTab={pdf ? readingTab : undefined}
              onTabChange={pdf ? setReadingTab : undefined}
              beforeGenerate={async () => {
                await saveAll();
                return revision.current;
              }}
              onLocate={(id) => {
                const block = blocks.find((b) => b.id === id);
                if (block) {
                  select(block);
                  setReaderView(video || image ? 'layout' : 'text');
                  if (window.innerWidth < 1024) setMobileSurface('file');
                }
              }}
              onClose={() => {
                setPanel(null);
                setMobileSurface('file');
              }}
            />
          </div>
          {pdf && panel !== 'edit' && (
            <button
              className="pdf-correction-button"
              aria-label={copy('edit_5301648')}
              title={copy('edit_5301648')}
              onClick={() => setPanel('edit')}
            >
              <SquarePen size={24} />
            </button>
          )}
          <WorkspaceDialog
            open={downloadOpen}
            onClose={() => setDownloadOpen(false)}
            label={copy('download_translation_aa52aea')}
          >
            <section className="panel translation-export-panel">
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              )}
              <Button
                className="dialog-close"
                variant="ghost"
                aria-label={copy('close_download_e939eb5')}
                onClick={() => setDownloadOpen(false)}
              >
                <X size={18} />
              </Button>
              <div>
                <h2>{copy('export_your_translation_ae15b72')}</h2>
                <p>{copy('generate_a_file_from_your_saved_text_and_l_a861d40')}</p>
              </div>
              <div className="translation-export-settings">
                <label>
                  {copy('export_content_28970a1')}
                  <SelectField
                    value={outputMode}
                    onValueChange={(nextValue) => setOutputMode(nextValue as typeof outputMode)}
                  >
                    <SelectItem value="translated">{copy('translated_c86099d')}</SelectItem>
                    <SelectItem value="original">{copy('original_c0a8060')}</SelectItem>
                    {!image && (
                      <SelectItem value="bilingual">{copy('bilingual_7870ebe')}</SelectItem>
                    )}
                  </SelectField>
                </label>
                {video && (
                  <>
                    <label>
                      {copy('subtitle_size_a59b8cc')}
                      <input
                        type="number"
                        min={12}
                        max={120}
                        value={subtitle.fontSize}
                        onChange={(e) =>
                          setSubtitle({ ...subtitle, fontSize: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      {copy('subtitle_color_092a554')}
                      <input
                        type="color"
                        value={subtitle.color}
                        onChange={(e) => setSubtitle({ ...subtitle, color: e.target.value })}
                      />
                    </label>
                    <label>
                      {copy('subtitle_position_8f50864')}
                      <SelectField
                        value={subtitle.position}
                        onValueChange={(nextValue) =>
                          setSubtitle({ ...subtitle, position: nextValue as 'top' | 'bottom' })
                        }
                      >
                        <SelectItem value="bottom">{copy('bottom_cce7f2f')}</SelectItem>
                        <SelectItem value="top">{copy('top_cae0435')}</SelectItem>
                      </SelectField>
                    </label>
                  </>
                )}
                <label>
                  {copy('file_format_361a824')}
                  <SelectField value={format} onValueChange={(nextValue) => setFormat(nextValue)}>
                    {job &&
                      isTranslationTool(job.tool) &&
                      translationFormats(job.tool, data.format).map((f) => (
                        <SelectItem key={f} value={f}>
                          {f.toUpperCase()}
                        </SelectItem>
                      ))}
                  </SelectField>
                </label>
                <Button disabled={busy || job?.state !== 'completed'} onClick={() => generate()}>
                  <Download size={16} />
                  {autoDownload ? copy('generating_11edad7') : copy('save_download_b1ceec9')}
                </Button>
                <CostEstimate
                  tool={job?.tool || 'document-translator'}
                  operation={
                    downloadOpen && job?.state === 'completed' && saveState === 'saved'
                      ? {
                          path: `jobs/${id}/translation/exports`,
                          body: {
                            revision: revision.current,
                            format,
                            mode: outputMode,
                            preview: false,
                            previewStartMs: 0,
                            subtitle,
                          },
                        }
                      : null
                  }
                  note={copy('estimate_for_this_export_format_reusing_th_ffd40e6')}
                />
                {video && (
                  <Button
                    variant="outline"
                    disabled={busy || job?.state !== 'completed'}
                    onClick={() => generate(true)}
                  >
                    <Play size={16} />
                    {copy('preview_15_seconds_ffd8fc6')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        blocks
                          .filter((b) => !b.hidden)
                          .map((b) =>
                            outputMode === 'original'
                              ? b.sourceText
                              : outputMode === 'bilingual'
                                ? `${b.sourceText}\n${b.translatedText}`
                                : b.translatedText,
                          )
                          .join('\n\n'),
                      );
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      setError(copy('clipboard_is_unavailable_download_txt_inst_11c7bb0'));
                    }
                  }}
                >
                  <Copy size={15} />
                  {copied ? copy('copied_8e3df45') : copy('copy_text_06a76cc')}
                </Button>
              </div>
              {!!layoutIssues.length && outputMode !== 'original' && (
                <div className="reading-stale">
                  <p>
                    {copy('_value0_regions_need_adjustment_keep_their_47f25a1', {
                      value0: layoutIssues.length,
                    })}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || !!autoDownload}
                    onClick={async () => {
                      for (const b of layoutIssues)
                        change(b.id, { keepOriginal: true, reviewed: true });
                      await generate();
                    }}
                  >
                    {copy('keep_original_problem_regions_download_590f7aa')}
                  </Button>
                </div>
              )}
              <details
                className="translation-export-history"
                open={!!autoDownload || exports[0]?.state === 'failed'}
              >
                <summary>
                  {copy('generated_files_6bd3281')} · {exports.length}
                </summary>
                <div className="translation-export-list">
                  {exports.map((e) => (
                    <div key={e.id}>
                      <div>
                        <strong>
                          {e.options.format.toUpperCase()} · v{e.revision} ·{' '}
                          {e.options.mode === 'bilingual'
                            ? copy('bilingual_7870ebe')
                            : e.options.mode === 'original'
                              ? copy('original_c0a8060')
                              : copy('translated_c86099d')}
                          {e.options.preview ? ' · ' + copy('preview_f1fbb2b') : ''}
                        </strong>
                        {e.error && <p role="alert">{errorMessage(e.error, translateError)}</p>}
                      </div>
                      <div className="action-row">
                        {e.state === 'completed' ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openExport(e, false)}
                            >
                              {copy('download_a479c9c')}
                            </Button>
                            {['mp4', 'pdf', 'docx', 'png', 'jpg', 'webp'].includes(
                              e.options.format,
                            ) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openExport(e, true)}
                              >
                                {copy('view_result_a4a3e20')}
                              </Button>
                            )}
                          </>
                        ) : ['failed', 'cancelled'].includes(e.state) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              act(() => request(`translation-exports/${e.id}/retry`, {}))
                            }
                          >
                            {copy('retry_export_f58f53e')}
                          </Button>
                        ) : (
                          <>
                            <span role="status">{copy('generating_11edad7')}</span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                act(() => request(`translation-exports/${e.id}/cancel`, {}))
                              }
                            >
                              {copy('cancel_77dfd21')}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          </WorkspaceDialog>
        </>
      )}
      {preview && (
        <div
          className="translation-preview-modal"
          ref={previewArea}
          role="dialog"
          aria-modal="true"
          aria-label={copy('export_preview_0eb4eac')}
        >
          <div className="panel">
            <Button variant="outline" onClick={() => setPreview(null)}>
              {copy('close_preview_baa5503')}
            </Button>
            {preview.format === 'mp4' ? (
              <video src={preview.url} controls autoPlay />
            ) : preview.format === 'pdf' ? (
              <PdfPreview url={preview.url} />
            ) : (
              <img src={preview.url} alt={copy('exported_image_49a7c88')} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
