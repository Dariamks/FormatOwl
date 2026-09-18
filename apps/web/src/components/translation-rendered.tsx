'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { errorMessage, request } from '@/lib/client-api';
import type { PreviewResult, ReadingActivity } from '@filemorph/core/reading';
import type { TranslationView } from '@filemorph/core/translation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PdfPreview } from './pdf-preview';
import { Button } from './ui/button';

export function TranslationRendered({
  id,
  view,
  page,
  enabled,
  selected,
  onSelect,
  onIssues,
  zoom,
  original,
  slider,
  documentPage,
  onDocumentPageChange,
  quiet = false,
}: {
  id: string;
  view: TranslationView;
  page: number;
  enabled: boolean;
  selected: string;
  onSelect: (id: string) => void;
  onIssues: (ids: string[]) => void;
  zoom: number;
  original?: string;
  slider?: boolean;
  documentPage?: number;
  onDocumentPageChange?: (page: number) => void;
  quiet?: boolean;
}) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('translation');

  const locale = useLocale();
  const [activity, setActivity] = useState<ReadingActivity | null>(null),
    [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [split, setSplit] = useState(50),
    [retry, setRetry] = useState(0);
  const pageContent = JSON.stringify(view.data?.blocks.filter((b) => b.page === page));
  useEffect(() => {
    if (!enabled) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    setError('');
    setActivity(null);
    setUrl('');
    const poll = async (a: ReadingActivity) => {
      if (!live) return;
      setActivity(a);
      if (a.state === 'completed') {
        const r = await request<{ url: string }>(
          `reading-activities/${a.id}/download?format=preview`,
        );
        if (live) {
          setUrl(r.url);
          onIssues((a.result as PreviewResult).overflow);
        }
      } else if (['queued', 'processing', 'cancelling'].includes(a.state)) {
        timer = setTimeout(
          () =>
            void request<{ activities: ReadingActivity[] }>(`jobs/${id}/reading`)
              .then((r) => poll(r.activities.find((v) => v.id === a.id) || a))
              .catch((e) => {
                if (live) setError(errorMessage(e, translateError));
              }),
          1500,
        );
      }
    };
    timer = setTimeout(
      () =>
        void request<ReadingActivity>(`jobs/${id}/reading`, {
          kind: 'preview',
          revision: view.revision,
          page,
        })
          .then(poll)
          .catch((e) => {
            if (live) setError(errorMessage(e, translateError));
          }),
      500,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, view.revision, pageContent, view.stage, page, enabled, retry, locale]);
  const result = activity?.result as PreviewResult | null,
    p = view.data!.pages[page];
  return (
    <div className={`translation-rendered ${quiet ? 'is-quiet' : ''}`}>
      <div
        className="rendered-status"
        role="status"
        hidden={quiet && !!url && !error && !activity?.error}
      >
        {!enabled
          ? copy('editing_preview_save_to_refresh_reading_vi_4936057')
          : error || activity?.error
            ? error || errorMessage(activity!.error!, translateError)
            : url
              ? copy('saved_reading_version_90032b2')
              : copy('preparing_reading_view_be29c4f')}
        {activity && ['failed', 'cancelled'].includes(activity.state) && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await request(`reading-activities/${activity.id}/retry`, {});
                setRetry((n) => n + 1);
              } catch (e) {
                setError(errorMessage(e, translateError));
              }
            }}
          >
            {copy('retry_preview_6e54939')}
          </Button>
        )}
      </div>
      {url && result?.format === 'pdf' ? (
        <PdfPreview url={url} zoom={zoom} page={documentPage} onPageChange={onDocumentPageChange} />
      ) : (
        url && (
          <>
            <div
              className="rendered-image"
              style={{
                width: `${zoom * 100}%`,
                maxWidth: 'none',
                aspectRatio: `${p.width}/${p.height}`,
              }}
            >
              <img src={url} alt={copy('rendered_translation_db4ad7b')} draggable={false} />
              {slider && original && (
                <img
                  src={original}
                  className="comparison-original"
                  alt={copy('original_c0a8060')}
                  style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                />
              )}
              {slider && <div className="comparison-divider" style={{ left: `${split}%` }} />}
              {result?.regions.map((r) => (
                <button
                  key={r.id}
                  data-block-id={r.memberIds.includes(selected) ? selected : r.id}
                  aria-label={`${copy('edit_region_703e051')} ${r.id}`}
                  className={`rendered-region ${r.memberIds.includes(selected) ? 'selected' : ''} ${r.memberIds.some((id) => result.overflow.includes(id)) ? 'needs-review' : ''}`}
                  style={{
                    left: `${(r.box.x / p.width) * 100}%`,
                    top: `${(r.box.y / p.height) * 100}%`,
                    width: `${(r.box.width / p.width) * 100}%`,
                    height: `${(r.box.height / p.height) * 100}%`,
                    transform: `rotate(${r.box.angle}deg)`,
                  }}
                  onClick={() => onSelect(r.memberIds.includes(selected) ? selected : r.id)}
                />
              ))}
            </div>
            {slider && (
              <label className="comparison-slider">
                {copy('original_translated_898434f')}
                <input
                  aria-label={copy('slide_to_compare_bde7dd1')}
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                />
              </label>
            )}
          </>
        )
      )}
      {result?.overflow?.length ? (
        <p className="rendered-overflow">
          {copy('_value0_regions_lack_space_or_overlap_pres_3ec1ab3', {
            value0: result.overflow.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
