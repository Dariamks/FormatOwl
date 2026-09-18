import { publishedTools } from '@/lib/published-tools';
import type { ToolContent } from '@/content/tool-content';
import { toolLabel } from '@/content/tool-label';
import type { Locale } from '@/i18n/registry';
import { getSiteTranslations } from '@/i18n/server';
import Link from 'next/link';
import { GuideCards } from './home-sections';
export async function ToolInformation({
  content,
  locale,
}: {
  content: ToolContent;
  locale: Locale;
}) {
  const { visible } = await publishedTools();
  const contentText = await getSiteTranslations('content');

  const copy = await getSiteTranslations('tool_information');

  return (
    <article className="seo-information page-width">
      <div className="seo-info-grid">
        <section>
          <h2>{copy('formats_and_limits_131c753')}</h2>
          <dl className="seo-formats">
            <dt>{copy('input_b568d47')}</dt>
            <dd>{content.input}</dd>
            <dt>{copy('output_4bed336')}</dt>
            <dd>{content.output}</dd>
          </dl>
          <p>{contentText(content.limits)}</p>
        </section>
        <section>
          <h2>{copy('how_to_use_this_tool_5db405f')}</h2>
          <ol>
            {content.steps.map((step, i) => (
              <li key={i}>{contentText(step)}</li>
            ))}
          </ol>
        </section>
      </div>
      <section>
        <h2>{copy('settings_and_results_356f281')}</h2>
        <p>{contentText(content.settings)}</p>
      </section>
      <section>
        <h2>{copy('file_storage_and_deletion_2f7e739')}</h2>
        <p>{copy('files_are_uploaded_and_processed_on_the_se_a49de44')}</p>
        <Link href={`/${locale}/guide`}>{copy('read_the_usage_and_data_guide_cb055b8')}</Link>
      </section>
      {content.questions.length > 0 && (
        <section>
          <h2>{copy('common_questions_f07ac22')}</h2>
          {content.questions.map((q) => (
            <details key={q.question}>
              <summary>{contentText(q.question)}</summary>
              <p>{contentText(q.answer)}</p>
            </details>
          ))}
        </section>
      )}
      <section>
        <h2>{copy('related_tools_0bdd4ec')}</h2>
        <ul className="seo-link-list">
          {content.related.filter(visible).map((slug) => (
            <li key={slug}>
              <Link href={`/${locale}/tools/${slug}`}>{toolLabel(slug, locale)}</Link>
            </li>
          ))}
        </ul>
      </section>
      {content.guides.length > 0 && (
        <section>
          <h2>{copy('helpful_guides_2c00610')}</h2>
          <GuideCards locale={locale} slugs={content.guides} />
        </section>
      )}
    </article>
  );
}
