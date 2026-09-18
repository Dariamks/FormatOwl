'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { pendingFiles } from '@/lib/pending-files';
import { forgetUpload, makeUploader, releaseUploader } from '@/lib/uploader';
import { bytes } from '@/lib/utils';
import {
  defaultConversionOptions,
  isConversionTool,
  type ConversionOptions,
} from '@filemorph/core/conversion';
import {
  formats,
  maxFileSize,
  supportsInput,
  terminalStates,
  type AudioOptions,
  type BatchTool,
  type BatchView,
  type JobView,
} from '@filemorph/core/domain';
import type Uppy from '@uppy/core';
import {
  ArrowLeft,
  Check,
  Download,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversionSettings } from './conversion-options';
import { CostEstimate } from './cost-estimate';
import { ExamplePicker } from './example-picker';
import { FileResult } from './file-result';
import { ToolIcon } from './tool-icon';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { SettingsTabs } from './ui/settings-tabs';
type Entry = { id: string; file: File; progress: number; assetId?: string; error?: string };
export function BatchCompressor({
  tool,
  batchId,
  jobId,
  showHeading = true,
  initialConversionOptions,
  inputExtensions,
  fixedOutputFormat,
  initialSampleId,
}: {
  tool: BatchTool;
  batchId?: string;
  jobId?: string;
  showHeading?: boolean;
  initialConversionOptions?: ConversionOptions;
  inputExtensions?: readonly string[];
  fixedOutputFormat?: ConversionOptions['format'];
  initialSampleId?: string;
}) {
  const labels = useTranslations('tools');
  const translateError = useErrorTranslator();

  const copy = useTranslations('conversion');

  const t = useTranslations('batch'),
    c = useTranslations('compress'),
    locale = useLocale(),
    router = useRouter();
  const [entries, setEntries] = useState<Entry[]>(() =>
    !batchId && !jobId
      ? pendingFiles.current
          .filter(
            (file) =>
              !inputExtensions ||
              inputExtensions.includes(file.name.split('.').pop()!.toLowerCase()),
          )
          .map((file) => ({ id: crypto.randomUUID(), file, progress: 0 }))
      : [],
  );
  const converting = isConversionTool(tool);
  const [conversionOptions, setConversionOptions] = useState<ConversionOptions>(
    () =>
      initialConversionOptions ??
      defaultConversionOptions(isConversionTool(tool) ? tool : 'image-converter'),
  );
  const [options, setOptions] = useState<AudioOptions>({
      preset: 'balanced',
      format: 'mp3',
      sampleRate: 'auto',
      channels: 'auto',
    }),
    [busy, setBusy] = useState(false),
    [paused, setPaused] = useState(false),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false),
    [batch, setBatch] = useState<BatchView | null>(null),
    [actionBusy, setActionBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    uploaders = useRef(new Map<string, Uppy>()),
    mounted = useRef(true),
    requestId = useRef(''),
    pausedRef = useRef(false);
  const isResult = !!(batchId || jobId),
    kind = tool.split('-')[0];
  useEffect(() => {
    mounted.current = true;
    pendingFiles.current = [];
    return () => {
      mounted.current = false;
      for (const uploader of uploaders.current.values()) releaseUploader(uploader);
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!isResult) return;
    try {
      if (batchId) {
        const data = await request<{ batch: BatchView }>(`batches/${batchId}`);
        if (mounted.current) setBatch(data.batch);
      } else {
        const data = await request<{ job: JobView }>(`jobs/${jobId}`);
        if (mounted.current)
          setBatch({
            id: '',
            tool,
            jobs: [data.job],
            expiresAt: data.job.expiresAt,
            archive: null,
          });
      }
      if (mounted.current) setError('');
    } catch (e) {
      if (mounted.current) setError(errorMessage(e, translateError));
    }
  }, [batchId, jobId, isResult, tool, locale]);
  useEffect(() => {
    void refresh();
    if (!isResult) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh, isResult]);
  function select(files: File[]) {
    if (busy) return;
    setError('');
    if (
      inputExtensions &&
      files.some((file) => !inputExtensions.includes(file.name.split('.').pop()!.toLowerCase()))
    ) {
      setError(
        copy('this_page_accepts_value0_files_only_use_th_4d977d0', {
          value0: inputExtensions.join(', ').toUpperCase(),
        }),
      );
      return;
    }
    if (files.some((file) => !supportsInput(tool, file.name))) {
      setError(t('sameType'));
      return;
    }
    if (files.some((file) => file.size > maxFileSize(tool) || file.size === 0)) {
      setError(t('sizeLimit', { size: bytes(maxFileSize(tool)) }));
      return;
    }
    const fresh = files.filter(
      (f) =>
        !entries.some(
          (e) =>
            e.file.name === f.name &&
            e.file.size === f.size &&
            e.file.lastModified === f.lastModified,
        ),
    );
    if (entries.length + fresh.length > 20) {
      setError(t('batchLimit'));
      return;
    }
    requestId.current = '';
    setEntries((previous) => [
      ...previous,
      ...fresh.map((file) => ({ id: crypto.randomUUID(), file, progress: 0 })),
    ]);
  }
  function update(id: string, patch: Partial<Entry>) {
    if (mounted.current)
      setEntries((previous) =>
        previous.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
  }
  async function start() {
    if (!entries.length || busy) return;
    setBusy(true);
    setPaused(false);
    pausedRef.current = false;
    setError('');
    requestId.current ||= crypto.randomUUID();
    let cursor = 0;
    const ready = new Map<string, string>();
    let failed = false;
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, entries.length) }, async () => {
          for (;;) {
            const entry = entries[cursor++];
            if (!entry || !mounted.current) return;
            if (entry.assetId) {
              ready.set(entry.id, entry.assetId);
              continue;
            }
            try {
              update(entry.id, { error: undefined });
              const previous = uploaders.current.get(entry.id);
              if (previous) releaseUploader(previous);
              const upload = await makeUploader(
                entry.file,
                (value) => update(entry.id, { progress: value }),
                1,
              );
              uploaders.current.set(entry.id, upload.uppy);
              if (!mounted.current) {
                releaseUploader(upload.uppy);
                return;
              }
              if (!upload.ready) {
                const uploading = upload.uppy.upload();
                if (pausedRef.current) upload.uppy.pauseAll();
                const result = await uploading;
                if (!result?.successful?.length) throw new Error('UPLOAD_FAILED');
              }
              ready.set(entry.id, upload.assetId);
              update(entry.id, { assetId: upload.assetId, progress: 100 });
            } catch (e) {
              failed = true;
              update(entry.id, { error: errorMessage(e, translateError) });
            }
          }
        }),
      );
      if (!mounted.current) return;
      if (failed) {
        setError(t('uploadRetry'));
        return;
      }
      const result = await request<{ id: string }>('batches', {
        tool,
        assetIds: entries.map((e) => ready.get(e.id)),
        requestId: requestId.current,
        options: converting
          ? conversionOptions
          : tool === 'audio-compressor'
            ? options
            : { preset: options.preset },
      });
      for (const id of ready.values()) forgetUpload(id);
      router.push(`/${locale}/batches/${result.id}`);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e, translateError));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function batchAction(action: 'cancel' | 'retry') {
    setActionBusy(true);
    try {
      await request(`batches/${batchId}/${action}`, {});
      await refresh();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setActionBusy(false);
    }
  }
  async function zip() {
    setActionBusy(true);
    try {
      if (batch?.archive?.state === 'completed') {
        const { url } = await request<{ url: string }>(`archives/${batch.archive.id}`);
        const a = document.createElement('a');
        a.href = url;
        a.click();
      } else {
        await request(`batches/${batchId}/archive`, {});
        await refresh();
      }
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setActionBusy(false);
    }
  }
  const active = batch?.jobs.some((job) => !terminalStates.includes(job.state)),
    completed = batch?.jobs.filter((j) => j.state === 'completed').length || 0;
  function setting(key: keyof AudioOptions, value: string) {
    requestId.current = '';
    setOptions((old) => ({
      ...old,
      [key]: key === 'bitrate' ? (value === 'auto' ? undefined : Number(value)) : value,
    }));
  }
  function dropdown(key: 'format' | 'bitrate' | 'sampleRate' | 'channels', values: string[]) {
    return (
      <div>
        <label className="label" htmlFor={`audio-${key}`}>
          {t(key)}
        </label>
        <Select
          disabled={busy}
          value={String(options[key] ?? 'auto')}
          onValueChange={(value) => setting(key, value)}
        >
          <SelectTrigger id={`audio-${key}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {values.map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'auto'
                  ? t('auto')
                  : key === 'channels'
                    ? t(value === '1' ? 'mono' : 'stereo')
                    : value.toUpperCase() +
                      (key === 'bitrate' ? ' kbps' : key === 'sampleRate' ? ' Hz' : '')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  const compressionPresets = (
    <fieldset>
      <legend className="label">{t('preset')}</legend>
      <div className="quality-options">
        {(['light', 'balanced', 'strong'] as const).map((preset) => (
          <label key={preset} className={options.preset === preset ? 'selected' : ''}>
            <input
              type="radio"
              name="compression-preset"
              checked={options.preset === preset}
              onChange={() => {
                requestId.current = '';
                setOptions((old) => ({ ...old, preset, bitrate: undefined }));
              }}
            />
            <div>
              <strong>{t(preset)}</strong>
              <span>{t(`${kind}${preset}`)}</span>
            </div>
            <span className="radio-indicator" aria-hidden="true">
              {options.preset === preset && <Check size={12} strokeWidth={2.5} />}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  useLocaleGuard({ busy: busy || actionBusy, dirty: entries.length > 0 && !isResult });
  return (
    <div className="page-width batch-page">
      {showHeading && (
        <div className="page-heading">
          <Link href={`/${locale}`} className="back-link">
            <ArrowLeft size={15} />
            {c('back')}
          </Link>
          <div className="title-with-icon">
            <span className={`tool-icon ${kind}`}>
              <ToolIcon name={kind === 'pdf' ? 'file' : kind} />
            </span>
            <h1>{converting ? labels(`${tool}.name`) : t(`${kind}Title`)}</h1>
          </div>
          <p>
            {converting
              ? copy('choose_a_format_convert_preview_and_downlo_5c76333')
              : t(`${kind}Intro`)}
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {isResult ? (
        <>
          {!batch ? (
            <div className="panel empty-state">
              <LoaderCircle className="spinner" />
              <p>{t('loading')}</p>
            </div>
          ) : (
            <>
              <div className="batch-toolbar">
                <div>
                  <h2>{t('results')}</h2>
                  <p>{t('completedCount', { completed, total: batch.jobs.length })}</p>
                </div>
                <div className="action-row">
                  {batchId && (
                    <>
                      {active && (
                        <Button
                          variant="outline"
                          disabled={actionBusy}
                          onClick={() => batchAction('cancel')}
                        >
                          {t('cancelAll')}
                        </Button>
                      )}
                      {batch.jobs.some((j) => ['failed', 'cancelled'].includes(j.state)) && (
                        <Button
                          variant="outline"
                          disabled={actionBusy}
                          onClick={() => batchAction('retry')}
                        >
                          {t('retryFailed')}
                        </Button>
                      )}
                      <Button
                        disabled={
                          actionBusy ||
                          active ||
                          !completed ||
                          ['queued', 'processing'].includes(batch.archive?.state || '')
                        }
                        onClick={zip}
                      >
                        <Download size={17} />
                        {['queued', 'processing'].includes(batch.archive?.state || '')
                          ? t('packing')
                          : batch.archive?.state === 'completed'
                            ? t('downloadZip')
                            : t('makeZip')}
                      </Button>
                    </>
                  )}
                  <Button asChild variant="outline">
                    <Link href={`/${locale}/tools/${tool}`}>{t('newBatch')}</Link>
                  </Button>
                </div>
              </div>
              {batch.archive?.error && (
                <div className="error-banner">
                  {errorMessage(batch.archive.error, translateError)}
                </div>
              )}
              {batchId && !active && completed < batch.jobs.length && (
                <p className="file-note">{t('zipSuccessOnly')}</p>
              )}
              <div className="batch-results">
                {batch.jobs.map((job) => (
                  <FileResult key={job.id} job={job} onChange={refresh} />
                ))}
              </div>
              {!batch.jobs.length && <p className="panel">{t('emptyResults')}</p>}
              {!batchId && batch.jobs[0]?.batchId && (
                <Link className="back-link" href={`/${locale}/batches/${batch.jobs[0].batchId}`}>
                  {t('backBatch')}
                </Link>
              )}
            </>
          )}
        </>
      ) : (
        <div className="batch-grid">
          <section className="panel batch-upload">
            <div className="panel-label">
              <span>01</span>
              <h2>{c('upload')}</h2>
              <Upload size={18} />
            </div>
            <div
              className={`batch-drop ${drag ? 'is-dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                select([...e.dataTransfer.files]);
              }}
            >
              <span className="upload-glyph">
                <Upload size={30} />
              </span>
              <h3>{t('drop')}</h3>
              <p>{(inputExtensions ?? formats[tool]).map((v) => v.toUpperCase()).join(' · ')}</p>
              <Button disabled={busy} onClick={() => input.current?.click()}>
                <Plus size={16} />
                {t('choose')}
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                disabled={busy}
                accept={(inputExtensions ?? formats[tool]).map((v) => `.${v}`).join(',')}
                aria-label={t('choose')}
                onChange={(e) => {
                  select([...(e.target.files || [])]);
                  e.target.value = '';
                }}
              />
              <p className="field-help">{t('limits', { size: bytes(maxFileSize(tool)) })}</p>
            </div>
            {(tool === 'pdf-compressor' ||
              (tool === 'image-converter' &&
                (!inputExtensions || inputExtensions.includes('webp')) &&
                (!fixedOutputFormat || fixedOutputFormat === 'jpg'))) && (
              <ExamplePicker
                exampleId={tool === 'pdf-compressor' ? 'pdf' : 'image'}
                initialSampleId={initialSampleId}
                selectionKey={entries.map((entry) => entry.id).join(',')}
                busy={busy}
                onSelect={(source, example) => {
                  for (const uploader of uploaders.current.values()) releaseUploader(uploader);
                  uploaders.current.clear();
                  requestId.current = '';
                  setEntries([{ id: crypto.randomUUID(), file: source, progress: 0 }]);
                  setError('');
                  if (example.kind === 'image') setConversionOptions(example.options);
                  if (example.kind === 'pdf')
                    setOptions((current) => ({ ...current, preset: example.options.preset }));
                }}
              />
            )}
            <div className="selected-files">
              {entries.map((entry) => (
                <div key={entry.id} className="selected-file">
                  <ToolIcon name={kind === 'pdf' ? 'file' : kind} size={20} />
                  <div>
                    <strong>{entry.file.name}</strong>
                    <p>
                      {bytes(entry.file.size)}
                      {entry.progress > 0 ? ` · ${entry.progress}%` : ''}
                    </p>
                    {entry.error && <p className="error-text">{entry.error}</p>}
                    {busy && (
                      <div className="progress-track">
                        <div style={{ width: `${entry.progress}%` }} />
                      </div>
                    )}
                  </div>
                  <button
                    className="delete-button"
                    disabled={busy}
                    aria-label={`${t('remove')} ${entry.file.name}`}
                    onClick={() => {
                      requestId.current = '';
                      setEntries((old) => old.filter((e) => e.id !== entry.id));
                    }}
                  >
                    <X size={17} />
                  </button>
                </div>
              ))}
            </div>
            {busy && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  pausedRef.current = !paused;
                  for (const uppy of uploaders.current.values())
                    paused ? uppy.resumeAll() : uppy.pauseAll();
                  setPaused(!paused);
                }}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
                {t(paused ? 'resume' : 'pause')}
              </Button>
            )}
          </section>
          <section className="panel settings-panel batch-settings">
            <div className="panel-label">
              <span>02</span>
              <h2>{c('settings')}</h2>
            </div>
            <fieldset disabled={busy}>
              {converting ? (
                <ConversionSettings
                  tool={tool}
                  disabled={busy}
                  value={conversionOptions}
                  fixedOutputFormat={fixedOutputFormat}
                  onChange={(value) => {
                    requestId.current = '';
                    setConversionOptions(value);
                  }}
                />
              ) : (
                <>
                  {tool === 'audio-compressor' ? (
                    <SettingsTabs
                      label={c('settings')}
                      basicLabel={c('basicMode')}
                      advancedLabel={c('advancedMode')}
                      disabled={busy}
                      common={dropdown('format', ['mp3', 'm4a'])}
                      basic={compressionPresets}
                      advanced={
                        <div className="form-grid">
                          {dropdown('bitrate', [
                            'auto',
                            '32',
                            '64',
                            '96',
                            '128',
                            '192',
                            '256',
                            '320',
                          ])}
                          {dropdown('sampleRate', ['auto', '22050', '32000', '44100', '48000'])}
                          {dropdown('channels', ['auto', '1', '2'])}
                        </div>
                      }
                    />
                  ) : (
                    compressionPresets
                  )}
                  <div className="compatibility-note">
                    <ShieldCheck size={17} />
                    <p>{t(`${kind}Note`)}</p>
                  </div>
                </>
              )}
              <Button className="batch-submit" disabled={busy || !entries.length} onClick={start}>
                {busy ? <LoaderCircle className="spinner" size={18} /> : null}
                {busy ? t('uploading') : converting ? copy('convert_files_868811b') : t('start')}
                {entries.length ? ` · ${entries.length}` : ''}
              </Button>
              <CostEstimate
                tool={tool}
                files={entries.map((e) => e.file)}
                options={converting ? conversionOptions : options}
              />
            </fieldset>
          </section>
        </div>
      )}
      <p className="workspace-note">
        <ShieldCheck size={16} />
        {t('privacy')}
      </p>
    </div>
  );
}
