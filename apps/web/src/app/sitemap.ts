import { locales } from '@/i18n/registry';
import type { MetadataRoute } from 'next';
import { publicPages } from '@/content/public-pages';
import { seoConfig } from '@/lib/seo-config';
import { publishedTools } from '@/lib/published-tools';
export const dynamic = 'force-dynamic';
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { origin, indexable } = seoConfig();
  if (!indexable) return [];
  const { visible, collectionVisible } = await publishedTools();
  const pages = publicPages().filter((page) => {
    if (page.path === '/convert' || page.path === '/compress')
      return collectionVisible(page.path.slice(1) as 'convert' | 'compress');
    return !page.path.startsWith('/tools/') || visible(page.path.slice(7));
  });
  return pages.flatMap((page) =>
    locales.map((locale) => ({
      url: `${origin}/${locale}${page.path}`,
      ...(page.updated ? { lastModified: page.updated } : {}),
    })),
  );
}
