import { isLocale, validLocale } from '../i18n/registry';
export function authReturnPath(value: unknown, locale: string) {
  const fallback = `/${validLocale(locale)}/workspace`;
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\\\r\n]/.test(value) ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return fallback;
  const url = new URL(value, 'https://filemorph.invalid');
  if (
    url.origin !== 'https://filemorph.invalid' ||
    !isLocale(url.pathname.split('/')[1]) ||
    /\/(login|reset-password)(\/|$)/.test(url.pathname)
  )
    return fallback;
  return url.pathname + url.search + url.hash;
}
