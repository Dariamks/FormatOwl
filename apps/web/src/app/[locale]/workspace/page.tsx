import { getSiteTranslations } from '@/i18n/server';
import { Messages } from '@/i18n/messages';
import { Workspace } from '@/components/workspace';
export async function generateMetadata() {
  const t = await getSiteTranslations('common');
  return { title: t('title_workspace') + ' — FormatOwl', robots: { index: false, follow: false } };
}
export default function Page() {
  return (
    <Messages namespaces={['workspace']}>
      <Workspace />
    </Messages>
  );
}
