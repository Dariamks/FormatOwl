'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { pendingFiles } from '@/lib/pending-files';
import { makeUploader, releaseUploader } from '@/lib/uploader';
import { bytes } from '@/lib/utils';
import { tools } from '@filemorph/core/catalog';
import {
  formats,
  jobSpecSchema,
  supportsInput,
  terminalStates,
  type JobView,
} from '@filemorph/core/domain';
import {
  editValidation,
  evenRect,
  keptRanges,
  type AudioClip,
  type AudioEditOptions,
  type EditOptions,
  type EditorTool,
  type ExtractAudioOptions,
  type PreparationView,
  type TimeRange,
  type VideoCropOptions,
  type VideoCutOptions,
} from '@filemorph/core/editing';
import type Uppy from '@uppy/core';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import VideoTimeline from './editor-video-timeline';
import EditorVideoTransport, { timecode } from './editor-video-transport';
import { ToolIcon } from './tool-icon';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectField,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { SettingsTabs } from './ui/settings-tabs';

const Waveform = dynamic(() => import('./editor-waveform'), { ssr: false });
const Crop = dynamic(() => import('./editor-crop'), { ssr: false });
const key = (tool: EditorTool) => `filemorph-editor-v1-${tool}`;
export function saveEditorDraft(
  tool: EditorTool,
  sources: Pick<
    PreparationView,
    'assetId' | 'profile' | 'streamIndex' | 'name' | 'size' | 'expiresAt'
  >[],
  options: EditOptions | null,
  cropRatio?: string,
) {
  try {
    localStorage.setItem(
      key(tool),
      JSON.stringify({
        sources: sources.map((s) => ({
          assetId: s.assetId,
          profile: s.profile,
          streamIndex: s.streamIndex,
          name: s.name,
          size: s.size,
          expiresAt: s.expiresAt,
        })),
        options,
        ...(cropRatio ? { cropRatio } : {}),
      }),
    );
  } catch {
    /* Editing still works without browser storage. */
  }
}
const seconds = (ms: number) => (ms / 1000).toFixed(3);

function SecondsInput({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (ms: number) => void;
}) {
  const [text, setText] = useState(seconds(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(seconds(value));
  }, [value]);
  return (
    <input
      type="number"
      step="0.001"
      min="0"
      max={max / 1000}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(seconds(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value !== '' && Number.isFinite(+e.target.value))
          onChange(Math.round(+e.target.value * 1000));
      }}
    />
  );
}
function TimeFields({
  range,
  onChange,
  max,
}: {
  range: TimeRange;
  onChange: (r: TimeRange) => void;
  max: number;
}) {
  const copy = useTranslations('media');

  return (
    <div className="editor-time-fields">
      <label>
        {copy('start_seconds_4130a6a')}
        <SecondsInput
          value={range.startMs}
          max={max}
          onChange={(startMs) => onChange({ ...range, startMs })}
        />
      </label>
      <label>
        {copy('end_seconds_c6f784f')}
        <SecondsInput
          value={range.endMs}
          max={max}
          onChange={(endMs) => onChange({ ...range, endMs })}
        />
      </label>
    </div>
  );
}
function CutTimeInput({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const [text, setText] = useState(timecode(value, true));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(timecode(value, true));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder="00:00:00.000"
      spellCheck={false}
      aria-invalid={!Number.isFinite(value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (Number.isFinite(value)) setText(timecode(value, true));
      }}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(next);
        onChange(
          match
            ? +match[1] * 3600000 +
                +match[2] * 60000 +
                +match[3] * 1000 +
                +(match[4] || '').padEnd(3, '0')
            : /^\d+(?:\.\d{1,3})?$/.test(next)
              ? Math.round(+next * 1000)
              : NaN,
        );
      }}
    />
  );
}

export function MediaEditor({
  tool,
  showHeading = true,
}: {
  tool: EditorTool;
  showHeading?: boolean;
}) {
  const translateError = useErrorTranslator();
  const labels = useTranslations('tools');

  const copy = useTranslations('media');

  const locale = useLocale(),
    router = useRouter();
  const catalog = tools.find((t) => t.id === tool)!;
  const audio = tool === 'audio-cutter',
    profile = tool === 'video-cutter' || tool === 'video-cropper' ? 'video' : 'audio';
  const [sources, setSources] = useState<PreparationView[]>([]),
    [options, setOptions] = useState<EditOptions | null>(null);
  const [activeId, setActiveId] = useState(''),
    [selected, setSelected] = useState(0),
    [ratio, setRatio] = useState('original'),
    [currentTime, setCurrentTime] = useState(0);
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(''),
    [uploadProgress, setUploadProgress] = useState(0),
    [paused, setPaused] = useState(false);
  const [error, setError] = useState(''),
    [hydrated, setHydrated] = useState(false),
    [restored, setRestored] = useState(false);
  const [preview, setPreview] = useState<{
    id: string;
    signature: string;
    job?: JobView;
    url?: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    video = useRef<HTMLVideoElement>(null),
    uploader = useRef<Uppy | null>(null),
    alive = useRef(true),
    sourcesRef = useRef(sources),
    versions = useRef(new Map<string, symbol>());
  const submissions = useRef<{ signature: string; requestId: string } | null>(null),
    optionsRef = useRef(options);
  sourcesRef.current = sources;
  optionsRef.current = options;
  const signature = JSON.stringify({ options, ids: sources.map((s) => s.assetId) });
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  function initialize(p: PreparationView) {
    const m = p.media!;
    const full = { startMs: 0, endMs: Math.round(m.duration * 1000) };
    if (audio) {
      const clips = (optionsRef.current as AudioEditOptions | null)?.clips || [];
      const existing = clips.findIndex((c) => c.assetId === p.assetId);
      setSelected(existing >= 0 ? existing : clips.length);
    }
    setOptions((current) => {
      if (audio) {
        const o = current as AudioEditOptions | null;
        if (o?.clips.some((c) => c.assetId === p.assetId)) return o;
        return {
          clips: [
            ...(o?.clips || []),
            {
              assetId: p.assetId,
              streamIndex: m.defaultAudioIndex!,
              ...full,
              fadeInMs: 0,
              fadeOutMs: 0,
            },
          ],
          format: o?.format || 'mp3',
          bitrate: o?.bitrate || 192,
        };
      }
      if (current) return current;
      if (tool === 'video-cutter') return { mode: 'keep', ranges: [full] };
      if (tool === 'video-cropper')
        return { rect: { x: 0, y: 0, width: m.width, height: m.height } };
      return { audioStreamIndex: m.defaultAudioIndex!, bitrate: 192, range: full };
    });
  }
  async function loadPreparation(
    assetId: string,
    requestedProfile: 'video' | 'audio',
    streamIndex = -1,
    fresh = false,
    retry = false,
  ) {
    const version = Symbol(assetId);
    versions.current.set(assetId, version);
    setSources((old) =>
      old.map((s) =>
        s.assetId === assetId && (s.streamIndex !== streamIndex || s.profile !== requestedProfile)
          ? { ...s, state: 'queued', progress: 0 }
          : s,
      ),
    );
    try {
      let p = await request<PreparationView>(`assets/${assetId}/prepare`, {
        profile: requestedProfile,
        streamIndex,
        retry,
      });
      for (;;) {
        if (!alive.current || versions.current.get(assetId) !== version) return;
        setSources((old) => old.map((s) => (s.assetId === assetId ? p : s)));
        if (p.state === 'completed') {
          if (fresh) initialize(p);
          return;
        }
        if (['failed', 'cancelled', 'expired'].includes(p.state)) return;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (!alive.current || versions.current.get(assetId) !== version) return;
        p = await request<PreparationView>(
          `assets/${assetId}/prepare?profile=${requestedProfile}&streamIndex=${streamIndex}`,
        );
      }
    } catch (e) {
      if (alive.current && versions.current.get(assetId) === version) {
        setError(errorMessage(e, translateError));
        setSources((old) =>
          old.map((s) =>
            s.assetId === assetId
              ? {
                  ...s,
                  state: 'failed',
                  error: e instanceof Error ? e.message : 'SERVICE_UNAVAILABLE',
                }
              : s,
          ),
        );
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const incoming = pendingFiles.current;
      pendingFiles.current = [];
      const saved = incoming.length ? null : JSON.parse(localStorage.getItem(key(tool)) || 'null');
      if (incoming.length) void addFiles(incoming);
      if (saved?.sources?.length && saved.sources.length <= 20) {
        const restoredSources = saved.sources.map((s: PreparationView) => ({
          ...s,
          state: 'queued',
          progress: 0,
          media: null,
          error: null,
        }));
        const firstClip = audio ? saved.options?.clips?.[0] : undefined;
        if (firstClip) {
          const first = restoredSources.find(
            (s: PreparationView) => s.assetId === firstClip.assetId,
          );
          if (first) first.streamIndex = firstClip.streamIndex;
        } else if (!audio && saved.options?.audioStreamIndex !== undefined) {
          restoredSources[0].streamIndex = saved.options.audioStreamIndex;
        }
        setSources(restoredSources);
        setOptions(saved.options);
        if (tool === 'video-cropper' && saved.options)
          setRatio(
            ['original', '1:1', '9:16', '16:9', '4:3', '3:4', '5:4', 'free'].includes(
              saved.cropRatio,
            )
              ? saved.cropRatio
              : 'free',
          );
        setActiveId(firstClip?.assetId || restoredSources[0].assetId);
        setRestored(true);
        for (const s of restoredSources)
          void loadPreparation(
            s.assetId,
            s.profile,
            s.streamIndex,
            !saved.options ||
              (audio && !saved.options.clips?.some((c: AudioClip) => c.assetId === s.assetId)),
          );
      }
    } catch {
      /* Invalid or unavailable local draft. */
    }
    setHydrated(true);
    const refresh = setInterval(
      () => {
        for (const s of sourcesRef.current)
          if (s.state === 'completed') void loadPreparation(s.assetId, s.profile, s.streamIndex);
      },
      12 * 60 * 1000,
    );
    return () => {
      alive.current = false;
      clearInterval(refresh);
      versions.current.clear();
      if (uploader.current) releaseUploader(uploader.current);
    };
  }, [tool]);
  useEffect(() => {
    if (hydrated)
      saveEditorDraft(tool, sources, options, tool === 'video-cropper' ? ratio : undefined);
  }, [sources, options, hydrated, tool, ratio]);
  useEffect(() => {
    if (!preview?.id || preview.signature !== signature) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const id = preview.id;
    async function poll() {
      try {
        const { job } = await request<{ job: JobView }>(`jobs/${id}`);
        if (stopped) return;
        const url =
          job.state === 'completed'
            ? (await request<{ url: string }>(`jobs/${id}/download?inline=1`)).url
            : undefined;
        if (stopped) return;
        setPreview((p) => (p?.id === id ? { ...p, job, url } : p));
        if (!terminalStates.includes(job.state) || job.state === 'completed')
          timer = setTimeout(poll, job.state === 'completed' ? 12 * 60 * 1000 : 1200);
      } catch (e) {
        if (!stopped) {
          setError(errorMessage(e, translateError));
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [preview?.id, signature, locale]);

  async function addFiles(files: File[]) {
    if (!files.length || busy) return;
    if (files.some((f) => !supportsInput(tool, f.name))) {
      setError(copy('choose_a_supported_audio_or_video_file_fafb524'));
      return;
    }
    const count = audio ? sources.length + files.length : files.length;
    if (
      count > (audio ? 20 : 1) ||
      files.reduce((n, f) => n + f.size, audio ? sources.reduce((n, s) => n + s.size, 0) : 0) >
        1024 ** 3
    ) {
      setError(copy('up_to_20_sources_and_1_gib_total_video_too_0aafde3'));
      return;
    }
    setBusy(true);
    setError('');
    setRestored(false);
    if (!audio) {
      versions.current.clear();
      setSources([]);
      setOptions(null);
      setSelected(0);
      setRatio('original');
    }
    try {
      for (const file of files) {
        setUploading(file.name);
        setUploadProgress(0);
        setPaused(false);
        const upload = await makeUploader(file, (p) => {
          if (alive.current) setUploadProgress(p);
        });
        if (!alive.current) {
          releaseUploader(upload.uppy);
          return;
        }
        uploader.current = upload.uppy;
        if (!upload.ready) {
          const result = await upload.uppy.upload();
          if (!result?.successful?.length) throw new Error('UPLOAD_FAILED');
        }
        releaseUploader(upload.uppy);
        uploader.current = null;
        const p = await request<PreparationView>(`assets/${upload.assetId}/prepare`, { profile });
        if (!alive.current) return;
        setSources((old) => [...old.filter((s) => s.assetId !== p.assetId), p]);
        setActiveId(p.assetId);
        await loadPreparation(p.assetId, profile, -1, true);
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error && e.message === 'UPLOAD_FAILED'
            ? copy('upload_interrupted_select_the_same_file_to_6eb405b')
            : errorMessage(e, translateError),
        );
    } finally {
      if (alive.current) {
        setBusy(false);
        setUploading('');
        setPaused(false);
      }
    }
  }
  function removeSource(id: string) {
    versions.current.delete(id);
    setSources((old) => old.filter((s) => s.assetId !== id));
    if (audio)
      setOptions((o) =>
        o
          ? {
              ...(o as AudioEditOptions),
              clips: (o as AudioEditOptions).clips.filter((c) => c.assetId !== id),
            }
          : o,
      );
    else setOptions(null);
    setSelected(0);
    setActiveId(sources.find((s) => s.assetId !== id)?.assetId || '');
  }
  const selectedClip = audio ? (options as AudioEditOptions | null)?.clips[selected] : undefined;
  const source = sources.find((s) => s.assetId === activeId) || sources[0];
  const media = source?.media,
    maxMs = Math.round((media?.duration || 0) * 1000);
  const cut = tool === 'video-cutter' ? (options as VideoCutOptions | null) : null;
  const extract = tool === 'video-to-mp3' ? (options as ExtractAudioOptions | null) : null;
  const activeRange =
    cut?.ranges[selected] ||
    (selectedClip?.assetId === source?.assetId ? selectedClip : undefined) ||
    extract?.range;
  const actualSources =
    audio && options
      ? sources.filter((s) =>
          (options as AudioEditOptions).clips.some((c) => c.assetId === s.assetId),
        )
      : sources;
  const allReady =
    !!actualSources.length && actualSources.every((s) => s.state === 'completed' && s.media);
  let validation = '';
  if (options && allReady) {
    const parsed = jobSpecSchema.safeParse({ tool, options });
    validation = parsed.success
      ? editValidation(
          tool,
          options,
          actualSources.map((s) => ({ id: s.assetId, media: s.media! })),
        ) || ''
      : 'INVALID_EDIT';
  }
  const duration =
    cut && media
      ? keptRanges(cut.ranges, cut.mode, maxMs).reduce((n, r) => n + r.endMs - r.startMs, 0)
      : audio && options
        ? (options as AudioEditOptions).clips.reduce((n, c) => n + c.endMs - c.startMs, 0)
        : extract?.range
          ? extract.range.endMs - extract.range.startMs
          : maxMs;
  const outputFormat =
    tool === 'video-cropper' || cut
      ? ((options as VideoCropOptions | VideoCutOptions | null)?.format ?? 'mp4').toUpperCase()
      : audio && options
        ? (options as AudioEditOptions).format.toUpperCase()
        : 'MP3';
  const videoReady =
    profile === 'video' && source?.state === 'completed' && !!source.previewUrl && !!options;
  function changeRange(r: TimeRange) {
    if (cut) setOptions({ ...cut, ranges: cut.ranges.map((v, i) => (i === selected ? r : v)) });
    else if (audio && selectedClip) updateClip(selected, r);
    else if (extract) setOptions({ ...extract, range: r });
  }
  function updateClip(index: number, value: Partial<AudioClip>) {
    setOptions((o) => {
      const v = o as AudioEditOptions;
      return { ...v, clips: v.clips.map((c, i) => (i === index ? { ...c, ...value } : c)) };
    });
  }
  function activateClip(clip: AudioClip, index: number) {
    setSelected(index);
    setActiveId(clip.assetId);
    const s = sources.find((s) => s.assetId === clip.assetId);
    if (
      s &&
      (s.streamIndex === -1 ? s.media?.defaultAudioIndex : s.streamIndex) !== clip.streamIndex
    )
      void loadPreparation(s.assetId, 'audio', clip.streamIndex);
  }
  async function selectTrack(index: number) {
    if (!source) return;
    if (audio) {
      if (selectedClip?.assetId === source.assetId) updateClip(selected, { streamIndex: index });
    } else if (options) setOptions({ ...options, audioStreamIndex: index });
    await loadPreparation(source.assetId, profile, index);
  }
  async function submit(purpose: 'export' | 'preview') {
    if (!options || !allReady || validation || busy) return;
    setBusy(true);
    setError('');
    const submittedSignature = signature;
    try {
      const spec = jobSpecSchema.parse({ tool, options });
      const identity = `${signature}:${purpose}`;
      if (
        purpose === 'preview' &&
        preview?.signature === signature &&
        preview.job &&
        ['failed', 'cancelled'].includes(preview.job.state)
      )
        submissions.current = null;
      if (submissions.current?.signature !== identity)
        submissions.current = { signature: identity, requestId: crypto.randomUUID() };
      if (purpose === 'preview' && preview && preview.signature !== signature)
        await request(`jobs/${preview.id}`, undefined, 'DELETE');
      const result = await request<{ id: string }>('jobs', {
        tool,
        assetIds: actualSources.map((s) => s.assetId),
        purpose,
        options: spec.options,
        requestId: submissions.current.requestId,
      });
      if (purpose === 'export') router.push(`/${locale}/workspace/${result.id}`);
      else if (signatureRef.current === submittedSignature)
        setPreview({ id: result.id, signature: submittedSignature });
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useLocaleGuard({ busy: Boolean(uploading) || busy, dirty: sources.length > 0 });
  return (
    <div
      className={`page-width editor-page ${profile === 'video' ? 'video-editor-page' : ''} ${videoReady ? 'is-editing' : ''}`}
    >
      {showHeading && (
        <div className="page-heading">
          <Link className="back-link" href={`/${locale}`}>
            ← {copy('all_tools_b390ab3')}
          </Link>
          <div className="title-with-icon">
            <span className={`tool-icon ${catalog.group}`}>
              <ToolIcon name={catalog.icon} />
            </span>
            <h1>{labels(`${catalog.id}.name`)}</h1>
          </div>
          <p>{labels(`${catalog.id}.description`)}</p>
        </div>
      )}
      {!options && (
        <CostEstimate
          tool={tool}
          note={copy('preparation_is_estimated_after_file_select_b82cf61')}
        />
      )}
      <div className="editor-steps">
        {copy('1_select_files_2_edit_preview_3_export_dow_08460db')}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {restored && (
        <p className="editor-notice">
          {copy('restored_your_draft_in_this_browser_source_5c079b9')}
        </p>
      )}
      <label
        className={`editor-upload panel ${busy ? 'disabled' : ''} ${videoReady ? 'editor-upload-hidden' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={24} />
        <strong>
          {sources.length
            ? audio
              ? copy('add_sources_a0dbe88')
              : copy('replace_file_6d45b8c')
            : copy('choose_or_drop_files_db5b9a7')}
        </strong>
        <span>
          {formats[tool].map((f) => f.toUpperCase()).join(' · ')} · {copy('1_gib_total_f1e1788')}
        </span>
        <input
          type="file"
          ref={fileInput}
          disabled={busy}
          multiple={audio}
          accept={formats[tool].map((f) => `.${f}`).join(',')}
          onChange={(e) => {
            void addFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </label>
      {uploading && (
        <div className="panel editor-upload-progress" role="status">
          <strong>
            {uploading} · {uploadProgress}%
          </strong>
          <div className="progress-track">
            <div style={{ width: `${uploadProgress}%` }} />
          </div>
          {uploader.current && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (paused) uploader.current?.resumeAll();
                else uploader.current?.pauseAll();
                setPaused(!paused);
              }}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {copy(paused ? 'resumeUpload' : 'pauseUpload')}
            </Button>
          )}
        </div>
      )}
      {!!sources.length && !videoReady && (
        <div className="editor-sources">
          {sources.map((s) => (
            <div
              className={`editor-source ${source?.assetId === s.assetId ? 'active' : ''}`}
              key={s.assetId}
            >
              <button
                onClick={() => {
                  setActiveId(s.assetId);
                  if (audio && options) {
                    const i = (options as AudioEditOptions).clips.findIndex(
                      (c) => c.assetId === s.assetId,
                    );
                    const clip = (options as AudioEditOptions).clips[i];
                    if (clip) activateClip(clip, i);
                    else setSelected(-1);
                  }
                }}
              >
                <strong>{s.name}</strong>
                <span>
                  {bytes(s.size)} ·{' '}
                  {s.state === 'completed'
                    ? `${seconds(Math.round((s.media?.duration || 0) * 1000))} s`
                    : s.state === 'failed'
                      ? errorMessage(s.error, translateError)
                      : `${copy('preparing_preview_484ca6a')} ${s.progress}%`}
                </span>
              </button>
              {['failed', 'cancelled'].includes(s.state) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void loadPreparation(
                      s.assetId,
                      s.profile,
                      s.streamIndex,
                      !options ||
                        (audio &&
                          !(options as AudioEditOptions).clips.some(
                            (c) => c.assetId === s.assetId,
                          )),
                      true,
                    )
                  }
                >
                  {copy('retry_9f5cd8a')}
                </Button>
              )}
              <button
                className="icon-button"
                aria-label={`${copy('remove_source_2da9336')} ${s.name}`}
                disabled={busy}
                onClick={() => removeSource(s.assetId)}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {source?.state === 'completed' && media && source.previewUrl && options && (
        <div className={`editor-layout ${profile === 'video' ? 'video-editor-layout' : ''}`}>
          <section className="panel editor-preview">
            <div className="editor-preview-heading">
              <h2>{copy('editor_preview_e66273b')}</h2>
              {tool === 'video-cropper' && (
                <button
                  className="editor-replace"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} />
                  {copy('replace_video_3df3e0e')}
                </button>
              )}
            </div>
            {tool === 'video-cropper' && (
              <p className="editor-preview-filename" title={source.name}>
                {source.name} <span>{bytes(source.size)}</span>
              </p>
            )}
            {tool === 'video-cropper' ? (
              <Crop
                url={source.previewUrl}
                media={media}
                rect={(options as VideoCropOptions).rect}
                ratio={
                  ratio === 'free'
                    ? false
                    : ratio === 'original'
                      ? media.width / media.height
                      : ratio
                          .split(':')
                          .map(Number)
                          .reduce((a, b) => a / b)
                }
                onChange={(rect) => setOptions({ ...(options as VideoCropOptions), rect })}
              />
            ) : profile === 'video' ? (
              <>
                <video
                  ref={video}
                  className="cutter-video"
                  src={source.previewUrl}
                  playsInline
                  preload="auto"
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={() => setCurrentTime(0)}
                />
                <EditorVideoTransport
                  videoRef={video}
                  url={source.previewUrl}
                  duration={media.duration}
                  compact
                />
              </>
            ) : source.peaksUrl ? (
              <Waveform
                url={source.previewUrl}
                peaksUrl={source.peaksUrl}
                range={activeRange}
                onChange={changeRange}
              />
            ) : null}
            {media.kind === 'video' && !cut && (
              <p className="editor-meta">
                {media.width} × {media.height} · {media.codec.toUpperCase()} ·{' '}
                {media.duration.toFixed(3)} s
              </p>
            )}
            {cut && (
              <>
                <VideoTimeline
                  source={source}
                  currentTime={currentTime}
                  ranges={cut.ranges}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={changeRange}
                  onSeek={(s) => {
                    setCurrentTime(s);
                    if (video.current) video.current.currentTime = s;
                  }}
                />
                <div className="editor-region-list">
                  {cut.ranges.map((r, i) => (
                    <div key={i} className={i === selected ? 'active' : ''}>
                      <button onClick={() => setSelected(i)}>
                        {copy('region_0f21717')} {i + 1} · {seconds(r.startMs)}–{seconds(r.endMs)} s
                      </button>
                      <button
                        aria-label={`${copy('remove_region_64cb2bb')} ${i + 1}`}
                        onClick={() => {
                          setOptions({ ...cut, ranges: cut.ranges.filter((_, n) => n !== i) });
                          setSelected(0);
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cut.ranges.length >= 50}
                  onClick={() => {
                    const startMs = Math.min(
                      maxMs - 1,
                      Math.round((video.current?.currentTime || 0) * 1000),
                    );
                    setOptions({
                      ...cut,
                      ranges: [
                        ...cut.ranges,
                        {
                          startMs,
                          endMs: Math.min(maxMs, startMs + Math.max(1, Math.round(maxMs / 4))),
                        },
                      ],
                    });
                    setSelected(cut.ranges.length);
                  }}
                >
                  <Plus size={16} />
                  {copy('add_region_e3362b4')}
                </Button>
              </>
            )}
            {audio && (
              <>
                <div className="editor-section-heading">
                  <h3>{copy('output_clip_order_ee98f65')}</h3>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(options as AudioEditOptions).clips.length >= 50}
                    onClick={() => {
                      const o = options as AudioEditOptions;
                      setOptions({
                        ...o,
                        clips: [
                          ...o.clips,
                          {
                            assetId: source.assetId,
                            streamIndex:
                              source.streamIndex === -1
                                ? media.defaultAudioIndex!
                                : source.streamIndex,
                            startMs: 0,
                            endMs: maxMs,
                            fadeInMs: 0,
                            fadeOutMs: 0,
                          },
                        ],
                      });
                      setSelected(o.clips.length);
                    }}
                  >
                    <Plus size={15} />
                    {copy('add_clip_2b9a0b7')}
                  </Button>
                </div>
                <div className="audio-clip-list">
                  {(options as AudioEditOptions).clips.map((clip, i, all) => (
                    <div className={`audio-clip ${i === selected ? 'active' : ''}`} key={i}>
                      <button className="clip-label" onClick={() => activateClip(clip, i)}>
                        <strong>
                          {i + 1}. {sources.find((s) => s.assetId === clip.assetId)?.name}
                        </strong>
                        <span>
                          {seconds(clip.startMs)}–{seconds(clip.endMs)} s ·{' '}
                          {copy('fade_in_out_c612211')} {seconds(clip.fadeInMs)} /{' '}
                          {seconds(clip.fadeOutMs)} s
                        </span>
                      </button>
                      <div className="clip-actions">
                        {[-1, 1].map((delta) => (
                          <button
                            className="icon-button"
                            key={delta}
                            disabled={i + delta < 0 || i + delta >= all.length}
                            aria-label={`${delta < 0 ? copy('move_clip_up_9f0bd09') : copy('move_clip_down_5e8af22')} ${i + 1}`}
                            onClick={() => {
                              const clips = [...all];
                              [clips[i], clips[i + delta]] = [clips[i + delta], clips[i]];
                              setOptions({ ...(options as AudioEditOptions), clips });
                              activateClip(clip, i + delta);
                            }}
                          >
                            {delta < 0 ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
                          </button>
                        ))}
                        <button
                          className="icon-button"
                          disabled={all.length >= 50}
                          aria-label={`${copy('duplicate_clip_541a869')} ${i + 1}`}
                          onClick={() => {
                            const clips = [...all];
                            clips.splice(i + 1, 0, { ...clip });
                            setOptions({ ...(options as AudioEditOptions), clips });
                            activateClip(clip, i + 1);
                          }}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${copy('delete_clip_91a6cf3')} ${i + 1}`}
                          onClick={() => {
                            const clips = all.filter((_, n) => n !== i);
                            setOptions({ ...(options as AudioEditOptions), clips });
                            if (clips[0]) activateClip(clips[0], 0);
                            else setSelected(-1);
                          }}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
          <aside className="panel editor-settings">
            <h2>{copy('edit_settings_aea819e')}</h2>
            {cut && (
              <>
                <div className="editor-mode-block">
                  <div
                    className="editor-mode-switch"
                    role="group"
                    aria-label={copy('selection_mode_6251207')}
                  >
                    {(['keep', 'remove'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={cut.mode === mode}
                        onClick={() => setOptions({ ...cut, mode })}
                      >
                        {mode === 'keep'
                          ? copy('keep_regions_d441e32')
                          : copy('remove_regions_86abbe3')}
                      </button>
                    ))}
                  </div>
                  <p className="editor-mode-description">
                    {cut.mode === 'keep'
                      ? copy('keep_the_selected_time_ranges_and_remove_t_9977e41')
                      : copy('remove_the_selected_time_ranges_and_join_t_a40dbe9')}
                  </p>
                </div>
                <div className="editor-file-card">
                  <div>
                    <strong title={source.name}>{source.name}</strong>
                    <span>
                      {bytes(source.size)} · {timecode(maxMs)}
                    </span>
                  </div>
                  <button
                    className="editor-replace"
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                  >
                    {copy('replace_a7cf7b2')}
                  </button>
                </div>
              </>
            )}
            {activeRange &&
              (cut ? (
                <fieldset className="cut-range-fields">
                  <legend>{copy('trim_range_69f2125')}</legend>
                  <div className="cut-time-inputs">
                    <label>
                      <span className="sr-only">{copy('start_time_88d8206')}</span>
                      <CutTimeInput
                        value={activeRange.startMs}
                        onChange={(startMs) => changeRange({ ...activeRange, startMs })}
                      />
                    </label>
                    <span>{copy('to_4374aae')}</span>
                    <label>
                      <span className="sr-only">{copy('end_time_cd7800d')}</span>
                      <CutTimeInput
                        value={activeRange.endMs}
                        onChange={(endMs) => changeRange({ ...activeRange, endMs })}
                      />
                    </label>
                  </div>
                  <small>{copy('hours_minutes_seconds_milliseconds_9525c10')}</small>
                </fieldset>
              ) : (
                <TimeFields range={activeRange} onChange={changeRange} max={maxMs} />
              ))}
            {extract && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOptions({ ...extract, range: { startMs: 0, endMs: maxMs } })}
              >
                {copy('use_full_track_8cf013d')}
              </Button>
            )}
            {!!media.tracks.length &&
              tool !== 'video-cropper' &&
              (!cut || media.tracks.length > 1) && (
                <label>
                  {copy('audio_track_8ff5fe5')}
                  <SelectField
                    value={String(
                      selectedClip?.streamIndex ??
                        (options as ExtractAudioOptions).audioStreamIndex ??
                        media.defaultAudioIndex,
                    )}
                    onValueChange={(nextValue) => void selectTrack(+nextValue)}
                  >
                    {media.tracks.map((t) => (
                      <SelectItem key={t.index} value={String(t.index)}>
                        {copy('track_b1c5a7a')} {t.index} · {t.language || t.title || t.codec} ·{' '}
                        {t.channels} ch
                      </SelectItem>
                    ))}
                  </SelectField>
                </label>
              )}
            {audio && selectedClip && selectedClip.assetId === source.assetId && (
              <div className="editor-time-fields">
                {(['fadeInMs', 'fadeOutMs'] as const).map((field) => (
                  <label key={field}>
                    {field === 'fadeInMs'
                      ? copy('fade_in_seconds_83af911')
                      : copy('fade_out_seconds_627ab15')}
                    <SecondsInput
                      value={selectedClip[field]}
                      max={selectedClip.endMs - selectedClip.startMs}
                      onChange={(value) => updateClip(selected, { [field]: value })}
                    />
                  </label>
                ))}
              </div>
            )}
            {tool === 'video-cropper' && (
              <>
                <SettingsTabs
                  label={copy('crop_settings_a5005be')}
                  basicLabel={copy('aspect_ratio_4e077cf')}
                  advancedLabel={copy('precise_crop_5079902')}
                  disabled={busy}
                  basic={
                    <fieldset className="crop-ratios">
                      <legend>{copy('aspect_ratio_4e077cf')}</legend>
                      <div className="crop-ratio-grid">
                        {['original', '1:1', '9:16', '16:9', '4:3', '3:4', '5:4', 'free'].map(
                          (value) => (
                            <label
                              className={`crop-ratio-option ${ratio === value ? 'selected' : ''}`}
                              key={value}
                            >
                              <input
                                type="radio"
                                name="crop-ratio"
                                value={value}
                                checked={ratio === value}
                                onChange={() => {
                                  setRatio(value);
                                  if (value === 'free') return;
                                  const r =
                                    value === 'original'
                                      ? media.width / media.height
                                      : value
                                          .split(':')
                                          .map(Number)
                                          .reduce((a, b) => a / b);
                                  const w = Math.min(media.width, media.height * r),
                                    h = w / r;
                                  setOptions({
                                    ...(options as VideoCropOptions),
                                    rect: evenRect({
                                      x: Math.floor((media.width - w) / 2),
                                      y: Math.floor((media.height - h) / 2),
                                      width: Math.floor(w),
                                      height: Math.floor(h),
                                    }),
                                  });
                                }}
                              />
                              <span>
                                {value === 'original'
                                  ? copy('original_c0a8060')
                                  : value === 'free'
                                    ? copy('custom_081ae3f')
                                    : value}
                              </span>
                            </label>
                          ),
                        )}
                      </div>
                    </fieldset>
                  }
                  advanced={
                    <>
                      <fieldset className="crop-dimensions">
                        <legend>{copy('exact_dimensions_563d524')}</legend>
                        <div className="crop-size-inputs">
                          {(['width', 'height'] as const).map((field, i) => (
                            <label key={field}>
                              {i === 1 && (
                                <span className="crop-size-times" aria-hidden="true">
                                  ×
                                </span>
                              )}
                              <span className="sr-only">
                                {field === 'width' ? copy('width_a58ddf5') : copy('height_3f608b4')}{' '}
                                (px)
                              </span>
                              <input
                                type="number"
                                aria-label={`${field === 'width' ? copy('width_a58ddf5') : copy('height_3f608b4')} (px)`}
                                min="2"
                                max={field === 'width' ? media.width : media.height}
                                step="2"
                                value={(options as VideoCropOptions).rect[field]}
                                onChange={(e) => {
                                  setRatio('free');
                                  setOptions({
                                    ...(options as VideoCropOptions),
                                    rect: evenRect({
                                      ...(options as VideoCropOptions).rect,
                                      [field]: +e.target.value,
                                    }),
                                  });
                                }}
                              />
                              <span className="input-unit" aria-hidden="true">
                                px
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="crop-position">
                        <h3>{copy('position_cf1c85a')}</h3>
                        <div className="editor-time-fields">
                          {(['x', 'y'] as const).map((field) => (
                            <label key={field}>
                              {field.toUpperCase()} (px)
                              <input
                                type="number"
                                min="0"
                                step="2"
                                max={
                                  field === 'x'
                                    ? media.width - (options as VideoCropOptions).rect.width
                                    : media.height - (options as VideoCropOptions).rect.height
                                }
                                value={(options as VideoCropOptions).rect[field]}
                                onChange={(e) =>
                                  setOptions({
                                    ...(options as VideoCropOptions),
                                    rect: evenRect({
                                      ...(options as VideoCropOptions).rect,
                                      [field]: +e.target.value,
                                    }),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRatio('original');
                            setOptions({
                              ...(options as VideoCropOptions),
                              rect: { x: 0, y: 0, width: media.width, height: media.height },
                            });
                          }}
                        >
                          {copy('reset_crop_444ee19')}
                        </Button>
                      </div>
                    </>
                  }
                />
              </>
            )}
            {profile === 'video' && (
              <div className="video-export-format">
                <label id="video-format-label">{copy('exportFormat')}</label>
                <Select
                  value={(options as VideoCutOptions | VideoCropOptions).format ?? 'mp4'}
                  onValueChange={(format) =>
                    setOptions({
                      ...(options as VideoCutOptions | VideoCropOptions),
                      format: format as 'mp4' | 'mkv' | 'mov',
                    })
                  }
                >
                  <SelectTrigger aria-labelledby="video-format-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['mp4', 'mkv', 'mov'].map((format) => (
                      <SelectItem key={format} value={format}>
                        {format.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {audio && (
              <label>
                {copy('output_format_c03f08a')}
                <SelectField
                  value={(options as AudioEditOptions).format}
                  onValueChange={(nextValue) =>
                    setOptions({
                      ...(options as AudioEditOptions),
                      format: nextValue as AudioEditOptions['format'],
                    })
                  }
                >
                  {['mp3', 'wav', 'm4a', 'm4r'].map((f) => (
                    <SelectItem key={f} value={f}>
                      {f.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectField>
              </label>
            )}
            {(audio || extract) && (!audio || (options as AudioEditOptions).format !== 'wav') && (
              <label>
                {copy('audio_quality_12a6238')}
                <SelectField
                  value={String((options as AudioEditOptions).bitrate)}
                  onValueChange={(nextValue) =>
                    setOptions({ ...options, bitrate: +nextValue as 128 | 192 | 320 })
                  }
                >
                  {[128, 192, 320].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} kbps{n === 192 ? copy('_recommended_0ce4305') : ''}
                    </SelectItem>
                  ))}
                </SelectField>
              </label>
            )}
            {audio && (options as AudioEditOptions).format === 'm4r' && (
              <p className="editor-notice">
                {copy('ringtones_can_be_up_to_30_seconds_adjust_y_8d65b17')}
              </p>
            )}
            <div className="editor-export-summary">
              <span>{copy('expected_output_fd02e3d')}</span>
              <strong>
                {Number.isFinite(duration) ? `${seconds(Math.max(0, duration))} s` : '—'} ·{' '}
                {outputFormat}
              </strong>
              <small>{copy('rendered_from_original_sources_a0b01c1')}</small>
            </div>
            {validation && (
              <p className="error-banner" role="alert">
                {errorMessage(validation, translateError)}
              </p>
            )}
            {audio && (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !allReady ||
                  !!validation ||
                  (preview?.signature === signature &&
                    !!preview.job &&
                    !terminalStates.includes(preview.job.state))
                }
                onClick={() => void submit('preview')}
              >
                <Play size={17} />
                {copy('preview_composition_7d7fbee')}
              </Button>
            )}
            <Button
              disabled={busy || !allReady || !!validation}
              onClick={() => void submit('export')}
            >
              {busy ? <LoaderCircle size={17} className="spinner" /> : <Download size={17} />}
              {copy('export_file_3071639')}
            </Button>
            <CostEstimate
              tool={tool}
              operation={
                allReady && options && !validation
                  ? {
                      path: 'jobs',
                      body: {
                        tool,
                        assetIds: actualSources.map((s) => s.assetId),
                        purpose: 'export',
                        options,
                      },
                    }
                  : null
              }
              note={copy('export_estimate_source_preparation_and_com_07985f8')}
            />
          </aside>
        </div>
      )}
      {preview && (
        <section className="panel composition-preview">
          <h2>{copy('composition_preview_a1f29cd')}</h2>
          {preview.signature !== signature ? (
            <p>{copy('your_edits_have_changed_generate_a_new_pre_b0309b4')}</p>
          ) : preview.url ? (
            <audio controls src={preview.url} preload="auto" />
          ) : (
            <>
              <p role="status">
                {preview.job?.state === 'failed'
                  ? errorMessage(preview.job.error, translateError)
                  : `${copy('preparing_composition_89acf97')} · ${preview.job?.progress || 0}%`}
              </p>
              {preview.job && !terminalStates.includes(preview.job.state) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await request(`jobs/${preview.id}/cancel`, {});
                    setPreview(null);
                    submissions.current = null;
                  }}
                >
                  {copy('cancel_preview_6ea314a')}
                </Button>
              )}
            </>
          )}
        </section>
      )}
      {sources.length > 0 && (
        <p className="editor-footer">
          {copy('your_draft_is_saved_in_this_browser_expire_2dc9666')}
        </p>
      )}
    </div>
  );
}
