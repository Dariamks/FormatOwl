import {
  WatermarkEntry,
  TranslationEntry,
  TranscriptionEntry,
  EditorEntry,
  BatchCompressor,
  Compressor,
} from '@/components/tool-entries';
import { Messages } from '@/i18n/messages';
import { entryNamespaces } from '@/i18n/bundles';
import { getSiteTranslations } from '@/i18n/server';
import Link from 'next/link';
import { publicExample } from '@/content/examples';
import { isWatermarkTool } from '@filemorph/core/watermark';
import { isTranslationTool } from '@filemorph/core/translation';
import { isConversionTool } from '@filemorph/core/conversion';
import { isEditorTool } from '@filemorph/core/editing';
import { notFound } from 'next/navigation';
import { tools } from '@filemorph/core/catalog';
import type { Locale } from '@/i18n/registry';
import { ToolIcon } from '@/components/tool-icon';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ToolInformation } from '@/components/tool-information';
import { contentForTool } from '@/content/public-pages';
import { conversionLandings } from '@/content/conversion-landings';
import { pageMetadata } from '@/lib/seo';
import { collectionForTool } from '@/content/tool-collections';
import { isToolPublished } from '@filemorph/core/access';
type Props = {
  params: Promise<{ locale: Locale; slug: string }>;
  searchParams: Promise<{ sample?: string | string[] }>;
};
async function resolveTool(slug: string) {
  const landing = Object.hasOwn(conversionLandings, slug) ? conversionLandings[slug] : undefined;
  const tool = tools.find((t) => t.id === (landing?.tool ?? slug));
  if (!tool || !(await isToolPublished(tool.id))) notFound();
  return { tool, landing, content: contentForTool(slug) };
}
export async function generateMetadata({ params }: Props) {
  const contentText = await getSiteTranslations('content');
  const labels = await getSiteTranslations('tools');

  const { locale, slug } = await params;
  const { tool, content } = await resolveTool(slug);
  return pageMetadata(
    locale,
    `/tools/${slug}`,
    content ? contentText(content.title) : labels(`${tool.id}.name`),
    content ? contentText(content.description) : labels(`${tool.id}.description`),
    Boolean(content),
  );
}
export default async function Page({ params, searchParams }: Props) {
  const contentText = await getSiteTranslations('content');
  const labels = await getSiteTranslations('tools');

  const copy = await getSiteTranslations('page');

  const { locale, slug } = await params;
  const { tool, landing, content } = await resolveTool(slug);
  const collection = collectionForTool(slug);
  const collectionCopy = await getSiteTranslations('homeServer', locale);
  const requestedSample = (await searchParams).sample;
  const example = typeof requestedSample === 'string' ? publicExample(requestedSample) : undefined;
  const sampleMatches = example?.tool === tool.id && (!landing || example.route === slug);
  const initialSampleId = sampleMatches ? example?.id : undefined;
  function interaction() {
    if (isWatermarkTool(tool.id)) return <WatermarkEntry tool={tool.id} />;
    if (isTranslationTool(tool.id)) return <TranslationEntry key={slug} tool={tool.id} />;
    if (tool.id === 'transcription') return <TranscriptionEntry />;
    if (isEditorTool(tool.id)) return <EditorEntry key={slug} tool={tool.id} showHeading={false} />;
    if (tool.id === 'video-compressor')
      return <Compressor key={slug} showHeading={false} initialSampleId={initialSampleId} />;
    if (isConversionTool(tool.id))
      return (
        <BatchCompressor
          key={slug}
          tool={tool.id}
          showHeading={false}
          initialConversionOptions={landing?.options}
          inputExtensions={landing?.inputExtensions}
          fixedOutputFormat={landing?.options.format}
          initialSampleId={initialSampleId}
        />
      );
    if (
      tool.id === 'image-compressor' ||
      tool.id === 'pdf-compressor' ||
      tool.id === 'audio-compressor'
    )
      return (
        <BatchCompressor
          key={slug}
          tool={tool.id}
          showHeading={false}
          initialSampleId={initialSampleId}
        />
      );
    notFound();
  }
  return (
    <>
      <div
        className={
          content ? 'page-width page-heading seo-tool-heading' : 'page-width seo-breadcrumb-only'
        }
      >
        <Breadcrumbs
          locale={locale}
          items={[
            ...(collection
              ? [{ name: collectionCopy(`${collection}Title`), path: `/${locale}/${collection}` }]
              : []),
            {
              name:
                content && slug !== tool.id
                  ? contentText(content.heading)
                  : labels(`${tool.id}.name`),
              path: `/${locale}/tools/${slug}`,
            },
          ]}
        />
        {content && (
          <>
            <div className="title-with-icon">
              <span className={`tool-icon ${tool.group}`}>
                <ToolIcon name={tool.icon} />
              </span>
              <h1>{slug === tool.id ? labels(`${tool.id}.name`) : contentText(content.heading)}</h1>
            </div>
            <p>{contentText(content.description)}</p>
            {landing && (
              <p>
                <Link href={`/${locale}/tools/${landing.tool}`} className="back-link">
                  {copy('need_another_format_open_the_general_conve_63c9560')}
                </Link>
              </p>
            )}
          </>
        )}
      </div>
      {requestedSample !== undefined && !sampleMatches && (
        <div className="page-width">
          <p className="error-banner" role="alert">
            {copy('this_sample_is_unavailable_or_does_not_mat_8437575')}
          </p>
        </div>
      )}
      <Messages namespaces={entryNamespaces(tool.id)}>{interaction()}</Messages>
      {content && <ToolInformation content={content} locale={locale} />}
    </>
  );
}
