import { publishedTools } from '@/lib/published-tools';
import { getSiteTranslations } from '@/i18n/server';
import { Messages } from '@/i18n/messages';
import { Pricing } from '@/components/pricing';
export async function generateMetadata() {
  const t = await getSiteTranslations('common');
  return { title: t('title_pricing') + ' — FormatOwl', robots: { index: false, follow: false } };
}
export default async function Page() {
  const { ids } = await publishedTools();
  return (
    <Messages namespaces={['billing', 'tools']}>
      <Pricing publishedToolIds={ids} />
    </Messages>
  );
}
