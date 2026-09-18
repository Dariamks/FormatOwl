import { getRequestConfig } from 'next-intl/server';
import { validLocale } from './registry';
import { loadMessages } from './server';
export const commonNamespaces = ['nav', 'common', 'errors'] as const;
export default getRequestConfig(async ({ requestLocale }) => {
  const locale = validLocale(await requestLocale);
  return { locale, messages: await loadMessages(locale, commonNamespaces) };
});
