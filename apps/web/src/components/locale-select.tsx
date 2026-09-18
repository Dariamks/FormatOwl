'use client';
import { Globe } from 'lucide-react';
import { hasLocale, useLocale, useTranslations } from 'next-intl';
import { localeRegistry, validLocale } from '@/i18n/registry';
import { routing } from '@/i18n/routing';
import { allowLocaleUnload, useLocaleSwitchGuard } from '@/i18n/switch-guard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
export function LocaleSelect() {
  const locale = useLocale(),
    t = useTranslations('nav'),
    h = useTranslations('common');
  const guard = useLocaleSwitchGuard();
  function changeLocale(nextLocale: string) {
    if (guard.busy || nextLocale === locale || !hasLocale(routing.locales, nextLocale)) return;
    if (guard.dirty && !window.confirm(h('switchDiscard'))) return;
    const url = new URL(window.location.href);
    const segments = url.pathname.split('/');
    segments[1] = nextLocale;
    url.pathname = segments.join('/');
    // Reload the root layout so its messages and document language update together.
    allowLocaleUnload();
    window.location.assign(url.href);
  }
  return (
    <Select
      dir={localeRegistry[validLocale(locale)].dir}
      disabled={guard.busy}
      value={locale}
      onValueChange={changeLocale}
    >
      <SelectTrigger
        className="locale-select"
        aria-label={t('language')}
        title={guard.busy ? h('switchBusy') : undefined}
      >
        <Globe size={16} aria-hidden="true" />
        <span className="locale-name">
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent className="locale-options" align="end">
        {routing.locales.map((language) => (
          <SelectItem key={language} value={language} textValue={localeRegistry[language].name}>
            <bdi lang={localeRegistry[language].lang}>{localeRegistry[language].name}</bdi>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
