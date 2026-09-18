'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { forgetUpload, makeUploader, releaseUploader } from '@/lib/uploader';
import { bytes } from '@/lib/utils';
import {
  compressionSchema,
  terminalStates,
  validateVideoName,
  type CompressionOptions,
  type VideoJobView as JobView,
} from '@filemorph/core/domain';
import type Uppy from '@uppy/core';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  Download,
  FileVideo,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { ExamplePicker } from './example-picker';
import { pendingFile } from './home';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { SettingsTabs } from './ui/settings-tabs';
const defaults: CompressionOptions = {
  preset: 'balanced',
  codec: 'h264',
  resolution: 'original',
  speed: 'medium',
};
export function Compressor({
  jobId,
  showHeading = true,
  initialSampleId,
}: {
  jobId?: string;
  showHeading?: boolean;
  initialSampleId?: string;
}) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('conversion');

  const t = useTranslations('compress'),
    w = useTranslations('workspace'),
    locale = useLocale(),
    router = useRouter();
  const [file, setFile] = useState<File | null>(() => (jobId ? null : pendingFile.current)),
    [localUrl, setLocalUrl] = useState(''),
    [options, setOptions] = useState(defaults),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [paused, setPaused] = useState(false),
    [uploadProgress, setUploadProgress] = useState(0),
    [job, setJob] = useState<JobView | null>(null),
    [preview, setPreview] = useState(''),
    [original, setOriginal] = useState(''),
    [localPreviewError, setLocalPreviewError] = useState(false),
    [originalPreviewError, setOriginalPreviewError] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    uppy = useRef<Uppy | null>(null),
    mounted = useRef(true),
    requestId = useRef(''),
    assetId = useRef('');
  useEffect(() => {
    mounted.current = true;
    pendingFile.current = null;
    return () => {
      mounted.current = false;
      if (uppy.current) releaseUploader(uppy.current);
    };
  }, []);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!jobId) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<{ job: JobView }>(`jobs/${jobId}`);
        if (stopped) return;
        setJob(data.job);
        setError('');
        if (!terminalStates.includes(data.job.state)) timer = setTimeout(poll, 1200);
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
  }, [jobId, locale]);
  useEffect(() => {
    if (job?.state !== 'completed') return;
    let active = true;
    Promise.all([
      request<{ url: string }>(`jobs/${job.id}/download?inline=1`),
      request<{ url: string }>(`jobs/${job.id}/download?inline=1&original=1`),
    ])
      .then(([out, source]) => {
        if (active) {
          setPreview(out.url);
          setOriginal(source.url);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, translateError));
      });
    return () => {
      active = false;
    };
  }, [job?.id, job?.state, locale]);
  function select(next?: File) {
    if (!next) return;
    setError('');
    if (!validateVideoName(next.name)) {
      setError(copy('choose_an_mp4_mov_mkv_or_webm_video_6280343'));
      return;
    }
    if (next.size > 1024 ** 3) {
      setError(t('fileTooLarge'));
      return;
    }
    if (uppy.current) {
      releaseUploader(uppy.current);
      uppy.current = null;
    }
    setFile(next);
    setLocalPreviewError(false);
    assetId.current = '';
    requestId.current = '';
    setUploadProgress(0);
  }
  function setting<K extends keyof CompressionOptions>(key: K, value: CompressionOptions[K]) {
    setOptions((current) => ({ ...current, [key]: value }));
  }
  async function start() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const parsed = compressionSchema.parse(options);
      if (!requestId.current) requestId.current = crypto.randomUUID();
      if (!assetId.current) {
        setUploading(true);
        setPaused(false);
        if (uppy.current) releaseUploader(uppy.current);
        const uploader = await makeUploader(file, (value) => {
          if (mounted.current) setUploadProgress(value);
        });
        uppy.current = uploader.uppy;
        if (!mounted.current) {
          releaseUploader(uploader.uppy);
          return;
        }
        if (!uploader.ready) {
          const result = await uploader.uppy.upload();
          if (!result?.successful?.length) throw new Error('UPLOAD_FAILED');
        }
        assetId.current = uploader.assetId;
        setUploadProgress(100);
      }
      setUploading(false);
      const result = await request<{ id: string }>('jobs', {
        assetId: assetId.current,
        options: parsed,
        requestId: requestId.current,
      });
      forgetUpload(assetId.current);
      router.push(`/${locale}/workspace/${result.id}`);
    } catch (e) {
      if (mounted.current) {
        setError(
          e instanceof Error && e.message === 'UPLOAD_FAILED'
            ? t('uploadFailed')
            : errorMessage(e, translateError),
        );
        setUploading(false);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function action(action: 'cancel' | 'retry') {
    if (!job || busy) return;
    setBusy(true);
    try {
      const result = await request<{ job: JobView }>(`jobs/${job.id}/${action}`, {});
      setJob(result.job);
      setError('');
      if (action === 'retry') window.location.reload();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!job) return;
    try {
      const { url } = await request<{ url: string }>(`jobs/${job.id}/download`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  const complete = job?.state === 'completed',
    active = job && !terminalStates.includes(job.state);
  useLocaleGuard({ busy: uploading || busy, dirty: Boolean(file) && !jobId });
  return (
    <div className="page-width compressor-page">
      {showHeading && (
        <div className="page-heading">
          <Link className="back-link" href={`/${locale}`}>
            <ArrowLeft size={15} />
            {t('back')}
          </Link>
          <div className="title-with-icon">
            <span className="tool-icon video">
              <FileVideo size={25} />
            </span>
            <h1>{t('title')}</h1>
          </div>
          <p>{t('intro')}</p>
        </div>
      )}
      <div className="flow-steps">
        {['upload', 'settings', 'download'].map((key, i) => (
          <span key={key} className={(complete ? 2 : job || file ? 1 : 0) >= i ? 'current' : ''}>
            <b>{(complete ? 2 : job || file ? 1 : 0) > i ? <Check size={13} /> : i + 1}</b>
            {t(key)}
            {i < 2 && <span className="flow-line" />}
          </span>
        ))}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {jobId && !job ? (
        <div className="panel empty-state">
          <LoaderCircle className="spinner" size={26} />
          <p>{w('loading')}</p>
        </div>
      ) : job ? (
        <>
          <div className="panel result-panel">
            <div className={`result-symbol ${complete ? 'success' : ''}`}>
              {complete ? (
                <Check size={28} />
              ) : active ? (
                <LoaderCircle size={27} className="spinner" />
              ) : (
                <FileVideo size={27} />
              )}
            </div>
            <h2>{complete ? t('done') : active ? t('processing') : w(job.state)}</h2>
            <p className="result-filename">{job.name}</p>
            {active && (
              <>
                <div className="progress-track">
                  <div style={{ width: `${job.progress}%` }} />
                </div>
                <div className="progress-label">
                  <span>{w(job.state)}</span>
                  <span>{job.progress}%</span>
                </div>
                <Button
                  variant="outline"
                  onClick={() => action('cancel')}
                  disabled={busy || job.state === 'cancelling'}
                >
                  <X size={15} />
                  {t('cancel')}
                </Button>
              </>
            )}
            {job.error && (
              <p className="error-text" role="alert">
                {errorMessage(job.error, translateError)}
              </p>
            )}
            {complete && (
              <>
                <p className="muted">{t('doneHint')}</p>
                <div className="comparison">
                  <div>
                    <span>{t('before')}</span>
                    <strong>{bytes(job.inputSize)}</strong>
                  </div>
                  <ArrowRight size={22} />
                  <div>
                    <span>{t('after')}</span>
                    <strong>{bytes(job.outputSize || 0)}</strong>
                  </div>
                  {(job.outputSize || 0) < job.inputSize && (
                    <span className="savings">
                      {Math.round(100 * (1 - (job.outputSize || 0) / job.inputSize))}% {t('saved')}
                    </span>
                  )}
                </div>
                {(job.outputSize || 0) >= job.inputSize && <p className="notice">{t('larger')}</p>}
                <div className="preview-grid">
                  <div>
                    <h3>{t('before')}</h3>
                    <video
                      controls
                      preload="metadata"
                      src={original || undefined}
                      onError={() => setOriginalPreviewError(true)}
                      aria-label={t('before')}
                    />
                  </div>
                  <div>
                    <h3>{t('after')}</h3>
                    <video
                      controls
                      preload="metadata"
                      src={preview || undefined}
                      aria-label={t('after')}
                    />
                  </div>
                </div>
                {(job.options.codec === 'h265' || originalPreviewError) && (
                  <p className="field-help">
                    {job.options.codec === 'h265' ? t('h265Hint') : t('noPreview')}
                  </p>
                )}
                <Button onClick={download}>
                  <Download size={17} />
                  {t('downloadAction')}
                </Button>
              </>
            )}
            {['failed', 'cancelled'].includes(job.state) && (
              <Button onClick={() => action('retry')} disabled={busy}>
                <RotateCcw size={17} />
                {t('retry')}
              </Button>
            )}
            <div className="result-links">
              <Link href={`/${locale}/workspace`}>
                {t('workspace')}
                <ArrowRight size={14} />
              </Link>
              <Link href={`/${locale}/tools/video-compressor`}>{t('new')}</Link>
            </div>
            <p className="field-help">
              <Clock3 size={13} />
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(job.expiresAt),
              )}
            </p>
          </div>
        </>
      ) : (
        <div className="compressor-grid">
          <section className="panel file-panel">
            <div className="panel-label">
              <span>01</span>
              <h2>{t('file')}</h2>
            </div>
            <div
              className={`video-drop ${file ? 'has-file' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) select(e.dataTransfer.files[0]);
              }}
            >
              {file ? (
                <>
                  <video
                    key={localUrl}
                    src={localUrl || undefined}
                    onError={() => setLocalPreviewError(true)}
                    controls
                    preload="metadata"
                    aria-label={t('file')}
                  />
                  <div className="file-details">
                    <FileVideo size={24} />
                    <div>
                      <strong>{file.name}</strong>
                      <span>
                        {bytes(file.size)} · {file.name.split('.').pop()?.toUpperCase()}
                      </span>
                    </div>
                    <button
                      aria-label={t('replace')}
                      onClick={() => input.current?.click()}
                      disabled={busy}
                    >
                      <RotateCcw size={17} />
                    </button>
                  </div>
                  {localPreviewError && <p className="field-help">{t('noPreview')}</p>}
                </>
              ) : (
                <>
                  <div className="upload-glyph">
                    <Upload size={28} />
                  </div>
                  <h3>{t('subtitle')}</h3>
                  <p>{t('choose')}</p>
                  <Button onClick={() => input.current?.click()}>
                    <Upload size={17} />
                    {t('choose')}
                  </Button>
                  <span>MP4 · MOV · MKV · WebM · 1 GB</span>
                </>
              )}
            </div>
            <input
              type="file"
              accept=".mp4,.mov,.mkv,.webm"
              ref={input}
              className="sr-only"
              aria-label={t('choose')}
              onChange={(e) => select(e.target.files?.[0])}
            />
            <ExamplePicker
              exampleId="video"
              initialSampleId={initialSampleId}
              selectionKey={file ? `${file.name}:${file.size}:${file.lastModified}` : ''}
              busy={busy}
              onSelect={(source, example) => {
                if (example.kind !== 'video') return;
                select(source);
                setOptions(example.options);
              }}
            />
            {uploading && (
              <div className="upload-status">
                <div className="progress-label">
                  <strong>{t('uploading')}</strong>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="progress-track">
                  <div style={{ width: `${uploadProgress}%` }} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (paused) uppy.current?.resumeAll();
                    else uppy.current?.pauseAll();
                    setPaused(!paused);
                  }}
                >
                  {paused ? <Play size={14} /> : <Pause size={14} />}{' '}
                  {paused ? t('resume') : t('pause')}
                </Button>
              </div>
            )}
            <div className="file-reassurance">
              <ShieldCheck size={18} />
              <div>
                <strong>{t('expired')}</strong>
                <p>{t('resumeHint')}</p>
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <div className="panel-label">
              <span>02</span>
              <h2>{t('settings')}</h2>
              <SlidersHorizontal size={17} />
            </div>
            <fieldset disabled={busy}>
              <SettingsTabs
                label={t('settings')}
                basicLabel={t('basicMode')}
                advancedLabel={t('advancedMode')}
                disabled={busy}
                basic={
                  <fieldset>
                    <legend className="label">{t('quality')}</legend>
                    <div className="quality-options">
                      {(['light', 'balanced', 'strong'] as const).map((preset) => (
                        <label key={preset} className={options.preset === preset ? 'selected' : ''}>
                          <input
                            type="radio"
                            name="preset"
                            checked={options.preset === preset}
                            value={preset}
                            onChange={() =>
                              setOptions((current) => ({ ...current, preset, crf: undefined }))
                            }
                          />
                          <div>
                            <strong>{t(preset)}</strong>
                            <span>{t(`${preset}Hint`)}</span>
                          </div>
                          <span className="radio-indicator" aria-hidden="true">
                            {options.preset === preset && <Check size={12} strokeWidth={2.5} />}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                }
                advanced={
                  <>
                    <p className="settings-intro">{t('advancedHint')}</p>
                    <div className="form-grid">
                      <div>
                        <label className="label" htmlFor="video-codec">
                          {t('codec')}
                        </label>
                        <Select
                          value={options.codec}
                          disabled={busy}
                          onValueChange={(value) =>
                            setting('codec', value as CompressionOptions['codec'])
                          }
                        >
                          <SelectTrigger id="video-codec">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="h264">{t('h264')}</SelectItem>
                            <SelectItem value="h265">{t('h265')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="label" htmlFor="video-resolution">
                          {t('resolution')}
                        </label>
                        <Select
                          value={options.resolution}
                          disabled={busy}
                          onValueChange={(value) =>
                            setting('resolution', value as CompressionOptions['resolution'])
                          }
                        >
                          <SelectTrigger id="video-resolution">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="original">{t('original')}</SelectItem>
                            {['2160', '1080', '720', '480'].map((v) => (
                              <SelectItem value={v} key={v}>
                                {v}p
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="label" htmlFor="video-speed">
                          {t('speed')}
                        </label>
                        <Select
                          value={options.speed}
                          disabled={busy}
                          onValueChange={(value) =>
                            setting('speed', value as CompressionOptions['speed'])
                          }
                        >
                          <SelectTrigger id="video-speed">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['fast', 'medium', 'slow'].map((v) => (
                              <SelectItem value={v} key={v}>
                                {t(v)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <label>
                        <span className="label">{t('target')}</span>
                        <input
                          type="number"
                          min="0.1"
                          max="10240"
                          step="0.1"
                          className="field"
                          value={options.targetMb ?? ''}
                          onChange={(e) =>
                            setting('targetMb', e.target.value ? Number(e.target.value) : undefined)
                          }
                          placeholder="—"
                        />
                      </label>
                      <label>
                        <span className="label">{t('maxrate')}</span>
                        <input
                          type="number"
                          min="100"
                          max="100000"
                          className="field"
                          value={options.maxBitrateKbps ?? ''}
                          onChange={(e) =>
                            setting(
                              'maxBitrateKbps',
                              e.target.value ? Number(e.target.value) : undefined,
                            )
                          }
                          placeholder="—"
                        />
                      </label>
                      <label>
                        <span className="label">
                          {t('crf')} ·{' '}
                          {options.crf ?? { light: 23, balanced: 28, strong: 34 }[options.preset]}
                        </span>
                        <input
                          className="quality-range"
                          type="range"
                          min="18"
                          max="40"
                          value={
                            options.crf ?? { light: 23, balanced: 28, strong: 34 }[options.preset]
                          }
                          disabled={busy || !!options.targetMb}
                          onChange={(e) => setting('crf', Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <p className="field-help">
                      {options.targetMb ? t('targetHint') : t('crfHint')}
                    </p>
                    <div className="compatibility-note">
                      <strong>{t('compatibility')}</strong>
                      <p>{t('compatibilityHint')}</p>
                    </div>
                  </>
                }
              />
            </fieldset>
            <div className="start-task">
              <Button onClick={start} disabled={!file || busy}>
                {busy ? <LoaderCircle size={17} className="spinner" /> : <ArrowRight size={18} />}{' '}
                {busy ? t('starting') : t('start')}
              </Button>
              <CostEstimate tool="video-compressor" files={file ? [file] : []} options={options} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
