import { publishedTools } from '@/lib/published-tools';
import { getSiteTranslations } from '@/i18n/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Locale } from '@/i18n/registry';
import { guides } from '@/content/guides';
import { toolLabel } from '@/content/tool-label';
import { pageMetadata } from '@/lib/seo';
import { Breadcrumbs } from '@/components/breadcrumbs';
type Props = { params: Promise<{ locale: Locale; slug: string }> };
function guideFor(slug: string) {
  if (!Object.hasOwn(guides, slug)) notFound();
  return guides[slug];
}
export async function generateMetadata({ params }: Props) {
  const contentText = await getSiteTranslations('content');

  const { locale, slug } = await params;
  const guide = guideFor(slug);
  return pageMetadata(
    locale,
    `/guide/${slug}`,
    contentText(guide.title),
    contentText(guide.description),
  );
}
export default async function Page({ params }: Props) {
  const contentText = await getSiteTranslations('content');

  const copy = await getSiteTranslations('page');

  const { locale, slug } = await params;
  const guide = guideFor(slug);
  const { visible } = await publishedTools();
  const visibleTools = guide.tools.filter(visible);
  return (
    <article className="narrow-page seo-guide">
      <Breadcrumbs
        locale={locale}
        items={[
          { name: copy('guides_929a28d'), path: `/${locale}/guide` },
          { name: contentText(guide.title), path: `/${locale}/guide/${slug}` },
        ]}
      />
      <h1>{contentText(guide.title)}</h1>
      <p>{contentText(guide.description)}</p>
      <p className="seo-date">
        {copy('updated_f2f8570')} <time dateTime={guide.updated}>{guide.updated}</time> · FormatOwl
      </p>
      {visibleTools[0] && (
        <Link className="button button-primary" href={`/${locale}/tools/${visibleTools[0]}`}>
          {copy('open_cf9b770')} {toolLabel(visibleTools[0], locale)}
        </Link>
      )}
      {guide.sections.map((section) => (
        <section key={section.heading}>
          <h2>{contentText(section.heading)}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{contentText(p)}</p>
          ))}
        </section>
      ))}
      <section>
        <h2>{contentText(guide.example.caption)}</h2>
        <div
          className="seo-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={contentText(guide.example.caption)}
        >
          <table>
            <caption className="sr-only">{contentText(guide.example.caption)}</caption>
            <thead>
              <tr>
                {guide.example.columns.map((col) => (
                  <th key={col} scope="col">
                    {contentText(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {guide.example.rows.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, i) => (
                    <td key={i}>{contentText.has(cell) ? contentText(cell) : cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{contentText(guide.example.note)}</p>
      </section>
      <section>
        <h2>{copy('related_tools_0bdd4ec')}</h2>
        <ul className="seo-link-list">
          {visibleTools.map((tool) => (
            <li key={tool}>
              <Link href={`/${locale}/tools/${tool}`}>{toolLabel(tool, locale)}</Link>
            </li>
          ))}
        </ul>
      </section>
      <p>
        {copy('files_are_uploaded_for_server_processing_d_2024e58')}{' '}
        <Link href={`/${locale}/guide`}>{copy('usage_and_data_guide_24e1755')}</Link>
      </p>
    </article>
  );
}
