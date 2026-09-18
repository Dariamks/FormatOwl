import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.data/reflow-qa');
const fixture = existsSync(root + '/browser-fixture.json')
  ? JSON.parse(readFileSync(root + '/browser-fixture.json', 'utf8'))
  : null;
const state = resolve('.data/translation-live/browser-state.json');
test.use({ storageState: existsSync(state) ? state : undefined });
test('reflow PDF has semantic bidirectional sync, keyboard controls, correction and mobile AI surfaces', async ({
  page,
}) => {
  test.skip(!fixture, 'Requires a locally upgraded PDF acceptance fixture');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/zh/workspace/${fixture.id}`);
  const source = page.getByLabel('滚动原文', { exact: true }),
    target = page.getByLabel('滚动译文', { exact: true });
  await expect(source).toBeVisible();
  await expect(target.locator('canvas').first()).toBeVisible();
  await expect
    .poll(() => target.locator('[data-page-index]').count())
    .toBeGreaterThan(await source.locator('[data-page-index]').count());
  expect(
    Math.abs((await source.boundingBox())!.width - (await target.boundingBox())!.width),
  ).toBeLessThan(2);
  const controls = page.getByRole('group', { name: '原文分页和缩放' });
  await page.mouse.move(20, 20);
  await expect(controls).toHaveCSS('opacity', '0');
  await source.focus();
  await expect(controls).toHaveCSS('opacity', '1');
  async function position(side: typeof source, id: string) {
    await side.evaluate((el, id) => {
      const block = el.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
      el.scrollTop += block.getBoundingClientRect().top - el.getBoundingClientRect().top - 100;
    }, id);
  }
  async function offset(side: typeof source, id: string) {
    return side.evaluate((el, id) => {
      const block = el.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
      return block.getBoundingClientRect().top - el.getBoundingClientRect().top;
    }, id);
  }
  await position(source, 'b18');
  await expect.poll(async () => Math.abs((await offset(target, 'b18')) - 100)).toBeLessThan(3);
  await position(target, 'b8');
  await expect.poll(async () => Math.abs((await offset(source, 'b8')) - 100)).toBeLessThan(3);
  // Distinct panels in a composite illustration keep their own scroll anchors.
  for (const id of ['d-3c28fe5f3f8974a957', 'd-bb4757ba558ad0764d', 'd-3c2da69967e4d7e126']) {
    await position(target, id);
    await expect.poll(async () => Math.abs((await offset(source, id)) - 100)).toBeLessThan(3);
    await position(source, id);
    await expect.poll(async () => Math.abs((await offset(target, id)) - 100)).toBeLessThan(3);
  }
  await position(source, 'b29');
  await expect.poll(async () => Math.abs((await offset(target, 'b29')) - 100)).toBeLessThan(3);
  await page.screenshot({ path: root + '/layout-figures.png' });
  await position(source, 'b37');
  await expect.poll(async () => Math.abs((await offset(target, 'b37')) - 100)).toBeLessThan(3);
  await page.screenshot({ path: root + '/layout-question.png' });
  await position(target, 'b8');
  await expect.poll(async () => Math.abs((await offset(source, 'b8')) - 100)).toBeLessThan(3);
  await controls.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(controls.getByRole('spinbutton', { name: '页码' })).toHaveValue('2');
  await expect
    .poll(() =>
      target.evaluate((el) => {
        const y = el.getBoundingClientRect().top + 100;
        const region = [...el.querySelectorAll<HTMLElement>('[data-block-id]')].find(
          (n) => n.getBoundingClientRect().bottom > y,
        );
        return region?.closest<HTMLElement>('[data-source-page]')?.dataset.sourcePage;
      }),
    )
    .toBe('1');
  await position(target, 'b8');
  await target.getByRole('button', { name: '校正区域 b8', exact: true }).click();
  const correction = page.getByRole('complementary', { name: '校正面板' });
  await expect(correction).toBeVisible();
  await expect(correction.getByText('位置和尺寸', { exact: true })).toHaveCount(0);
  await expect(correction.getByRole('combobox', { name: '字体', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭校正' }).click();
  await page.getByRole('button', { name: '仅译文', exact: true }).click();
  const ai = page.getByRole('complementary', { name: 'AI 阅读', exact: true });
  await expect(ai).toBeVisible();
  await expect(source).toHaveCount(0);
  expect(
    Math.abs(
      (await page.locator('.pdf-reader').boundingBox())!.width - (await ai.boundingBox())!.width,
    ),
  ).toBeLessThan(2);
  await page.screenshot({ path: root + '/reader-desktop.png' });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('tab', { name: 'AI 阅读', exact: true }).click();
    await expect(ai).toBeVisible();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(ai).toBeHidden();
    await expect(target).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: root + `/reader-mobile-${width}.png` });
  }
  expect(errors).toEqual([]);
});
