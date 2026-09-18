import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.data/watermark-test'),
  report = resolve(root, 'report.json'),
  state = resolve(root, 'browser-state.json');
const records: { fmt: string; id: string }[] = existsSync(report)
  ? JSON.parse(readFileSync(report, 'utf8'))
  : [];
const detectionReport = resolve(root, 'detection/report.json');
const detectionState = resolve(root, 'detection/browser-state.json');
test.describe('complete watermark backplate', () => {
  test.use({ storageState: existsSync(detectionState) ? detectionState : undefined });
  test('re-detection keeps the full badge selected without duplicating candidates', async ({
    page,
  }) => {
    test.skip(!existsSync(detectionReport), 'Run check-watermark-detection.ts first');
    const { id, region } = JSON.parse(readFileSync(detectionReport, 'utf8'));
    await page.goto('/zh/workspace/' + id);
    const detect = page.getByRole('button', { name: '重新识别水印', exact: true });
    await expect(detect).toBeEnabled();
    const mark = page.locator('svg.wm-overlay rect.wm-object');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveClass(/selected/);
    const dimensions = await mark.evaluate((element) => {
      const rect = element as SVGRectElement;
      const view = rect.ownerSVGElement!.viewBox.baseVal;
      return {
        x: rect.x.baseVal.value / view.width,
        y: rect.y.baseVal.value / view.height,
        width: rect.width.baseVal.value / view.width,
        height: rect.height.baseVal.value / view.height,
      };
    });
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(dimensions[key]).toBeCloseTo(region[key], 5);
    const before = await (await page.request.get('/api/jobs/' + id + '/watermark')).json();
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith('/watermark/runs') && r.request().method() === 'POST' && r.ok(),
    );
    await detect.click();
    const { id: runId } = await (await submitted).json();
    await expect
      .poll(async () => {
        const view = await (await page.request.get('/api/jobs/' + id + '/watermark')).json();
        return view.runs.find((run: { id: string }) => run.id === runId)?.state;
      })
      .toBe('completed');
    await page.reload();
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveClass(/selected/);
    await expect(page.locator('.wm-region-row')).toHaveCount(1);
    const after = await (await page.request.get('/api/jobs/' + id + '/watermark')).json();
    expect(after.selection).toEqual(before.selection);
    expect(after.revision).toBe(before.revision);
    await page.screenshot({ path: resolve(root, 'detection/desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detect).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(root, 'detection/mobile.png'), fullPage: true });
  });
});
test('watermark entries are localized, single-file and fit mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const slug of ['image', 'pdf', 'word', 'ppt']) {
    await page.goto('/zh/tools/' + slug + '-watermark-remover');
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
    expect(await page.locator('input[type=file]').getAttribute('multiple')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.pptm',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('invalid'),
  });
  await expect(page.getByRole('alert').filter({ hasText: '请选择支持的文件' })).toBeVisible();
  await page.goto('/en/tools/pdf-watermark-remover');
  await expect(page.getByRole('heading', { name: 'Remove PDF watermarks' })).toBeVisible();
});
test.describe('watermark workspaces', () => {
  test.use({ storageState: existsSync(state) ? state : undefined });
  test.beforeEach(async ({ page }) => {
    // File processing is real. Disable automatic paid OCR in browser regression only.
    await page.route('**/api/jobs/*/watermark', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const data = await response.json();
      if (data.capabilities) data.capabilities.ocr = false;
      await route.fulfill({ response, json: data });
    });
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
  });
  for (const fmt of ['png', 'pdf', 'docx', 'pptx'])
    test(fmt + ': preview, compare, download, restore, and mobile', async ({ page }) => {
      const record = records.find((r) => r.fmt === fmt);
      test.skip(!record, 'Run test:watermarks first');
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/zh/workspace/' + record!.id);
      await expect(page.getByRole('heading', { name: '水印与选区' })).toBeVisible();
      await expect(page.locator('.wm-canvas > img').first()).toBeVisible();
      if (fmt === 'png') {
        const canvas = page.locator('svg.wm-overlay');
        await page.getByRole('button', { name: '矩形选区', exact: true }).click();
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.79);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.92);
        await page.mouse.up();
        await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await page.getByRole('button', { name: '重做', exact: true }).click();
        await expect
          .poll(async () => {
            const v = await (
              await page.request.get('/api/jobs/' + record!.id + '/watermark')
            ).json();
            return v.selection.regions.length;
          })
          .toBe(2);
        await page.reload();
        await expect(page.locator('.wm-region-row')).toHaveCount(2);
        await page.getByRole('button', { name: '删除选区' }).last().click();
        await page.getByRole('button', { name: '画笔', exact: true }).click();
        await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.82);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.85, { steps: 8 });
        await page.mouse.up();
        await expect(page.locator('.wm-region-row')).toHaveCount(2);
        await page.getByRole('button', { name: '擦除选区', exact: true }).click();
        await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.83);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.84, { steps: 4 });
        await page.mouse.up();
        await expect
          .poll(async () => {
            const v = await (
              await page.request.get('/api/jobs/' + record!.id + '/watermark')
            ).json();
            return v.selection.regions.at(-1)?.strokes.some((s: { erase: boolean }) => s.erase);
          })
          .toBe(true);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await page.getByRole('button', { name: '删除选区' }).last().click();
      } else if (fmt === 'pdf') {
        await page.getByRole('button', { name: '应用到匹配页面…' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      }
      await page.getByRole('button', { name: '预览当前页效果', exact: true }).click();
      await expect(page.getByRole('button', { name: '滑动对比', exact: true })).toBeEnabled({
        timeout: 90000,
      });
      await page.getByRole('button', { name: '滑动对比', exact: true }).click();
      await expect(page.getByRole('slider', { name: '对比位置' })).toBeVisible();
      await page.getByRole('button', { name: '处理全部选区并导出', exact: true }).click();
      const downloadButton = page.getByRole('button', { name: '下载', exact: true });
      await expect(downloadButton).toBeEnabled({ timeout: 90000 });
      const event = page.waitForEvent('download');
      await downloadButton.click();
      const file = await event;
      expect(await file.failure()).toBeNull();
      await file.saveAs(resolve(root, 'browser-result.' + fmt));
      await page.screenshot({ path: resolve(root, fmt + '-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: resolve(root, fmt + '-mobile.png'), fullPage: true });
      expect(errors).toEqual([]);
    });
});
