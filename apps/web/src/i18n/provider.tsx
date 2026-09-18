'use client';
import {
  NextIntlClientProvider,
  useLocale,
  useMessages,
  useTranslations,
  type AbstractIntlMessages,
} from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import type { Namespace } from './imports';
import { messageVersion } from './version';
const pending = new Map<string, Promise<AbstractIntlMessages>>();
export function fetchMessages(locale: string, namespaces: readonly Namespace[]) {
  const names = [...new Set(namespaces)].sort();
  const missing = names.filter((name) => !pending.has(`${locale}:${name}`));
  if (missing.length) {
    const request = fetch(
      `/api/i18n?locale=${encodeURIComponent(locale)}&namespaces=${missing.join(',')}&v=${messageVersion}`,
    ).then(async (response) => {
      if (response.status === 409) throw new Error('MESSAGES_VERSION');
      if (!response.ok) throw new Error('MESSAGES_UNAVAILABLE');
      return (await response.json()) as AbstractIntlMessages;
    });
    for (const name of missing) {
      const key = `${locale}:${name}`;
      const promise = request.then((messages) => {
        const value = messages[name];
        if (!value || typeof value !== 'object') throw new Error('MESSAGES_UNAVAILABLE');
        return value;
      });
      pending.set(key, promise);
      promise.catch(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    }
  }
  return Promise.all(
    names.map(async (name) => [name, await pending.get(`${locale}:${name}`)] as const),
  ).then(Object.fromEntries);
}
export function MessageProvider({
  messages,
  children,
}: {
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  const parent = useMessages();
  const locale = useLocale();
  return (
    <NextIntlClientProvider locale={locale} messages={{ ...parent, ...messages }}>
      {children}
    </NextIntlClientProvider>
  );
}
export function AsyncMessages({
  namespaces,
  children,
}: {
  namespaces: readonly Namespace[];
  children: ReactNode;
}) {
  const locale = useLocale(),
    parent = useMessages(),
    t = useTranslations('common');
  const missing = namespaces
    .filter((name) => !Object.hasOwn(parent, name))
    .sort()
    .join(',');
  const [state, setState] = useState<{
    key: string;
    messages?: AbstractIntlMessages;
    failed?: boolean;
    stale?: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  const key = `${locale}:${missing}`;
  useEffect(() => {
    if (!missing) return;
    let active = true;
    fetchMessages(locale, missing.split(',') as Namespace[]).then(
      (messages) => {
        if (active) setState({ key, messages });
      },
      (error) => {
        if (active)
          setState({
            key,
            failed: true,
            stale: error instanceof Error && error.message === 'MESSAGES_VERSION',
          });
      },
    );
    return () => {
      active = false;
    };
  }, [locale, missing, key, retry]);
  if (!missing) return children;
  if (state?.key === key && state.messages)
    return <MessageProvider messages={state.messages}>{children}</MessageProvider>;
  if (state?.key === key && state.failed)
    return (
      <div role="alert">
        {t('loadFailed')}{' '}
        <button
          onClick={() => {
            if (state.stale) {
              window.location.reload();
              return;
            }
            setState(undefined);
            setRetry((n) => n + 1);
          }}
        >
          {t('retry')}
        </button>
      </div>
    );
  return (
    <div role="status" aria-live="polite">
      {t('loading')}
    </div>
  );
}
