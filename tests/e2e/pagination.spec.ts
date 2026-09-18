import { test, expect } from '@playwright/test';

function pagination(total: number, requested: number) {
  const totalPages = Math.max(1, Math.ceil(total / 10));
  return { page: Math.min(requested, totalPages), pageSize: 10, total, totalPages };
}

test('workspace pages, refresh, failed navigation and last-page deletion', async ({ page }) => {
  let total = 21;
  let fail = false;
  await page.route('**/api/jobs?*', async (route) => {
    if (fail) {
      await route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } });
      return;
    }
    const meta = pagination(total, Number(new URL(route.request().url()).searchParams.get('page')));
    await route.fulfill({
      json: {
        pagination: meta,
        jobs: Array.from({ length: Math.min(10, total - (meta.page - 1) * 10) }, (_, i) => ({
          id: `task-${(meta.page - 1) * 10 + i + 1}`,
          name: `文件 ${(meta.page - 1) * 10 + i + 1}.pdf`,
          tool: 'pdf-compressor',
          state: 'completed',
          createdAt: '2026-09-18T00:00:00Z',
          inputSize: 100,
        })),
      },
    });
  });
  await page.route('**/api/jobs/task-21', async (route) => {
    total--;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/zh/workspace');
  const nav = page.getByRole('navigation', { name: '我的工作台', exact: true });
  await expect(page.locator('.job-row')).toHaveCount(10);
  await expect(nav.getByRole('button', { name: '上一页' })).toBeDisabled();
  await nav.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('.job-row h2').first()).toHaveText('文件 11.pdf');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('2');
  fail = true;
  await nav.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('.error-banner[role=alert]')).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('2');
  await expect(page.locator('.job-row')).toHaveCount(10);
  fail = false;
  await nav.getByRole('button', { name: '3', exact: true }).click();
  await expect(page.locator('.job-row')).toHaveCount(1);
  await expect(nav.getByRole('button', { name: '下一页' })).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除 文件 21.pdf' }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('2');
  await expect(page.locator('.job-row')).toHaveCount(10);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/pagination-workspace-mobile.png', fullPage: true });
});

test('billing pages and receipt selection, compact page numbers on mobile', async ({ page }) => {
  await page.route('**/api/billing?*', async (route) => {
    const meta = pagination(101, Number(new URL(route.request().url()).searchParams.get('page')));
    await route.fulfill({
      json: {
        pagination: meta,
        balance: { available: 0, reserved: 0 },
        operations: Array.from({ length: meta.page === 11 ? 1 : 10 }, (_, i) => ({
          id: `receipt-${(meta.page - 1) * 10 + i + 1}`,
          createdAt: '2026-09-18T00:00:00Z',
          state: 'settled',
          mode: 'shadow',
          chargedCredits: 0,
        })),
      },
    });
  });
  await page.route('**/api/billing/receipts/receipt-101', (route) =>
    route.fulfill({ json: { priceVersion: 'receipt-101', chargedCredits: 0, lines: [] } }),
  );
  await page.goto('/zh/pricing');
  const history = page.locator('.billing-history');
  const nav = history.getByRole('navigation');
  await expect(history.locator('tbody tr')).toHaveCount(10);
  await nav.getByRole('button', { name: '11', exact: true }).click();
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(nav.getByRole('button', { name: '下一页' })).toBeDisabled();
  await history.getByRole('button', { name: '查看账单' }).click();
  await expect(history.locator('.billing-receipt')).toContainText('receipt-101');
  await nav.getByRole('button', { name: '上一页' }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('10');
  await expect(history.locator('.billing-receipt')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/pagination-billing-mobile.png' });
});

test('empty lists omit pagination and invalid page arguments are rejected', async ({ page }) => {
  for (const path of ['jobs', 'billing']) {
    for (const value of ['0', '-1', '1.5', 'abc', '2147483648'])
      expect((await page.request.get(`/api/${path}?page=${value}`)).status()).toBe(400);
  }
  await page.goto('/zh/workspace');
  await expect(page.locator('.empty-state')).toBeVisible();
  await expect(page.locator('.list-pagination')).toHaveCount(0);
  await page.goto('/zh/pricing');
  await expect(page.locator('.billing-history')).toContainText('暂无计费记录');
  await expect(page.locator('.list-pagination')).toHaveCount(0);
});
