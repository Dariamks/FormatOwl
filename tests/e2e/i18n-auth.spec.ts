import { test, expect, request as apiRequest } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sqlClient } from '@filemorph/core/db';
import { locales, validLocale } from '../../apps/web/src/i18n/registry';
process.loadEnvFile('.env');
const origin = 'http://127.0.0.1:3000';
const emails: string[] = [],
  files = new Set<string>();
const password = 'Locale test passphrase 2026!';
async function mail(to: string, kind: string) {
  let result: { subject: string; text: string; url: string } | undefined;
  await expect
    .poll(async () => {
      for (const name of await readdir('.data/auth-mail')) {
        const path = resolve('.data/auth-mail', name);
        let value;
        try {
          value = JSON.parse(await readFile(path, 'utf8'));
        } catch {
          continue;
        } // The local mailbox writer may still be finishing this file.
        if (value.to === to && value.kind === kind) {
          files.add(path);
          result = value;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return result!;
}
test.beforeAll(() => {
  if (process.env.AUTH_EMAIL_MODE !== 'local' || process.env.BETTER_AUTH_URL !== origin)
    throw new Error(
      'Locale email tests require local mail and localhost auth; live delivery is not used.',
    );
});
test.afterAll(async () => {
  for (const email of emails) await sqlClient()`delete from auth_users where email=${email}`;
  for (const file of files) await unlink(file);
  await sqlClient().end();
});
for (const requested of [...locales, 'invalid-locale']) {
  test(`${requested}: verification and password-reset mail use the requested language`, async () => {
    const locale = validLocale(requested);
    const messages = JSON.parse(await readFile(`apps/web/messages/${locale}/email.json`, 'utf8'));
    const context = await apiRequest.newContext({
      baseURL: origin,
      extraHTTPHeaders: {
        Origin: origin,
        'x-filemorph-locale': requested,
        'x-forwarded-for': `198.18.${randomInt(1, 255)}.${randomInt(1, 255)}`,
      },
    });
    const email = `locale-${randomUUID()}@example.test`;
    emails.push(email);
    try {
      const created = await context.post('/api/auth/sign-up/email', {
        data: {
          email,
          password,
          name: 'Locale test',
          callbackURL: `/${locale}/login?verified=1`,
        },
      });
      expect(created.status()).toBe(200);
      const verify = await mail(email, 'verify');
      expect(verify.subject).toBe(messages.verifySubject);
      expect(verify.text).toContain(messages.verify);
      const verified = await context.get(verify.url, { maxRedirects: 0 });
      expect(verified.status()).toBe(302);
      expect(new URL(verified.headers().location, origin).pathname).toBe(`/${locale}/login`);
      const resetRequest = await context.post('/api/auth/request-password-reset', {
        data: {
          email,
          redirectTo: `${origin}/${locale}/reset-password`,
        },
      });
      expect(resetRequest.status()).toBe(200);
      const reset = await mail(email, 'reset');
      expect(reset.subject).toBe(messages.resetSubject);
      expect(reset.text).toContain(messages.reset);
      const redirected = await context.get(reset.url, { maxRedirects: 0 });
      expect(redirected.status()).toBe(302);
      const target = new URL(redirected.headers().location, origin);
      expect(target.origin).toBe(origin);
      expect(target.pathname).toBe(`/${locale}/reset-password`);
      expect(target.searchParams.get('token')).toBeTruthy();
    } finally {
      await context.dispose();
    }
  });
}
