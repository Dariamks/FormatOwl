import Link from 'next/link';
import type { Locale } from '@/i18n/registry';
import { getSiteTranslations } from '@/i18n/server';
import { toolCollections, type ToolCollection } from '@/content/tool-collections';
import { toolContent } from '@/content/tool-content';
import { conversionLandings } from '@/content/conversion-landings';
import { pageMetadata } from '@/lib/seo';
import { Breadcrumbs } from './breadcrumbs';
import { GuideCards } from './home-sections';
import { publishedTools } from '@/lib/published-tools';
import { notFound } from 'next/navigation';

export async function collectionMetadata(locale: Locale, collection: ToolCollection) {
  if (!(await publishedTools()).collectionVisible(collection)) notFound();
  const copy = await getSiteTranslations('homeServer', locale);
  return pageMetadata(
    locale,
    `/${collection}`,
    copy(`${collection}Title`),
    copy(`${collection}Description`),
  );
}

export async function ToolCollectionPage({
  locale,
  collection,
}: {
  locale: Locale;
  collection: ToolCollection;
}) {
  const copy = await getSiteTranslations('homeServer', locale);
  const content = await getSiteTranslations('content', locale);
  const info = await getSiteTranslations('tool_information', locale);
  const { visible, collectionVisible } = await publishedTools();
  const slugs = toolCollections[collection].filter(visible);
  if (!slugs.length) notFound();
  const guideSlugs = [...new Set(slugs.flatMap((slug) => toolContent[slug].guides))];
  const other = collection === 'convert' ? 'compress' : 'convert';
  return (
    <>
      <div className="page-width page-heading">
        <Breadcrumbs
          locale={locale}
          items={[{ name: copy(`${collection}Title`), path: `/${locale}/${collection}` }]}
        />
        <h1>{copy(`${collection}Title`)}</h1>
        <p>{copy(`${collection}Description`)}</p>
      </div>
      <article className="seo-information page-width">
        <div className="seo-info-grid">
          {slugs.map((slug) => {
            const tool = toolContent[slug];
            return (
              <section key={slug}>
                <h2>
                  <Link href={`/${locale}/tools/${slug}`}>{content(tool.title)}</Link>
                </h2>
                <p>{content(tool.description)}</p>
                <dl className="seo-formats">
                  <dt>{info('input_b568d47')}</dt>
                  <dd dir="ltr">{tool.input}</dd>
                  <dt>{info('output_4bed336')}</dt>
                  <dd dir="ltr">{tool.output}</dd>
                </dl>
                <p>{content(tool.limits)}</p>
                <p>{content(tool.settings)}</p>
              </section>
            );
          })}
        </div>
        {collection === 'convert' && (
          <section>
            <h2>{copy('convert_by_format_d714562')}</h2>
            <ul className="guide-card-grid">
              {Object.entries(conversionLandings)
                .filter(([slug]) => visible(slug))
                .map(([slug, landing]) => (
                  <li key={slug}>
                    <Link className="guide-card" href={`/${locale}/tools/${slug}`}>
                      <h3>{content(landing.content.heading)}</h3>
                      <p>{content(landing.content.description)}</p>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        )}
        <section>
          <h2>{copy('helpful_file_guides_535e62b')}</h2>
          <GuideCards locale={locale} slugs={guideSlugs} />
        </section>
        <section>
          <h2>
            {collectionVisible(other) && (
              <Link href={`/${locale}/${other}`}>{copy(`${other}Title`)}</Link>
            )}
          </h2>
          <p>{copy(`${other}Description`)}</p>
          <Link href={`/${locale}/pricing`}>{copy('view_credits_pricing_8d4b5e5')}</Link>
        </section>
      </article>
    </>
  );
}
