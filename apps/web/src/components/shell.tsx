'use client';
import { LocaleSelect } from './locale-select';
import { AsyncMessages } from '@/i18n/provider';
import { authClient } from '@/lib/auth-client';
import type { AuthCapabilities } from '@/lib/auth-config';
import { ArrowUpRight, LoaderCircle, Menu, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { BillingConfirmation } from './billing-confirmation';
import { Button } from './ui/button';
import { WorkspaceDialog } from './workspace-dialog';
function AuthLoading() {
  const copy = useTranslations('common');

  const locale = useLocale();
  return (
    <div className="auth-loading" role="status">
      <LoaderCircle size={24} className="spinner" aria-hidden="true" />
      <span>{copy('loading_your_account_447bf46')}</span>
    </div>
  );
}
const Login = dynamic(() => import('./login').then((module) => module.Login), {
  ssr: false,
  loading: AuthLoading,
});
export function Shell({
  children,
  authCapabilities,
}: {
  children: React.ReactNode;
  authCapabilities: AuthCapabilities;
}) {
  const copy = useTranslations('common');

  const locale = useLocale(),
    t = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <Link href={`/${locale}`} className="brand" onClick={() => setOpen(false)}>
            <img src="/icon.png" className="brand-icon" width={35} height={35} alt="" />
            FormatOwl<span className="brand-period">.</span>
          </Link>
          <nav
            className={open ? 'navigation is-open' : 'navigation'}
            aria-label={copy('main_navigation_efd197f')}
          >
            <Link
              href={`/${locale}#tools`}
              aria-current={
                pathname === `/${locale}` || pathname.startsWith(`/${locale}/tools/`)
                  ? 'page'
                  : undefined
              }
              onClick={() => setOpen(false)}
            >
              {t('tools')}
            </Link>
            <Link
              href={`/${locale}/workspace`}
              aria-current={
                pathname.startsWith(`/${locale}/workspace`) ||
                pathname.startsWith(`/${locale}/batches/`)
                  ? 'page'
                  : undefined
              }
              onClick={() => setOpen(false)}
            >
              {t('workspace')}
            </Link>
            <Link
              href={`/${locale}/guide`}
              aria-current={pathname.startsWith(`/${locale}/guide`) ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {t('guide')}
            </Link>
            <Link
              href={`/${locale}/pricing`}
              className="mobile-pricing-link"
              aria-current={pathname === `/${locale}/pricing` ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {copy('credits_pricing_2ebf1c7')}
            </Link>
          </nav>
          <div className="header-actions">
            <Link
              href={`/${locale}/pricing`}
              className="billing-nav"
              aria-current={pathname === `/${locale}/pricing` ? 'page' : undefined}
            >
              {copy('credits_pricing_2ebf1c7')}
            </Link>
            <LocaleSelect />
            <Button
              className="auth-trigger"
              disabled={isPending}
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                setAuthOpen(true);
              }}
            >
              {session ? t('account') : t('login')}
              <ArrowUpRight size={15} />
            </Button>
            <button
              className="menu-button"
              onClick={() => setOpen(!open)}
              aria-label={copy('menu_57f5f5e')}
              aria-expanded={open}
            >
              {open ? <X /> : <Menu />}
            </button>
          </div>
        </div>
      </header>
      <WorkspaceDialog
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        label={session ? t('account') : t('login')}
        className="auth-dialog"
      >
        {authOpen && (
          <AsyncMessages namespaces={['login']}>
            <Login
              capabilities={authCapabilities}
              onClose={() => setAuthOpen(false)}
              next={pathname}
            />
          </AsyncMessages>
        )}
      </WorkspaceDialog>
      <BillingConfirmation />
      <main>{children}</main>
      <footer className="site-footer">
        <Link href={`/${locale}`} className="brand">
          <img src="/icon.png" className="brand-icon" width={28} height={28} alt="" /> FormatOwl.
        </Link>
        <span>{copy('footer')}</span>
        <nav className="footer-links" aria-label={copy('footer_navigation_a32d98c')}>
          <Link href={`/${locale}#examples`}>{copy('try_a_sample_dee2176')}</Link>
          <Link href={`/${locale}/guide`}>{t('guide')}</Link>
          <Link href={`/${locale}/pricing`}>{copy('credits_pricing_2ebf1c7')}</Link>
        </nav>
        <span className="footer-note">© {new Date().getFullYear()} FormatOwl</span>
      </footer>
    </>
  );
}
