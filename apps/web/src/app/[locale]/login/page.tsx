import { getSiteTranslations } from '@/i18n/server';
import { Messages } from '@/i18n/messages';
import { authCapabilities } from '@/lib/auth-config';
import { Login } from '@/components/login';
export async function generateMetadata() {
  const t = await getSiteTranslations('common');
  return { title: t('title_login') + ' — FormatOwl', robots: { index: false, follow: false } };
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return (
    <Messages namespaces={['login']}>
      <div className="auth-page">
        <Login
          capabilities={authCapabilities()}
          next={typeof query.next === 'string' ? query.next : undefined}
          verified={query.verified === '1'}
          initialError={Boolean(query.error)}
        />
      </div>
    </Messages>
  );
}
