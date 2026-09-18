'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { errorMessage, request } from '@/lib/client-api';
import { bytes } from '@/lib/utils';
import type { JobView } from '@filemorph/core/domain';
import { ChevronDown, Download, RotateCcw, Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PdfPreview } from './pdf-preview';
import { ToolIcon } from './tool-icon';
import { Button } from './ui/button';
export function FileResult({ job, onChange }: { job: JobView; onChange: () => void }) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('conversion');

  const t = useTranslations('batch'),
    w = useTranslations('workspace'),
    locale = useLocale();
  const [expanded, setExpanded] = useState(false),
    [urls, setUrls] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const complete = job.state === 'completed';
  useEffect(() => {
    let active = true;
    if (!expanded || !complete) {
      setUrls([]);
      return;
    }
    async function load() {
      try {
        const links = await Promise.all([
          request<{ url: string }>(`jobs/${job.id}/download?inline=1&preview=1&original=1`),
          request<{ url: string }>(`jobs/${job.id}/download?inline=1&preview=1`),
        ]);
        if (active) setUrls(links.map((l) => l.url));
      } catch (e) {
        if (active) setError(errorMessage(e, translateError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 12 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job.id, job.attempt, complete, expanded, locale]);
  async function action(action: 'retry' | 'cancel' | 'delete') {
    if (action === 'delete' && !window.confirm(w('deleteConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      await request(
        `jobs/${job.id}${action === 'delete' ? '' : `/${action}`}`,
        action === 'delete' ? undefined : {},
        action === 'delete' ? 'DELETE' : 'POST',
      );
      onChange();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    try {
      const { url } = await request<{ url: string }>(`jobs/${job.id}/download`);
      const a = document.createElement('a');
      a.href = url;
      a.click();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  const kind = job.tool.split('-')[0];
  return (
    <article className="file-result">
      <div className="file-result-main">
        <span className={`tool-icon ${kind}`}>
          <ToolIcon name={kind === 'pdf' ? 'file' : kind} />
        </span>
        <div className="file-result-name">
          <strong>{job.name}</strong>
          <p>
            {bytes(job.inputSize)}
            {complete && job.outputSize !== null ? ` → ${bytes(job.outputSize)}` : ''}
            {complete && job.outputSize !== null && job.outputSize < job.inputSize && (
              <span className="saving">
                {' '}
                −{Math.round((1 - job.outputSize / job.inputSize) * 100)}%
              </span>
            )}
          </p>
          <span className={`state-${job.state}`}>
            {w(job.state)}
            {['processing', 'cancelling'].includes(job.state) ? ` · ${job.progress}%` : ''}
          </span>
        </div>
        <div className="file-result-actions">
          {complete && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
              >
                {t('preview')}
                <ChevronDown size={14} />
              </Button>
              <Button size="sm" onClick={download} aria-label={`${t('download')} ${job.name}`}>
                <Download size={16} />
                {t('download')}
              </Button>
            </>
          )}
          {['failed', 'cancelled'].includes(job.state) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => action('retry')}>
              <RotateCcw size={15} />
              {t('retry')}
            </Button>
          )}
          {['queued', 'processing'].includes(job.state) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => action('cancel')}>
              <X size={15} />
              {t('cancel')}
            </Button>
          )}
          <button
            className="delete-button"
            disabled={busy}
            onClick={() => action('delete')}
            aria-label={`${t('delete')} ${job.name}`}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {['queued', 'processing', 'cancelling'].includes(job.state) && (
        <div className="progress-track">
          <div style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.note && complete && (
        <p className="file-note">
          {job.note === 'PRIMARY_IMAGE_ONLY'
            ? copy('converted_the_primary_heic_image_8f819f8')
            : job.note === 'FIRST_FRAME_ONLY'
              ? copy('converted_only_the_first_frame_as_selected_12be9c2')
              : t(job.note)}
        </p>
      )}
      {job.error && (
        <p className="error-banner" role="alert">
          {errorMessage(job.error, translateError)}
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {job.tool.endsWith('-converter') && 'format' in job.options && (
        <p className="file-details">
          {copy('output_format_c03f08a')}: {job.options.format?.toUpperCase()}
          {'codec' in job.options ? ` · ${job.options.codec.toUpperCase()}` : ''}
        </p>
      )}
      {job.media && (
        <p className="file-details">
          {'kind' in job.media && job.media.kind === 'audio'
            ? `${Math.round(job.media.duration)} s · ${job.media.sampleRate} Hz · ${job.media.channels} ch · ${job.media.bitrate} kbps${job.media.outputSampleRate ? ` → ${job.media.outputSampleRate} Hz · ${job.media.outputChannels} ch · ${job.media.outputBitrate} kbps` : ''}`
            : 'kind' in job.media && job.media.kind === 'pdf'
              ? t('pages', { count: job.media.pages })
              : 'width' in job.media
                ? `${job.media.width} × ${job.media.height}`
                : ''}
          {complete && job.outputName ? ` · ${job.outputName}` : ''}
        </p>
      )}
      {expanded && complete && (
        <div className="file-previews">
          {[0, 1].map((index) => (
            <div key={index}>
              <h3>{t(index === 0 ? 'original' : 'result')}</h3>
              {urls[index] ? (
                kind === 'pdf' ? (
                  <PdfPreview url={urls[index]} />
                ) : kind === 'video' ? (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={urls[index]}
                    onError={() => setError(t('previewFailed'))}
                  />
                ) : kind === 'audio' ? (
                  <audio
                    controls
                    preload="metadata"
                    src={urls[index]}
                    onError={() => setError(t('previewFailed'))}
                  />
                ) : (
                  <img
                    src={urls[index]}
                    alt={t(index === 0 ? 'original' : 'result')}
                    onError={() => setError(t('previewFailed'))}
                  />
                )
              ) : (
                <p>{t('loading')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
