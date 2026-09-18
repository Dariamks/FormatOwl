import type { Locale } from '@/i18n/registry';
import { collectionMetadata, ToolCollectionPage } from '@/components/tool-collection';
type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props) {
  return collectionMetadata((await params).locale, 'compress');
}
export default async function Page({ params }: Props) {
  return <ToolCollectionPage locale={(await params).locale} collection="compress" />;
}
