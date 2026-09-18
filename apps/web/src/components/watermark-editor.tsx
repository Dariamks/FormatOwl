'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import type { JobView } from '@filemorph/core/domain';
import type {
  WatermarkCandidate,
  WatermarkRegion,
  WatermarkRunOptions,
  WatermarkSelection,
  WatermarkView,
} from '@filemorph/core/watermark';
import {
  ArrowLeft,
  Check,
  Circle,
  CircleAlert,
  Download,
  Eraser,
  Image as ImageIcon,
  LoaderCircle,
  MousePointer2,
  Paintbrush,
  Redo2,
  RefreshCw,
  ScanLine,
  Square,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { Button } from './ui/button';
import './watermark.css';
import { WorkspaceDialog } from './workspace-dialog';
const empty: WatermarkSelection = { candidates: [], regions: [] };
function Media({
  path,
  alt,
  ...props
}: {
  path: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [url, setUrl] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl('');
    setFailed(false);
    request<{ url: string }>(path)
      .then((r) => {
        if (active) setUrl(r.url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return url ? (
    <img src={url} alt={alt} draggable={false} {...props} />
  ) : (
    <span className="wm-media-loading" role="status">
      {failed ? '⚠' : '…'}
    </span>
  );
}
const reasonLabels: Record<string, string> = {
  object: 'independent_object_review_first_4fab2b9',
  header: 'shared_header_footer_cc6f858',
  master: 'layout_master_object_0996f92',
  repeated: 'repeated_across_pages_27edbc2',
  rotated: 'rotated_text_object_954fc8c',
  transparent: 'transparent_drawing_7020a31',
  ocr: 'possible_text_watermark_4afcf42',
};
export default function WatermarkEditor({ id }: { id: string }) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('watermark');

  const locale = useLocale();
  const labelKeys: Record<string, string> = {
    Image: 'object_image',
    Shape: 'object_shape',
    'PDF image': 'object_pdfImage',
    'PDF text watermark': 'object_pdfText',
    'PDF text object': 'object_pdfText',
  };
  const label = (text: string) => (labelKeys[text] ? copy(labelKeys[text]) : text);
  const scopeLabel = (scope: string) =>
    scope
      .replace(/section (\d+)/g, (_, number) => copy('scope_section', { number }))
      .replace(/default|first|even|header|footer|layouts:|master|layout|slide/g, (word) =>
        copy('scope_' + word.replace(':', '')),
      );
  const [view, setView] = useState<WatermarkView | null>(null),
    [job, setJob] = useState<JobView | null>(null),
    [selection, setSelection] = useState<WatermarkSelection>(empty),
    [saved, setSaved] = useState<WatermarkSelection>(empty);
  const [page, setPage] = useState(0),
    [targetId, setTargetId] = useState(''),
    [mode, setMode] = useState<'select' | 'rect' | 'brush' | 'erase'>('select'),
    [radius, setRadius] = useState(0.015),
    [zoom, setZoom] = useState(100);
  const [compare, setCompare] = useState<'original' | 'result' | 'compare'>('original'),
    [split, setSplit] = useState(50),
    [format, setFormat] = useState('png');
  const [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [saving, setSaving] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [history, setHistory] = useState<WatermarkSelection[]>([]),
    [future, setFuture] = useState<WatermarkSelection[]>([]);
  const [copyRegions, setCopyRegions] = useState<WatermarkRegion[] | null>(null),
    [copyTargets, setCopyTargets] = useState<string[]>([]);
  const [draft, setDraft] = useState<WatermarkRegion | null>(null),
    [match, setMatch] = useState<WatermarkCandidate | null>(null),
    [matchIds, setMatchIds] = useState<string[]>([]),
    [focus, setFocus] = useState('');
  const initialized = useRef(false),
    selectionRef = useRef(empty),
    savedRef = useRef(empty),
    revision = useRef(0),
    saveInFlight = useRef<Promise<void> | null>(null),
    submitLock = useRef(false),
    loadSequence = useRef(0),
    drag = useRef<{ x: number; y: number; region: WatermarkRegion } | null>(null);
  const prefix = 'jobs/' + id + '/watermark';
  const load = useCallback(
    async (reset = false) => {
      const sequence = ++loadSequence.current;
      try {
        const [v, j] = await Promise.all([
          request<WatermarkView>(prefix),
          request<{ job: JobView }>('jobs/' + id),
        ]);
        if (sequence !== loadSequence.current) return;
        setView(v);
        setJob(j.job);
        if (v.data && (!initialized.current || reset)) {
          initialized.current = true;
          selectionRef.current = v.selection;
          savedRef.current = v.selection;
          revision.current = v.revision;
          setSelection(v.selection);
          setSaved(v.selection);
          setHistory([]);
          setFuture([]);
          setConflict(false);
          setFormat(['jpg', 'jpeg', 'png', 'webp'].includes(v.data.format) ? 'png' : v.data.format);
          setTargetId(v.data.targets.some((x) => x.id === 'image') ? 'image' : '');
        } else if (v.revision > revision.current && !saveInFlight.current) {
          if (JSON.stringify(selectionRef.current) !== JSON.stringify(savedRef.current)) {
            setConflict(true);
            setError(errorMessage('WATERMARK_CONFLICT', translateError));
          } else {
            revision.current = v.revision;
            selectionRef.current = v.selection;
            savedRef.current = v.selection;
            setSelection(v.selection);
            setSaved(v.selection);
            setHistory([]);
            setFuture([]);
          }
        }
      } catch (e) {
        setError(errorMessage(e, translateError));
      }
    },
    [id, locale, prefix],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);
  const dirty = JSON.stringify(selection) !== JSON.stringify(saved),
    active = view?.runs.find((r) => ['queued', 'processing', 'cancelling'].includes(r.state));
  const busy = !!active || submitting || job?.state === 'queued' || job?.state === 'processing';
  async function saveNow() {
    if (saveInFlight.current) await saveInFlight.current;
    if (JSON.stringify(selectionRef.current) === JSON.stringify(savedRef.current)) return;
    const snapshot = selectionRef.current;
    setSaving(true);
    const action = (async () => {
      const r = await request<{ revision: number }>(
        prefix,
        { revision: revision.current, ...snapshot },
        'PATCH',
      );
      revision.current = r.revision;
      savedRef.current = snapshot;
      setSaved(snapshot);
    })();
    saveInFlight.current = action;
    try {
      await action;
    } finally {
      saveInFlight.current = null;
      setSaving(false);
    }
  }
  useEffect(() => {
    if (!dirty || conflict || !initialized.current) return;
    const timer = setTimeout(
      () =>
        void saveNow().catch((e) => {
          setError(errorMessage(e, translateError));
          if ((e as { code?: string }).code === 'WATERMARK_CONFLICT') setConflict(true);
        }),
      650,
    );
    return () => clearTimeout(timer);
  }, [selection, saved, conflict, saving]);
  function change(next: WatermarkSelection) {
    if (busy || conflict) return;
    setHistory((h) => [...h.slice(-49), selectionRef.current]);
    setFuture([]);
    selectionRef.current = next;
    setSelection(next);
    setCompare('original');
    setError('');
  }
  function undo() {
    const prev = history.at(-1);
    if (!prev) return;
    setFuture((f) => [selection, ...f]);
    setHistory((h) => h.slice(0, -1));
    selectionRef.current = prev;
    setSelection(prev);
    setCompare('original');
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setHistory((h) => [...h, selection]);
    setFuture((f) => f.slice(1));
    selectionRef.current = next;
    setSelection(next);
    setCompare('original');
  }
  async function submit(kind: WatermarkRunOptions['kind'], auto = false) {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    if (!auto) setError('');
    try {
      await saveNow();
      await request(prefix + '/runs', {
        requestId: crypto.randomUUID(),
        revision: revision.current,
        kind,
        ...(kind === 'detect' ? { targetId } : kind === 'preview' ? { page } : { format }),
      });
      if (kind === 'preview') {
        if (targetId !== 'image') setTargetId('');
        setMode('select');
        setCompare('result');
      }
      if (kind === 'detect') setCompare('original');
      await load();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }
  useEffect(() => {
    if (
      !view?.data ||
      !targetId ||
      !view.capabilities.ocr ||
      busy ||
      conflict ||
      view.data.detected.includes(targetId) ||
      view.runs.some((r) => r.options.kind === 'detect' && r.options.targetId === targetId)
    )
      return;
    void submit('detect', true);
  }, [targetId, view?.data?.detected.join(','), view?.capabilities.ocr, busy]);
  async function actionRun(runId: string, action: 'retry' | 'cancel') {
    setError('');
    try {
      await request('watermark-runs/' + runId + '/' + action, {});
      await load();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  async function download(runId: string) {
    try {
      const { url } = await request<{ url: string }>('watermark-runs/' + runId + '/download');
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  const data = view?.data,
    target = data?.targets.find((x) => x.id === targetId),
    current = data?.pages[page];
  const preview = view?.runs.find(
    (r) =>
      r.state === 'completed' &&
      r.revision === revision.current &&
      r.options.kind !== 'detect' &&
      r.pages.includes(page),
  );
  const downloadable = view?.runs.find(
    (r) =>
      r.state === 'completed' &&
      r.revision === revision.current &&
      r.options.kind === 'export' &&
      r.options.format === format,
  );
  const resultUsable = preview && !dirty && !busy && (!target || target.id === 'image');
  const width = target?.width || current?.width || 1,
    height = target?.height || current?.height || 1;
  const regions = [
    ...selection.regions.filter((r) => r.targetId === targetId),
    ...(data?.candidates
      .filter((c) => selection.candidates.includes(c.id) && c.targetId === targetId && c.region)
      .map((c) => c.region!) || []),
  ];
  const candidates =
    data?.candidates.filter((c) => (target ? c.targetId === target.id : c.pages.includes(page))) ||
    [];
  const allSelected = selection.candidates.length + selection.regions.length;
  function toggle(c: WatermarkCandidate) {
    setFocus(c.id);
    if (!target && c.targetId) setTargetId(c.targetId);
    change({
      ...selection,
      candidates: selection.candidates.includes(c.id)
        ? selection.candidates.filter((id) => id !== c.id)
        : [...selection.candidates, c.id],
    });
  }
  function coords(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (!target || mode === 'select' || busy || conflict || compare !== 'original') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = coords(e),
      r: WatermarkRegion = {
        id: crypto.randomUUID(),
        targetId,
        kind: mode === 'rect' ? 'rect' : 'brush',
        x: mode === 'rect' ? x : 0,
        y: mode === 'rect' ? y : 0,
        width: mode === 'rect' ? 0 : 1,
        height: mode === 'rect' ? 0 : 1,
        strokes: mode === 'rect' ? [] : [{ erase: mode === 'erase', radius, points: [[x, y]] }],
      };
    drag.current = { x, y, region: r };
    setDraft(r);
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current) return;
    const d = drag.current,
      { x, y } = coords(e);
    if (mode === 'rect')
      d.region = {
        ...d.region,
        x: Math.min(d.x, x),
        y: Math.min(d.y, y),
        width: Math.abs(x - d.x),
        height: Math.abs(y - d.y),
      };
    else {
      const stroke = d.region.strokes[0];
      if (stroke.points.length < 2000) stroke.points.push([x, y]);
      d.region = { ...d.region, strokes: [{ ...stroke }] };
    }
    setDraft({ ...d.region });
  }
  function up() {
    if (!drag.current) return;
    const r = drag.current.region;
    drag.current = null;
    setDraft(null);
    if (mode === 'erase') {
      const converted = selection.candidates.filter(
        (id) => data?.candidates.find((c) => c.id === id)?.targetId === targetId,
      );
      const masks = [
        ...selection.regions,
        ...(data?.candidates
          .filter((c) => converted.includes(c.id) && c.region)
          .map((c) => c.region!) || []),
      ];
      change({
        candidates: selection.candidates.filter((id) => !converted.includes(id)),
        regions: masks.map((m) =>
          m.targetId === targetId ? { ...m, strokes: [...m.strokes, ...r.strokes] } : m,
        ),
      });
    } else if (r.width * width >= 2 && r.height * height >= 2)
      change({ ...selection, regions: [...selection.regions, r] });
  }
  function shapes(r: WatermarkRegion) {
    return (
      <>
        {r.kind === 'rect' && (
          <rect
            x={r.x * width}
            y={r.y * height}
            width={r.width * width}
            height={r.height * height}
            fill="white"
          />
        )}
        {r.strokes.map((s, i) => (
          <g
            key={i}
            fill={s.erase ? 'black' : 'white'}
            stroke={s.erase ? 'black' : 'white'}
            strokeWidth={2 * s.radius * Math.min(width, height)}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline
              fill="none"
              points={s.points.map((p) => p[0] * width + ',' + p[1] * height).join(' ')}
            />
            {s.points.length === 1 && (
              <circle
                cx={s.points[0][0] * width}
                cy={s.points[0][1] * height}
                r={s.radius * Math.min(width, height)}
                stroke="none"
              />
            )}
          </g>
        ))}
      </>
    );
  }
  useLocaleGuard({ busy: saving || submitting, dirty: dirty || Boolean(draft) });
  if (!data || !current)
    return (
      <main className="page-width wm-entry">
        <Link className="back-link" href={'/' + locale + '/workspace'}>
          <ArrowLeft size={16} />
          {copy('workspace_4ca0a75')}
        </Link>
        <div className="wm-upload">
          <ScanLine size={40} />
          <h1>{job?.name || copy('loading_8f26c65')}</h1>
          <p>
            {job?.state === 'failed'
              ? errorMessage(job.error, translateError)
              : copy('reading_the_file_structure_and_preparing_p_5907830')}
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {['failed', 'cancelled'].includes(job?.state || '') ? (
            <Button
              onClick={() =>
                void request('jobs/' + id + '/retry', {})
                  .then(() => load())
                  .catch((e) => setError(errorMessage(e, translateError)))
              }
            >
              {copy('retry_analysis_b6d5316')}
            </Button>
          ) : (
            job?.state !== 'expired' && (
              <Button
                variant="outline"
                onClick={() => void request('jobs/' + id + '/cancel', {}).then(() => load())}
              >
                {copy('cancel_77dfd21')}
              </Button>
            )
          )}
        </div>
      </main>
    );
  const originalPath =
    prefix + '/media?' + (target ? 'target=' + encodeURIComponent(target.id) : 'page=' + page);
  return (
    <main className="wm-workspace">
      <header className="wm-topbar">
        <div className="wm-title">
          <Link href={'/' + locale + '/workspace'} aria-label={copy('back_to_workspace_1d99bfb')}>
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1>{job?.name}</h1>
            <span aria-live="polite">
              {conflict
                ? copy('version_conflict_ec603f7')
                : saving
                  ? copy('saving_56a2285')
                  : dirty
                    ? copy('unsaved_changes_2926726')
                    : copy('saved_c0ae8f6')}{' '}
              · {copy('remove_watermarks_ee56e7a')}
            </span>
          </div>
        </div>
        <div className="wm-top-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={!history.length || busy || conflict}
            onClick={undo}
            aria-label={copy('undo_39fc721')}
          >
            <Undo2 size={17} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!future.length || busy || conflict}
            onClick={redo}
            aria-label={copy('redo_471b94d')}
          >
            <Redo2 size={17} />
          </Button>
          <Button
            size="sm"
            disabled={busy || dirty || !downloadable}
            onClick={() => downloadable && download(downloadable.id)}
          >
            <Download size={16} />
            {copy('download_a479c9c')}
          </Button>
        </div>
      </header>
      {error && (
        <div className="wm-banner error-banner" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label={copy('dismiss_70afe9e')}>
            <X size={16} />
          </button>
          {conflict && (
            <Button size="sm" variant="outline" onClick={() => void load(true)}>
              {copy('reload_saved_version_83688d3')}
            </Button>
          )}
        </div>
      )}
      {active && (
        <div className="wm-banner" role="status">
          <LoaderCircle className="spinner" size={17} />
          {active.options.kind === 'detect'
            ? copy('finding_possible_watermarks_9b6e216')
            : copy('processing_your_selection_38a42a6')}{' '}
          {active.progress}%
          <Button
            variant="outline"
            size="sm"
            onClick={() => actionRun(active.id, 'cancel')}
            disabled={active.state === 'cancelling'}
          >
            {copy('cancel_77dfd21')}
          </Button>
        </div>
      )}
      <div className={'wm-layout ' + (data.pages.length === 1 ? 'wm-single' : '')}>
        {data.pages.length > 1 && (
          <nav className="wm-pages" aria-label={copy('pages_600584c')}>
            {data.pages.map((p) => {
              const modified =
                data.candidates.some(
                  (c) => selection.candidates.includes(c.id) && c.pages.includes(p.index),
                ) ||
                selection.regions.some((r) =>
                  data.targets.find((x) => x.id === r.targetId)?.pages.includes(p.index),
                );
              const hasCandidate = data.candidates.some((c) => c.pages.includes(p.index));
              const failed =
                view!.runs.find(
                  (r) =>
                    r.revision === revision.current &&
                    r.options.kind !== 'detect' &&
                    (r.options.kind === 'export' ? modified : r.options.page === p.index),
                )?.state === 'failed';
              return (
                <button
                  key={p.index}
                  className={page === p.index ? 'active' : ''}
                  onClick={() => {
                    setPage(p.index);
                    setTargetId('');
                    setMode('select');
                    setCompare('original');
                  }}
                  aria-label={copy('page_value0_23ce682', { value0: p.index + 1 })}
                  aria-current={page === p.index ? 'page' : undefined}
                >
                  <Media path={prefix + '/media?page=' + p.index} alt="" />
                  <span>
                    {p.index + 1}
                    {failed ? (
                      <CircleAlert size={12} aria-label={copy('processing_failed_7cd54da')} />
                    ) : modified ? (
                      <Check size={12} aria-label={copy('modified_19a532c')} />
                    ) : hasCandidate ? (
                      <Circle size={10} aria-label={copy('possible_watermark_76dee80')} />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        <section className="wm-main">
          <div className="wm-toolbar">
            <div className="wm-tools">
              {(
                [
                  ['select', MousePointer2, copy('select_object_10c1d5e')],
                  ['rect', Square, copy('rectangle_c158695')],
                  ['brush', Paintbrush, copy('brush_25f0852')],
                  ['erase', Eraser, copy('erase_selection_1fdc82b')],
                ] as const
              ).map(([key, Icon, label]) => (
                <button
                  key={key}
                  aria-label={label}
                  title={label}
                  aria-pressed={mode === key}
                  disabled={busy || conflict || (!target && key !== 'select')}
                  onClick={() => {
                    setMode(key);
                    setCompare('original');
                  }}
                >
                  <Icon size={18} />
                </button>
              ))}
              {(mode === 'brush' || mode === 'erase') && (
                <input
                  aria-label={copy('brush_size_6c0c786')}
                  type="range"
                  min="0.003"
                  max="0.08"
                  step="0.002"
                  value={radius}
                  onChange={(e) => setRadius(+e.target.value)}
                />
              )}
            </div>
            <div className="wm-tools">
              <button
                aria-label={copy('zoom_out_a4ae4b2')}
                onClick={() => setZoom((z) => Math.max(25, z - 25))}
              >
                <ZoomOut size={17} />
              </button>
              <span>{zoom}%</span>
              <button
                aria-label={copy('zoom_in_4fc05f2')}
                onClick={() => setZoom((z) => Math.min(300, z + 25))}
              >
                <ZoomIn size={17} />
              </button>
            </div>
          </div>
          {target && target.id !== 'image' && (
            <div className="wm-context">
              <ImageIcon size={15} />
              {copy('editing_embedded_image_a24bd86')}
              <button
                onClick={() => {
                  setTargetId('');
                  setMode('select');
                }}
              >
                {copy('back_to_document_53ca776')}
              </button>
            </div>
          )}
          <div className="wm-canvas-scroll">
            <div
              className="wm-canvas"
              style={{
                width: (Math.min(900, width) * zoom) / 100,
                aspectRatio: width + '/' + height,
                maxWidth: zoom <= 100 ? '100%' : 'none',
              }}
            >
              <Media path={originalPath} alt={copy('original_file_9139c8d')} />
              {compare !== 'original' && resultUsable && (
                <Media
                  className="wm-result-image"
                  path={prefix + '/media?page=' + page + '&run=' + preview.id}
                  alt={copy('processed_result_99f9b13')}
                  style={{
                    clipPath:
                      compare === 'compare' ? 'inset(0 ' + (100 - split) + '% 0 0)' : undefined,
                  }}
                />
              )}
              {compare === 'original' && (
                <svg
                  viewBox={'0 0 ' + width + ' ' + height}
                  className={'wm-overlay ' + (mode !== 'select' && target ? 'drawing' : '')}
                  aria-label={copy('watermark_selection_canvas_390fbc1')}
                  onPointerDown={down}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={() => {
                    drag.current = null;
                    setDraft(null);
                  }}
                >
                  {target &&
                    [...regions, ...(draft ? [draft] : [])].map((r, i) => (
                      <g key={r.id}>
                        <defs>
                          <mask
                            id={'mask-' + i}
                            maskUnits="userSpaceOnUse"
                            x="0"
                            y="0"
                            width={width}
                            height={height}
                          >
                            {shapes(r)}
                          </mask>
                        </defs>
                        <rect
                          width={width}
                          height={height}
                          fill={mode === 'erase' && draft?.id === r.id ? '#182126' : '#5865e8'}
                          fillOpacity=".38"
                          mask={'url(#mask-' + i + ')'}
                        />
                      </g>
                    ))}
                  {candidates.map((c) => {
                    const boxes =
                      target && c.region
                        ? [{ ...c.region, page }]
                        : c.boxes.filter((b) => b.page === page);
                    return boxes.map((b, i) => (
                      <rect
                        key={c.id + '-' + i}
                        x={b.x * width}
                        y={b.y * height}
                        width={b.width * width}
                        height={b.height * height}
                        className={
                          'wm-object ' +
                          (selection.candidates.includes(c.id) ? 'selected' : '') +
                          ' ' +
                          (focus === c.id ? 'focused' : '')
                        }
                        vectorEffect="non-scaling-stroke"
                        role="button"
                        tabIndex={mode === 'select' ? 0 : -1}
                        aria-label={c.label}
                        style={{ pointerEvents: mode === 'select' ? 'auto' : 'none' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(c);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggle(c);
                          }
                        }}
                      />
                    ));
                  })}
                </svg>
              )}
              {compare === 'compare' && resultUsable && (
                <div className="wm-divider" style={{ left: split + '%' }} />
              )}
            </div>
          </div>
          <div className="wm-comparison">
            <div>
              {(['original', 'result', 'compare'] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={compare === v}
                  disabled={v !== 'original' && !resultUsable}
                  onClick={() => setCompare(v)}
                >
                  {v === 'original'
                    ? copy('original_c0a8060')
                    : v === 'result'
                      ? copy('result_5faa59d')
                      : copy('compare_8d105cf')}
                </button>
              ))}
            </div>
            {compare === 'compare' && resultUsable && (
              <input
                type="range"
                min="0"
                max="100"
                value={split}
                aria-label={copy('comparison_position_0a7f2ab')}
                onChange={(e) => setSplit(+e.target.value)}
              />
            )}
            <span>
              {dirty
                ? copy('selection_changed_update_the_preview_c351466')
                : copy('page_value0_of_value1_74bea86', {
                    value0: page + 1,
                    value1: data.pages.length,
                  })}
            </span>
          </div>
        </section>
        <aside className="wm-panel">
          <div className="wm-panel-title">
            <h2>{copy('watermarks_selections_84eb05c')}</h2>
            <span>{allSelected}</span>
          </div>
          <p className="wm-muted">{copy('candidates_are_never_removed_automatically_a9fb6af')}</p>
          {!!target && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || conflict || !view?.capabilities.ocr}
              onClick={() => void submit('detect')}
            >
              <ScanLine size={16} />
              {data.detected.includes(target.id)
                ? copy('detect_watermarks_again_e1ad430')
                : copy('detect_in_this_image_fc60dc0')}
            </Button>
          )}
          {!view?.capabilities.ocr && (
            <p className="wm-muted">{copy('ocr_is_unavailable_you_can_select_regions_44047c9')}</p>
          )}
          <div className="wm-candidates">
            {candidates.length === 0 ? (
              <div className="wm-empty">
                <ScanLine size={25} />
                <p>{copy('no_selectable_watermark_found_f755796')}</p>
                <span>
                  {target
                    ? copy('use_the_rectangle_or_brush_to_add_a_region_9328b03')
                    : copy('open_an_image_below_for_local_repair_objec_8041eb1')}
                </span>
              </div>
            ) : (
              candidates.map((c) => (
                <div key={c.id} className={'wm-candidate ' + (focus === c.id ? 'focused' : '')}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selection.candidates.includes(c.id)}
                      disabled={busy || conflict}
                      onChange={() => toggle(c)}
                    />
                    <span>
                      <strong>{label(c.label)}</strong>
                      <small>{copy(reasonLabels[c.reason])}</small>
                      <small>
                        {copy('affected_pages_49d7d00')}
                        {c.pages.map((p) => p + 1).join(', ')}
                        {c.reason === 'header' || c.reason === 'master'
                          ? ' · ' + scopeLabel(c.scope)
                          : ''}
                      </small>
                    </span>
                  </label>
                  {data.format === 'pdf' &&
                    data.candidates.filter((x) => x.group === c.group).length > 1 && (
                      <button
                        className="wm-text-button"
                        disabled={busy || conflict}
                        onClick={() => {
                          setMatch(c);
                          setMatchIds(
                            selection.candidates.filter(
                              (id) => data.candidates.find((x) => x.id === id)?.group === c.group,
                            ),
                          );
                        }}
                      >
                        {copy('apply_to_matching_pages_ec5f7e6')}
                      </button>
                    )}
                </div>
              ))
            )}
          </div>
          {selection.regions
            .filter((r) => r.targetId === targetId)
            .map((r, i) => (
              <div className="wm-region-row" key={r.id}>
                <span>
                  {r.kind === 'rect' ? copy('rectangle_c158695') : copy('brush_25f0852')} {i + 1}
                </span>
                <button
                  aria-label={copy('delete_region_d2341bd')}
                  disabled={busy || conflict}
                  onClick={() =>
                    change({
                      ...selection,
                      regions: selection.regions.filter((x) => x.id !== r.id),
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          {data.targets.some((x) => x.id !== 'image' && x.pages.includes(page)) && (
            <div className="wm-embedded">
              <h3>{copy('images_on_this_page_d5bb45a')}</h3>
              {data.targets
                .filter((x) => x.id !== 'image' && x.pages.includes(page))
                .map((x) => (
                  <button
                    key={x.id}
                    onClick={() => {
                      setTargetId(x.id);
                      setMode('rect');
                      setCompare('original');
                    }}
                  >
                    <ImageIcon size={16} />
                    <span>
                      {label(x.label)}
                      <small>
                        {x.width} × {x.height}
                      </small>
                    </span>
                  </button>
                ))}
            </div>
          )}
          {data.format === 'pdf' && target && regions.length > 0 && data.targets.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || conflict}
              onClick={() => {
                setCopyRegions(regions);
                setCopyTargets([]);
              }}
            >
              {copy('apply_regions_to_other_pages_a305d78')}
            </Button>
          )}
          <div className="wm-export">
            <p className="wm-muted">
              {data.format === 'pdf'
                ? copy('text_and_page_structure_are_preserved_scan_a1d6c6c')
                : copy('ai_repair_may_change_details_inside_the_se_a0c38f6')}
            </p>
            <Button
              variant="outline"
              disabled={busy || conflict || !allSelected}
              onClick={() => void submit('preview')}
            >
              {busy ? <LoaderCircle size={16} className="spinner" /> : <ScanLine size={16} />}{' '}
              {copy('preview_this_page_6cbbb5e')}
            </Button>
            {['jpg', 'jpeg', 'png', 'webp'].includes(data.format) && (
              <label className="wm-format">
                {copy('output_format_c03f08a')}
                <select value={format} onChange={(e) => setFormat(e.target.value)}>
                  <option value="png">PNG</option>
                  <option value="jpg">JPG</option>
                  <option value="webp">WebP</option>
                </select>
              </label>
            )}
            <Button
              disabled={busy || conflict || !allSelected}
              onClick={() => void submit('export')}
            >
              <Download size={16} />
              {copy('process_all_selections_export_65d14fe')}
            </Button>
            <CostEstimate
              tool={job?.tool || 'image-watermark-remover'}
              operation={
                !dirty && !conflict && allSelected
                  ? {
                      path: prefix + '/runs',
                      body: { revision: revision.current, kind: 'export', format },
                    }
                  : null
              }
              note={
                dirty
                  ? copy('the_estimate_updates_after_selections_are_69c42f1')
                  : copy('total_for_processing_and_exporting_all_sel_35ed264')
              }
            />
            {downloadable && !dirty && (
              <Button variant="outline" onClick={() => download(downloadable.id)}>
                <Download size={16} />
                {copy('download_value0_e164995', { value0: format.toUpperCase() })}
              </Button>
            )}
          </div>
          {view!.runs
            .filter((r) => ['failed', 'cancelled'].includes(r.state))
            .slice(0, 3)
            .map((r) => (
              <div className="wm-run-error" key={r.id}>
                <span>
                  {r.error
                    ? errorMessage(r.error, translateError)
                    : copy('processing_cancelled_4c14216')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => actionRun(r.id, 'retry')}
                >
                  <RefreshCw size={14} />
                  {copy('retry_this_version_0d4f220')}
                </Button>
              </div>
            ))}
        </aside>
      </div>
      {copyRegions && (
        <WorkspaceDialog
          open
          onClose={() => setCopyRegions(null)}
          label={copy('review_target_pages_c7f62c1')}
        >
          <section className="wm-modal">
            <h2>{copy('review_target_pages_c7f62c1')}</h2>
            <p>{copy('copy_regions_at_the_same_relative_image_po_586b2bc')}</p>
            <div>
              {data.targets
                .filter((x) => x.id !== targetId)
                .map((x) => (
                  <label key={x.id}>
                    <input
                      type="checkbox"
                      checked={copyTargets.includes(x.id)}
                      onChange={() =>
                        setCopyTargets((ids) =>
                          ids.includes(x.id) ? ids.filter((id) => id !== x.id) : [...ids, x.id],
                        )
                      }
                    />
                    {copy('page_value0_23ce682', { value0: x.pages.map((p) => p + 1).join(', ') })}{' '}
                    · {x.width} × {x.height}
                  </label>
                ))}
            </div>
            <div className="action-row">
              <Button variant="outline" onClick={() => setCopyRegions(null)}>
                {copy('cancel_77dfd21')}
              </Button>
              <Button
                disabled={!copyTargets.length}
                onClick={() => {
                  change({
                    ...selection,
                    regions: [
                      ...selection.regions,
                      ...copyTargets.flatMap((targetId) =>
                        copyRegions.map((r) => ({
                          ...structuredClone(r),
                          id: crypto.randomUUID(),
                          targetId,
                        })),
                      ),
                    ],
                  });
                  setCopyRegions(null);
                }}
              >
                {copy('copy_regions_3696458')}
              </Button>
            </div>
          </section>
        </WorkspaceDialog>
      )}
      {match && (
        <WorkspaceDialog
          open={!!match}
          onClose={() => setMatch(null)}
          label={copy('review_matching_pages_542b034')}
        >
          <section className="wm-modal" aria-labelledby="wm-match-title">
            <h2 id="wm-match-title">{copy('review_matching_pages_542b034')}</h2>
            <p>{match.label}</p>
            <div>
              {data.candidates
                .filter((c) => c.group === match.group)
                .map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={matchIds.includes(c.id)}
                      onChange={() =>
                        setMatchIds((ids) =>
                          ids.includes(c.id) ? ids.filter((id) => id !== c.id) : [...ids, c.id],
                        )
                      }
                    />
                    {copy('page_value0_23ce682', { value0: c.pages.map((p) => p + 1).join(', ') })}
                  </label>
                ))}
            </div>
            <div className="action-row">
              <Button variant="outline" onClick={() => setMatch(null)}>
                {copy('cancel_77dfd21')}
              </Button>
              <Button
                onClick={() => {
                  const groupIds = data.candidates
                    .filter((c) => c.group === match.group)
                    .map((c) => c.id);
                  change({
                    ...selection,
                    candidates: [
                      ...selection.candidates.filter((id) => !groupIds.includes(id)),
                      ...matchIds,
                    ],
                  });
                  setMatch(null);
                }}
              >
                {copy('apply_to_selected_pages_fa544ff')}
              </Button>
            </div>
          </section>
        </WorkspaceDialog>
      )}
    </main>
  );
}
