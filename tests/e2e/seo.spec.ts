import { locales, localeRegistry } from '../../apps/web/src/i18n/registry';
import { test, expect } from '@playwright/test';
const origin = process.env.SEO_TEST_ORIGIN || 'http://127.0.0.1:3000';
const indexable = process.env.SEO_TEST_INDEXABLE === 'true';
const slugs = [
  'video-compressor',
  'image-compressor',
  'pdf-compressor',
  'audio-compressor',
  'video-converter',
  'audio-converter',
  'image-converter',
  'video-to-mp3',
  'video-cutter',
  'video-cropper',
  'audio-cutter',
  'heic-to-jpg',
  'webp-to-jpg',
  'mov-to-mp4',
  'm4a-to-mp3',
];
const articles = [
  'compress-video-to-target-size',
  'webp-to-jpg-transparency',
  'why-pdf-wont-compress',
];
const paths = [
  '',
  '/guide',
  '/convert',
  '/compress',
  ...slugs.map((s) => `/tools/${s}`),
  ...articles.map((s) => `/guide/${s}`),
];
const sourceMarkup = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
test('root redirect is permanent and independent of language cookies', async ({ request }) => {
  const response = await request.get('/?utm_source=test', {
    maxRedirects: 0,
    headers: { 'accept-language': 'zh-CN', cookie: 'NEXT_LOCALE=zh' },
  });
  expect(response.status()).toBe(308);
  expect(new URL(response.headers().location, origin).pathname).toBe('/en');
  expect(new URL(response.headers().location, origin).search).toBe('?utm_source=test');
});
for (const locale of locales)
  test(`${locale}: published pages expose unique titles, canonical and all language alternatives`, async ({
    request,
  }) => {
    test.setTimeout(180000);
    const titles = new Set<string>();
    for (const path of paths) {
      const response = await request.get(`/${locale}${path}?utm_source=test`, {
        headers: { 'user-agent': 'Googlebot' },
      });
      expect(response.status(), `${locale}${path}`).toBe(200);
      const html = sourceMarkup(await response.text());
      expect(html.match(/<h1\b/g), `${locale}${path}`).toHaveLength(1);
      expect(html).toContain(`rel="canonical" href="${origin}/${locale}${path}"`);
      expect(html).toContain(`<html lang="${localeRegistry[locale].lang}"`);
      expect(html.match(/rel="alternate" hrefLang=/g)).toHaveLength(locales.length + 1);
      for (const [language, target] of [
        ...locales.map((code) => [localeRegistry[code].lang, code]),
        ['x-default', 'en'],
      ])
        expect(html).toContain(`hrefLang="${language}" href="${origin}/${target}${path}"`);
      expect(response.headers().link || '').not.toContain('hreflang');
      expect(html).toContain(`name="robots" content="${indexable ? 'index' : 'noindex'}, follow"`);
      expect(html).toContain('property="og:image"');
      expect(html).toContain('name="twitter:card" content="summary_large_image"');
      const title = html.match(/<title>(.*?)<\/title>/)?.[1];
      expect(title).toBeTruthy();
      expect(titles.has(title!)).toBe(false);
      titles.add(title!);
      if (path.startsWith('/tools/') && ['en', 'zh'].includes(locale))
        expect(html).toContain(locale === 'zh' ? '参数与效果' : 'Settings and results');
    }
  });
test('sitemap, robots and non-public routes follow the launch policy', async ({ request }) => {
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  expect(urls.length).toBe(indexable ? paths.length * locales.length : 0);
  if (indexable) {
    expect(new Set(urls).size).toBe(paths.length * locales.length);
    for (const locale of locales)
      for (const path of paths) expect(urls).toContain(`${origin}/${locale}${path}`);
    expect(xml.match(/<lastmod>/g)).toHaveLength(articles.length * locales.length);
  }
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
  expect(robots).toContain('Disallow: /api/');
  expect(robots).toContain('Disallow: /auth/');
  expect(robots).not.toMatch(/Disallow:.*(?:workspace|login|batches|reset-password)/);
  for (const locale of ['en', 'zh'])
    for (const path of [
      '/login',
      '/reset-password',
      '/workspace',
      '/workspace/00000000-0000-4000-8000-000000000000',
      '/batches/00000000-0000-4000-8000-000000000000',
      '/tools/transcription',
      '/tools/video-translator',
      '/tools/document-translator',
      '/tools/image-translator',
      '/tools/image-watermark-remover',
      '/tools/pdf-watermark-remover',
      '/tools/word-watermark-remover',
      '/tools/ppt-watermark-remover',
    ]) {
      const response = await request.get(`/${locale}${path}`);
      expect(response.status()).toBe(200);
      expect(sourceMarkup(await response.text())).toMatch(/name="robots" content="noindex/);
      expect(urls).not.toContain(`${origin}/${locale}${path}`);
    }
  for (const path of [
    '/en/tools/not-a-tool',
    '/en/guide/not-an-article',
    '/en/tools/toString',
    '/en/guide/toString',
  ])
    expect((await request.get(path)).status()).toBe(404);
});
test('public content and navigation work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const base = test.info().project.use.baseURL!;
  for (const path of [
    '/en/convert',
    '/zh/compress',
    '/ar/convert',
    '/en/tools/video-cutter',
    '/en/tools/video-to-mp3',
    '/zh/tools/webp-to-jpg',
    '/en/guide/why-pdf-wont-compress',
  ]) {
    await page.goto(`${base}${path}`);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', origin + path);
    await expect(page.locator('nav.breadcrumbs')).toBeVisible();
    await expect(page.locator('article')).toBeVisible();
    const data = await page.locator('script[type="application/ld+json"]').textContent();
    const breadcrumb = JSON.parse(data!);
    expect(breadcrumb['@type']).toBe('BreadcrumbList');
    expect(breadcrumb.itemListElement.at(-1).item).toBe(origin + path);
  }
  await context.close();
});
test('language switching preserves a new landing and a guide on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/tools/heic-to-jpg', '/guide/webp-to-jpg-transparency']) {
    await page.goto('/en' + path);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation', exact: true })
        .getByRole('link', { name: 'Credits & pricing' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('combobox', { name: 'Select language', exact: true }).click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/zh' + path + '$'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.locator('h1')).toHaveCount(1);
  }
});
test('share image returns a real PNG', async ({ request }) => {
  const response = await request.get('/og-image');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  const body = await response.body();
  expect(body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
});

test('search titles describe supported formats and collections link to working tools', async ({
  page,
}) => {
  await page.goto('/en');
  await expect(page).toHaveTitle('File Format Converter & Compressor Online | FormatOwl');
  await page.getByRole('link', { name: 'Online File Format Converter', exact: false }).click();
  await expect(page).toHaveURL(/\/en\/convert$/);
  for (const slug of [
    'video-converter',
    'audio-converter',
    'image-converter',
    'video-to-mp3',
    'heic-to-jpg',
    'webp-to-jpg',
    'mov-to-mp4',
    'm4a-to-mp3',
  ])
    await expect(page.locator(`article a[href="/en/tools/${slug}"]`)).toHaveCount(1);
  await page.locator('article a[href="/en/tools/video-converter"]').click();
  await expect(page).toHaveTitle(/Online video converter.*MP4.*FormatOwl/i);
  await expect(page.locator('nav.breadcrumbs a[href="/en/convert"]')).toBeVisible();
  await page.goto('/en/compress');
  for (const slug of ['video-compressor', 'image-compressor', 'audio-compressor', 'pdf-compressor'])
    await expect(page.locator(`article a[href="/en/tools/${slug}"]`)).toHaveCount(1);
  await page.locator('article a[href="/en/tools/pdf-compressor"]').click();
  await expect(page).toHaveTitle(/Online PDF compressor.*Reduce PDF size.*FormatOwl/i);
  await expect(page.locator('nav.breadcrumbs a[href="/en/compress"]')).toBeVisible();
});
