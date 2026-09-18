'use client';
import { useTranslations } from 'next-intl';
export function useErrorTranslator() {
  const t = useTranslations('errors');
  return (code: string) => t(t.has(code) ? code : 'UNKNOWN');
}
