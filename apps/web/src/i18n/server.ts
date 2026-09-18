import 'server-only';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { validLocale } from './registry';
import { messageImports, type Namespace } from './imports';
const pending = new Map<string, Promise<AbstractIntlMessages>>();
export function loadMessages(
  locale: string,
  names: readonly Namespace[],
): Promise<AbstractIntlMessages> {
  return Promise.all(
    names.map(async (name) => {
      const key = `${locale}:${name}`;
      let promise = pending.get(key);
      if (!promise) {
        const loaders = messageImports[validLocale(locale) as keyof typeof messageImports];
        if (!loaders) throw new Error(`Unpublished locale: ${locale}`);
        promise = loaders[name]();
        pending.set(key, promise);
        promise.catch(() => pending.delete(key));
      }
      return [name, await promise] as const;
    }),
  ).then(Object.fromEntries);
}
export async function getSiteTranslations(namespace: Namespace, requestedLocale?: string) {
  const locale = requestedLocale ?? (await getLocale());
  return createTranslator({ locale, messages: await loadMessages(locale, [namespace]), namespace });
}
