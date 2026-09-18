import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { seoConfig } from './lib/seo-config';
const internationalize = createMiddleware(routing);
export default function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/admin' || request.nextUrl.pathname.startsWith('/admin/')) {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }
  const response =
    request.nextUrl.pathname === '/'
      ? NextResponse.redirect(new URL(`/en${request.nextUrl.search}`, request.url), 308)
      : internationalize(request);
  if (!seoConfig().indexable) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}
export const config = { matcher: ['/((?!api|auth|og-image|_next|.*\\..*).*)'] };
