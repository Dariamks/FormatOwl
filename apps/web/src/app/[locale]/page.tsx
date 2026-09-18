import { Messages } from '@/i18n/messages';
import { getSiteTranslations } from '@/i18n/server';
import type { Locale } from '@/i18n/registry';
import { HomeSections } from '@/components/home-sections';
import { Home } from '@/components/home';
import { homeCopy } from '@/content/public-pages';
import { pageMetadata } from '@/lib/seo';
import { listPublishedToolIds } from '@filemorph/core/access';
type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props) {
  const contentText = await getSiteTranslations('content');

  const { locale } = await params;
  return pageMetadata(locale, '', contentText(homeCopy.title), contentText(homeCopy.description));
}
export default async function Page({ params }: Props) {
  const { locale } = await params;
  const publishedToolIds = await listPublishedToolIds();
  return (
    <Messages namespaces={['home', 'homeExtra', 'examples', 'tools']}>
      <>
        <Home publishedToolIds={publishedToolIds} />
        <HomeSections locale={locale} />
      </>
    </Messages>
  );
}
