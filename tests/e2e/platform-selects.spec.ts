import { test, expect } from '@playwright/test';

test('transcription language menu supports keyboard, long lists and focus restoration', async ({
  page,
}) => {
  await page.goto('/zh/tools/transcription');
  const language = page.getByRole('combobox', { name: '语言', exact: true });
  await expect(language).toHaveText('自动识别');
  await language.press('Enter');
  await expect(page.getByRole('option', { name: '自动识别', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'हिन्दी', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('हिन्दी');
  await expect(language).toBeFocused();
  await language.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'हिन्दी', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('option', { name: '自动识别', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('自动识别');
  await language.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(language).toBeFocused();
  await language.click();
  await page.screenshot({ path: '.data/platform-selects/transcription-language.png' });
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await expect(language).toHaveText('English');
  await expect(page.getByRole('button', { name: '开始转写', exact: true })).toBeDisabled();
});

test('all translation language menus work on mobile without native pickers or overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const slug of ['video-translator', 'document-translator', 'image-translator']) {
    await page.goto(`/zh/tools/${slug}`);
    const source = page.getByRole('combobox', { name: '源语言', exact: true });
    const target = page.getByRole('combobox', { name: '目标语言', exact: true });
    await source.click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await expect(source).toHaveText('简体中文');
    await target.click();
    await page.keyboard.press('End');
    const menu = page.getByRole('listbox');
    await expect(page.getByRole('option', { name: '阿拉伯语', exact: true })).toBeFocused();
    await expect(menu).toHaveCSS('opacity', '1');
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: `.data/platform-selects/${slug}-mobile.png` });
    await page.getByRole('option', { name: '阿拉伯语', exact: true }).click();
    await expect(target).toHaveText('阿拉伯语');
    await expect(page.getByRole('button', { name: '开始翻译', exact: true })).toBeDisabled();
    await expect(page.locator('select:visible')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
