import { toolCollections } from './tool-collections';
import { toolContent, type ToolContent } from './tool-content';
import { conversionLandings } from './conversion-landings';
import { guides } from './guides';
export const homeCopy = {
  title: 'online_file_tools_compress_edit_convert_4485942',
  description: 'compress_video_audio_images_and_pdf_edit_m_df4902c',
};
export const guideCopy = {
  title: 'file_compression_conversion_guides_3e85e4b',
  description: 'practical_guides_to_video_size_image_trans_7e460e4',
};
export function contentForTool(slug: string): ToolContent | undefined {
  return Object.hasOwn(conversionLandings, slug)
    ? conversionLandings[slug].content
    : Object.hasOwn(toolContent, slug)
      ? toolContent[slug as keyof typeof toolContent]
      : undefined;
}
/** The eleven launched non-AI tools plus curated conversion pages and guides. */
export function publicPages(): { path: string; updated?: string }[] {
  return [
    { path: '' },
    { path: '/guide' },
    ...Object.keys(toolCollections).map((slug) => ({ path: `/${slug}` })),
    ...Object.keys(toolContent).map((slug) => ({ path: `/tools/${slug}` })),
    ...Object.keys(conversionLandings).map((slug) => ({ path: `/tools/${slug}` })),
    ...Object.entries(guides).map(([slug, guide]) => ({
      path: `/guide/${slug}`,
      updated: guide.updated,
    })),
  ];
}
