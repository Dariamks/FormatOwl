'use client';
import { useLocale, useTranslations } from 'next-intl';
const formatters = new Map<string, Intl.DisplayNames>();
export function useLanguageName() {
  const locale = useLocale(),
    t = useTranslations('common');
  let names = formatters.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: 'language' });
    formatters.set(locale, names);
  }
  return (code: string) => {
    if (code === 'auto') return t('autoLanguage');
    try {
      return names.of(code === 'zh' ? 'zh-Hans' : code) ?? code;
    } catch {
      return code;
    }
  };
}
