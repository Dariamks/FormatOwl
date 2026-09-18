'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLanguageName } from '@/i18n/language-name';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { forgetUpload, makeUploader, releaseUploader } from '@/lib/uploader';
import { formats, maxFileSize, supportsInput } from '@filemorph/core/domain';
import type { PreparationView } from '@filemorph/core/editing';
import { translationLanguages, type TranslationTool } from '@filemorph/core/translation';
import type Uppy from '@uppy/core';
import {
  ArrowLeft,
  FileCheck,
  Languages,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import './translation-workspace.css';
import { Button } from './ui/button';
import { SelectField, SelectItem } from './ui/select';
export default function TranslationEntry({ tool }: { tool: TranslationTool }) {
  const languageName = useLanguageName();

  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale(),
    zh = locale === 'zh',
    router = useRouter();
  const [cap, setCap] = useState<{
      translation: boolean;
      workerReady: boolean;
      subtitleBurn: boolean;
    } | null>(null),
    [file, setFile] = useState<File | null>(null),
    [asset, setAsset] = useState(''),
    [progress, setProgress] = useState(0),
    [uploading, setUploading] = useState(false),
    [paused, setPaused] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [source, setSource] = useState('auto'),
    [target, setTarget] = useState(zh ? 'en' : 'zh'),
    [prep, setPrep] = useState<PreparationView | null>(null),
    [track, setTrack] = useState(-1);
  const [thumbnail, setThumbnail] = useState('');
  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      setThumbnail('');
      return;
    }
    const url = URL.createObjectURL(file);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const uploader = useRef<Uppy | null>(null),
    generation = useRef(0),
    mounted = useRef(true),
    requestId = useRef('');
  const video = tool === 'video-translator';
  const title = video
    ? copy('translate_video_8bab2ec')
    : tool === 'document-translator'
      ? copy('translate_document_a51a649')
      : copy('translate_image_86c367d');
  useEffect(() => {
    mounted.current = true;
    void request<typeof cap & {}>('capabilities')
      .then(setCap)
      .catch((e) => setError(errorMessage(e, translateError)));
    return () => {
      mounted.current = false;
      generation.current++;
      if (uploader.current) releaseUploader(uploader.current);
    };
  }, [locale]);
  useEffect(() => {
    if (!asset || !video) return;
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
      .then(load)
      .catch((e) => setError(errorMessage(e, translateError)));
    void request(`assets/${asset}/prepare`, { profile: 'video', streamIndex: track }).catch(
      () => {},
    );
    const timer = setInterval(load, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [asset, video, track, locale]);
  async function select(f: File) {
    if (uploading || busy) return;
    if (!supportsInput(tool, f.name) || !f.size || f.size > maxFileSize(tool)) {
      setError(copy('unsupported_file_format_or_file_too_large_35d9c88'));
      return;
    }
    const current = ++generation.current;
    setFile(f);
    setAsset('');
    setPrep(null);
    setTrack(-1);
    setError('');
    setProgress(0);
    setUploading(true);
    requestId.current = '';
    try {
      if (uploader.current) releaseUploader(uploader.current);
      const result = await makeUploader(
        f,
        (p) => {
          if (current === generation.current) setProgress(p);
        },
        1,
      );
      uploader.current = result.uppy;
      if (!mounted.current) {
        releaseUploader(result.uppy);
        return;
      }
      if (!result.ready) {
        const r = await result.uppy.upload();
        if (!r?.successful?.length) throw new Error('UPLOAD_FAILED');
      }
      if (current === generation.current) {
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
    setBusy(true);
    setError('');
    requestId.current ||= crypto.randomUUID();
    try {
      const job = await request<{ id: string }>('jobs', {
        tool,
        assetId: asset,
        requestId: requestId.current,
        options: {
          sourceLanguage: source,
          targetLanguage: target,
          streamIndex: video ? (track < 0 ? prep?.media?.defaultAudioIndex : track) : 0,
        },
      });
      forgetUpload(asset);
      router.push(`/${locale}/workspace/${job.id}`);
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  useLocaleGuard({ busy: uploading || busy, dirty: Boolean(file) });
  return (
    <main className="page-width translation-entry">
      <Link className="back-link" href={`/${locale}`}>
        <ArrowLeft size={15} />
        {copy('all_tools_b390ab3')}
      </Link>
      <div className="page-heading">
        <div className="title-with-icon">
          <span className="tool-icon ai">
            <Languages />
          </span>
          <h1>{title}</h1>
        </div>
        <p>
          {video
            ? copy('keep_the_original_voice_translate_refine_a_1b663ca')
            : tool === 'document-translator'
              ? copy('across_languages_with_the_structure_of_you_9b76690')
              : copy('recognize_text_restore_the_background_and_e70b951')}
        </p>
      </div>
      <nav className="translation-tool-switch" aria-label={copy('translation_tools_418179a')}>
        {(['document-translator', 'image-translator', 'video-translator'] as const).map((v) => (
          <Link key={v} href={`/${locale}/tools/${v}`} className={tool === v ? 'active' : ''}>
            {v === 'document-translator'
              ? copy('document_e214b8a')
              : v === 'image-translator'
                ? copy('image_50e19fd')
                : copy('video_bc17c1f')}
          </Link>
        ))}
      </nav>
      <div className="translation-entry-grid">
        <section
          className="panel translation-upload"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files[0]) void select(e.dataTransfer.files[0]);
          }}
        >
          {thumbnail && (
            <img
              className="translation-upload-thumbnail"
              src={thumbnail}
              alt={copy('selected_image_1d97fe3')}
            />
          )}
          <span className="translation-upload-icon">
            {asset ? <FileCheck size={34} /> : <Upload size={34} />}
          </span>
          <h2>{file ? file.name : copy('drop_your_file_here_65f4b6c')}</h2>
          {file && (
            <p className="translation-file-size">
              {file.size < 1024 * 1024
                ? `${(file.size / 1024).toFixed(1)} KB`
                : `${(file.size / 1024 / 1024).toFixed(2)} MB`}
            </p>
          )}
          <p>{formats[tool].map((f) => f.toUpperCase()).join(' · ')}</p>
          <p className="muted">
            {video
              ? copy('up_to_1_gib_2_hours_19e82de')
              : tool === 'image-translator'
                ? copy('up_to_50_mib_one_image_at_a_time_044e2ff')
                : copy('up_to_50_mib_documents_100_pages_100_000_c_903fc15')}
          </p>
          <label className="translation-file-label">
            {file ? copy('choose_another_file_6235237') : copy('choose_file_eb7eb7a')}
            <input
              aria-label={copy('choose_file_eb7eb7a')}
              type="file"
              accept={formats[tool].map((f) => '.' + f).join(',')}
              disabled={uploading || busy}
              onChange={(e) => {
                if (e.target.files?.[0]) void select(e.target.files[0]);
              }}
            />
          </label>
          {(uploading || asset) && (
            <div className="translation-upload-progress">
              <progress max={100} value={progress} />
              <span>{Math.round(progress)}%</span>
              {uploading && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (paused) uploader.current?.resumeAll();
                    else uploader.current?.pauseAll();
                    setPaused(!paused);
                  }}
                >
                  {paused ? <Play size={14} /> : <Pause size={14} />}{' '}
                  {paused ? copy('resume_b3bd0b5') : copy('pause_781961b')}
                </Button>
              )}
            </div>
          )}
          {video && asset && prep?.state !== 'completed' && (
            <p role="status">
              <LoaderCircle className="spin" size={15} />{' '}
              {prep?.state === 'failed'
                ? errorMessage(prep.error || 'PROCESSING_FAILED', translateError)
                : copy('preparing_audio_tracks_1debe3d')}
            </p>
          )}
        </section>
        <section className="panel translation-settings">
          <label>
            {copy('source_language_c951fe1')}
            <SelectField
              value={source}
              onValueChange={(nextValue) => {
                setSource(nextValue);
                requestId.current = '';
              }}
            >
              {['auto', ...translationLanguages].map((l) => (
                <SelectItem key={l} value={l}>
                  {languageName(l)}
                </SelectItem>
              ))}
            </SelectField>
          </label>
          <label>
            {copy('target_language_f137c97')}
            <SelectField
              value={target}
              onValueChange={(nextValue) => {
                setTarget(nextValue);
                requestId.current = '';
              }}
            >
              {translationLanguages.map((l) => (
                <SelectItem key={l} value={l}>
                  {languageName(l)}
                </SelectItem>
              ))}
            </SelectField>
          </label>
          {video && prep?.media && (
            <label>
              {copy('audio_track_8ff5fe5')}
              <SelectField
                value={String(track)}
                onValueChange={(nextValue) => {
                  setTrack(Number(nextValue));
                  requestId.current = '';
                }}
              >
                <SelectItem value={String(-1)}>{copy('default_track_e296804')}</SelectItem>
                {prep.media.tracks.map((a) => (
                  <SelectItem key={a.index} value={String(a.index)}>
                    {a.index + 1} · {a.language || a.codec} {a.title || ''}
                  </SelectItem>
                ))}
              </SelectField>
            </label>
          )}
          <details>
            <summary>{copy('advanced_options_file_details_311a536')}</summary>
            <p>{copy('recognition_and_translation_use_alibaba_cl_45c4169')}</p>
            <p>{copy('review_complex_layouts_recognized_text_and_3f68d07')}</p>
          </details>
          {cap && !cap.translation && (
            <div className="notice">
              {copy('translation_is_not_configured_configure_mo_0543dad')}
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <Button
            className="translation-start"
            disabled={
              !asset ||
              busy ||
              !cap?.translation ||
              (video && prep?.state !== 'completed') ||
              source === target
            }
            onClick={start}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Languages size={16} />}{' '}
            {copy('start_translation_f769911')}
          </Button>
          <CostEstimate
            tool={tool}
            files={file ? [file] : []}
            operation={
              asset && (!video || prep?.media)
                ? {
                    path: 'jobs',
                    body: {
                      tool,
                      assetId: asset,
                      options: {
                        sourceLanguage: source,
                        targetLanguage: target,
                        streamIndex: video
                          ? track < 0
                            ? prep?.media?.defaultAudioIndex
                            : track
                          : 0,
                      },
                    },
                  }
                : null
            }
            note={copy('recognition_translation_and_background_rep_53cccf3')}
          />
          {cap && !cap.workerReady && (
            <p role="status" className="muted">
              {copy('the_processing_service_is_not_ready_upload_019c1b2')}
            </p>
          )}
          {source === target && (
            <p className="muted">{copy('choose_different_source_and_target_languag_58a5871')}</p>
          )}
          <p className="translation-private">
            <ShieldCheck size={15} />
            {copy('files_are_private_to_your_session_bb8d4cf')}
          </p>
        </section>
      </div>
    </main>
  );
}
