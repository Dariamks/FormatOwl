import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
const sample = resolve('.data/fixtures/sample.mp4');
async function removeTask(page: Page) {
  const id = page.url().split('/').pop();
  if (id && /^[a-f\d-]{36}$/.test(id))
    await page.request.delete(`/api/jobs/${id}`, { headers: { Origin: 'http://127.0.0.1:3000' } });
}
test('home upload, settings, real export, page refresh and download', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/en');
  await expect(
    page.getByRole('heading', { name: /Your files\.\s*A little simpler\./ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled({
    timeout: 60000,
  });
  await page.locator('input[type=file]').setInputFiles(sample);
  await expect(page).toHaveURL(/\/en\/tools\/video-compressor/);
  await expect(page.getByText('sample.mp4', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Advanced compression|高级压缩/, exact: true }).click();
  await page.getByRole('combobox', { name: 'Maximum resolution' }).click();
  await page.getByRole('option', { name: '480p', exact: true }).click();
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/workspace\/[a-f\d-]+/, { timeout: 45000 });
  await expect(page.getByRole('heading', { name: 'Your video is ready.' })).toBeVisible({
    timeout: 45000,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your video is ready.' })).toBeVisible();
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download MP4' }).click();
  const downloaded = await promise;
  expect(downloaded.suggestedFilename()).toBe('sample-formatowl.mp4');
  expect(await downloaded.failure()).toBeNull();
  await expect(page.locator('video').nth(1)).toHaveJSProperty('videoHeight', 480);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.data/result-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
  await removeTask(page);
});
test('mobile Chinese navigation, translation tools and anonymous entry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/zh');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('文件处理，简单一点。');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.data/home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click();
  await page
    .locator('.tool-card')
    .filter({ has: page.getByRole('heading', { name: '图片翻译', exact: true }) })
    .click();
  await expect(page.getByRole('heading', { name: '图片翻译', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '目标语言', exact: true })).toBeVisible();
  await page.goto('/zh/login');
  await expect(page.getByRole('heading', { name: '欢迎来到 FormatOwl' })).toBeVisible();
  await page.getByRole('link', { name: '无需注册，直接使用' }).click();
  await expect(page.getByRole('heading', { name: '视频压缩', exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(sample);
  await page.getByRole('tab', { name: /Advanced compression|高级压缩/, exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.data/compressor-mobile.png', fullPage: true });
});
test('corrupted upload produces a real failure and allows retry', async ({ page }) => {
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/broken.mp4'));
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/[a-f\d-]+/, { timeout: 30000 });
  await expect(
    page.getByRole('alert').filter({ hasText: 'This media file is damaged or unsupported' }),
  ).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This media file is damaged or unsupported' }),
  ).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/jobs/${page.url().split('/').pop()}`);
      return (await response.json()).job.attempt;
    })
    .toBe(2);
  await removeTask(page);
});
test('multipart resumes after a page refresh without sending the first part again', async ({
  page,
}) => {
  test.setTimeout(150000);
  let block = true;
  let intercepted = false;
  const signedParts: number[] = [];
  await page.route('**/api/uploads/*/parts', async (route) => {
    const part = route.request().postDataJSON().partNumber as number;
    signedParts.push(part);
    if (block && part === 2) {
      intercepted = true;
      await route.abort();
    } else await route.continue();
  });
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/multipart.mp4'));
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect.poll(() => intercepted, { timeout: 45000 }).toBe(true);
  // Part requests run concurrently; wait until part one is confirmed by storage.
  await expect
    .poll(async () => {
      const records = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('filemorph-upload-v1') || '[]'),
      );
      if (!records.length) return false;
      const response = await page.request.get(`/api/uploads/${records[0].id}`);
      return (await response.json()).parts?.some((p: { PartNumber: number }) => p.PartNumber === 1);
    })
    .toBe(true);
  await page.reload();
  block = false;
  signedParts.length = 0;
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/multipart.mp4'));
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your video is ready.' })).toBeVisible({
    timeout: 45000,
  });
  expect(signedParts).not.toContain(1);
  await removeTask(page);
});
