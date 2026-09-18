import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
const fixture = resolve('.data/fixtures/sample.mp4');
async function openEditor(page: Page, tool: string) {
  await page.request.get('/api/session');
  await page.goto(`/zh/tools/${tool}`);
  await expect(page.locator('.auth-trigger')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByRole('button', { name: '导出文件', exact: true })).toBeEnabled({
    timeout: 60000,
  });
}
async function format(page: Page, value: string) {
  await page.getByRole('combobox', { name: '导出格式', exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function capture(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
}
test('cutter transport, pointer selection, invalid time, touch handles and format draft', async ({
  page,
  browser,
}) => {
  await openEditor(page, 'video-cutter');
  const media = page.locator('.cutter-video');
  await expect(media).toHaveJSProperty('controls', false);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(media).toHaveJSProperty('paused', true);
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await expect(media).toHaveJSProperty('muted', true);
  await page.getByRole('button', { name: '取消静音', exact: true }).click();
  await expect(media).toHaveJSProperty('muted', false);
  const end = page.getByRole('slider', { name: '拖动选区终点', exact: true });
  await end.scrollIntoViewIfNeeded();
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => +(await end.getAttribute('aria-valuenow'))!).toBeLessThan(4800);
  await expect(page.getByRole('textbox', { name: '结束时间', exact: true })).not.toHaveValue(
    '00:00:05.000',
  );
  const start = page.getByRole('textbox', { name: '开始时间', exact: true });
  await start.fill('not a time');
  await expect(page.getByRole('button', { name: '导出文件', exact: true })).toBeDisabled();
  await start.fill('00:00:00.250');
  await page.getByRole('textbox', { name: '结束时间', exact: true }).fill('00:00:04.250');
  await expect(page.getByRole('button', { name: '导出文件', exact: true })).toBeEnabled();
  await format(page, 'MOV');
  await page.reload();
  await expect(start).toHaveValue('00:00:00.250');
  await expect(page.getByRole('combobox', { name: '导出格式', exact: true })).toHaveText('MOV');
  await capture(page, '.data/video-cutter-design-desktop.png');
  await page
    .locator('.video-editor-layout')
    .screenshot({ path: '.data/video-cutter-design-detail.png' });
  await page.getByRole('combobox', { name: '导出格式', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await capture(page, '.data/video-cutter-format-menu.png');
  await page.keyboard.press('Escape');
  // Continue the same saved draft on a touch viewport and drag a timeline edge.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: await page.context().storageState(),
  });
  const phone = await mobile.newPage();
  await phone.goto('/zh/tools/video-cutter');
  const touchEnd = phone.getByRole('slider', { name: '拖动选区终点', exact: true });
  await expect(touchEnd).toBeVisible({ timeout: 30000 });
  await touchEnd.scrollIntoViewIfNeeded();
  const touchBox = (await touchEnd.boundingBox())!;
  const cdp = await mobile.newCDPSession(phone);
  const x = touchBox.x + touchBox.width / 2,
    y = touchBox.y + touchBox.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x - 25, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(async () => +(await touchEnd.getAttribute('aria-valuenow'))!)
    .toBeLessThan(4250);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(phone, '.data/video-cutter-design-mobile.png');
  await mobile.close();
});

test('crop ratios, edge resizing, external seek and volume, format persistence and responsive settings', async ({
  page,
}) => {
  await openEditor(page, 'video-cropper');
  const media = page.locator('.crop-stage video');
  await expect(media).toHaveJSProperty('controls', false);
  await expect(page.getByRole('radio')).toHaveCount(8);
  await page.getByRole('radio', { name: '5:4', exact: true }).check();
  await expect(page.getByLabel('宽度 (px)', { exact: true })).toHaveValue('674');
  await expect(page.getByLabel('高度 (px)', { exact: true })).toHaveValue('540');
  await format(page, 'MKV');
  await page.reload();
  await expect(page.getByRole('radio', { name: '5:4', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: '导出格式', exact: true })).toHaveText('MKV');
  await page.getByRole('radio', { name: '自定义', exact: true }).check();
  const dot = page.locator('.crop-resize-dot[data-crop-handle=bottomRight]');
  await dot.scrollIntoViewIfNeeded();
  const handle = (await dot.boundingBox())!;
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  await page.mouse.move(handle.x - 60, handle.y - 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => +(await page.getByLabel('宽度 (px)', { exact: true }).inputValue()))
    .toBeLessThan(674);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const seek = page.getByRole('slider', { name: '预览位置', exact: true });
  await seek.press('Home');
  for (let i = 0; i < 5; i++) await seek.press('PageUp');
  await expect
    .poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(2.5, 2);
  await expect(page.locator('.transport-time').first()).toHaveText('00:02');
  const volume = page.getByRole('slider', { name: '音量', exact: true });
  await volume.press('Home');
  for (let i = 0; i < 6; i++) await volume.press('ArrowRight');
  await expect(media).toHaveJSProperty('volume', 0.3);
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await expect(page.getByRole('slider', { name: '音量', exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: '取消静音', exact: true }).click();
  await expect(media).toHaveJSProperty('muted', false);
  await volume.press('Home');
  await page.getByRole('button', { name: '取消静音', exact: true }).click();
  await expect(media).toHaveJSProperty('volume', 1);
  await expect(media).toHaveJSProperty('muted', false);
  await page.getByRole('radio', { name: '原比例', exact: true }).check();
  await expect(page.getByRole('combobox', { name: '导出格式', exact: true })).toHaveText('MKV');
  await capture(page, '.data/video-crop-design-desktop.png');
  await page
    .locator('.video-editor-layout')
    .screenshot({ path: '.data/video-crop-design-detail.png' });
  await page
    .locator('.editor-settings')
    .screenshot({ path: '.data/video-crop-settings-detail.png' });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect(page.getByRole('combobox', { name: '导出格式', exact: true })).toBeVisible();
    await capture(page, `.data/video-crop-design-${width}.png`);
  }
});
