import { test, expect, request as apiRequest } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { sqlClient } from '@filemorph/core/db';
import { initialPriceBook } from '@filemorph/core/billing-model';
process.loadEnvFile('.env');
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { hashPassword } = await import(webRequire.resolve('better-auth/crypto'));
const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const headers = { Origin: origin };
const userId = randomUUID(),
  owner = `user:${userId}`,
  email = `admin-test-${userId}@example.test`;
const password = `Test passphrase ${randomUUID()}`;
const assetId = randomUUID(),
  jobId = randomUUID(),
  operationId = randomUUID();
const toolsToRestore = ['image-converter', 'video-converter', 'audio-converter', 'video-to-mp3'];
let originalTools: { tool_id: string; published: boolean }[] = [];
const credentials = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
};

test.beforeAll(async () => {
  if (
    !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL!).hostname) ||
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)
  )
    throw new Error('Admin browser tests are local-only');
  const sql = sqlClient();
  originalTools =
    await sql`select tool_id,published from tool_visibility where tool_id in ${sql(toolsToRestore)}`;
  await sql`insert into auth_users(id,name,email,email_verified) values(${userId},'后台测试用户',${email},true)`;
  await sql`insert into auth_accounts(id,account_id,provider_id,user_id,password) values(${randomUUID()},${userId},'credential',${userId},${await hashPassword(password)})`;
  await sql`insert into assets(id,owner,key,name,mime,size,state,expires_at) values(${assetId},${owner},${`admin-test/${assetId}`},'管理后台测试.png','image/png',100,'ready',now()+interval '1 day')`;
  await sql`insert into jobs(id,owner,request_id,asset_id,tool,state,options,expires_at) values(${jobId},${owner},${randomUUID()},${assetId},'image-converter','completed','{"format":"png"}',now()+interval '1 day')`;
  await sql`insert into billing_operations(id,owner,mode,state,price_book) values(${operationId},${owner},'shadow','settled',${sql.json(initialPriceBook as any)})`;
  await sql`insert into billing_targets(key,operation_id,kind,target_id,state) values(${`job:${jobId}:1`},${operationId},'job',${jobId},'completed')`;
  await sql`insert into cost_usage(id,operation_id,target_key,event_key,meter,stage,quantity,cost_micro_cny,state) values(${randomUUID()},${operationId},${`job:${jobId}:1`},${`admin-test:${jobId}`},'runtime_ms','job',100,1000,'settled')`;
});
test.afterAll(async () => {
  const sql = sqlClient();
  for (const tool of originalTools)
    await sql`update tool_visibility set published=${tool.published} where tool_id=${tool.tool_id}`;
  await sql`delete from cost_usage where operation_id=${operationId}`;
  await sql`delete from credit_ledger where owner=${owner}`;
  await sql`delete from billing_targets where operation_id=${operationId}`;
  await sql`delete from billing_operations where id=${operationId}`;
  await sql`delete from jobs where id=${jobId}`;
  await sql`delete from assets where id=${assetId}`;
  await sql`delete from credit_accounts where owner=${owner}`;
  await sql`delete from auth_users where id=${userId}`;
  await sql.end();
});
test.afterEach(async ({ page }) => {
  await page.request.post('/api/admin/logout', { headers, data: {} });
});
async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin/login');
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '登录后台' }).click();
  await expect(page.getByRole('heading', { name: '管理控制台' })).toBeVisible();
  await expect(page.getByRole('button', { name: '工具管理 19' })).toBeVisible();
}
test('admin isolation, invalid credentials, CSRF, expiry and logout', async ({ page, request }) => {
  for (const path of ['overview', 'users', 'tools', 'session', `users/${userId}`])
    expect((await request.get(`/api/admin/${path}`)).status()).toBe(401);
  await page.goto(`/admin/users/${userId}`);
  await expect(page).toHaveURL('/admin/login');
  expect(
    (
      await request.post('/api/admin/login', {
        headers: { Origin: 'https://example.invalid' },
        data: credentials,
      })
    ).status(),
  ).toBe(403);
  expect((await request.post('/api/admin/login', { data: credentials })).status()).toBe(403);
  expect(
    (
      await request.post('/api/admin/login', {
        headers,
        data: { ...credentials, password: 'wrong' },
      })
    ).status(),
  ).toBe(401);
  await login(page);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'fm-admin-session')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await page.request.get('/api/auth/get-session')).status()).toBe(200);
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();
  expect(
    (
      await page.request.patch('/api/admin/tools/image-converter', {
        headers: { Origin: 'https://example.invalid' },
        data: { published: false },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post(`/api/admin/users/${userId}/recharge`, {
        headers,
        data: { receipt: 'invalid', credits: 1.5, amountCny: 1 },
      })
    ).status(),
  ).toBe(400);
  const sql = sqlClient();
  const { createHmac } = await import('node:crypto');
  const hash = createHmac(
    'sha256',
    process.env.ADMIN_SESSION_SECRET || process.env.BETTER_AUTH_SECRET!,
  )
    .update(`${credentials.username}:${credentials.password}:${cookie.value}`)
    .digest('hex');
  await sql`update admin_sessions set expires_at=now()-interval '1 second' where token_hash=${hash}`;
  expect((await page.request.get('/api/admin/users')).status()).toBe(401);
  await login(page);
  const activeCookie = (await page.context().cookies()).find((c) => c.name === 'fm-admin-session')!;
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/admin/login');
  expect(
    (
      await request.get('/api/admin/users', {
        headers: { Cookie: `fm-admin-session=${activeCookie.value}` },
      })
    ).status(),
  ).toBe(401);
});
test('user detail, atomic recharge, ban and restore existing user sessions', async ({ page }) => {
  await login(page);
  await page.getByRole('textbox', { name: '搜索用户' }).fill(email);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: email })).toHaveCount(1);
  await page
    .getByRole('row')
    .filter({ hasText: email })
    .getByRole('link', { name: '查看详情' })
    .click();
  await expect(page.getByRole('heading', { name: '后台测试用户' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '管理后台测试.png', exact: false })).toBeVisible();
  const receipt = `browser-${randomUUID()}`;
  await page.getByLabel('充值金额（元）').fill('5');
  await page.getByLabel('到账积分', { exact: true }).fill('500');
  await page.getByLabel('凭证编号').fill(receipt);
  await page.getByLabel('充值备注').fill('本地自动化验证');
  await page.getByRole('button', { name: '确认充值' }).click();
  await expect(page.getByRole('status')).toContainText('充值已入账');
  const repeats = await Promise.all(
    Array.from({ length: 4 }, () =>
      page.request.post(`/api/admin/users/${userId}/recharge`, {
        headers,
        data: { receipt, amountCny: 5, credits: 500, note: '本地自动化验证' },
      }),
    ),
  );
  expect(repeats.map((r) => r.status())).toEqual([200, 200, 200, 200]);
  const detail = await (await page.request.get(`/api/admin/users/${userId}`)).json();
  expect(detail.user.available).toBe(500);
  expect(detail.recharges).toHaveLength(1);
  expect(detail.ledger).toHaveLength(1);
  await page.getByRole('button', { name: '充值记录', exact: true }).click();
  await expect(page.getByRole('cell', { name: receipt, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '用量明细', exact: true }).click();
  await expect(page.getByRole('cell', { name: '¥0.001000', exact: true })).toBeVisible();
  const user = await apiRequest.newContext({ baseURL: origin });
  try {
    expect(
      (await user.post('/api/auth/sign-in/email', { headers, data: { email, password } })).status(),
    ).toBe(200);
    expect((await user.get('/api/admin/overview')).status()).toBe(401);
    await page.getByLabel('封禁原因（选填）').fill('测试封禁');
    await page.getByRole('button', { name: '封禁用户', exact: true }).click();
    await expect(page.getByRole('button', { name: '恢复使用' })).toBeVisible();
    for (const path of [
      'uploads',
      'jobs',
      'batches',
      `assets/${assetId}/prepare`,
      `jobs/${jobId}/retry`,
      `jobs/${jobId}/transcript/exports`,
    ]) {
      const response = await user.post(`/api/${path}`, { headers, data: {} });
      expect(response.status(), path).toBe(403);
      expect((await response.json()).error).toBe('USER_BLOCKED');
    }
    expect((await user.get(`/api/jobs/${jobId}`)).status()).toBe(200);
    expect((await user.get('/api/billing')).status()).toBe(200);
    await page.screenshot({ path: '.data/admin-user-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '恢复使用' }).click();
    await expect(page.getByRole('status')).toContainText('用户已恢复使用');
    expect((await user.post('/api/jobs', { headers, data: {} })).status()).toBe(400);
  } finally {
    await user.dispose();
  }
});
test('tool unpublishing hides cards, aliases, pricing, related links and rejects APIs', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: '工具管理 19' }).click();
  const row = page.getByRole('row').filter({ hasText: 'image-converter' });
  await row.getByRole('button', { name: '下架', exact: true }).click();
  await expect(row).toContainText('已下架');
  await page.screenshot({ path: '.data/admin-tools-desktop.png', fullPage: true });
  try {
    const publicPage = await page.context().newPage();
    await publicPage.goto('/zh');
    await expect(
      publicPage.locator(
        'a[href*="/tools/image-converter"],a[href*="/tools/heic-to-jpg"],a[href*="/tools/webp-to-jpg"]',
      ),
    ).toHaveCount(0);
    for (const slug of ['image-converter', 'heic-to-jpg', 'webp-to-jpg'])
      expect(
        (
          await publicPage.request.get(`/zh/tools/${slug}`, {
            headers: { 'user-agent': 'Googlebot' },
          })
        ).status(),
      ).toBe(404);
    await publicPage.goto('/zh/convert');
    await expect(
      publicPage.locator(
        'a[href*="/tools/image-converter"],a[href*="/tools/heic-to-jpg"],a[href*="/tools/webp-to-jpg"]',
      ),
    ).toHaveCount(0);
    await publicPage.goto('/zh/pricing');
    await expect(publicPage.getByRole('row').filter({ hasText: '图片格式转换' })).toHaveCount(0);
    await publicPage.goto('/zh/tools/image-compressor');
    await expect(
      publicPage.locator(
        'a[href*="/tools/image-converter"],a[href*="/tools/heic-to-jpg"],a[href*="/tools/webp-to-jpg"]',
      ),
    ).toHaveCount(0);
    await publicPage.goto('/zh/guide/webp-to-jpg-transparency');
    await expect(
      publicPage.locator('a[href*="/tools/image-converter"],a[href*="/tools/webp-to-jpg"]'),
    ).toHaveCount(0);
    const user = await apiRequest.newContext({ baseURL: origin });
    try {
      await user.post('/api/auth/sign-in/email', { headers, data: { email, password } });
      const operation = {
        tool: 'image-converter',
        options: { format: 'png' },
        assetId,
        requestId: randomUUID(),
      };
      for (const [path, data] of [
        ['jobs', operation],
        ['quote', { operation: { path: 'jobs', body: operation } }],
        [`jobs/${jobId}/retry`, {}],
      ] as const) {
        const response = await user.post(`/api/${path}`, { headers, data });
        expect(response.status(), path).toBe(404);
        expect((await response.json()).error).toBe('TOOL_UNPUBLISHED');
      }
    } finally {
      await user.dispose();
    }
    for (const tool of toolsToRestore)
      await page.request.patch(`/api/admin/tools/${tool}`, { headers, data: { published: false } });
    expect(
      (
        await publicPage.request.get('/zh/convert', { headers: { 'user-agent': 'Googlebot' } })
      ).status(),
    ).toBe(404);
    const xml = await (await publicPage.request.get('/sitemap.xml')).text();
    expect(xml).not.toContain('/tools/image-converter');
    expect(xml).not.toContain('/tools/heic-to-jpg');
    expect(xml).not.toContain('/zh/convert');
    await publicPage.close();
  } finally {
    for (const tool of originalTools)
      await page.request.patch(`/api/admin/tools/${tool.tool_id}`, {
        headers,
        data: { published: tool.published },
      });
  }
  expect(
    (
      await page.request.get('/zh/tools/image-converter', {
        headers: { 'user-agent': 'Googlebot' },
      })
    ).status(),
  ).toBe(200);
});
test('mobile console and user detail fit viewport without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.data/admin-mobile.png', fullPage: true });
  await page.goto(`/admin/users/${userId}`);
  await expect(page.getByRole('heading', { name: '后台测试用户' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.data/admin-user-mobile.png', fullPage: true });
});
