import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { tools } from '../../packages/core/src/catalog';

const balance = { mode: 'shadow', balance: { available: 345, reserved: 0 } };
test('all 19 tool pages show inline cost and remaining credits before starting', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.route('**/api/billing', (route) => route.fulfill({ json: balance }));
  for (const tool of tools) {
    await page.goto(`/zh/tools/${tool.id}`);
    const estimate = page.locator(`.cost-estimate[data-tool="${tool.id}"]`).first();
    await expect(estimate).toBeVisible();
    await expect(estimate).toContainText('预计花费');
    await expect(estimate).toContainText('剩余 345');
    await expect(estimate).toContainText('当前试算，不扣积分');
  }
});

test('local file preview estimates before upload, resets on navigation, and fits mobile', async ({
  page,
}) => {
  let uploads = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/uploads') && r.method() === 'POST') uploads++;
  });
  await page.route('**/api/billing', (route) => route.fulfill({ json: balance }));
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  const estimate = page.locator('.cost-estimate');
  await expect(estimate).toContainText(/≈ \d+ credits/);
  expect(uploads).toBe(0);
  await estimate.getByLabel('About this estimate').click();
  await expect(estimate.getByText('Resource budgets', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(estimate).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/credit-estimate-mobile.png', fullPage: true });
  await page.goto('/en/tools/video-compressor');
  await expect(page.locator('.cost-estimate')).toContainText('Choose a file to estimate');
  await expect(page.locator('.cost-estimate-line')).not.toContainText('≈');
});

test('server estimate handles errors, retry and low balance', async ({ page }) => {
  const asset = '22222222-2222-4222-8222-222222222222';
  let fail = false,
    quoteCalls = 0,
    submits = 0;
  await page.route('**/api/session', (route) => route.fulfill({ json: { signedIn: true } }));
  await page.route('**/api/billing', (route) =>
    route.fulfill({ json: { mode: 'enforced', balance: { available: 5, reserved: 0 } } }),
  );
  await page.route('**/api/uploads', (route) =>
    route.fulfill({ json: { id: asset, partSize: 8388608, state: 'ready', parts: [] } }),
  );
  await page.route('**/api/jobs', (route) => {
    submits++;
    return route.fulfill({ status: 400, json: { error: 'INVALID_REQUEST' } });
  });
  await page.route('**/api/quote', (route) => {
    quoteCalls++;
    if (fail) return route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } });
    return route.fulfill({
      json: {
        id: '11111111-1111-4111-8111-111111111111',
        mode: 'enforced',
        state: 'ready',
        estimatedCredits: 12,
        maximumCredits: 20,
        knownCredits: 12,
        balance: 5,
        currency: 'credits',
        priceVersion: 'test',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        lines: [],
        missingPrices: [],
        stage: 'process',
        warnings: [],
        operation: route.request().postDataJSON().operation,
      },
    });
  });
  await page.goto('/zh/tools/pdf-watermark-remover');
  await page.locator('input[type=file]').setInputFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });
  const estimate = page.locator('.cost-estimate');
  await expect(estimate).toContainText('12 积分');
  await expect(estimate).toContainText('最高 20 积分');
  await expect(estimate).toContainText('积分不足');
  expect(submits).toBe(0);
  fail = true;
  await page.locator('input[type=file]').setInputFiles({
    name: 'another.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.5'),
  });
  // A real upload gets a new asset; reset the page to force a fresh quote with this fixture.
  await page.reload();
  await page.locator('input[type=file]').setInputFiles({
    name: 'another.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.5'),
  });
  await expect(estimate).toContainText('暂时无法估算');
  await expect(estimate).not.toContainText('12 积分');
  fail = false;
  await estimate.getByRole('button', { name: '重试', exact: true }).click();
  await expect(estimate).toContainText('12 积分');
  expect(quoteCalls).toBeGreaterThanOrEqual(3);
  expect(submits).toBe(0);
});

test('a late quote cannot replace the estimate for a newer file; missing AI prices stay partial', async ({
  page,
}) => {
  const first = '22222222-2222-4222-8222-222222222222';
  const second = '33333333-3333-4333-8333-333333333333';
  let uploads = 0,
    firstRequested = false;
  let finishFirst!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  await page.route('**/api/session', (route) => route.fulfill({ json: { signedIn: true } }));
  await page.route('**/api/billing', (route) => route.fulfill({ json: balance }));
  await page.route('**/api/uploads', (route) =>
    route.fulfill({
      json: { id: ++uploads === 1 ? first : second, partSize: 8388608, state: 'ready', parts: [] },
    }),
  );
  await page.route('**/api/quote', async (route) => {
    const operation = route.request().postDataJSON().operation;
    const old = operation.body.assetId === first;
    if (old) {
      firstRequested = true;
      await delayed;
    }
    await route.fulfill({
      json: {
        id: old ? first : second,
        mode: 'shadow',
        state: 'unpriced',
        estimatedCredits: null,
        maximumCredits: null,
        knownCredits: 18,
        balance: 345,
        currency: 'credits',
        priceVersion: 'test',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        missingPrices: ['translation'],
        stage: 'process',
        warnings: [],
        operation,
        lines: [
          {
            label: 'repair',
            meter: 'repair_images',
            quantity: 1,
            maximum: 1,
            rateId: 'repair',
            estimatedMicroCny: old ? 1000000 : 30000,
            maximumMicroCny: null,
            verified: false,
          },
          {
            label: 'translation',
            meter: 'input_tokens',
            quantity: 1000,
            maximum: 2000,
            rateId: 'translation',
            estimatedMicroCny: null,
            maximumMicroCny: null,
            verified: false,
          },
        ],
      },
    });
  });
  await page.goto('/en/tools/pdf-watermark-remover');
  const file = page.locator('input[type=file]');
  await file.setInputFiles({
    name: 'first.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });
  await expect.poll(() => firstRequested).toBe(true);
  await file.setInputFiles({
    name: 'second.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.5'),
  });
  const line = page.locator('.cost-estimate-line');
  await expect(line).toContainText('≈ 18+ credits');
  const firstResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/quote') && r.request().postDataJSON().operation.body.assetId === first,
  );
  finishFirst();
  await firstResponse;
  await expect(line).toContainText('≈ 18+ credits');
  await expect(line).not.toContainText('600');
  await page.locator('.cost-estimate').getByLabel('About this estimate').click();
  await expect(page.locator('.cost-explanation')).toContainText('only part of the cost');
});
