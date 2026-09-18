import { conversionLandings } from './conversion-landings';
import type { PublishedTool } from './tool-content';

/** Browseable collections of shipped tools; no generated format combinations. */
export const toolCollections = {
  convert: ['video-converter', 'audio-converter', 'image-converter', 'video-to-mp3'],
  compress: ['video-compressor', 'image-compressor', 'audio-compressor', 'pdf-compressor'],
} satisfies Record<string, PublishedTool[]>;
export type ToolCollection = keyof typeof toolCollections;

export function collectionForTool(slug: string): ToolCollection | undefined {
  const tool = Object.hasOwn(conversionLandings, slug) ? conversionLandings[slug].tool : slug;
  return (Object.keys(toolCollections) as ToolCollection[]).find((collection) =>
    (toolCollections[collection] as readonly string[]).includes(tool),
  );
}
