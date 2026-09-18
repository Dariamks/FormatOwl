import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/seo';
export const dynamic = 'force-dynamic';
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/auth/', '/admin'] },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
