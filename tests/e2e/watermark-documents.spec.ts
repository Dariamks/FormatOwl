import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve('.data/watermark-documents');
const report = resolve(root, 'report.json');
const state = resolve(root, 'browser-state.json');
const records: { name: string; id: string; pages: number; repair: boolean; labels: string[] }[] =
  existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : [];

test.describe('document watermark regression', () => {
  test.use({ storageState: existsSync(state) ? state : undefined });
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/jobs/*/watermark', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      if (data.capabilities) data.capabilities.ocr = false;
      await route.fulfill({ response, json: data });
    });
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
  });
  for (const name of [
    'compatibility.docx',
    'image-compatibility.docx',
    'grouped.pptx',
    'hidden.pptx',
    'text-state.pdf',
    'scan.pdf',
  ]) {
    test(name + ': restore, preview, editable download and mobile', async ({ page }) => {
      const row = records.find((r) => r.name === name);
      test.skip(!row || !existsSync(state), 'Run test:watermarks:documents first');
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/zh/workspace/' + row!.id);
      await expect(page.getByRole('heading', { name: '水印与选区' })).toBeVisible();
      await expect(page.getByAltText('原始文件', { exact: true })).toBeVisible();
      for (const label of row!.labels) {
        await expect(
          page.locator('.wm-candidate').filter({ hasText: label }).getByRole('checkbox'),
        ).toBeChecked();
      }
      await expect(page.locator('.wm-comparison')).toContainText('第 1 / ' + row!.pages + ' 页');
      if (row!.pages > 1) {
        await page.getByRole('button', { name: '第 2 页', exact: true }).click();
        await expect(page.locator('.wm-comparison')).toContainText('第 2 / ' + row!.pages + ' 页');
        await expect(page.getByAltText('原始文件', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '第 1 页', exact: true }).click();
      }
      if (row!.repair) {
        await page.locator('.wm-embedded button').first().click();
        await expect(page.getByText('正在编辑嵌入图片', { exact: false })).toBeVisible();
        if (name !== 'scan.pdf')
          await expect(
            page.locator('.wm-candidate').filter({ hasText: 'SAMPLE' }).getByRole('checkbox'),
          ).toBeChecked();
        else await expect(page.locator('.wm-region-row')).toHaveCount(1);
        await page.getByRole('button', { name: '返回文档', exact: true }).click();
      }
      await page.getByRole('button', { name: '预览当前页效果', exact: true }).click();
      await expect(page.getByRole('button', { name: '滑动对比', exact: true })).toBeEnabled({
        timeout: 90000,
      });
      await page.getByRole('button', { name: '滑动对比', exact: true }).click();
      await expect(page.getByRole('slider', { name: '对比位置' })).toBeVisible();
      await page.screenshot({ path: resolve(root, name + '-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: '处理全部选区并导出', exact: true }).click();
      const button = page.getByRole('button', { name: '下载', exact: true });
      await expect(button).toBeEnabled({ timeout: 90000 });
      const downloading = page.waitForEvent('download');
      await button.click();
      const download = await downloading;
      expect(await download.failure()).toBeNull();
      await download.saveAs(resolve(root, 'browser-' + name));
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: resolve(root, name + '-mobile.png'), fullPage: true });
      await page.reload();
      await expect(page.getByRole('heading', { name: '水印与选区' })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
  test('browser downloads preserve editable document content', () => {
    test.skip(!existsSync(state), 'Run test:watermarks:documents first');
    execFileSync(
      resolve('.data/venv/bin/python'),
      ['scripts/check-watermark-document-results.py', root, 'browser-'],
      { stdio: 'inherit' },
    );
  });
});
