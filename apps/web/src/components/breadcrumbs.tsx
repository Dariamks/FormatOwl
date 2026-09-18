import type { Locale } from '@/i18n/registry';
import { getSiteTranslations } from '@/i18n/server';
import { absoluteUrl } from '@/lib/seo';
import Link from 'next/link';
export async function Breadcrumbs({
  locale,
  items,
}: {
  locale: Locale;
  items: { name: string; path: string }[];
}) {
  const copy = await getSiteTranslations('common');

  const all = [{ name: copy('home_70f8bb9'), path: `/${locale}` }, ...items];
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
  return (
    <>
      <nav aria-label={copy('breadcrumb_c766e66')} className="breadcrumbs">
        <ol>
          {all.map((item, i) => (
            <li key={item.path}>
              {i === all.length - 1 ? (
                <span aria-current="page">{item.name}</span>
              ) : (
                <Link href={item.path}>{item.name}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
      />
    </>
  );
}
