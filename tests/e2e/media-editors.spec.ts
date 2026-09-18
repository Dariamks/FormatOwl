import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
const fixture = (name: string) => resolve('.data/fixtures', name);
async function expectPreviewTone(page: Page, frequency: number) {
  await expect(page.locator('.editor-waveform audio')).toHaveJSProperty('readyState', 4);
  const amplitudes = await page.locator('.editor-waveform audio').evaluate(async (element) => {
    const context = new AudioContext();
    try {
      const data = await (await fetch((element as HTMLAudioElement).currentSrc)).arrayBuffer();
      const audio = await context.decodeAudioData(data);
      const samples = audio.getChannelData(0);
      return [440, 880].map((hz) => {
        let re = 0,
          im = 0;
        for (let i = Math.round(audio.sampleRate * 0.5); i < audio.sampleRate * 0.7; i++) {
          re += samples[i] * Math.cos((2 * Math.PI * hz * i) / audio.sampleRate);
          im += samples[i] * Math.sin((2 * Math.PI * hz * i) / audio.sampleRate);
        }
        return Math.hypot(re, im);
      });
    } finally {
      await context.close();
    }
  });
  expect(amplitudes[frequency === 440 ? 0 : 1]).toBeGreaterThan(
    amplitudes[frequency === 440 ? 1 : 0] * 10,
  );
}
async function upload(page: Page, tool: string, files: string[], locale = 'en') {
  // Establish the anonymous owner before any page request can race to create a session.
  await page.request.get('/api/session');
  await page.goto(`/${locale}/tools/${tool}`);
  await expect(page.locator('.auth-trigger')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(files.map(fixture));
  await expect(
    page.getByRole('heading', {
      name: locale === 'en' ? 'Editor preview' : '编辑预览',
      exact: true,
    }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole('button', { name: locale === 'en' ? 'Export file' : '导出文件', exact: true }),
  ).toBeEnabled({ timeout: 60000 });
}
async function exportAndDownload(page: Page, suffix: string) {
  await page.getByRole('button', { name: 'Export file', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\//);
  const download = page.getByRole('button', { name: 'Download file', exact: true });
  await expect(download).toBeVisible({ timeout: 60000 });
  const media = page.locator('.editor-result video, .editor-result audio');
  await expect(media).toHaveJSProperty('readyState', 4, { timeout: 15000 });
  const file = page.waitForEvent('download');
  await download.click();
  const result = await file;
  expect(result.suggestedFilename()).toMatch(new RegExp(`\\.${suffix}$`));
  expect(await result.failure()).toBeNull();
  await page.reload();
  await expect(download).toBeVisible();
  return page.url().split('/').pop()!;
}
test('extract audio: tracks, millisecond range, draft restore and result', async ({ page }) => {
  await upload(page, 'video-to-mp3', ['editor-multitrack.mp4']);
  await expect(page.getByRole('combobox', { name: 'Audio track', exact: true })).toHaveText(
    /^Track 2 ·/,
  );
  await page.getByRole('combobox', { name: 'Audio track', exact: true }).click();
  await page.getByRole('option', { name: /^Track 1 ·/, exact: true }).click();
  await expectPreviewTone(page, 440);
  await page.getByLabel('Start (seconds)', { exact: true }).fill('0.250');
  await page.getByLabel('End (seconds)', { exact: true }).fill('2.750');
  await page.getByRole('combobox', { name: 'Audio quality', exact: true }).click();
  await page.getByRole('option', { name: '320 kbps', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Start (seconds)', { exact: true })).toHaveValue('0.250', {
    timeout: 30000,
  });
  await expect(page.getByLabel('End (seconds)', { exact: true })).toHaveValue('2.750');
  const id = await exportAndDownload(page, 'mp3');
  await expect(page.locator('.editor-result-details')).toContainText('320');
  await page.getByRole('button', { name: 'Continue editing' }).click();
  await expect(page.getByLabel('Start (seconds)', { exact: true })).toHaveValue('0.250');
  await expect(page.getByRole('combobox', { name: 'Audio track', exact: true })).toHaveText(
    /^Track 1 ·/,
  );
  await expectPreviewTone(page, 440);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.data/editor-extract-desktop.png', fullPage: true });
  await page.request.delete(`/api/jobs/${id}`, { headers: { Origin: 'http://127.0.0.1:3000' } });
});
test('video cutter: multiple regions, keyboard handles and remove mode', async ({ page }) => {
  await upload(page, 'video-cutter', ['sample.webm']);
  await page.getByLabel('Start time', { exact: true }).fill('0.500');
  await page.getByLabel('End time', { exact: true }).fill('1.500');
  await page.getByRole('button', { name: 'Add region' }).click();
  await page.getByLabel('Start time', { exact: true }).fill('3.000');
  await page.getByLabel('End time', { exact: true }).fill('4.000');
  await page.getByLabel('Selection end handle').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('00:00:03.999');
  await page.getByRole('button', { name: 'Remove regions', exact: true }).click();
  await expect(page.locator('.editor-mode-description')).toContainText(
    'Remove the selected time ranges',
  );
  await page.getByRole('combobox', { name: 'Output format', exact: true }).click();
  await page.getByRole('option', { name: 'MKV', exact: true }).click();
  await expect(page.locator('.editor-export-summary')).toContainText('3.');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.data/editor-cut-desktop.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Output format', exact: true })).toHaveText(
    'MKV',
  );
  await expect(page.locator('.cutter-video')).toHaveJSProperty('controls', false);
  await exportAndDownload(page, 'mkv');
});
test('video crop: ratio, pixel controls, real preview and output dimensions', async ({ page }) => {
  await upload(page, 'video-cropper', ['editor-multitrack.mp4']);
  await page.getByRole('radio', { name: '1:1', exact: true }).check();
  await page.getByRole('tab', { name: 'Precise crop', exact: true }).click();
  await expect(page.getByLabel('Width (px)', { exact: true })).toHaveValue('240');
  await page.locator('.crop-selection').scrollIntoViewIfNeeded();
  const frame = await page.locator('.crop-selection').boundingBox();
  await page.mouse.move(frame!.x + frame!.width / 2, frame!.y + frame!.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame!.x + frame!.width / 2 + 20, frame!.y + frame!.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(Number(await page.getByLabel('X (px)', { exact: true }).inputValue())).toBeGreaterThan(40);
  await page.getByLabel('X (px)', { exact: true }).fill('160');
  await page.getByLabel('Y (px)', { exact: true }).fill('120');
  await page.getByLabel('Width (px)', { exact: true }).fill('160');
  await page.getByLabel('Height (px)', { exact: true }).fill('120');
  await expect(page.locator('.crop-output')).toHaveJSProperty('width', 160);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.data/editor-crop-desktop.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Output format', exact: true }).click();
  await page.getByRole('option', { name: 'MOV', exact: true }).click();
  await exportAndDownload(page, 'mov');
  await expect(page.locator('.editor-result-details')).toContainText('160 × 120');
});
test('audio composition: two sources, reorder, fades, preview invalidation and M4R', async ({
  page,
}) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await upload(page, 'audio-cutter', ['editor-low.wav', 'editor-multitrack.mp4']);
  await expect(page.locator('.audio-clip')).toHaveCount(2, { timeout: 60000 });
  await page.getByRole('combobox', { name: 'Audio track', exact: true }).click();
  await page.getByRole('option', { name: /^Track 1 ·/, exact: true }).click();
  await expectPreviewTone(page, 440);
  await page.getByRole('button', { name: 'Duplicate clip 2', exact: true }).click();
  await page.getByRole('combobox', { name: 'Audio track', exact: true }).click();
  await page.getByRole('option', { name: /^Track 2 ·/, exact: true }).click();
  await expectPreviewTone(page, 880);
  await page
    .locator('.editor-source')
    .getByRole('button', { name: /^editor-multitrack.mp4/ })
    .click();
  await expectPreviewTone(page, 440);
  await page.getByRole('button', { name: 'Delete clip 3', exact: true }).click();
  await page.locator('.clip-label').first().click();
  await page.getByLabel('End (seconds)', { exact: true }).fill('1.500');
  const handle = page.locator('.editor-waveform [part~="region-handle-right"]');
  await expect(handle).toBeVisible();
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 30);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - 35, handleBox!.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByLabel('End (seconds)', { exact: true }).inputValue()))
    .toBeLessThan(1.5);
  await page.getByLabel('End (seconds)', { exact: true }).fill('1.500');
  await page.getByLabel('Fade in (seconds)', { exact: true }).fill('0.200');
  await page.getByLabel('Fade out (seconds)', { exact: true }).fill('0.300');
  await page.getByRole('button', { name: 'Duplicate clip 1', exact: true }).click();
  await expect(page.locator('.audio-clip')).toHaveCount(3);
  await page.getByRole('button', { name: 'Delete clip 2', exact: true }).click();
  await page.getByRole('button', { name: 'Move clip down 1', exact: true }).click();
  await expect(page.locator('.clip-label').first()).toContainText('editor-multitrack.mp4');
  await page.getByLabel('Output format').click();
  await page.getByRole('option', { name: 'M4R', exact: true }).click();
  await page.getByRole('button', { name: 'Preview composition', exact: true }).click();
  await expect(page.locator('.composition-preview audio')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.composition-preview audio')).toHaveJSProperty('readyState', 4);
  await page.getByLabel('Fade in (seconds)', { exact: true }).fill('0.100');
  await expect(page.locator('.composition-preview')).toContainText('Your edits have changed');
  await expect(page.locator('.composition-preview audio')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.data/editor-audio-desktop.png', fullPage: true });
  await exportAndDownload(page, 'm4r');
  expect(errors).toEqual([]);
});
test('mobile Chinese editor, touch crop and draft persistence', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.request.get('/api/session');
  await page.goto('/zh/tools/video-cropper');
  await expect(page.locator('.auth-trigger')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(fixture('rotated.mp4'));
  await expect(page.locator('.editor-source')).toContainText('rotated.mp4');
  // Reload while preparation is pending; no editing options exist in this draft yet.
  await page.reload();
  await expect(page.getByRole('heading', { name: '编辑预览', exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.getByRole('radio', { name: '1:1', exact: true }).check();
  const before = Number(await page.getByLabel('Y (px)', { exact: true }).inputValue());
  await page.locator('.crop-selection').scrollIntoViewIfNeeded();
  const visible = await page.locator('.crop-selection').boundingBox();
  const cdp = await context.newCDPSession(page);
  const x = visible!.x + visible!.width / 2,
    y = visible!.y + visible!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y + 25 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(Number(await page.getByLabel('Y (px)', { exact: true }).inputValue())).toBeGreaterThan(
    before,
  );
  await page.getByRole('button', { name: '播放', exact: true }).tap();
  await expect(page.locator('.crop-stage video')).toHaveJSProperty('paused', false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.data/editor-crop-mobile.png', fullPage: true });
  await page.reload();
  await expect(page.getByText('已恢复本浏览器中的编辑草稿。素材有效期为 24 小时。')).toBeVisible();
  await expect(page.getByLabel('宽度 (px)', { exact: true })).toHaveValue('540', {
    timeout: 30000,
  });
  await context.close();
});
