'use client';
import type { Pagination } from '@filemorph/core/pagination';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from './ui/button';

export function ListPagination({
  pagination: { page, pageSize, total, totalPages },
  label,
  disabled = false,
  onChange,
}: {
  pagination: Pagination;
  label: string;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  const t = useTranslations('common');
  const locale = useLocale();
  if (total === 0) return null;
  const pages = Array.from(
    new Set([1, page - 1, page, page + 1, totalPages].filter((n) => n >= 1 && n <= totalPages)),
  ).sort((a, b) => a - b);
  const number = (value: number) => value.toLocaleString(locale);
  return (
    <nav className="list-pagination" aria-label={label} aria-busy={disabled}>
      <span className="pagination-summary" aria-live="polite">
        {number((page - 1) * pageSize + 1)}–{number(Math.min(page * pageSize, total))} /{' '}
        {number(total)}
      </span>
      <div className="pagination-controls">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || page === 1}
          aria-label={t('paginationPrevious')}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} className="pagination-arrow" />
          <span className="pagination-direction">{t('paginationPrevious')}</span>
        </Button>
        {pages.map((value, index) => (
          <span className="pagination-page" key={value}>
            {index > 0 && value - pages[index - 1] > 1 && <span aria-hidden="true">…</span>}
            <Button
              variant={value === page ? 'default' : 'outline'}
              size="sm"
              aria-current={value === page ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onChange(value)}
            >
              {number(value)}
            </Button>
          </span>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || page === totalPages}
          aria-label={t('paginationNext')}
          onClick={() => onChange(page + 1)}
        >
          <span className="pagination-direction">{t('paginationNext')}</span>
          <ChevronRight size={16} className="pagination-arrow" />
        </Button>
      </div>
    </nav>
  );
}
