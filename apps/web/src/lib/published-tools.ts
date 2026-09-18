import { cache } from 'react';
import { listPublishedToolIds } from '@filemorph/core/access';
import { conversionLandings } from '@/content/conversion-landings';
import { toolCollections } from '@/content/tool-collections';

/** Request-scoped only: admin updates are visible on the next request. */
export const publishedTools = cache(async () => {
  const ids: string[] = await listPublishedToolIds();
  const visible = (slug: string) =>
    ids.includes(Object.hasOwn(conversionLandings, slug) ? conversionLandings[slug].tool : slug);
  const collectionVisible = (collection: keyof typeof toolCollections) =>
    toolCollections[collection].some(visible);
  return { ids, visible, collectionVisible };
});
