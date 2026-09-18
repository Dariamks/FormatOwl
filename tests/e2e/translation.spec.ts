import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const liveRoot = process.env.TRANSLATION_LIVE_DIR || '.data/translation-live';
const reportPath = resolve(liveRoot, 'end-to-end.json'),
  state = resolve(liveRoot, 'browser-state.json');
const records: { tool: string; id: string }[] = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, 'utf8'))
  : [];
test('translation entry settings fit mobile and reject unsupported files', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const slug of ['video-translator', 'document-translator', 'image-translator']) {
    await page.goto(`/zh/tools/${slug}`);
    await expect(page.getByRole('combobox', { name: '源语言', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始翻译', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<html>not an image</html>'),
  });
  await expect(page.getByRole('alert').filter({ hasText: '文件格式' })).toBeVisible();
});
test.describe('live translation review and downloads', () => {
  test.use({ storageState: existsSync(state) ? state : undefined });
  for (const tool of ['document-translator', 'video-translator', 'image-translator'])
    test(`${tool}: saved corrections, preview, immutable download and mobile`, async ({ page }) => {
      const record = records.find((r) => r.tool === tool);
      test.skip(
        !record,
        'Run test:translation:e2e:live to create synthetic real-model acceptance files',
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`/zh/workspace/${record!.id}`);
      await expect(page.getByRole('complementary', { name: '校正面板' })).toBeHidden();
      if (tool === 'document-translator')
        await expect(page.locator('.translation-canvases canvas').first()).toBeVisible();
      await page.getByRole('button', { name: '校正', exact: true }).click();
      const translation = page.getByRole('textbox', { name: '译文', exact: true });
      await expect(translation).toBeVisible();
      const original = await translation.inputValue();
      const edited = tool === 'image-translator' ? `测试${Date.now() % 10000}` : `${original} ✓`;
      await translation.fill(edited);
      await expect(page.getByText('已保存', { exact: true })).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: '校正', exact: true }).click();
      await expect(translation).toHaveValue(edited);
      if (tool === 'video-translator') {
        await expect(page.locator('.translation-player video')).toHaveJSProperty('readyState', 4);
        await page.getByRole('button', { name: '下载', exact: true }).first().click();
        await page.getByLabel('字幕字号', { exact: true }).fill('42');
        await page.getByRole('combobox', { name: '字幕位置', exact: true }).click();
        await page.getByRole('option', { name: '顶部', exact: true }).click();
        await page.getByRole('combobox', { name: '文件格式', exact: true }).click();
        await page.getByRole('option', { name: 'ASS', exact: true }).click();
        await page.getByRole('combobox', { name: '导出内容', exact: true }).click();
        await page.getByRole('option', { name: '双语', exact: true }).click();
      } else if (tool === 'image-translator') {
        await expect(page.locator('.translation-canvas img').first()).toHaveJSProperty(
          'naturalWidth',
          800,
        );
        await page.getByLabel('字号', { exact: true }).fill('22');
      }
      if (tool !== 'video-translator')
        await page.getByRole('button', { name: '下载', exact: true }).first().click();
      const download = page.waitForEvent('download', { timeout: 90000 });
      await page.getByRole('button', { name: '保存并下载', exact: true }).click();
      const file = await download;
      expect(await file.failure()).toBeNull();
      await file.saveAs(
        resolve(
          liveRoot,
          `browser-${tool}.${tool === 'video-translator' ? 'ass' : tool === 'document-translator' ? 'docx' : 'png'}`,
        ),
      );
      const history = page.locator('.translation-export-history');
      if (!(await history.evaluate((element) => (element as HTMLDetailsElement).open)))
        await history.locator('summary').click();
      if (tool !== 'video-translator') {
        await page.getByRole('button', { name: '查看成品' }).first().click();
        await expect(page.getByRole('dialog', { name: '导出预览', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '关闭预览' }).click();
      }
      if (tool === 'video-translator') await page.getByRole('button', { name: '关闭下载' }).click();
      await page.screenshot({ path: resolve(liveRoot, `${tool}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(translation).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: resolve(liveRoot, `${tool}-mobile.png`), fullPage: true });
      expect(errors).toEqual([]);
    });
  test('stale edit conflicts are explicit and reloading restores the server copy', async ({
    page,
  }) => {
    const record = records.find((r) => r.tool === 'document-translator');
    test.skip(!record, 'Requires live synthetic fixtures');
    await page.goto(`/zh/workspace/${record!.id}`);
    await page.getByRole('button', { name: '校正', exact: true }).click();
    const field = page.getByRole('textbox', { name: '译文', exact: true });
    await expect(field).toBeVisible();
    await field.fill('本地冲突修改');
    const view = await (await page.request.get(`/api/jobs/${record!.id}/translation`)).json();
    await page.request.patch(`/api/jobs/${record!.id}/translation`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
      data: {
        revision: view.revision,
        upsert: [{ id: view.data.blocks[0].id, translatedText: '服务端保存版本' }],
      },
    });
    await expect(page.getByText('保存失败', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '载入服务端版本' }).click();
    await expect(field).toHaveValue('服务端保存版本');
  });
  test('overflow can preserve the original appearance and still expose the full translated text', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const record = records.find((r) => r.tool === 'image-translator');
    test.skip(!record, 'Requires live synthetic fixtures');
    const path = `/api/jobs/${record!.id}/translation`,
      headers = { Origin: 'http://127.0.0.1:3000' };
    const before = await (await page.request.get(path)).json(),
      block = before.data.blocks[0],
      text = '完整译文不可裁切。'.repeat(150);
    try {
      expect(
        (
          await page.request.patch(path, {
            headers,
            data: {
              revision: before.revision,
              upsert: [{ id: block.id, translatedText: text, keepOriginal: false, reviewed: true }],
            },
          })
        ).ok(),
      ).toBeTruthy();
      await page.goto(`/zh/workspace/${record!.id}`);
      await page.getByRole('button', { name: '下载', exact: true }).first().click();
      await page.getByRole('button', { name: '保存并下载', exact: true }).click();
      const preserve = page.getByRole('button', { name: '保留问题区域原文后下载', exact: true });
      await expect(preserve).toBeEnabled({ timeout: 60000 });
      const file = page.waitForEvent('download');
      await preserve.click();
      expect(await (await file).failure()).toBeNull();
      await page.getByRole('button', { name: '关闭下载', exact: true }).click();
      await page.getByRole('button', { name: '文字', exact: true }).click();
      await expect(page.locator('.translation-reading')).toContainText(text);
    } finally {
      const latest = await (await page.request.get(path)).json();
      await page.request.patch(path, {
        headers,
        data: {
          revision: latest.revision,
          upsert: [
            {
              id: block.id,
              translatedText: block.translatedText,
              keepOriginal: block.keepOriginal,
              reviewed: true,
            },
          ],
        },
      });
    }
  });
});
