import { isIP } from 'node:net';

/** Explicit opt-in, shared by build validation and request-time metadata. */
export function seoConfig(env: Record<string, string | undefined> = process.env) {
  if (env.SEO_INDEXABLE && !['true', 'false'].includes(env.SEO_INDEXABLE))
    throw new Error('SEO_INDEXABLE must be true or false');
  const indexable = env.SEO_INDEXABLE === 'true';
  const url = new URL(env.APP_URL || 'http://127.0.0.1:3000');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'APP_URL must be an HTTP(S) origin without credentials, a path, query or fragment',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    indexable &&
    (!env.APP_URL ||
      url.protocol !== 'https:' ||
      isIP(host) ||
      !host.includes('.') ||
      /\.(localhost|local|test|invalid|internal)$/.test(host))
  )
    throw new Error('SEO_INDEXABLE=true requires APP_URL to be a public HTTPS domain');
  return { indexable, origin: url.origin };
}
