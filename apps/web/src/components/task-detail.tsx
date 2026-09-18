'use client';
import { toolNamespaces } from '@/i18n/bundles';
import { useErrorTranslator } from '@/i18n/errors';
import { AsyncMessages, fetchMessages } from '@/i18n/provider';
import { errorMessage, request } from '@/lib/client-api';
import type { BatchView, JobView } from '@filemorph/core/domain';
import { isEditorTool } from '@filemorph/core/editing';
import { isTranslationTool } from '@filemorph/core/translation';
import { isWatermarkTool } from '@filemorph/core/watermark';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
const BatchCompressor = dynamic(() =>
  import('./batch-compressor').then((module) => module.BatchCompressor),
);
const Compressor = dynamic(() => import('./compressor').then((module) => module.Compressor));
const WatermarkEditor = dynamic(() => import('./watermark-editor'));
const TranslationEditor = dynamic(() => import('./translation-editor'));
const TranscriptEditor = dynamic(() => import('./transcript-editor'));
const EditorResult = dynamic(() => import('./editor-result'));
export function TaskDetail({ id, batch = false }: { id: string; batch?: boolean }) {
  const translateError = useErrorTranslator();

  const copy = useTranslations('task_detail');

  const [tool, setTool] = useState<JobView['tool']>(),
    [error, setError] = useState(''),
    locale = useLocale();
  useEffect(() => {
    let active = true;
    request<{ job?: JobView; batch?: BatchView }>(`${batch ? 'batches' : 'jobs'}/${id}`)
      .then((data) => {
        if (active) setTool(data.job?.tool || data.batch?.tool);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, translateError));
      });
    return () => {
      active = false;
    };
  }, [id, batch, locale]);
  useEffect(() => {
    if (!tool) return;
    void fetchMessages(locale, toolNamespaces(tool)).catch(() => {});
    // Start code and dictionary requests together; AsyncMessages owns retry UI.
    const code = isWatermarkTool(tool)
      ? import('./watermark-editor')
      : isTranslationTool(tool)
        ? import('./translation-editor')
        : tool === 'transcription'
          ? import('./transcript-editor')
          : isEditorTool(tool)
            ? import('./editor-result')
            : tool === 'video-compressor'
              ? import('./compressor')
              : import('./batch-compressor');
    void code?.catch(() => {});
  }, [tool, locale]);
  if (error)
    return (
      <div className="page-width error-banner" role="alert">
        {error}
      </div>
    );
  if (!tool)
    return (
      <div className="page-width panel empty-state" role="status">
        {copy('loading_33ce417')}
      </div>
    );
  function editor(tool: NonNullable<JobView['tool']>) {
    if (isWatermarkTool(tool)) return <WatermarkEditor id={id} />;
    if (isTranslationTool(tool)) return <TranslationEditor id={id} />;
    if (tool === 'transcription') return <TranscriptEditor id={id} />;
    if (isEditorTool(tool)) return <EditorResult id={id} />;
    return tool === 'video-compressor' ? (
      <Compressor jobId={id} />
    ) : (
      <BatchCompressor
        tool={tool}
        batchId={batch ? id : undefined}
        jobId={batch ? undefined : id}
      />
    );
  }
  return <AsyncMessages namespaces={toolNamespaces(tool)}>{editor(tool)}</AsyncMessages>;
}
