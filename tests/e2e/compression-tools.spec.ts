import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
const fixture = (name: string) => resolve('.data/fixtures', name);
for (const scenario of [
  { tool: 'image-compressor', files: ['photo.jpg', 'photo.heic', 'broken.png'], success: 2 },
  { tool: 'pdf-compressor', files: ['document.pdf', 'scan.pdf'], success: 2 },
  { tool: 'audio-compressor', files: ['audio.wav', 'audio.ogg'], success: 2 },
]) {
  test(`${scenario.tool}: batch upload, preview, export, ZIP and refresh`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/en/tools/${scenario.tool}`);
    await page.locator('input[type=file]').setInputFiles(scenario.files.map(fixture));
    if (scenario.tool === 'audio-compressor') {
      await page.getByRole('combobox', { name: 'Output format' }).click();
      await page.getByRole('option', { name: 'M4A', exact: true }).click();
      await page.getByRole('tab', { name: /Advanced compression|高级压缩/, exact: true }).click();
      await page.getByRole('combobox', { name: 'Channels' }).click();
      await page.getByRole('option', { name: 'Mono', exact: true }).click();
    }
    await page.getByRole('button', { name: /Compress files/ }).click();
    await expect(page).toHaveURL(/\/en\/batches\//, { timeout: 65000 });
    await expect(
      page.getByText(`${scenario.success} of ${scenario.files.length} files completed`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60000 });
    await page.reload();
    await expect(page.locator('.file-result')).toHaveCount(scenario.files.length);
    const previewRow =
      scenario.tool === 'pdf-compressor'
        ? page
            .locator('.file-result')
            .filter({ has: page.getByText('document.pdf', { exact: true }) })
        : page
            .locator('.file-result')
            .filter({ has: page.getByRole('button', { name: 'Preview', exact: true }) })
            .first();
    await previewRow.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = previewRow.locator('.file-previews');
    await expect(preview).toBeVisible();
    if (scenario.tool === 'pdf-compressor') {
      await expect(preview.locator('canvas').first()).toHaveJSProperty('width', 900, {
        timeout: 15000,
      });
      await preview.getByRole('button', { name: 'Next page' }).first().click();
      await expect(preview.getByText('2 / 2', { exact: true })).toBeVisible();
    } else if (scenario.tool === 'audio-compressor') {
      await expect(preview.locator('audio').last()).toHaveJSProperty('readyState', 4, {
        timeout: 15000,
      });
    } else {
      await expect(preview.locator('img').last()).toHaveJSProperty('complete', true);
    }
    const individual = page.waitForEvent('download');
    await page
      .locator('.file-result')
      .filter({ has: page.getByRole('button', { name: 'Preview', exact: true }) })
      .first()
      .getByRole('button', { name: /Download / })
      .click();
    const file = await individual;
    expect(await file.failure()).toBeNull();
    await page.getByRole('button', { name: 'Pack successful files' }).click();
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeEnabled({
      timeout: 30000,
    });
    const zipped = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    expect((await zipped).suggestedFilename()).toBe('formatowl-results.zip');
    await page.screenshot({ path: `.data/${scenario.tool}-results.png`, fullPage: true });
    expect(errors).toEqual([]);
    const id = page.url().split('/').pop();
    await page.request.delete(`/api/batches/${id}`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
  });
}
test('homepage dispatch and mobile settings for all new tools', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [file, tool] of [
    ['photo.jpg', 'image-compressor'],
    ['document.pdf', 'pdf-compressor'],
    ['audio.wav', 'audio-compressor'],
  ]) {
    await page.goto('/zh');
    await page.locator('input[type=file]').setInputFiles(fixture(file));
    await expect(page).toHaveURL(new RegExp(`/zh/tools/${tool}`));
    await expect(page.getByText(file, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `.data/${tool}-mobile.png`, fullPage: true });
  }
  await page.goto('/zh/tools/image-compressor');
  await page
    .locator('input[type=file]')
    .setInputFiles([fixture('photo.jpg'), fixture('audio.wav')]);
  await expect(page.locator('.error-banner[role=alert]')).toContainText('不要混合文件类型');
});
