'use client';
import { publicExample, type PublicExample } from '@/content/examples';
import type { Locale } from '@/i18n/registry';
import { ArrowRight, LoaderCircle, Play, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ExamplePreview } from './example-preview';
import { Button } from './ui/button';
import { WorkspaceDialog } from './workspace-dialog';

/** Loads only our public source file; uploading and processing remain explicit tool actions. */
export function ExamplePicker({
  exampleId,
  initialSampleId,
  selectionKey,
  busy,
  onSelect,
}: {
  exampleId: string;
  initialSampleId?: string;
  selectionKey: string;
  busy: boolean;
  onSelect: (file: File, example: PublicExample) => void;
}) {
  const contentText = useTranslations('examples');

  const copy = useTranslations('homeExtra');

  const locale = useLocale() as Locale;
  const example = publicExample(exampleId)!;
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const loadedSelection = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ selectionKey, busy, onSelect });
  latest.current = { selectionKey, busy, onSelect };
  async function load() {
    if (latest.current.busy) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const previousSelection = latest.current.selectionKey;
    setLoading(true);
    setError('');
    setLoaded(false);
    try {
      const response = await fetch(example.input.url, { signal: request.signal });
      if (!response.ok) throw new Error('LOAD_FAILED');
      const blob = await response.blob();
      if (blob.size !== example.input.size) throw new Error('LOAD_FAILED');
      if (request.signal.aborted) return;
      if (latest.current.busy || latest.current.selectionKey !== previousSelection) {
        setError(copy('your_selection_changed_the_sample_did_not_883ea64'));
        return;
      }
      latest.current.onSelect(
        new File([blob], example.input.name, { type: example.input.mime }),
        example,
      );
      loadedSelection.current = null;
      setLoaded(true);
      setOpen(false);
    } catch {
      if (!request.signal.aborted)
        setError(copy('the_sample_could_not_load_retry_or_choose_0224ac6'));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (initialSampleId === exampleId) {
      if (latest.current.selectionKey) setOpen(true);
      else void load();
    }
    return () => controller.current?.abort();
    // A route sample is consumed once; choosing/replacing a file must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSampleId, exampleId]);
  useEffect(() => {
    if (!loaded) return;
    if (loadedSelection.current === null) loadedSelection.current = selectionKey;
    else if (loadedSelection.current !== selectionKey) setLoaded(false);
  }, [loaded, selectionKey]);
  function close() {
    controller.current?.abort();
    setLoading(false);
    setOpen(false);
  }
  const action = selectionKey
    ? copy('replace_current_files_with_sample_5f92ff1')
    : copy('load_sample_and_adjust_settings_352c879');
  return (
    <div className="example-picker">
      <button
        type="button"
        className="example-open"
        disabled={busy || loading}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <Play size={14} />
        {copy('explore_a_sample_fafe52d')}
        <ArrowRight size={14} />
      </button>
      {loading && !open && (
        <p role="status">
          <LoaderCircle className="spinner" size={14} />
          {copy('loading_sample_file_a8f9c1c')}
        </p>
      )}
      {loaded && !loading && (
        <p role="status">{copy('sample_ready_adjust_the_settings_then_subm_e9720e2')}</p>
      )}
      {error && !open && (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || loading}
            onClick={() => setOpen(true)}
          >
            {copy('retry_9f5cd8a')}
          </Button>
        </div>
      )}
      <WorkspaceDialog
        open={open}
        onClose={close}
        label={copy('public_sample_preview_e03227c')}
        className="example-dialog"
      >
        <header>
          <div>
            <span className="section-kicker">{copy('free_preview_no_credits_4ec340c')}</span>
            <h2>{contentText(example.title)}</h2>
          </div>
          <button
            type="button"
            className="example-close"
            aria-label={copy('close_sample_1526d98')}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        {open && (
          <>
            <p className="example-dialog-description">{contentText(example.description)}</p>
            <ExamplePreview key={example.id} example={example} locale={locale} />
            <p className="field-help">{contentText(example.settings)}</p>
          </>
        )}
        {error && open && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="example-dialog-actions">
          <p>
            {selectionKey
              ? copy('continuing_replaces_the_current_files_and_8bb7dfc')
              : copy('adjust_settings_after_loading_processing_f_e2f95b4')}
          </p>
          <Button disabled={busy || loading} onClick={() => void load()}>
            {loading ? (
              <>
                <LoaderCircle className="spinner" size={16} />
                {copy('loading_33ce417')}
              </>
            ) : (
              action
            )}
          </Button>
        </div>
      </WorkspaceDialog>
    </div>
  );
}
