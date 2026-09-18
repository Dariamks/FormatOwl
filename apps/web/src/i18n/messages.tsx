import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { loadMessages } from './server';
import { MessageProvider } from './provider';
import type { Namespace } from './imports';
export async function Messages({
  namespaces,
  children,
}: {
  namespaces: readonly Namespace[];
  children: ReactNode;
}) {
  return (
    <MessageProvider messages={await loadMessages(await getLocale(), namespaces)}>
      {children}
    </MessageProvider>
  );
}
