import { test, expect } from '@playwright/test';

for (const locale of ['zh', 'en']) {
  test(`${locale}: settings tabs preserve values and support keyboard and narrow screens`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [tool, field, option] of [
      ['video-compressor', locale === 'zh' ? '最大分辨率' : 'Maximum resolution', '720p'],
      [
        'audio-compressor',
        locale === 'zh' ? '声道' : 'Channels',
        locale === 'zh' ? '单声道' : 'Mono',
      ],
      ['video-converter', locale === 'zh' ? '帧率' : 'Frame rate', '24 fps'],
      ['audio-converter', locale === 'zh' ? '采样率' : 'Sample rate', '48000 Hz'],
    ]) {
      await page.setViewportSize({ width: 1365, height: 1000 });
      await page.goto(`/${locale}/tools/${tool}`);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(2);
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      const control = page.getByRole('combobox', { name: field, exact: true });
      await expect(control).not.toBeVisible();
      await tabs.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.last()).toBeFocused();
      await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
      await control.click();
      await page.getByRole('option', { name: option, exact: true }).click();
      await tabs.last().focus();
      await page.keyboard.press('Home');
      await expect(control).not.toBeVisible();
      await page.keyboard.press('End');
      await expect(control).toHaveText(option);
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const left = await tabs.first().boundingBox();
        const right = await tabs.last().boundingBox();
        expect(left!.y).toBe(right!.y);
        expect(right!.x).toBeGreaterThan(left!.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await tabs.first().click();
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        await tabs.last().click();
        await expect(control).toHaveText(option);
      }
    }
    expect(errors).toEqual([]);
  });
}

test('image conversion keeps shared format and custom quality across views', async ({ page }) => {
  await page.goto('/zh/tools/image-converter');
  const tabs = page.getByRole('tab');
  const format = page.getByRole('combobox', { name: '输出格式', exact: true });
  await format.click();
  await page.getByRole('option', { name: 'WEBP', exact: true }).click();
  await tabs.last().click();
  await page.getByLabel('质量', { exact: true }).fill('72');
  await page.getByRole('checkbox').check();
  await tabs.first().click();
  await expect(format).toHaveText('WEBP');
  await tabs.last().click();
  await expect(page.getByLabel('质量', { exact: true })).toHaveValue('72');
  await expect(page.getByRole('checkbox')).toBeChecked();
  await format.click();
  await page.getByRole('option', { name: 'PNG', exact: true }).click();
  await expect(page.getByLabel('质量', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
