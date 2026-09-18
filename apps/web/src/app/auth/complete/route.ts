import { validLocale } from '@/i18n/registry';
import { owner } from '@/lib/api';
import { authBaseURL } from '@/lib/auth-config';
import { authReturnPath } from '@/lib/auth-navigation';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const url = new URL(request.url);
  const locale = validLocale(url.searchParams.get('locale'));
  const next = authReturnPath(url.searchParams.get('next'), locale);
  try {
    if ((await owner()).startsWith('user:')) return Response.redirect(new URL(next, authBaseURL()));
  } catch {}
  return Response.redirect(
    new URL(`/${locale}/login?error=auth&next=${encodeURIComponent(next)}`, authBaseURL()),
  );
}
