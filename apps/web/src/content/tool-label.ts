import { getSiteTranslations } from '@/i18n/server';
import { tools } from '@filemorph/core/catalog';
import type { Locale } from '@/i18n/registry';
import { contentForTool } from './public-pages';
export async function toolLabel(slug: string, locale: Locale) {
  const content = contentForTool(slug);
  if (content) return (await getSiteTranslations('content', locale))(content.heading);
  if (tools.some((tool) => tool.id === slug))
    return (await getSiteTranslations('tools', locale))(`${slug}.name`);
  return slug;
}
