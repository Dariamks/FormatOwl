import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
test('credit pricing, closed sales, all tool rules and mobile layout', async ({ page }) => {
  await page.goto('/zh/pricing');
  await expect(page.getByRole('heading', { name: '按实际用量，清楚地付费。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '充值尚未开放' })).toHaveCount(3);
  for (const b of await page.getByRole('button', { name: '充值尚未开放' }).all())
    await expect(b).toBeDisabled();
  await expect(page.locator('.pack-price')).toHaveText(['$0', '$9', '$29', '$59']);
  await expect(page.locator('.credit-pack.featured .pack-price')).toHaveText('$29');
  await expect(page.getByRole('link', { name: '开始体验' })).toHaveAttribute(
    'href',
    '/zh#examples',
  );
  for (const credits of ['900 积分', '2,900 积分', '5,900 积分'])
    await expect(page.getByText(credits, { exact: true })).toBeVisible();
  const overview = await (await page.request.get('/api/billing')).json();
  expect(overview.packs.map((pack: { credits: number }) => pack.credits)).toEqual([
    900, 2900, 5900,
  ]);
  await expect(page.getByRole('cell', { name: '音视频转文字', exact: true })).toBeVisible();
  await expect(page.locator('.pricing-rules').first().locator('tbody tr')).toHaveCount(20);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/billing-pricing-mobile.png', fullPage: true });
});
test('real upload and compression creates an owner-scoped uncharged receipt', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto('/en/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  await page.getByRole('button', { name: 'Compress video', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/[a-f\d-]+/, { timeout: 65000 });
  await expect(page.getByRole('heading', { name: 'Your video is ready.' })).toBeVisible({
    timeout: 60000,
  });
  const result = await page.request.get('/api/billing');
  expect(result.ok()).toBeTruthy();
  const data = await result.json();
  expect(data.mode).toBe('shadow');
  expect(data.balance.available).toBe(0);
  expect(data.balance.reserved).toBe(0);
  expect(data.operations.length).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/billing/receipts/${data.operations[0].id}`);
        return (await r.json()).state;
      },
      { timeout: 45000 },
    )
    .toBe('settled');
  const receipt = await (
    await page.request.get(`/api/billing/receipts/${data.operations[0].id}`)
  ).json();
  expect(receipt.chargedCredits).toBe(0);
  expect(receipt.lines.some((l: any) => l.meter === 'runtime_ms' && l.quantity > 0)).toBeTruthy();
  await page.goto('/en/pricing');
  await page.getByRole('button', { name: 'View receipt' }).first().click();
  await expect(page.getByRole('heading', { name: 'Itemized usage' })).toBeVisible();
});
test('paid quote requires explicit confirmation and cancel never submits work', async ({
  page,
}) => {
  // UI contract test only: real transaction economics are exercised in the isolated PostgreSQL test.
  let submits = 0;
  // This test isolates the consent UI; the preceding test exercises the real upload.
  await page.route('**/api/session', (route) => route.fulfill({ json: { signedIn: true } }));
  await page.route('**/api/uploads', (route) =>
    route.fulfill({
      json: {
        id: '22222222-2222-4222-8222-222222222222',
        partSize: 8388608,
        state: 'ready',
        parts: [],
      },
    }),
  );
  await page.route('**/api/quote', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        id: '11111111-1111-4111-8111-111111111111',
        mode: 'enforced',
        state: 'ready',
        estimatedCredits: 80,
        maximumCredits: 100,
        knownCredits: 80,
        currency: 'credits',
        priceVersion: 'ui-test',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        balance: 2000,
        lines: [],
        missingPrices: [],
        stage: 'process',
        warnings: [],
        operation: body.operation,
      },
    });
  });
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      if (route.request().postDataJSON().billingReuseOnly) {
        await route.fulfill({ status: 409, json: { error: 'BILLING_NEW_WORK_REQUIRED' } });
        return;
      }
      submits++;
      await route.fulfill({ status: 409, json: { error: 'QUOTE_EXPIRED' } });
    } else await route.continue();
  });
  await page.goto('/zh/tools/video-compressor');
  await page.locator('input[type=file]').setInputFiles(resolve('.data/fixtures/sample.mp4'));
  await page.getByRole('button', { name: '开始压缩', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认积分费用' })).toBeVisible({ timeout: 65000 });
  await expect(page.getByText('预计消耗 80 积分', { exact: true })).toBeVisible();
  await expect(page.getByText('最多扣除 100 积分', { exact: false })).toBeVisible();
  expect(submits).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认积分费用' })).not.toBeVisible();
  expect(submits).toBe(0);
  await page.getByRole('button', { name: '开始压缩', exact: true }).click();
  await page.getByRole('button', { name: '确认并开始', exact: true }).click();
  await expect.poll(() => submits).toBe(1);
  await expect(page.getByText('报价已过期，请重新获取报价。')).toBeVisible();
});
