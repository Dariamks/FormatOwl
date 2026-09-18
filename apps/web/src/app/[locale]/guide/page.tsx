import { getSiteTranslations } from '@/i18n/server';
import type { Locale } from '@/i18n/registry';
import { GuideCards } from '@/components/home-sections';
import { guideCopy } from '@/content/public-pages';
import { pageMetadata } from '@/lib/seo';
import { Breadcrumbs } from '@/components/breadcrumbs';
import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import { Button } from '@/components/ui/button';
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }) {
  const contentText = await getSiteTranslations('content');

  const { locale } = await params;
  return pageMetadata(
    locale,
    '/guide',
    contentText(guideCopy.title),
    contentText(guideCopy.description),
  );
}
export default async function Page() {
  const copy = await getSiteTranslations('page');

  const t = await getSiteTranslations('guide'),
    h = await getSiteTranslations('home'),
    locale = (await getLocale()) as Locale;
  return (
    <div className="narrow-page seo-guide">
      <Breadcrumbs
        locale={locale}
        items={[{ name: copy('guides_929a28d'), path: `/${locale}/guide` }]}
      />
      <Link className="back-link" href={`/${locale}`}>
        ← {h('back')}
      </Link>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <section>
        <h2>{copy('practical_tutorials_af7137d')}</h2>
        <GuideCards locale={locale} />
      </section>
      {[
        'quality',
        'formats',
        'image',
        'pdf',
        'audio',
        'batch',
        'translation',
        'reading',
        'privacy',
        'progress',
      ].map((key) => (
        <section key={key}>
          <h2>{t(`${key}Title`)}</h2>
          <p>{t(`${key}Text`)}</p>
        </section>
      ))}
      <Button asChild>
        <Link href={`/${locale}/#tools`}>{h('all')}</Link>
      </Button>
    </div>
  );
}
