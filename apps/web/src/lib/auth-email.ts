import { getSiteTranslations } from '@/i18n/server';
import { validLocale } from '@/i18n/registry';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { localAuthEmail } from './auth-config';

export async function sendAuthEmail(
  kind: 'verify' | 'reset',
  to: string,
  url: string,
  request?: Request,
) {
  const locale = validLocale(request?.headers.get('x-filemorph-locale'));
  const t = await getSiteTranslations('email', locale);
  const subject = t(kind === 'verify' ? 'verifySubject' : 'resetSubject');
  const text = `${t(kind)}\n\n${url}\n\n${t('ignore')}`;
  if (localAuthEmail()) {
    // Local-only test mailbox, never exposed through an HTTP endpoint or server logs.
    const root = process.env.INIT_CWD || process.cwd();
    const directory = resolve(
      root.endsWith('/apps/web') ? resolve(root, '../..') : root,
      '.data/auth-mail',
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify({ to, kind, subject, text, url }, null, 2),
      { mode: 0o600 },
    );
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.AUTH_EMAIL_FROM)
    throw new Error('AUTH_EMAIL_NOT_CONFIGURED');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('AUTH_EMAIL_DELIVERY_FAILED');
}
