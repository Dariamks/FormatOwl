'use client';
import { LocaleSelect } from './locale-select';
import { useErrorTranslator } from '@/i18n/errors';
import { isLocaleUnloadAllowed, useLocaleGuard } from '@/i18n/switch-guard';
import { ApiError, errorMessage, request } from '@/lib/client-api';
import type { JobView } from '@filemorph/core/domain';
import type { PreparationView } from '@filemorph/core/editing';
import { transcriptReadingData } from '@filemorph/core/transcript-reading';
import type {
  TranscriptExportOptions,
  TranscriptExportView,
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptView,
} from '@filemorph/core/transcription';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileAudio,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { ReadingPanel } from './reading-panel';
import './transcript-workspace.css';
import './translation-workspace.css';
import { Button } from './ui/button';
import { SelectField, SelectItem } from './ui/select';

function clock(seconds: number) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${n >= 3600 ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

type Patch = {
  upsert?: TranscriptSegment[];
  remove?: string[];
  speakerUpsert?: TranscriptSpeaker[];
  mergeSpeaker?: { from: string; to: string };
};
export default function TranscriptEditor({ id }: { id: string }) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('transcription');
  const common = useTranslations('common');
  const transcriptSpeakerName = (speaker: { name: string }, index: number, _locale?: string) =>
    /^\d+ · /u.test(speaker.name) ? common('speaker', { number: index + 1 }) : speaker.name;

  const locale = useLocale(),
    w = useTranslations('workspace');
  const [job, setJob] = useState<JobView | null>(null),
    [view, setView] = useState<TranscriptView | null>(null),
    [error, setError] = useState(''),
    [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved'),
    [conflict, setConflict] = useState(false),
    [mutating, setMutating] = useState(false),
    [url, setUrl] = useState(''),
    [exports, setExports] = useState<TranscriptExportView[]>([]),
    [format, setFormat] = useState<TranscriptExportOptions['format']>('txt'),
    [exportOpen, setExportOpen] = useState(false),
    [includeSpeakers, setIncludeSpeakers] = useState(true),
    [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [editing, setEditing] = useState<string | null>(null),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1),
    [muted, setMuted] = useState(false),
    [autoScroll, setAutoScroll] = useState(true),
    [showAI, setShowAI] = useState(true),
    [mobileTab, setMobileTab] = useState<'transcript' | 'ai'>('transcript'),
    [copied, setCopied] = useState(''),
    [copying, setCopying] = useState(false),
    [audioReady, setAudioReady] = useState(false),
    [audioError, setAudioError] = useState(false);
  const exportDialog = useRef<HTMLDialogElement>(null),
    resumePlayback = useRef<{ time: number; playing: boolean } | null>(null),
    speakerDialog = useRef<HTMLDialogElement>(null),
    transcriptScroll = useRef<HTMLDivElement>(null),
    player = useRef<HTMLAudioElement>(null),
    revision = useRef(0),
    dirty = useRef(new Map<string, TranscriptSegment>()),
    orderChanged = useRef(false),
    chain = useRef<Promise<unknown>>(Promise.resolve()),
    operationActive = useRef(false),
    blocked = useRef(false),
    mounted = useRef(true),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = job?.state === 'completed' && !conflict && !mutating;
  const fail = useCallback(
    (e: unknown) => {
      if (!mounted.current) return;
      setError(errorMessage(e, translateError));
      setSaveState('failed');
      if (e instanceof ApiError && e.code === 'TRANSCRIPT_CONFLICT') {
        blocked.current = true;
        setConflict(true);
      }
    },
    [locale],
  );
  const refresh = useCallback(async () => {
    try {
      const j = await request<{ job: JobView }>(`jobs/${id}`);
      if (!mounted.current) return;
      setJob(j.job);
      const list = await request<{ exports: TranscriptExportView[] }>(
        `jobs/${id}/transcript/exports`,
      );
      if (mounted.current) setExports(list.exports);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e, translateError));
    }
  }, [id, locale]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [refresh]);
  const load = useCallback(async () => {
    const v = await request<TranscriptView>(`jobs/${id}/transcript`);
    if (mounted.current) {
      setView(v);
      revision.current = v.revision;
    }
  }, [id]);
  useEffect(() => {
    if (job && !dirty.current.size) void load().catch(fail);
  }, [job?.state, job?.state === 'processing' ? job.progress : 0, load, fail]);
  useEffect(() => {
    if (!job || job.tool !== 'transcription') return;
    let active = true;
    const updatePreview = (next: string) => {
      if (!active) return;
      const audio = player.current;
      if (audio?.readyState && audio.getAttribute('src') !== next)
        resumePlayback.current = { time: audio.currentTime, playing: !audio.paused };
      setUrl(next);
    };
    const fetchPreview = async () => {
      try {
        const p = await request<PreparationView>(
          `assets/${job.sourceIds[0]}/prepare?profile=audio&streamIndex=${job.options.streamIndex}`,
        );
        if (active && p.previewUrl) updatePreview(p.previewUrl);
      } catch {
        try {
          const p = await request<PreparationView>(
            `assets/${job.sourceIds[0]}/prepare?profile=audio&streamIndex=-1`,
          );
          if (active && p.previewUrl && p.media?.defaultAudioIndex === job.options.streamIndex)
            updatePreview(p.previewUrl);
        } catch {}
      }
    };
    void fetchPreview();
    const timer = setInterval(() => void fetchPreview(), 12 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.tool, job?.attempt]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (!isLocaleUnloadAllowed() && dirty.current.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const flush = useCallback(() => {
    const operation = chain.current
      .catch(() => {})
      .then(async () => {
        if (blocked.current) throw new ApiError('TRANSCRIPT_CONFLICT', 409);
        while (dirty.current.size) {
          if (mounted.current) setSaveState('saving');
          const batch: TranscriptSegment[] = [];
          for (const s of dirty.current.values()) {
            if (
              batch.length >= 20 ||
              new TextEncoder().encode(
                JSON.stringify({ revision: revision.current, upsert: [...batch, s] }),
              ).length > 30000
            )
              break;
            batch.push(s);
          }
          if (!batch.length) throw new ApiError('REQUEST_TOO_LARGE', 413);
          const response = await request<{ revision: number }>(
            `jobs/${id}/transcript`,
            { revision: revision.current, upsert: batch },
            'PATCH',
          );
          revision.current = response.revision;
          for (const s of batch)
            if (JSON.stringify(dirty.current.get(s.id)) === JSON.stringify(s))
              dirty.current.delete(s.id);
          if (mounted.current) setView((v) => (v ? { ...v, revision: response.revision } : v));
        }
        if (mounted.current) {
          setSaveState('saved');
          setError('');
        }
      });
    chain.current = operation;
    operation.catch(fail);
    return operation;
  }, [id, fail]);
  function edit(segment: TranscriptSegment) {
    const previous = view?.segments.find((s) => s.id === segment.id);
    if (previous && (previous.startMs !== segment.startMs || previous.endMs !== segment.endMs))
      orderChanged.current = true;
    dirty.current.set(segment.id, segment);
    setSaveState('saving');
    setView((v) =>
      v ? { ...v, segments: v.segments.map((s) => (s.id === segment.id ? segment : s)) } : v,
    );
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush().catch(() => {}), 700);
  }
  async function structural(patch: Patch, update: (v: TranscriptView) => TranscriptView) {
    if (operationActive.current) return;
    operationActive.current = true;
    setMutating(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const operation = flush().then(async () => {
        const response = await request<{ revision: number }>(
          `jobs/${id}/transcript`,
          { revision: revision.current, ...patch },
          'PATCH',
        );
        revision.current = response.revision;
        setView((v) => (v ? { ...update(v), revision: response.revision } : v));
        setSaveState('saved');
      });
      chain.current = operation;
      await operation;
    } catch (e) {
      fail(e);
    } finally {
      operationActive.current = false;
      setMutating(false);
    }
  }
  async function exportFile() {
    if (operationActive.current) return;
    operationActive.current = true;
    setMutating(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const operation = flush().then(async () => {
        await request(`jobs/${id}/transcript/exports`, {
          revision: revision.current,
          format,
          includeSpeakers,
          includeTimestamps,
        });
      });
      chain.current = operation;
      await operation;
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      operationActive.current = false;
      setMutating(false);
    }
  }
  async function action(name: 'cancel' | 'retry' | 'delete') {
    if (name === 'delete' && !window.confirm(w('deleteConfirm'))) return;
    try {
      await request(
        `jobs/${id}${name === 'delete' ? '' : '/' + name}`,
        name === 'delete' ? undefined : {},
        name === 'delete' ? 'DELETE' : 'POST',
      );
      await refresh();
    } catch (e) {
      fail(e);
    }
  }
  async function download(exportId: string) {
    try {
      const r = await request<{ url: string }>(`transcript-exports/${exportId}/download`);
      const a = document.createElement('a');
      a.href = r.url;
      a.click();
    } catch (e) {
      fail(e);
    }
  }
  async function more() {
    if (!view || view.nextOffset === null || operationActive.current) return;
    operationActive.current = true;
    setMutating(true);
    try {
      await flush();
      // Timing edits can move a saved segment beyond the current page. Reload the
      // prefix once before appending so offset pagination cannot skip or duplicate it.
      let prefix: TranscriptSegment[] = [];
      if (orderChanged.current) {
        for (let offset = 0; offset < view.nextOffset; offset += 100) {
          const page = await request<TranscriptView>(`jobs/${id}/transcript?offset=${offset}`);
          if (page.revision !== revision.current) throw new ApiError('TRANSCRIPT_CONFLICT', 409);
          prefix.push(...page.segments.slice(0, view.nextOffset - offset));
        }
      } else prefix = view.segments;
      const v = await request<TranscriptView>(`jobs/${id}/transcript?offset=${view.nextOffset}`);
      if (v.revision !== revision.current) throw new ApiError('TRANSCRIPT_CONFLICT', 409);
      setView({ ...v, segments: [...prefix, ...v.segments] });
      orderChanged.current = false;
    } catch (e) {
      fail(e);
    } finally {
      operationActive.current = false;
      setMutating(false);
    }
  }
  const duration = (view?.durationMs || 0) / 1000;
  const activeSegment = view?.segments.find(
    (s) => time * 1000 >= s.startMs && time * 1000 < s.endMs,
  );
  function reveal(segmentId: string) {
    const row = document.getElementById(`segment-${segmentId}`),
      container = transcriptScroll.current;
    if (!row || !container) return;
    const box = row.getBoundingClientRect(),
      viewport = container.getBoundingClientRect();
    if (box.top < viewport.top + 12 || box.bottom > viewport.bottom - 12)
      container.scrollTo({
        top: container.scrollTop + box.top - viewport.top - 24,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
  }
  useEffect(() => {
    if (autoScroll && !editing && activeSegment) reveal(activeSegment.id);
  }, [activeSegment?.id, autoScroll, editing]);
  useEffect(() => {
    if (
      view?.nextOffset != null &&
      !mutating &&
      !conflict &&
      !editing &&
      time * 1000 >= (view.segments.at(-1)?.startMs ?? Infinity)
    )
      void more();
  }, [time, playing, view?.nextOffset, mutating, conflict, editing]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  // Fetch a consistent saved snapshot. Copy and citation navigation must include later pages.
  async function allSegments() {
    await flush();
    let offset: number | null = 0;
    let result: TranscriptView | null = null;
    const segments: TranscriptSegment[] = [];
    while (offset !== null) {
      const page: TranscriptView = await request(`jobs/${id}/transcript?offset=${offset}`);
      if (page.revision !== revision.current) throw new ApiError('TRANSCRIPT_CONFLICT', 409);
      result = page;
      segments.push(...page.segments);
      offset = page.nextOffset;
    }
    return { ...result!, segments };
  }
  async function copyText(segment?: TranscriptSegment) {
    if (copying || operationActive.current) return;
    setCopying(true);
    try {
      const data = segment ? view! : await allSegments();
      const text = (segment ? [segment] : data.segments)
        .map((s) => {
          const speakerIndex = data.speakers.findIndex((v) => v.id === s.speakerId);
          const speaker =
            speakerIndex < 0
              ? ''
              : transcriptSpeakerName(data.speakers[speakerIndex], speakerIndex, locale);
          return `${clock(s.startMs / 1000)}${speaker ? ` · ${speaker}` : ''}\n${s.text}`;
        })
        .join('\n\n');
      await navigator.clipboard.writeText(text);
      setCopied(segment?.id || 'all');
    } catch (e) {
      if (e instanceof ApiError) fail(e);
      else setError(copy('copy_failed_please_export_the_text_instead_8902eed'));
    } finally {
      setCopying(false);
    }
  }
  async function seek(seconds: number, play = true) {
    if (!player.current || !audioReady || audioError) return;
    const value = Math.min(Math.max(0, seconds), duration);
    player.current.currentTime = value;
    setTime(value);
    if (play) {
      try {
        await player.current.play();
      } catch {
        setError(copy('playback_failed_please_try_again_1d6de3a'));
      }
    }
  }
  async function locate(segmentId: string) {
    try {
      let data = view;
      if (!data?.segments.some((s) => s.id === segmentId)) {
        data = await allSegments();
        setView(data);
        orderChanged.current = false;
      }
      const segment = data?.segments.find((s) => s.id === segmentId);
      if (!segment) {
        setError(copy('this_passage_was_removed_update_the_analys_d9cc50a'));
        return;
      }
      setMobileTab('transcript');
      void seek(segment.startMs / 1000);
      requestAnimationFrame(() => reveal(segmentId));
    } catch (e) {
      fail(e);
    }
  }
  async function skip(direction: -1 | 1) {
    let data = view;
    if (
      direction === 1 &&
      data?.nextOffset != null &&
      !data.segments.some((s) => s.startMs > time * 1000 + 100)
    ) {
      try {
        data = await allSegments();
        setView(data);
        orderChanged.current = false;
      } catch (e) {
        fail(e);
        return;
      }
    }
    const segments = [...(data?.segments || [])].sort((a, b) => a.startMs - b.startMs);
    const target =
      direction === 1
        ? segments.find((s) => s.startMs > time * 1000 + 100)
        : segments.reverse().find((s) => s.startMs < time * 1000 - 1000);
    void seek(target ? target.startMs / 1000 : direction === -1 ? 0 : duration);
  }

  useLocaleGuard({ busy: saveState === 'saving', dirty: dirty.current.size > 0 });
  if (!job)
    return (
      <div className="page-width panel">
        <p>{error || copy('loading_33ce417')}</p>
      </div>
    );
  return (
    <div className="transcript-workspace">
      <header className="transcript-topbar">
        <Link className="back-link" href={`/${locale}/workspace`}>
          <ArrowLeft size={18} />
          {copy('back_b52b36b')}
        </Link>
        <FileAudio className="transcript-file-icon" size={25} />
        <div className="transcript-file-title">
          <h1 title={job.name}>{job.name}</h1>
          <div className="transcript-file-status">
            <div role="status">
              {job.state === 'completed'
                ? saveState === 'saved'
                  ? copy('saved_c0ae8f6')
                  : saveState === 'saving'
                    ? copy('saving_56a2285')
                    : copy('save_failed_0a44446')
                : copy('_value0_value1_chunks_processed_1e45079', {
                    value0: view?.completedChunks ?? 0,
                    value1: view?.totalChunks ?? 0,
                  })}
              {view ? ` · v${view.revision}` : ''}
            </div>
            <span className="transcript-duration">
              {clock(duration)} · {view?.speakers.length || 0} {copy('speakers_c2a9517')}
            </span>
          </div>
        </div>
        <LocaleSelect />
        <Button
          onClick={() => {
            setExportOpen(true);
            exportDialog.current?.showModal();
          }}
          disabled={!view?.total}
        >
          <Download size={16} />
          <span>{copy('export_transcript_81c7e12')}</span>
        </Button>
      </header>

      {(error || job.error) && (
        <p className="error-banner transcript-error" role="alert">
          {error || errorMessage(job.error, translateError)}
        </p>
      )}
      <nav className="transcript-mobile-tabs" aria-label={copy('workspace_panels_bc2ff44')}>
        <button
          aria-pressed={mobileTab === 'transcript'}
          onClick={() => setMobileTab('transcript')}
        >
          {copy('transcript_5bcd602')}
        </button>
        <button
          aria-pressed={mobileTab === 'ai'}
          onClick={() => {
            setMobileTab('ai');
            setShowAI(true);
          }}
        >
          <Sparkles size={15} />
          {copy('ai_notes_6c90546')}
        </button>
      </nav>
      <div className={`transcript-columns ${showAI ? '' : 'without-ai'} mobile-${mobileTab}`}>
        <section className="transcript-main">
          <div className="transcript-section-toolbar">
            <h2>
              {copy('transcript_5bcd602')} <small>{view?.total || 0}</small>
            </h2>
            <div className="action-row">
              <Button
                size="sm"
                variant="outline"
                disabled={!view?.total || copying || mutating || conflict}
                onClick={() => void copyText()}
              >
                {copying ? (
                  <LoaderCircle size={15} className="spinner" />
                ) : copied === 'all' ? (
                  <Check size={15} />
                ) : (
                  <Copy size={15} />
                )}
                {copied === 'all' ? copy('copied_8e3df45') : copy('copy_all_9da9f04')}
              </Button>
              {!showAI && (
                <Button size="sm" variant="outline" onClick={() => setShowAI(true)}>
                  <Sparkles size={15} />
                  {copy('ai_notes_6c90546')}
                </Button>
              )}
              <details className="transcript-more">
                <summary aria-label={copy('more_actions_a1e34f9')}>
                  <MoreHorizontal size={19} />
                </summary>
                <div className="transcript-more-menu">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      speakerDialog.current?.showModal();
                    }}
                  >
                    <Users size={15} />
                    {copy('manage_speakers_6733c13')}
                  </Button>
                  <div className="action-row">
                    {['queued', 'processing'].includes(job.state) && (
                      <Button variant="outline" onClick={() => void action('cancel')}>
                        <X size={15} />
                        {copy('cancel_77dfd21')}
                      </Button>
                    )}
                    {['failed', 'cancelled'].includes(job.state) && (
                      <Button variant="outline" onClick={() => void action('retry')}>
                        <RotateCcw size={15} />
                        {copy('retry_unfinished_chunks_503ece4')}
                      </Button>
                    )}
                    {saveState === 'failed' && !conflict && (
                      <Button onClick={() => void flush().catch(() => {})}>
                        {copy('retry_saving_71e1aa9')}
                      </Button>
                    )}
                    {conflict && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          dirty.current.clear();
                          blocked.current = false;
                          setConflict(false);
                          setError('');
                          setSaveState('saved');
                          void load().catch(fail);
                        }}
                      >
                        {copy('reload_and_discard_unsaved_edits_59affe9')}
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => void action('delete')}>
                      <Trash2 size={15} />
                      {copy('delete_f6fdbe4')}
                    </Button>
                  </div>
                </div>
              </details>
            </div>
          </div>
          <div className="transcript-scroll" ref={transcriptScroll}>
            {job.state !== 'completed' && !view?.total && (
              <div className="transcript-empty">
                <FileAudio size={36} />
                <h3>{copy('preparing_your_transcript_1a84878')}</h3>
                <p>{w(job.state)}</p>
              </div>
            )}
            {job.state === 'completed' && view && !view.total && (
              <div className="transcript-empty">
                <FileAudio size={36} />
                <h3>{copy('no_speech_was_recognized_b8e4e47')}</h3>
                <p>{copy('try_a_file_with_a_clearer_voice_track_84fc74c')}</p>
              </div>
            )}
            {view?.segments.map((s, index) => (
              <article
                id={`segment-${s.id}`}
                className={`transcript-segment ${activeSegment?.id === s.id ? 'is-active' : ''} ${editing === s.id ? 'is-editing' : ''}`}
                key={s.id}
              >
                <div className="segment-toolbar">
                  <button
                    className="segment-timestamp"
                    onClick={() => void seek(s.startMs / 1000)}
                    disabled={!audioReady || audioError}
                    aria-label={`${copy('play_from_e2794f9')} ${clock(s.startMs / 1000)}`}
                  >
                    {clock(s.startMs / 1000)}
                  </button>
                  <span
                    className={`speaker-mark speaker-${
                      Math.max(
                        0,
                        view.speakers.findIndex((v) => v.id === s.speakerId),
                      ) % 5
                    }`}
                  >
                    <Users size={17} />
                  </span>
                  <SelectField
                    aria-label={`${copy('segment_speaker_0052954')} ${index + 1}`}
                    value={s.speakerId ?? 'unassigned'}
                    disabled={!editable}
                    onValueChange={(nextValue) =>
                      edit({ ...s, speakerId: nextValue === 'unassigned' ? null : nextValue })
                    }
                  >
                    <SelectItem value="unassigned">{copy('unknown_speaker_8d91000')}</SelectItem>
                    {view.speakers.map((x, i) => (
                      <SelectItem value={x.id} key={x.id}>
                        {transcriptSpeakerName(
                          x,
                          view.speakers.findIndex((s) => s.id === x.id),
                          locale,
                        )}
                      </SelectItem>
                    ))}
                  </SelectField>
                  <div className="segment-row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${copy('copy_segment_1c2c8e9')} ${index + 1}`}
                      onClick={() => void copyText(s)}
                    >
                      {copied === s.id ? <Check size={15} /> : <Copy size={15} />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${copy('edit_segment_305c3e1')} ${index + 1}`}
                      aria-pressed={editing === s.id}
                      disabled={!editable}
                      onClick={() => {
                        if (editing === s.id)
                          void flush()
                            .then(() => setEditing(null))
                            .catch(() => {});
                        else setEditing(s.id);
                      }}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${copy('play_segment_f46c8c9')} ${index + 1}`}
                      disabled={!audioReady || audioError}
                      onClick={() => void seek(s.startMs / 1000)}
                    >
                      <Play size={16} />
                    </Button>
                  </div>
                </div>
                {editing !== s.id ? (
                  <p className="transcript-segment-text" dir="auto">
                    {s.text}
                  </p>
                ) : (
                  <div className="segment-edit-fields">
                    <textarea
                      dir="auto"
                      autoFocus
                      id={`text-${s.id}`}
                      rows={3}
                      aria-label={`${copy('segment_text_880e8ff')} ${index + 1}`}
                      value={s.text}
                      maxLength={6000}
                      disabled={!editable}
                      onChange={(e) => edit({ ...s, text: e.target.value })}
                      onBlur={() => void flush().catch(() => {})}
                    />
                    <div className="segment-times">
                      <label>
                        {copy('start_s_a40a4e6')}
                        <input
                          aria-label={`${copy('start_952f375')} ${index + 1}`}
                          type="number"
                          min={0}
                          step={0.001}
                          value={s.startMs / 1000}
                          disabled={!editable}
                          onChange={(e) =>
                            edit({ ...s, startMs: Math.round(Number(e.target.value) * 1000) })
                          }
                        />
                      </label>
                      <label>
                        {copy('end_s_731a0d4')}
                        <input
                          aria-label={`${copy('end_a2bb9d3')} ${index + 1}`}
                          type="number"
                          min={0}
                          step={0.001}
                          value={s.endMs / 1000}
                          disabled={!editable}
                          onChange={(e) =>
                            edit({ ...s, endMs: Math.round(Number(e.target.value) * 1000) })
                          }
                        />
                      </label>
                    </div>
                    <div className="action-row">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable}
                        onClick={() => {
                          const time = Math.round((player.current?.currentTime ?? 0) * 1000),
                            element = document.getElementById(
                              `text-${s.id}`,
                            ) as HTMLTextAreaElement;
                          const caret = element?.selectionStart ?? 0;
                          if (
                            time <= s.startMs ||
                            time >= s.endMs ||
                            caret <= 0 ||
                            caret >= s.text.length
                          ) {
                            setError(copy('place_the_text_cursor_and_audio_playhead_i_9f1b2f3'));
                            return;
                          }
                          const left = { ...s, endMs: time, text: s.text.slice(0, caret) },
                            right = {
                              ...s,
                              id: crypto.randomUUID(),
                              startMs: time,
                              text: s.text.slice(caret),
                            };
                          void structural({ upsert: [left, right] }, (v) => ({
                            ...v,
                            total: v.total + 1,
                            nextOffset: v.nextOffset === null ? null : v.nextOffset + 1,
                            segments: v.segments.flatMap((x) =>
                              x.id === s.id ? [left, right] : [x],
                            ),
                          }));
                        }}
                      >
                        <Scissors size={14} />
                        {copy('split_fc8230b')}
                      </Button>
                      {view.segments[index + 1] && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!editable}
                          onClick={() => {
                            const next = view.segments[index + 1],
                              merged = {
                                ...s,
                                endMs: Math.max(s.endMs, next.endMs),
                                text: s.text + '\n' + next.text,
                              };
                            void structural({ upsert: [merged], remove: [next.id] }, (v) => ({
                              ...v,
                              total: v.total - 1,
                              nextOffset: v.nextOffset === null ? null : v.nextOffset - 1,
                              segments: v.segments
                                .filter((x) => x.id !== next.id)
                                .map((x) => (x.id === s.id ? merged : x)),
                            }));
                          }}
                        >
                          <Plus size={14} />
                          {copy('merge_next_d4a3404')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable}
                        onClick={() =>
                          void structural({ remove: [s.id] }, (v) => ({
                            ...v,
                            total: v.total - 1,
                            nextOffset: v.nextOffset === null ? null : v.nextOffset - 1,
                            segments: v.segments.filter((x) => x.id !== s.id),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                        {copy('remove_e963907')}
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      onClick={() =>
                        void flush()
                          .then(() => setEditing(null))
                          .catch(() => {})
                      }
                    >
                      <Check size={14} />
                      {copy('done_editing_b493845')}
                    </Button>
                  </div>
                )}
              </article>
            ))}
            {view?.nextOffset != null && (
              <Button
                className="transcript-load-more"
                variant="outline"
                disabled={mutating || conflict}
                onClick={() => void more()}
              >
                {copy('load_more_segments_78ad267')}
              </Button>
            )}
          </div>
        </section>
        {view && (
          <ReadingPanel
            id={id}
            revision={view.revision}
            data={transcriptReadingData(
              view,
              'language' in job.options ? job.options.language : 'auto',
            )}
            open={showAI}
            ready={editable && !!view.total}
            autoGenerate={false}
            beforeGenerate={async () => {
              await flush();
              return revision.current;
            }}
            onLocate={(segmentId) => void locate(segmentId)}
            onClose={() => {
              setShowAI(false);
              setMobileTab('transcript');
            }}
          />
        )}
      </div>
      <footer className="transcript-player-bar">
        <audio
          ref={player}
          src={url || undefined}
          preload="metadata"
          onLoadedMetadata={() => {
            setAudioReady(true);
            setAudioError(false);
            if (player.current) {
              player.current.playbackRate = rate;
              player.current.muted = muted;
              const resume = resumePlayback.current;
              if (resume) {
                resumePlayback.current = null;
                player.current.currentTime = resume.time;
                setTime(resume.time);
                if (resume.playing) void player.current.play().catch(() => setPlaying(false));
              }
            }
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => {
            if (url) setAudioError(true);
          }}
        />
        <input
          className="transcript-seek"
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={!audioReady || audioError}
          aria-label={copy('playback_position_61d5ff7')}
          aria-valuetext={clock(time)}
          onChange={(e) => void seek(Number(e.target.value), playing)}
        />
        <div className="transcript-player-controls">
          <div className="transcript-player-time">
            <strong>{clock(time)}</strong>
            <span>/ {clock(duration)}</span>
          </div>
          <div className="transcript-transport">
            <Button
              variant="ghost"
              size="sm"
              disabled={!audioReady || audioError}
              aria-label={copy('previous_segment_9bab155')}
              onClick={() => skip(-1)}
            >
              <SkipBack size={19} />
            </Button>
            <Button
              className="transcript-play-button"
              disabled={!audioReady || audioError}
              aria-label={playing ? copy('pause_audio_cd6cc6a') : copy('play_audio_f7eee16')}
              onClick={() => {
                if (playing) player.current?.pause();
                else void seek(time);
              }}
            >
              {playing ? <Pause size={22} /> : <Play size={22} />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!audioReady || audioError}
              aria-label={copy('next_segment_527c525')}
              onClick={() => skip(1)}
            >
              <SkipForward size={19} />
            </Button>
            <SelectField
              className="transcript-speed"
              aria-label={copy('playback_speed_6ff42b7')}
              value={String(rate)}
              onValueChange={(nextValue) => {
                const value = Number(nextValue);
                setRate(value);
                if (player.current) player.current.playbackRate = value;
              }}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                <SelectItem value={String(v)} key={v}>
                  {v}×
                </SelectItem>
              ))}
            </SelectField>
            <Button
              className="transcript-volume"
              variant="ghost"
              size="sm"
              aria-label={muted ? copy('unmute_7044c31') : copy('mute_0f09734')}
              onClick={() => {
                setMuted(!muted);
                if (player.current) player.current.muted = !muted;
              }}
            >
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </Button>
          </div>
          <label className="transcript-auto-scroll">
            <input
              type="checkbox"
              role="switch"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span>{copy('auto_scroll_d4617da')}</span>
          </label>
        </div>
        {(audioError || !url) && (
          <span className="transcript-audio-notice">
            {copy('audio_preview_unavailable_6137e17')}
          </span>
        )}
      </footer>
      <dialog
        className="transcript-dialog"
        ref={speakerDialog}
        aria-labelledby="transcript-speaker-title"
      >
        <header>
          <h2 id="transcript-speaker-title">{copy('speakers_e10d3ee')}</h2>
          <Button
            size="sm"
            variant="ghost"
            aria-label={copy('close_speakers_6494e1a')}
            onClick={() => speakerDialog.current?.close()}
          >
            <X size={18} />
          </Button>
        </header>
        <p className="field-help">{copy('labels_in_separate_chunks_need_review_rena_a9de478')}</p>
        {view?.speakers.map((s, i) => (
          <div className="speaker-row" key={s.id}>
            <label className="label" htmlFor={`speaker-${s.id}`}>
              {s.needsReview ? copy('needs_review_33a506c') : copy('speaker_7c23b0d')}
            </label>
            <input
              id={`speaker-${s.id}`}
              key={s.id + '-' + s.name}
              defaultValue={transcriptSpeakerName(s, i, locale)}
              maxLength={100}
              disabled={!editable}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== transcriptSpeakerName(s, i, locale)) {
                  const updated = { ...s, name, needsReview: false };
                  void structural({ speakerUpsert: [updated] }, (v) => ({
                    ...v,
                    speakers: v.speakers.map((x) => (x.id === s.id ? updated : x)),
                  }));
                }
              }}
            />
            <SelectField
              aria-label={`${copy('merge_speaker_7998f61')} ${transcriptSpeakerName(s, i, locale)}`}
              disabled={!editable || view.speakers.length < 2}
              value=""
              placeholder={copy('merge_into_56f0e1a')}
              onValueChange={(nextValue) => {
                const to = nextValue;
                if (to)
                  void structural({ mergeSpeaker: { from: s.id, to } }, (v) => ({
                    ...v,
                    speakers: v.speakers.filter((x) => x.id !== s.id),
                    segments: v.segments.map((x) =>
                      x.speakerId === s.id ? { ...x, speakerId: to } : x,
                    ),
                  }));
              }}
            >
              {view.speakers
                .filter((x) => x.id !== s.id)
                .map((x) => (
                  <SelectItem value={x.id} key={x.id}>
                    {transcriptSpeakerName(
                      x,
                      view.speakers.findIndex((s) => s.id === x.id),
                      locale,
                    )}
                  </SelectItem>
                ))}
            </SelectField>
          </div>
        ))}
      </dialog>
      <dialog
        className="transcript-dialog"
        ref={exportDialog}
        onClose={() => setExportOpen(false)}
        aria-label={copy('export_transcript_81c7e12')}
      >
        <header>
          <h2>{copy('export_transcript_81c7e12')}</h2>
          <Button
            size="sm"
            variant="ghost"
            aria-label={copy('close_export_0bd10bb')}
            onClick={() => exportDialog.current?.close()}
          >
            <X size={18} />
          </Button>
        </header>
        <h2>{copy('export_saved_text_d21a273')}</h2>
        <label className="label" htmlFor="transcript-format">
          {copy('export_format_483a5df')}
        </label>
        <SelectField
          id="transcript-format"
          value={format}
          onValueChange={(nextValue) => {
            const value = nextValue as typeof format;
            setFormat(value);
            setIncludeSpeakers(!['srt', 'vtt'].includes(value));
            setIncludeTimestamps(true);
          }}
        >
          {['txt', 'docx', 'pdf', 'srt', 'vtt'].map((f) => (
            <SelectItem key={f} value={f}>
              {f.toUpperCase()}
            </SelectItem>
          ))}
        </SelectField>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeSpeakers}
            onChange={(e) => setIncludeSpeakers(e.target.checked)}
          />
          {copy('include_speaker_names_5394eb3')}
        </label>
        {!['srt', 'vtt'].includes(format) && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeTimestamps}
              onChange={(e) => setIncludeTimestamps(e.target.checked)}
            />
            {copy('include_timestamps_1c1feaf')}
          </label>
        )}
        <Button
          className="batch-submit"
          disabled={!editable || !view?.total}
          onClick={() => void exportFile()}
        >
          <Download size={16} />
          {copy('create_export_bb69031')}
        </Button>
        <CostEstimate
          tool="transcription"
          operation={
            exportOpen && editable && saveState === 'saved' && view?.total
              ? {
                  path: `jobs/${id}/transcript/exports`,
                  body: { revision: view.revision, format, includeSpeakers, includeTimestamps },
                }
              : null
          }
          note={copy('export_only_saved_transcription_is_reused_7abc863')}
        />
        <div className="transcript-exports">
          {exports.map((e) => (
            <div key={e.id}>
              <strong>
                {e.format.toUpperCase()} · v{e.revision}
              </strong>
              <span> · {w(e.state as 'queued')}</span>
              {e.revision !== view?.revision && (
                <small>
                  {e.revision < (view?.revision ?? 0)
                    ? copy('previous_version_989537a')
                    : copy('newer_version_ad47b80')}
                </small>
              )}
              {e.error && <p className="error-text">{errorMessage(e.error, translateError)}</p>}
              {e.state === 'completed' ? (
                <Button size="sm" variant="outline" onClick={() => void download(e.id)}>
                  {copy('download_a479c9c')}
                </Button>
              ) : ['failed', 'cancelled'].includes(e.state) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void request(`transcript-exports/${e.id}/retry`, {}).then(refresh).catch(fail)
                  }
                >
                  {copy('retry_9f5cd8a')}
                </Button>
              ) : ['queued', 'processing'].includes(e.state) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void request(`transcript-exports/${e.id}/cancel`, {}).then(refresh).catch(fail)
                  }
                >
                  {copy('cancel_77dfd21')}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </dialog>
    </div>
  );
}
