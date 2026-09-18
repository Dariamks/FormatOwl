import { locales } from '../../apps/web/src/i18n/registry';
import { describe, expect, it } from 'vitest';
import { authReturnPath } from '../../apps/web/src/lib/auth-navigation';
import { authCapabilities, localAuthEmail } from '../../apps/web/src/lib/auth-config';
import { afterEach, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());
describe('authentication return paths', () => {
  it('preserves a local workspace destination and query', () => {
    expect(authReturnPath('/zh/workspace/123?view=original#preview', 'en')).toBe(
      '/zh/workspace/123?view=original#preview',
    );
  });
  it.each([
    'https://attacker.invalid',
    '//attacker.invalid',
    '/zh/..//attacker.invalid',
    '/zh/%2e%2e//attacker.invalid',
    '/zh/../api/auth/sign-out',
    '/en\\attacker.invalid',
    '/en/login',
    '/zh/reset-password?token=anything',
    null,
  ])('rejects external or normalized unsafe paths: %s', (value) => {
    expect(authReturnPath(value, 'zh')).toBe('/zh/workspace');
  });
});
it('local email cannot be enabled in production or on a public host', () => {
  vi.stubEnv('AUTH_EMAIL_MODE', 'local');
  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000');
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('AUTH_EMAIL_FROM', '');
  vi.stubEnv('NODE_ENV', 'development');
  expect(localAuthEmail()).toBe(true);
  vi.stubEnv('NODE_ENV', 'production');
  expect(authCapabilities().email).toBe(false);
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('BETTER_AUTH_URL', 'https://filemorph.example');
  expect(localAuthEmail()).toBe(false);
});

it.each(locales)('preserves a safe return path for %s', (locale) => {
  expect(authReturnPath(`/${locale}/workspace/123?view=original#preview`, locale)).toBe(
    `/${locale}/workspace/123?view=original#preview`,
  );
  expect(authReturnPath('//outside.example/', locale)).toBe(`/${locale}/workspace`);
  expect(authReturnPath('/zz/workspace', locale)).toBe(`/${locale}/workspace`);
});
