import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.data/translation-live'),
  state = resolve(root, 'browser-state.json'),
  report = resolve(root, 'end-to-end.json');
const records: { id: string; tool: string }[] = existsSync(report)
  ? JSON.parse(readFileSync(report, 'utf8'))
  : [];
test.use({ storageState: existsSync(state) ? state : undefined });
for (const tool of ['document-translator', 'video-translator', 'image-translator']) {
  test(`${tool}: reading sources, mind map download, chat cancellation and mobile workspace`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    const record = records.find((r) => r.tool === tool);
    test.skip(!record, 'Requires live translation fixtures');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/zh/workspace/${record!.id}`);
    const panel = page.getByRole('complementary', { name: 'AI 阅读', exact: true });
    await expect(panel).toBeVisible();
    const update = panel.getByRole('button', { name: '根据最新文字更新' });
    if (await update.isVisible()) {
      await update.click();
      await expect(update).toBeHidden();
    }
    await expect(
      panel.locator('.reading-tab-content:not([hidden]) .reading-citations button').first(),
    ).toBeVisible({
      timeout: 120000,
    });
    await expect(page.getByRole('button', { name: '双语对照', exact: true })).toBeEnabled();
    await panel
      .locator('.reading-tab-content:not([hidden]) .reading-citations button')
      .first()
      .click();
    if (tool === 'document-translator')
      await expect(page.locator('.reading-selected-text').first()).toBeVisible();
    if (tool === 'image-translator')
      await expect(page.locator('.rendered-region.selected').first()).toBeAttached();
    if (tool === 'video-translator')
      await expect(page.locator('.translation-player video')).toBeVisible();
    await panel.getByRole('tab', { name: '思维导图', exact: true }).click();
    if (await update.isVisible()) {
      await update.click();
      await expect(update).toBeHidden();
    }
    await expect(panel.locator('.reading-map-scroll svg')).toBeVisible({ timeout: 120000 });
    const collapse = panel.getByRole('button', { name: /^收起 / }).first();
    if (await collapse.count()) {
      await collapse.click();
      await panel.getByRole('button', { name: '展开全部' }).click();
    }
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载导图 PNG', exact: true }).click();
    const file = await download;
    expect(await file.failure()).toBeNull();
    await file.saveAs(resolve(root, 'reading', `${tool}-browser-map.png`));
    await page.screenshot({ path: resolve(root, 'reading', `${tool}-reader-desktop.png`) });
    await panel.getByRole('tab', { name: '问答', exact: true }).click();
    await panel
      .getByRole('textbox', { name: '向文件提问' })
      .fill('请列出文件中的重点，我可能会停止本次生成。');
    await panel.getByRole('button', { name: '发送问题' }).click();
    const stop = panel.getByRole('button', { name: '停止', exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(panel.getByText('已停止生成', { exact: true }).last()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'AI 阅读', exact: true }).click();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(root, 'reading', `${tool}-reader-mobile.png`) });
    await panel.getByRole('button', { name: '关闭 AI 阅读' }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('tab', { name: 'AI 阅读', exact: true }).click();
    await expect(panel.getByText('已停止生成', { exact: true }).last()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
