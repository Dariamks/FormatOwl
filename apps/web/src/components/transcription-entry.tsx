'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { forgetUpload, makeUploader, releaseUploader } from '@/lib/uploader';
import { formats, supportsInput } from '@filemorph/core/domain';
import type { PreparationView } from '@filemorph/core/editing';
import { transcriptionSchema } from '@filemorph/core/transcription';
import type Uppy from '@uppy/core';
import { ArrowLeft, FileText, LoaderCircle, Pause, Play, Upload } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { Button } from './ui/button';
import { SelectField, SelectItem } from './ui/select';
export default function TranscriptionEntry() {
  const translateError = useErrorTranslator();

  const copy = useTranslations('transcription');

  const locale = useLocale(),
    router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [provider, setProvider] = useState(''),
    [providerKind, setProviderKind] = useState(''),
    [asset, setAsset] = useState(''),
    [prep, setPrep] = useState<PreparationView | null>(null),
    [error, setError] = useState(''),
    [uploading, setUploading] = useState(false),
    [progress, setProgress] = useState(0),
    [language, setLanguage] = useState('auto'),
    [track, setTrack] = useState(-1),
    [paused, setPaused] = useState(false),
    [busy, setBusy] = useState(false);
  const upload = useRef<Uppy | null>(null),
    mounted = useRef(true),
    generation = useRef(0),
    input = useRef<HTMLInputElement>(null),
    requestId = useRef('');
  useEffect(() => {
    mounted.current = true;
    void request<{
      transcription: boolean;
      transcriptionProvider: string | null;
      transcriptionProviderKind: string | null;
    }>('capabilities')
      .then((r) => {
        setEnabled(r.transcription);
        setProvider(r.transcriptionProvider || '');
        setProviderKind(r.transcriptionProviderKind || '');
      })
      .catch((e) => setError(errorMessage(e, translateError)));
    return () => {
      mounted.current = false;
      if (upload.current) releaseUploader(upload.current);
    };
  }, [locale]);
  useEffect(() => {
    if (!asset) return;
    let active = true;
    const load = async () => {
      try {
        const p = await request<PreparationView>(
          `assets/${asset}/prepare?profile=audio&streamIndex=${track}`,
        );
        if (active) setPrep(p);
      } catch (e) {
        if (active) setError(errorMessage(e, translateError));
      }
    };
    void request(`assets/${asset}/prepare`, { profile: 'audio', streamIndex: track })
      .then(() => load())
      .catch((e) => {
        if (active) setError(errorMessage(e, translateError));
      });
    const timer = setInterval(() => void load(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [asset, track, locale]);
  async function select(file: File) {
    if (uploading || busy) return;
    if (!supportsInput('transcription', file.name) || !file.size || file.size > 1024 ** 3) {
      setError(errorMessage('UNSUPPORTED_FORMAT', translateError));
      return;
    }
    const current = ++generation.current;
    setError('');
    setUploading(true);
    setProgress(0);
    setAsset('');
    setPrep(null);
    setTrack(-1);
    requestId.current = '';
    try {
      if (upload.current) releaseUploader(upload.current);
      const result = await makeUploader(
        file,
        (p) => {
          if (mounted.current && current === generation.current) setProgress(p);
        },
        1,
      );
      upload.current = result.uppy;
      if (!mounted.current) {
        releaseUploader(result.uppy);
        return;
      }
      if (!result.ready) {
        const r = await result.uppy.upload();
        if (!r?.successful?.length) throw new Error('UPLOAD_FAILED');
      }
      if (mounted.current && current === generation.current) {
        setAsset(result.assetId);
        setProgress(100);
      }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e, translateError));
    } finally {
      if (mounted.current) setUploading(false);
    }
  }
  async function start() {
    if (!prep?.media) return;
    setBusy(true);
    setError('');
    requestId.current ||= crypto.randomUUID();
    try {
      const options = transcriptionSchema.parse({
        language,
        streamIndex: track < 0 ? prep.media.defaultAudioIndex : track,
      });
      const job = await request<{ id: string }>('jobs', {
        tool: 'transcription',
        assetId: asset,
        requestId: requestId.current,
        options,
      });
      forgetUpload(asset);
      router.push(`/${locale}/workspace/${job.id}`);
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  const tooLong = (prep?.media?.duration ?? 0) > 7200;
  useLocaleGuard({ busy: uploading || busy, dirty: Boolean(asset) });
  return (
    <div className="page-width batch-page transcript-page">
      <div className="page-heading">
        <Link className="back-link" href={`/${locale}`}>
          <ArrowLeft size={15} />
          {copy('all_tools_b390ab3')}
        </Link>
        <div className="title-with-icon">
          <span className="tool-icon ai">
            <FileText />
          </span>
          <h1>{copy('audio_video_to_text_c629601')}</h1>
        </div>
        <p>{copy('listen_edit_and_export_a_transcript_with_s_fd85739')}</p>
      </div>
      {enabled === false && (
        <div className="notice">{copy('transcription_awaits_service_configuration_e123230')}</div>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="batch-grid">
        <section className="panel batch-upload">
          <div className="panel-label">
            <span>01</span>
            <h2>{copy('upload_and_analyze_deca4ca')}</h2>
          </div>
          <div
            className="batch-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void select(f);
            }}
          >
            <Upload size={38} />
            <h3>{prep?.name || copy('drop_an_audio_or_video_file_fb09c28')}</h3>
            <p>{copy('one_file_up_to_1_gib_2_hours_0125712')}</p>
            <Button disabled={uploading || busy} onClick={() => input.current?.click()}>
              {copy('choose_file_eb7eb7a')}
            </Button>
            <input
              hidden
              type="file"
              ref={input}
              accept={formats.transcription.map((x) => '.' + x).join(',')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void select(f);
                e.target.value = '';
              }}
            />
            {uploading && (
              <>
                <p>{progress}%</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    paused ? upload.current?.resumeAll() : upload.current?.pauseAll();
                    setPaused(!paused);
                  }}
                >
                  {paused ? <Play size={16} /> : <Pause size={16} />}
                  {paused ? copy('resume_b3bd0b5') : copy('pause_781961b')}
                </Button>
              </>
            )}
          </div>
          {prep && (
            <>
              <p className="field-help">
                {prep.state === 'completed'
                  ? copy('ready_to_transcribe_5acc8c7')
                  : prep.error
                    ? errorMessage(prep.error, translateError)
                    : copy('analyzing_audio_511363a')}
              </p>
              {prep.previewUrl && (
                <audio className="transcript-player" controls src={prep.previewUrl} />
              )}
            </>
          )}
        </section>
        <section className="panel settings-panel">
          <div className="panel-label">
            <span>02</span>
            <h2>{copy('transcription_settings_f4bfbd5')}</h2>
          </div>
          <label className="label" htmlFor="transcript-language">
            {copy('language_89b86ab')}
          </label>
          <SelectField
            id="transcript-language"
            value={language}
            onValueChange={(nextValue) => {
              setLanguage(nextValue);
              requestId.current = '';
            }}
          >
            {[
              ['auto', copy('detect_automatically_25a3603')],
              ['zh', '中文'],
              ['en', 'English'],
              ['ja', '日本語'],
              ['ko', '한국어'],
              ['fr', 'Français'],
              ['de', 'Deutsch'],
              ['es', 'Español'],
              ['pt', 'Português'],
              ['it', 'Italiano'],
              ['ru', 'Русский'],
              ['ar', 'العربية'],
              ['hi', 'हिन्दी'],
            ].map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectField>
          {prep?.media && (
            <>
              <label className="label" htmlFor="transcript-track">
                {copy('audio_track_8ff5fe5')}
              </label>
              <SelectField
                id="transcript-track"
                value={String(track)}
                onValueChange={(nextValue) => {
                  setTrack(Number(nextValue));
                  setPrep(null);
                  requestId.current = '';
                }}
              >
                <SelectItem value={String(-1)}>{copy('default_audio_track_13b7e23')}</SelectItem>
                {prep.media.tracks.map((a) => (
                  <SelectItem key={a.index} value={String(a.index)}>
                    {a.index} · {a.language || a.title || a.codec}
                  </SelectItem>
                ))}
              </SelectField>
            </>
          )}
          <p className="field-help">
            {copy('audio_is_sent_to_value0_for_recognition_sp_bb31077', {
              value0: provider || 'the configured provider',
            })}
          </p>
          {providerKind === 'dashscope' && (
            <p className="field-help">
              {copy('for_local_testing_audio_chunks_use_alibaba_1b098c0')}
            </p>
          )}
          {tooLong && (
            <p role="alert" className="error-banner">
              {errorMessage('TRANSCRIPTION_LIMIT', translateError)}
            </p>
          )}
          <Button
            className="batch-submit"
            disabled={!enabled || !asset || prep?.state !== 'completed' || tooLong || busy}
            onClick={start}
          >
            {busy ? <LoaderCircle className="spinner" size={16} /> : null}
            {copy('start_transcription_748cd0c')}
          </Button>
          <CostEstimate
            tool="transcription"
            operation={
              asset && prep?.media
                ? {
                    path: 'jobs',
                    body: {
                      tool: 'transcription',
                      assetId: asset,
                      options: {
                        language,
                        streamIndex: track < 0 ? prep.media.defaultAudioIndex : track,
                      },
                    },
                  }
                : null
            }
          />
          {prep?.state === 'failed' && (
            <Button
              variant="outline"
              onClick={() =>
                void request(`assets/${asset}/prepare`, {
                  profile: 'audio',
                  streamIndex: track,
                  retry: true,
                }).catch((e) => setError(errorMessage(e, translateError)))
              }
            >
              {copy('retry_analysis_b6d5316')}
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
