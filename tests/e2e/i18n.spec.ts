import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { locales, localeRegistry } from '../../apps/web/src/i18n/registry';
import { messageVersion } from '../../apps/web/src/i18n/version';

for (const locale of locales) {
  test(`${locale}: public routes render translated HTML and locale metadata`, async ({
    request,
  }) => {
    for (const path of [
      '',
      '/tools/image-converter',
      '/login',
      '/pricing',
      '/guide',
      '/guide/webp-to-jpg-transparency',
      '/workspace',
    ]) {
      const response = await request.get(`/${locale}${path}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain(`lang="${localeRegistry[locale].lang}"`);
      expect(html).toContain(`dir="${localeRegistry[locale].dir}"`);
      expect(html).not.toContain('MISSING_MESSAGE');
      expect(html).not.toContain('data-next-error-message');
      const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      expect(markup).not.toMatch(
        />[^<>]*\b(?:content|examples|home|tools|billing|login|guide|page)\.[a-zA-Z_][^<>]*</,
      );
      if (path === '')
        for (const alternate of locales)
          expect(markup).toContain(
            `hrefLang="${localeRegistry[alternate].lang}" href="http://127.0.0.1:3000/${alternate}"`,
          );
      expect(html).not.toMatch(/<h1[^>]*>[^<]*(?:home\.|tools\.|_[a-f0-9]{7})/);
    }
  });
}

test('dictionary endpoint isolates language and namespaces and excludes server copy', async ({
  request,
}) => {
  const query = `/api/i18n?locale=ja&namespaces=login&v=${messageVersion}`;
  const response = await request.get(query);
  expect(response.status()).toBe(200);
  expect(Object.keys(await response.json())).toEqual(['login']);
  expect(response.headers()['cache-control']).toContain('immutable');
  for (const args of [
    'locale=zz&namespaces=login',
    'locale=en&namespaces=content',
    'locale=en&namespaces=email',
    'locale=en&namespaces=homeServer',
    'locale=en&namespaces=guide',
  ])
    expect((await request.get(`/api/i18n?${args}&v=${messageVersion}`)).status()).toBe(400);
  expect((await request.get('/api/i18n?locale=en&namespaces=login&v=old')).status()).toBe(409);
});

test('language menu has 25 native names and preserves path, query and anchor', async ({ page }) => {
  await page.goto('/en/tools/heic-to-jpg?utm_source=locale-test#settings');
  await expect(page.locator('.auth-trigger')).toBeEnabled();
  const menu = page.getByRole('combobox', { name: 'Select language', exact: true });
  await menu.click();
  await expect(page.getByRole('option')).toHaveCount(25);
  await page.getByRole('option', { name: '日本語', exact: true }).click();
  await expect(page).toHaveURL('/ja/tools/heic-to-jpg?utm_source=locale-test#settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('unsent files require confirmation and cancellation preserves the file', async ({ page }) => {
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('combobox', { name: 'Select language', exact: true }).click();
  await page.getByRole('option', { name: '简体中文', exact: true }).click();
  await expect(page).toHaveURL('/en/tools/video-compressor');
  expect(
    await page
      .locator('input[type=file]')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('combobox', { name: 'Select language', exact: true }).click();
  await page.getByRole('option', { name: '简体中文', exact: true }).click();
  await expect(page).toHaveURL('/zh/tools/video-compressor');
});

for (const locale of ['zh', 'ja', 'de', 'ar', 'ur'] as const) {
  test(`${locale}: mobile layout and language direction`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const path of ['', '/tools/image-converter', '/login', '/pricing']) {
      await page.goto(`/${locale}${path}`);
      await expect(page.locator('h1')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: `.data/i18n/${locale}-mobile.png`, fullPage: true });
  });
}

test('language switching is disabled while upload initialization is pending', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/uploads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    started();
    await pending;
    await route.fulfill({ status: 400, json: { error: 'INVALID_INPUT' } });
  });
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  try {
    await intercepted;
    await expect(
      page.getByRole('combobox', { name: 'Select language', exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('combobox', { name: 'Select language', exact: true })).toBeEnabled();
});

for (const locale of ['ar', 'ur'] as const) {
  test(`${locale}: RTL dialogs and video timeline retain their intended directions`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.request.get('/api/session');
    await page.goto(`/${locale}/tools/video-cutter`);
    await expect(page.locator('.auth-trigger')).toBeEnabled();
    await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
    await expect(page.locator('.editor-timeline')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.editor-timeline')).toHaveCSS('direction', 'ltr');
    await expect(page.locator('.site-header')).toHaveCSS('direction', 'rtl');
    for (const width of [1365, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.data/i18n/${locale}-editor-${width}.png`, fullPage: true });
    }
    await page.locator('.auth-trigger').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog.locator('input[type=email]')).toBeVisible();
    await expect(dialog).toHaveCSS('direction', 'rtl');
    await page.screenshot({ path: `.data/i18n/${locale}-dialog.png` });
    await page.keyboard.press('Escape');
    const before = page.url();
    page.once('dialog', (d) => d.dismiss());
    await page.locator('.locale-select').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    expect(page.url()).toBe(before);
    await expect(page.locator('.editor-timeline')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('a created task is restored by ID after a full language navigation', async ({ page }) => {
  const id = '00000000-0000-4000-8000-000000000025';
  const requests: string[] = [];
  await page.route(`**/api/jobs/${id}`, async (route) => {
    requests.push(route.request().method());
    await route.fulfill({
      json: {
        job: {
          id,
          tool: 'video-compressor',
          state: 'failed',
          progress: 0,
          errorCode: 'INVALID_MEDIA',
          name: 'locale-fixture.mp4',
          inputSize: 1024,
          outputSize: null,
          media: null,
          options: {
            mode: 'quality',
            codec: 'h264',
            preset: 'balanced',
            crf: 28,
            resolution: 'original',
          },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      },
    });
  });
  await page.goto(`/en/workspace/${id}?from=locale#task`);
  await expect(page.getByText('locale-fixture.mp4', { exact: true })).toBeVisible();
  await page.locator('.locale-select').click();
  await page.getByRole('option', { name: '日本語', exact: true }).click();
  await expect(page).toHaveURL(`/ja/workspace/${id}?from=locale#task`);
  await expect(page.getByText('locale-fixture.mp4', { exact: true })).toBeVisible();
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every((method) => method === 'GET')).toBe(true);
});

test('account messages load only when the dialog opens and are reused', async ({ page }) => {
  const requests: URL[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/i18n?')) requests.push(new URL(request.url()));
  });
  await page.goto('/en');
  await expect(page.locator('.auth-trigger')).toBeEnabled();
  expect(requests).toHaveLength(0);
  for (let i = 0; i < 2; i++) {
    await page.locator('.auth-trigger').click();
    await expect(page.locator('dialog[open] input[type=email]')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('locale')).toBe('en');
  expect(requests[0].searchParams.get('namespaces')).toBe('login');
});

test('AI creation forms use their own messages without loading review dictionaries', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /MISSING_MESSAGE|INVALID_MESSAGE/.test(message.text()))
      errors.push(message.text());
  });
  for (const locale of ['en', 'zh', 'ja', 'ar', 'ur']) {
    for (const tool of ['document-translator', 'transcription', 'image-watermark-remover']) {
      await page.goto(`/${locale}/tools/${tool}`);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('input[type=file]')).toBeAttached();
    }
  }
  expect(errors).toEqual([]);
});
