import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
// Two uploads and processing runs are needed by the animation consent scenario.
test.setTimeout(240000);
const scenarios = [
  {
    slug: 'heic-to-jpg',
    file: '.data/fixtures/photo.heic',
    format: 'JPG',
    extension: '.jpg',
    kind: 'image',
  },
  {
    slug: 'webp-to-jpg',
    file: '.data/seo-examples/transparent.webp',
    format: 'JPG',
    extension: '.jpg',
    kind: 'image',
  },
  {
    slug: 'mov-to-mp4',
    file: '.data/conversion-checks/fixtures/video.mov',
    format: 'MP4',
    extension: '.mp4',
    kind: 'video',
  },
  {
    slug: 'm4a-to-mp3',
    file: '.data/conversion-checks/fixtures/audio.m4a',
    format: 'MP3',
    extension: '.mp3',
    kind: 'audio',
  },
];
for (const s of scenarios)
  test(`${s.slug} uses its preset and produces a real download`, async ({ page }) => {
    await page.goto(`/en/tools/${s.slug}`);
    await expect(page.getByRole('combobox', { name: 'Output format', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Output format', exact: true })).toContainText(
      s.format,
    );
    await page.getByRole('tab', { name: 'Advanced conversion', exact: true }).click();
    if (s.kind === 'image') await expect(page.locator('#image-quality')).toHaveValue('85');
    if (s.kind === 'video')
      await expect(page.getByRole('combobox', { name: 'Video codec', exact: true })).toContainText(
        'H264',
      );
    if (s.kind === 'audio')
      await expect(page.getByRole('combobox', { name: 'Bitrate', exact: true })).toContainText(
        '192',
      );
    await page.locator('input[type=file]').setInputFiles(resolve(s.file));
    await page.getByRole('button', { name: /Convert files/ }).click();
    await expect(page).toHaveURL(/\/en\/batches\//, { timeout: 90000 });
    await expect(page.getByText('1 of 1 files completed', { exact: true })).toBeVisible({
      timeout: 90000,
    });
    const batchId = page.url().split('/').pop()!;
    const batch = (await (await page.request.get(`/api/batches/${batchId}`)).json()).batch;
    expect(batch.jobs[0].options.format).toBe(s.format.toLowerCase());
    const download = page.waitForEvent('download');
    await page
      .locator('.file-result')
      .getByRole('button', { name: /^Download / })
      .first()
      .click();
    const result = await download;
    expect(result.suggestedFilename()).toMatch(new RegExp(s.extension.replace('.', '\\.') + '$'));
    expect(await result.failure()).toBeNull();
    const bytes = await readFile((await result.path())!);
    expect(bytes.length).toBeGreaterThan(32);
    if (s.kind === 'image') expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    if (s.kind === 'video') expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
    for (const job of batch.jobs)
      await page.request.delete(`/api/jobs/${job.id}`, {
        headers: { Origin: 'http://127.0.0.1:3000' },
      });
  });
test('format-specific entry rejects other formats and animation needs explicit consent', async ({
  page,
}) => {
  await page.goto('/en/tools/webp-to-jpg');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/photo.jpg'));
  await expect(page.locator('.error-banner[role=alert]')).toContainText('WEBP files only');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/animated.webp'));
  await page.getByRole('tab', { name: 'Advanced conversion', exact: true }).click();
  const firstFrame = page.getByRole('checkbox', { name: 'Convert only the first animation frame' });
  await expect(firstFrame).not.toBeChecked();
  await page.getByRole('button', { name: /Convert files/ }).click();
  await expect(page).toHaveURL(/\/en\/batches\//, { timeout: 90000 });
  await expect(page.getByText(/first[- ]frame|首帧/).first()).toBeVisible({ timeout: 90000 });
  const failed = (
    await (await page.request.get(`/api/batches/${page.url().split('/').pop()}`)).json()
  ).batch;
  expect(failed.jobs[0].error).toBe('ANIMATION_REQUIRES_CHOICE');
  await page.goto('/en/tools/webp-to-jpg');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/animated.webp'));
  await page.getByRole('tab', { name: 'Advanced conversion', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Convert only the first animation frame' }).check();
  await page.getByRole('button', { name: /Convert files/ }).click();
  await expect(page).toHaveURL(/\/en\/batches\//, { timeout: 90000 });
  await expect(page.getByText('1 of 1 files completed', { exact: true })).toBeVisible({
    timeout: 90000,
  });
  const succeeded = (
    await (await page.request.get(`/api/batches/${page.url().split('/').pop()}`)).json()
  ).batch;
  expect(succeeded.jobs[0].options.firstFrame).toBe(true);
  for (const job of [...failed.jobs, ...succeeded.jobs])
    await page.request.delete(`/api/jobs/${job.id}`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
});
