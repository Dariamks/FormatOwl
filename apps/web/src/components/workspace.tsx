'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { errorMessage, request } from '@/lib/client-api';
import { bytes } from '@/lib/utils';
import { tools } from '@filemorph/core/catalog';
import type { JobView } from '@filemorph/core/domain';
import {
  ArrowRight,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pagination } from '@filemorph/core/pagination';
import { ListPagination } from './list-pagination';
import { ToolIcon } from './tool-icon';
import { Button } from './ui/button';
export function Workspace() {
  const translateError = useErrorTranslator();

  const copy = useTranslations('workspace');

  const t = useTranslations('workspace'),
    locale = useLocale();
  const [jobs, setJobs] = useState<JobView[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(''),
    [page, setPage] = useState<Pagination | null>(null),
    [changingPage, setChangingPage] = useState(false);
  const currentPage = useRef(1);
  const pageRequest = useRef(false);
  const requestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(
    async (requestedPage = currentPage.current, scroll = false) => {
      const id = ++requestId.current;
      try {
        const result = await request<{ jobs: JobView[]; pagination: Pagination }>(
          `jobs?page=${requestedPage}`,
        );
        if (id !== requestId.current) return;
        currentPage.current = result.pagination.page;
        setPage(result.pagination);
        setJobs(result.jobs);
        if (scroll) listRef.current?.scrollIntoView({ block: 'start' });
        setError('');
      } catch (e) {
        if (id === requestId.current) setError(errorMessage(e, translateError));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setChangingPage(false);
          pageRequest.current = false;
        }
      }
    },
    [locale],
  );
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (!pageRequest.current) void refresh();
    }, 5000);
    return () => {
      clearInterval(interval);
      requestId.current++;
    };
  }, [refresh]);
  async function remove(id: string) {
    if (!window.confirm(t('deleteConfirm'))) return;
    setDeleting(id);
    try {
      await request(`jobs/${id}`, undefined, 'DELETE');
      await refresh();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setDeleting('');
    }
  }
  return (
    <div className="page-width workspace-page">
      <div className="page-heading workspace-heading">
        <div>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <div className="action-row">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={changingPage}
            aria-label={t('refresh')}
          >
            <RefreshCw size={16} />
          </Button>
          <Button asChild>
            <Link href={`/${locale}#tools`}>
              <Plus size={17} />
              {t('action')}
            </Link>
          </Button>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="panel empty-state">
          <LoaderCircle size={28} className="spinner" />
          <p>{t('loading')}</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="panel empty-state">
          <FolderOpen size={46} strokeWidth={1.3} />
          <h2>{t('empty')}</h2>
          <p>{t('emptyHint')}</p>
          <Button asChild>
            <Link href={`/${locale}#tools`}>
              {t('action')}
              <ArrowRight size={16} />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="job-list" ref={listRef} aria-busy={changingPage}>
          {jobs.map((job) => (
            <article key={job.id} className="job-row">
              <span
                className={`tool-icon ${tools.find((t) => t.id === job.tool)?.group || 'video'}`}
              >
                <ToolIcon name={tools.find((t) => t.id === job.tool)?.icon || 'file'} size={23} />
              </span>
              <div className="job-description">
                <Link href={`/${locale}/workspace/${job.id}`}>
                  <h2>{job.name}</h2>
                </Link>
                <p>
                  {job.batchId && (
                    <Link href={`/${locale}/batches/${job.batchId}`}>
                      {copy('view_batch_f0aabf8')} ·{' '}
                    </Link>
                  )}
                  {bytes(job.inputSize)}
                  {job.outputSize ? ` → ${bytes(job.outputSize)}` : ''} <span>·</span>{' '}
                  {new Intl.DateTimeFormat(locale, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(job.createdAt))}
                </p>
              </div>
              <div className={`job-state state-${job.state}`}>
                <span>
                  {t(job.state)}
                  {['processing', 'cancelling'].includes(job.state) ? ` · ${job.progress}%` : ''}
                </span>
                {['queued', 'processing'].includes(job.state) && (
                  <div className="progress-track">
                    <div style={{ width: `${job.progress}%` }} />
                  </div>
                )}
              </div>
              <div className="job-actions">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/${locale}/workspace/${job.id}`}>
                    {t('view')}
                    <ArrowRight size={14} />
                  </Link>
                </Button>
                <button
                  className="delete-button"
                  disabled={deleting === job.id}
                  onClick={() => remove(job.id)}
                  aria-label={`${t('delete')} ${job.name}`}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {page && (
        <ListPagination
          pagination={page}
          label={t('title')}
          disabled={changingPage || !!deleting}
          onChange={(next) => {
            pageRequest.current = true;
            setChangingPage(true);
            void refresh(next, true);
          }}
        />
      )}
      <div className="workspace-note">
        <ShieldCheck size={16} />
        <span>
          {t('private')} {t('expiry')}
        </span>
      </div>
    </div>
  );
}
