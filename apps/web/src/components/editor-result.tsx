'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { errorMessage, request } from '@/lib/client-api';
import { bytes } from '@/lib/utils';
import { tools } from '@filemorph/core/catalog';
import { terminalStates, type JobView } from '@filemorph/core/domain';
import { isEditorTool, type EditOptions } from '@filemorph/core/editing';
import { Download, RotateCcw, Scissors, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { saveEditorDraft } from './media-editor';
import { Button } from './ui/button';

export default function EditorResult({ id }: { id: string }) {
  const translateError = useErrorTranslator();
  const labels = useTranslations('tools');

  const copy = useTranslations('media');

  const locale = useLocale(),
    w = useTranslations('workspace'),
    router = useRouter();
  const [job, setJob] = useState<JobView | null>(null),
    [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { job } = await request<{ job: JobView }>(`jobs/${id}`);
        if (stopped) return;
        setJob(job);
        setError('');
        if (job.state === 'completed') {
          const data = await request<{ url: string }>(`jobs/${id}/download?inline=1&preview=1`);
          if (!stopped) setUrl(data.url);
        }
        if (!stopped)
          timer = setTimeout(poll, terminalStates.includes(job.state) ? 12 * 60 * 1000 : 1200);
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
  }, [id, locale, revision]);
  async function action(value: 'cancel' | 'retry') {
    setBusy(true);
    try {
      const data = await request<{ job: JobView }>(`jobs/${id}/${value}`, {});
      setJob(data.job);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  const catalog = tools.find((t) => t.id === job?.tool);
  return (
    <div className="page-width editor-page">
      <div className="page-heading">
        <Link className="back-link" href={`/${locale}/workspace`}>
          ← {copy('workspace_4ca0a75')}
        </Link>
        <h1>{catalog ? labels(`${catalog.id}.name`) : copy('loading_33ce417')}</h1>
        <p>{job?.name}</p>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {job && (
        <section className="panel editor-result">
          <div className="editor-section-heading">
            <h2>{w(job.state)}</h2>
            <span>{!terminalStates.includes(job.state) ? `${job.progress}%` : ''}</span>
          </div>
          {!terminalStates.includes(job.state) && (
            <div className="progress-track">
              <div style={{ width: `${job.progress}%` }} />
            </div>
          )}
          {job.error && (
            <p className="error-banner" role="alert">
              {errorMessage(job.error, translateError)}
            </p>
          )}
          {job.state === 'completed' &&
            url &&
            (job.outputMime?.startsWith('video/') ? (
              <video src={url} controls playsInline preload="auto" />
            ) : (
              <audio src={url} controls preload="auto" />
            ))}
          {job.outputMedia && (
            <div className="editor-result-details">
              <strong>{job.outputName}</strong>
              <span>
                {job.outputMedia.duration.toFixed(3)} s · {job.outputMedia.codec.toUpperCase()}{' '}
                {job.outputMedia.width
                  ? `· ${job.outputMedia.width} × ${job.outputMedia.height}`
                  : `· ${job.outputMedia.sampleRate} Hz · ${job.outputMedia.channels} ch · ${job.outputMedia.bitrate} kbps`}
              </span>
              <span>
                {bytes(job.inputSize)} → {bytes(job.outputSize || 0)} · {job.sourceIds.length}{' '}
                {copy('sources_bce16dd')}
              </span>
            </div>
          )}
          <div className="action-row">
            {job.state === 'completed' && (
              <Button
                onClick={async () => {
                  try {
                    const { url } = await request<{ url: string }>(`jobs/${id}/download`);
                    const a = document.createElement('a');
                    a.href = url;
                    a.click();
                  } catch (e) {
                    setError(errorMessage(e, translateError));
                  }
                }}
              >
                <Download size={17} />
                {copy('download_file_774025d')}
              </Button>
            )}
            {['queued', 'processing'].includes(job.state) && (
              <Button variant="outline" disabled={busy} onClick={() => void action('cancel')}>
                <X size={17} />
                {copy('cancel_processing_15fc179')}
              </Button>
            )}
            {['failed', 'cancelled'].includes(job.state) && (
              <Button variant="outline" disabled={busy} onClick={() => void action('retry')}>
                <RotateCcw size={17} />
                {copy('retry_9f5cd8a')}
              </Button>
            )}
            {job.state !== 'expired' && isEditorTool(job.tool) && (
              <Button
                variant="outline"
                onClick={() => {
                  if (!isEditorTool(job.tool)) return;
                  const profile =
                    job.tool === 'video-cutter' || job.tool === 'video-cropper' ? 'video' : 'audio';
                  saveEditorDraft(
                    job.tool,
                    job.sourceIds.map((assetId) => ({
                      assetId,
                      profile,
                      streamIndex: -1,
                      name: assetId === job.sourceIds[0] ? job.name : copy('source_6da13ad'),
                      size: 0,
                      expiresAt: job.expiresAt,
                    })),
                    job.options as EditOptions,
                  );
                  router.push(`/${locale}/tools/${job.tool}`);
                }}
              >
                <Scissors size={17} />
                {copy('continue_editing_b101465')}
              </Button>
            )}
          </div>
          <p className="editor-footer">
            {copy('files_available_until_f83822e')} {new Date(job.expiresAt).toLocaleString(locale)}
          </p>
        </section>
      )}
    </div>
  );
}
