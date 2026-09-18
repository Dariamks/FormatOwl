import { getSiteTranslations } from '@/i18n/server';
import { Messages } from '@/i18n/messages';
import { Login } from '@/components/login';
import { authCapabilities } from '@/lib/auth-config';
export async function generateMetadata() {
  const t = await getSiteTranslations('common');
  return {
    title: t('title_resetPassword') + ' — FormatOwl',
    robots: { index: false, follow: false },
    referrer: 'no-referrer' as const,
  };
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
          initialMode="reset"
          token={typeof query.token === 'string' ? query.token : undefined}
          initialError={Boolean(query.error) || !query.token}
        />
      </div>
    </Messages>
  );
}
