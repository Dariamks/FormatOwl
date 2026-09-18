'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
export function PdfPreview({
  url,
  zoom = 1,
  page: controlledPage,
  onPageChange,
}: {
  url: string;
  zoom?: number;
  page?: number;
  onPageChange?: (page: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [localPage, setLocalPage] = useState(1),
    [error, setError] = useState(false);
  const t = useTranslations('preview');
  const page = Math.max(1, Math.min(controlledPage ?? localPage, document?.numPages || 1));
  const setPage = (n: number) => {
    setLocalPage(n);
    onPageChange?.(n);
  };
  useEffect(() => {
    let active = true;
    let task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    setDocument(null);
    if (controlledPage === undefined) setLocalPage(1);
    setError(false);
    void import('pdfjs-dist')
      .then((pdfjs) => {
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        task = pdfjs.getDocument({ url });
        void task.promise
          .then((doc) => {
            if (active) setDocument(doc);
          })
          .catch(() => {
            if (active) setError(true);
          });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let rendering:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>
      | undefined;
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (!active || !canvas.current) return;
        const viewport = pdfPage.getViewport({ scale: 1 });
        const scaled = pdfPage.getViewport({ scale: Math.min(900 / viewport.width, 1.8) });
        canvas.current.width = scaled.width;
        canvas.current.height = scaled.height;
        rendering = pdfPage.render({ canvas: canvas.current, viewport: scaled });
        return rendering.promise;
      })
      .catch((e) => {
        if (active && e.name !== 'RenderingCancelledException') setError(true);
      });
    return () => {
      active = false;
      rendering?.cancel();
    };
  }, [document, page]);
  return (
    <div className="pdf-preview">
      {error ? (
        <p role="alert">{t('previewFailed')}</p>
      ) : (
        <canvas
          ref={canvas}
          style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          aria-label={t('pdfPage', { page })}
        />
      )}
      <div className="pdf-controls">
        <Button
          size="sm"
          variant="outline"
          disabled={!document || page === 1}
          onClick={() => setPage(page - 1)}
          aria-label={t('previous')}
        >
          <ChevronLeft size={16} />
        </Button>
        <span>
          {page} / {document?.numPages || '—'}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={!document || page === document.numPages}
          onClick={() => setPage(page + 1)}
          aria-label={t('next')}
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
}
