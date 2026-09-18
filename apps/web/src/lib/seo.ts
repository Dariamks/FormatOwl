import { isLocale, locales, localeRegistry } from '@/i18n/registry';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Locale } from '@/i18n/registry';
import { seoConfig } from './seo-config';
export function absoluteUrl(path: string) {
  return new URL(path, seoConfig().origin).href;
}
export function pageMetadata(
  locale: Locale,
  path: string,
  title: string,
  description: string,
  published = true,
): Metadata {
  if (!isLocale(locale)) notFound();
  const { origin, indexable } = seoConfig();
  const url = absoluteUrl(`/${locale}${path}`);
  return {
    metadataBase: new URL(origin),
    title: `${title} | FormatOwl`,
    description,
    robots: { index: indexable && published, follow: true },
    alternates: {
      canonical: url,
      ...(published
        ? {
            languages: {
              ...Object.fromEntries(
                locales.map((code) => [localeRegistry[code].lang, absoluteUrl(`/${code}${path}`)]),
              ),
              'x-default': absoluteUrl(`/en${path}`),
            },
          }
        : {}),
    },
    openGraph: {
      type: 'website',
      siteName: 'FormatOwl',
      title,
      description,
      url,
      locale: localeRegistry[locale].og,
      images: [
        {
          url: absoluteUrl('/og-image'),
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [absoluteUrl('/og-image')],
    },
  };
}
