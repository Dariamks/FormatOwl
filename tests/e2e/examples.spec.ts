import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import enExamples from '../../apps/web/messages/en/examples.json' with { type: 'json' };
import zhExamples from '../../apps/web/messages/zh/examples.json' with { type: 'json' };
import { publicExamples } from '../../apps/web/src/content/examples';

function observeWork(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/(uploads|jobs|batches)(?:\?|$)/.test(request.url()))
      requests.push(request.url());
  });
  return requests;
}
test('public previews and downloads are real, bilingual and create no work', async ({ page }) => {
  const work = observeWork(page);
  for (const locale of ['zh', 'en'] as const) {
    const text: Record<string, string> = locale === 'zh' ? zhExamples : enExamples;
    await page.goto(`/${locale}`);
    const section = page.locator('#examples');
    for (const example of publicExamples) {
      await section.getByRole('button', { name: text[example.title], exact: true }).click();
      await expect(section.getByRole('heading', { name: text[example.scenario] })).toBeVisible();
      if (example.kind === 'video') {
        for (const video of await section.locator('video').all()) {
          await expect(video).toHaveAttribute('preload', 'none');
          await expect(video).toHaveJSProperty('paused', true);
        }
      } else {
        for (const image of await section.locator('.example-media img').all())
          await expect(image).toHaveJSProperty('complete', true);
      }
      const download = page.waitForEvent('download');
      await section
        .getByRole('link', {
          name: locale === 'zh' ? '下载处理结果' : 'Download result',
          exact: true,
        })
        .click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(example.output.name);
      expect((await readFile((await file.path())!)).length).toBe(example.output.size);
      await expect(
        section.getByRole('link', {
          name: locale === 'zh' ? '用这个示例试一试' : 'Try this sample',
          exact: true,
        }),
      ).toHaveAttribute('href', `/${locale}/tools/${example.route}?sample=${example.id}`);
    }
  }
  expect(work).toEqual([]);
});
for (const example of publicExamples) {
  test(`${example.id} sample loads its source and preset without uploading`, async ({ page }) => {
    const work = observeWork(page);
    await page.goto(`/en/tools/${example.route}?sample=${example.id}`);
    await expect(page.getByText(example.input.name, { exact: true })).toBeVisible();
    await expect(
      page.getByText('Sample ready. Adjust the settings, then submit to start processing.', {
        exact: true,
      }),
    ).toBeVisible();
    if (example.kind === 'video')
      await expect(page.locator('.quality-options input[value="balanced"]')).toBeChecked();
    if (example.kind === 'pdf')
      await expect(page.getByRole('radio', { name: /Strong compression/ })).toBeChecked();
    if (example.kind === 'image')
      await expect(page.getByRole('combobox', { name: 'Output format' })).toContainText('JPG');
    expect(work).toEqual([]);
  });
}
test('invalid and mismatched samples preserve ordinary upload and canonical URLs', async ({
  page,
}) => {
  for (const query of ['https://example.invalid/payload.mp4', 'image', 'video&sample=pdf']) {
    await page.goto('/en/tools/video-compressor?sample=' + query);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This sample is unavailable' }),
    ).toBeVisible();
    await expect(
      page.locator('.video-drop button').filter({ hasText: 'Choose video' }),
    ).toBeEnabled();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/en\/tools\/video-compressor$/,
    );
    await expect(page.locator('.file-details')).toHaveCount(0);
  }
});
test('sample preview requires explicit replacement and Escape preserves the current file', async ({
  page,
}) => {
  const work = observeWork(page);
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  await page.getByRole('button', { name: 'Explore a sample' }).click();
  const dialog = page.getByRole('dialog', { name: 'Public sample preview' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Replace current files with sample' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('sample.mp4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Explore a sample' }).click();
  await dialog.getByRole('button', { name: 'Replace current files with sample' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('studio-original.mp4', { exact: true })).toBeVisible();
  expect(work).toEqual([]);
});
test('failed sample loading can retry without losing the normal upload action', async ({
  page,
}) => {
  const work = observeWork(page);
  await page.route('**/examples/studio-original.pdf', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.goto('/zh/tools/pdf-compressor?sample=pdf');
  await expect(page.getByRole('alert').filter({ hasText: '示例加载失败' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled();
  await page.unroute('**/examples/studio-original.pdf');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '加载示例，调整参数' }).click();
  await expect(page.getByText('studio-original.pdf', { exact: true })).toBeVisible();
  expect(work).toEqual([]);
});
test('a late sample response cannot overwrite a newer personal file', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/examples/studio-original.mp4', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/en/tools/video-compressor?sample=video');
  await expect(page.getByText('Loading sample file…', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  release();
  await expect(page.getByText('Your selection changed.', { exact: false })).toBeVisible();
  await expect(page.getByText('sample.mp4', { exact: true })).toBeVisible();
  await expect(page.getByText('studio-original.mp4', { exact: true })).toHaveCount(0);
});
test('sample dialogs fit small screens and can be dismissed by keyboard', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/zh/tools/webp-to-jpg');
    await page.getByRole('button', { name: '先看示例效果' }).click();
    const dialog = page.getByRole('dialog', { name: '公开示例预览' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: '加载示例，调整参数' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '加载示例，调整参数' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
});
test('explicit sample submission uses the real upload, processing and download flow', async ({
  page,
}) => {
  test.setTimeout(150000);
  const work = observeWork(page);
  await page.goto('/en/tools/video-compressor?sample=video');
  await expect(page.getByText('studio-original.mp4', { exact: true })).toBeVisible();
  expect(work).toEqual([]);
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/[a-f\d-]+/, { timeout: 65000 });
  await expect(page.getByRole('heading', { name: 'Your video is ready.' })).toBeVisible({
    timeout: 60000,
  });
  expect(work.length).toBeGreaterThan(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download MP4', exact: true }).click();
  expect(await (await download).failure()).toBeNull();
});
