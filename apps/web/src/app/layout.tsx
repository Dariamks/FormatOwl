import { localeRegistry, validLocale } from '@/i18n/registry';
import type { Metadata } from 'next';
import { seoConfig } from '@/lib/seo-config';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import './globals.css';
export function generateMetadata(): Metadata {
  return { metadataBase: new URL(seoConfig().origin), robots: { index: false, follow: false } };
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = validLocale(await getLocale());
  const language = localeRegistry[locale];
  return (
    <html lang={language.lang} dir={language.dir} data-scroll-behavior="smooth">
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
