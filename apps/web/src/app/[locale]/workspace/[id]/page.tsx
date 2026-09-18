import { Messages } from '@/i18n/messages';
import { getSiteTranslations } from '@/i18n/server';
import { TaskDetail } from '@/components/task-detail';
export async function generateMetadata() {
  const t = await getSiteTranslations('common');
  return { title: t('title_task') + ' — FormatOwl', robots: { index: false, follow: false } };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Messages namespaces={['task_detail']}>
      <TaskDetail id={id} />
    </Messages>
  );
}
