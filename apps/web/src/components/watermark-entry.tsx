'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLocaleGuard } from '@/i18n/switch-guard';
import { errorMessage, request } from '@/lib/client-api';
import { pendingFiles } from '@/lib/pending-files';
import { forgetUpload, makeUploader, releaseUploader } from '@/lib/uploader';
import { tools } from '@filemorph/core/catalog';
import { formats, maxFileSize, supportsInput } from '@filemorph/core/domain';
import type { WatermarkTool } from '@filemorph/core/watermark';
import type Uppy from '@uppy/core';
import {
  ArrowLeft,
  Download,
  Eraser,
  MousePointer2,
  Pause,
  Play,
  ScanLine,
  Upload,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { Button } from './ui/button';
import './watermark.css';
export default function WatermarkEntry({ tool }: { tool: WatermarkTool }) {
  const translateError = useErrorTranslator();
  const labels = useTranslations('tools');

  const copy = useTranslations('watermark');

  const locale = useLocale(),
    router = useRouter();
  const [file, setFile] = useState<File | null>(null),
    [asset, setAsset] = useState(''),
    [progress, setProgress] = useState(0),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [paused, setPaused] = useState(false),
    [error, setError] = useState('');
  const uploader = useRef<Uppy | null>(null),
    mounted = useRef(true),
    requestId = useRef(''),
    input = useRef<HTMLInputElement>(null);
  const item = tools.find((v) => v.id === tool)!;
  useEffect(() => {
    mounted.current = true;
    const pending = pendingFiles.current;
    pendingFiles.current = [];
    if (pending?.length === 1) void select(pending[0]);
    return () => {
      mounted.current = false;
      if (uploader.current) releaseUploader(uploader.current);
    };
  }, []);
  async function select(f: File) {
    if (uploading || busy) return;
    if (!supportsInput(tool, f.name) || !f.size || f.size > maxFileSize(tool)) {
      setError(copy('choose_a_supported_file_up_to_50_mib_1b7832a'));
      return;
    }
    setFile(f);
    setAsset('');
    setError('');
    setProgress(0);
    setUploading(true);
    setPaused(false);
    requestId.current = '';
    try {
      if (uploader.current) releaseUploader(uploader.current);
      const r = await makeUploader(
        f,
        (p) => {
          if (mounted.current) setProgress(p);
        },
        1,
      );
      uploader.current = r.uppy;
      if (!mounted.current) {
        releaseUploader(r.uppy);
        return;
      }
      if (!r.ready) {
        const result = await r.uppy.upload();
        if (!result?.successful?.length) throw new Error('UPLOAD_FAILED');
      }
      if (mounted.current) {
        setAsset(r.assetId);
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
      const r = await request<{ id: string }>('jobs', {
        tool,
        assetId: asset,
        requestId: requestId.current,
        options: {},
      });
      forgetUpload(asset);
      router.push('/' + locale + '/workspace/' + r.id);
    } catch (e) {
      setError(errorMessage(e, translateError));
      setBusy(false);
    }
  }
  useLocaleGuard({ busy: uploading || busy, dirty: Boolean(file) });
  return (
    <main className="page-width wm-entry">
      <Link className="back-link" href={'/' + locale + '#tools'}>
        <ArrowLeft size={16} />
        {copy('all_tools_b390ab3')}
      </Link>
      <div className="wm-entry-heading">
        <span className="tool-icon">
          <Eraser />
        </span>
        <h1>{labels(`${item.id}.name`)}</h1>
        <p>{copy('find_the_watermark_review_your_selection_k_e760df3')}</p>
      </div>
      <div
        className="wm-upload"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length === 1) void select(e.dataTransfer.files[0]);
          else setError(copy('choose_one_file_at_a_time_f423d03'));
        }}
      >
        <Upload size={36} />
        <h2>{file ? file.name : copy('drop_your_file_here_65f4b6c')}</h2>
        <p>
          {formats[tool].join(' · ').toUpperCase()} · 50 MiB
          {tool !== 'image-watermark-remover' ? copy('_up_to_100_pages_slides_4c76fcf') : ''}
        </p>
        <Button disabled={busy || uploading} onClick={() => input.current?.click()}>
          {file ? copy('choose_another_file_6235237') : copy('choose_a_file_74b1d89')}
        </Button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label={copy('upload_file_503a3d8')}
          accept={formats[tool].map((f) => '.' + f).join(',')}
          onChange={(e) => {
            if (e.target.files?.[0]) void select(e.target.files[0]);
          }}
        />
        {!!file && (
          <>
            <progress value={progress} max={100} />
            <span>{progress}%</span>
          </>
        )}
        {uploading && (
          <Button
            variant="outline"
            onClick={() => {
              if (paused) uploader.current?.resumeAll();
              else uploader.current?.pauseAll();
              setPaused(!paused);
            }}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}{' '}
            {paused ? copy('resume_upload_b736baf') : copy('pause_upload_6d32bd7')}
          </Button>
        )}
        {asset && (
          <Button disabled={busy} onClick={start}>
            {busy ? copy('starting_e5f5809') : copy('analyze_watermarks_cdf7dc7')}
          </Button>
        )}
        <CostEstimate
          tool={tool}
          files={file ? [file] : []}
          operation={asset ? { path: 'jobs', body: { tool, assetId: asset, options: {} } } : null}
          note={copy('file_analysis_only_preview_repair_and_expo_5e61391')}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </div>
      <div className="wm-steps">
        {[
          [ScanLine, copy('find_candidates_722e234')],
          [MousePointer2, copy('review_your_selection_01db5c0')],
          [Download, copy('preview_and_export_f407ab1')],
        ].map(([Icon, label], i) => {
          const I = Icon as typeof ScanLine;
          return (
            <div key={i}>
              <I size={22} />
              <span>{label as string}</span>
            </div>
          );
        })}
      </div>
      <p className="wm-entry-note">
        {tool === 'pdf-watermark-remover'
          ? copy('text_and_page_structure_are_preserved_wate_325357d')
          : tool === 'image-watermark-remover'
            ? copy('complex_backgrounds_use_local_ai_repair_re_2d7cbb1')
            : copy('export_an_editable_original_format_documen_9172273')}
      </p>
    </main>
  );
}
