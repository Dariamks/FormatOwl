import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sqlClient } from '@filemorph/core/db';
import { createUpload } from '@filemorph/core/uploads';

process.loadEnvFile('.env');
const origin = 'http://127.0.0.1:3000';
const mailbox = resolve('.data/auth-mail');
const emails: string[] = [],
  mailFiles = new Set<string>();
const fixtures: {
  asset: string;
  job: string;
  batch: string;
  preparation: string;
  owner: string;
}[] = [];
const password = 'FormatOwl test passphrase 42!';
const newPassword = 'A fresh FormatOwl passphrase 73!';
const headers = { Origin: origin, 'x-filemorph-locale': 'zh' };
function emailAddress() {
  const email = `auth-${randomUUID()}@example.test`;
  emails.push(email);
  return email;
}
async function mail(to: string, kind: 'verify' | 'reset') {
  let found: { url: string; subject: string } | undefined;
  await expect
    .poll(async () => {
      for (const filename of (await readdir(mailbox).catch(() => [])).sort().reverse()) {
        const path = resolve(mailbox, filename);
        const message = JSON.parse(await readFile(path, 'utf8'));
        if (message.to === to && message.kind === kind) {
          mailFiles.add(path);
          found = message;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found!;
}
async function post(context: APIRequestContext, path: string, data: unknown) {
  return context.post(`/api/auth/${path}`, { data, headers });
}
async function createVerified(context: APIRequestContext) {
  const email = emailAddress();
  const response = await post(context, 'sign-up/email', {
    email,
    password,
    name: 'Auth test',
    callbackURL: '/zh/login?verified=1',
  });
  expect(response.status()).toBe(200);
  const message = await mail(email, 'verify');
  expect((await context.get(message.url, { maxRedirects: 0 })).status()).toBe(302);
  expect(await (await context.get('/api/auth/get-session')).json()).toBeNull();
  return email;
}
test.beforeAll(() => {
  if (process.env.AUTH_EMAIL_MODE !== 'local' || process.env.BETTER_AUTH_URL !== origin)
    throw new Error(
      'Auth tests require local mail and BETTER_AUTH_URL=http://127.0.0.1:3000; no live email is sent.',
    );
});
test.afterAll(async () => {
  const sql = sqlClient();
  for (const item of fixtures) {
    await sql`delete from preparations where id=${item.preparation}`;
    await sql`delete from jobs where id=${item.job}`;
    await sql`delete from batches where id=${item.batch}`;
    await sql`delete from assets where id=${item.asset}`;
    await sql`delete from guest_claims where owner=${item.owner}`;
  }
  for (const email of emails) {
    // Only accounts created by this run.
    await sql`delete from auth_users where email=${email}`;
  }
  for (const path of mailFiles) await unlink(path).catch(() => {});
  await sql.end();
});

test('register, require email verification, sign in, reset password and revoke every session', async ({
  page,
}) => {
  const email = emailAddress();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/zh');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录', exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: '.data/auth-login-desktop.png' });
  await page.getByRole('button', { name: '注册账户', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '创建你的账户' })).toBeVisible();
  await dialog.getByLabel('电子邮箱', { exact: true }).fill(email);
  await dialog.getByLabel('密码', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(dialog.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '请查看你的邮箱' })).toBeVisible();
  const verification = await mail(email, 'verify');
  expect(verification.subject).toContain('验证');
  const beforeVerify = await post(page.request, 'sign-in/email', { email, password });
  expect(beforeVerify.status()).toBe(403);
  expect((await beforeVerify.json()).code).toBe('EMAIL_NOT_VERIFIED');
  await page.goto(verification.url);
  await expect(page.getByRole('status')).toContainText('邮箱验证成功');
  await page.getByLabel('电子邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '使用邮箱登录', exact: true }).click();
  await expect(page).toHaveURL('/zh');
  await expect(page.getByRole('button', { name: '你的账户', exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '你的账户', exact: true })).toBeVisible({
    timeout: 60000,
  });
  const otherSession = await apiRequest.newContext({ baseURL: origin });
  expect((await post(otherSession, 'sign-in/email', { email, password })).ok()).toBe(true);
  const [{ password: storedPassword }] =
    await sqlClient()`select a.password from auth_accounts a join auth_users u on u.id=a.user_id where u.email=${email}`;
  expect(storedPassword).not.toBe(password);
  await page.getByRole('button', { name: '你的账户', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL('/zh');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  await page.getByLabel('电子邮箱', { exact: true }).fill(email);
  await page.getByRole('button', { name: '发送重置链接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('重置密码邮件');
  const reset = await mail(email, 'reset');
  await page.goto(reset.url);
  const resetToken = new URL(page.url()).searchParams.get('token');
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '保存新密码', exact: true }).click();
  await expect(page.locator('.auth-error')).toContainText('不一致');
  await page.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '保存新密码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已更新');
  expect(await (await otherSession.get('/api/auth/get-session')).json()).toBeNull();
  expect((await post(otherSession, 'sign-in/email', { email, password })).status()).toBe(401);
  expect(
    (await post(otherSession, 'reset-password', { token: resetToken, newPassword: password })).ok(),
  ).toBe(false);
  await page.getByLabel('电子邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '使用邮箱登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '你的账户', exact: true })).toBeVisible({
    timeout: 60000,
  });
  const cookie = (await page.context().cookies()).find((c) => c.name === 'filemorph.session_token');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  await otherSession.dispose();
  expect(errors).toEqual([]);
});

test('guest work transfers once; logout, another account and stale requests cannot access it', async ({
  request,
}) => {
  await request.get('/api/session');
  const guestState = await request.storageState();
  const guestCookie = guestState.cookies.find((c) => c.name === 'fm-session')!;
  const owner = `anon:${guestCookie.value.split('.')[0]}`;
  const item = {
    asset: randomUUID(),
    job: randomUUID(),
    batch: randomUUID(),
    preparation: randomUUID(),
    owner,
  };
  fixtures.push(item);
  const sql = sqlClient();
  await sql`insert into assets(id,owner,key,name,mime,size,state,expires_at) values(${item.asset},${owner},${`auth-test/${item.asset}`},'auth-test.mp4','video/mp4',1,'ready',now()+interval '1 hour')`;
  await sql`insert into batches(id,owner,request_id,tool,asset_ids,options,expires_at) values(${item.batch},${owner},${randomUUID()},'audio-compressor',${sql.json([item.asset])},'{}',now()+interval '1 hour')`;
  await sql`insert into jobs(id,owner,request_id,asset_id,batch_id,state,options,expires_at) values(${item.job},${owner},${randomUUID()},${item.asset},${item.batch},'cancelled','{}',now()+interval '1 hour')`;
  await sql`insert into preparations(id,owner,asset_id,profile,state,expires_at) values(${item.preparation},${owner},${item.asset},'audio','failed',now()+interval '1 hour')`;
  const email = await createVerified(request);
  expect((await post(request, 'sign-in/email', { email, password })).ok()).toBe(true);
  const session = await (await request.get('/api/auth/get-session')).json();
  await Promise.all([request.get('/api/session'), request.get('/api/jobs')]);
  for (const [table, id] of [
    ['assets', item.asset],
    ['jobs', item.job],
    ['batches', item.batch],
    ['preparations', item.preparation],
  ]) {
    const [row] = await sql`select owner from ${sql(table)} where id=${id}`;
    expect(row.owner).toBe(`user:${session.user.id}`);
  }
  expect((await request.get(`/api/jobs/${item.job}`)).status()).toBe(200);
  await expect(createUpload(owner, 'auth-test.png', 1)).rejects.toMatchObject({
    code: 'AUTH_EXPIRED',
  });
  const oldSession = await request.storageState();
  await post(request, 'sign-out', {});
  expect((await request.get(`/api/jobs/${item.job}`)).status()).toBe(404);
  const replay = await apiRequest.newContext({ baseURL: origin, storageState: oldSession });
  expect(await (await replay.get('/api/auth/get-session')).json()).toBeNull();
  expect((await replay.get(`/api/jobs/${item.job}`)).status()).toBe(404);
  await replay.dispose();
  const second = await apiRequest.newContext({ baseURL: origin, storageState: guestState });
  expect((await second.get(`/api/assets/${item.asset}`)).status()).toBe(404);
  const secondEmail = await createVerified(second);
  expect((await post(second, 'sign-in/email', { email: secondEmail, password })).ok()).toBe(true);
  // Explicitly replay the consumed guest cookie alongside another valid account session.
  await second.get('/api/session', {
    headers: {
      Cookie: [
        ...(await second.storageState()).cookies.map((c) => `${c.name}=${c.value}`),
        `fm-session=${guestCookie.value}`,
      ].join('; '),
    },
  });
  expect((await second.get(`/api/jobs/${item.job}`)).status()).toBe(404);
  const [afterReplay] = await sql`select owner from assets where id=${item.asset}`;
  expect(afterReplay.owner).toBe(`user:${session.user.id}`);
  await second.dispose();
});

test('mobile dialog, keyboard dismissal, English and invalid reset recovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.screenshot({ path: '.data/auth-signup-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeFocused();
  await page.goto('/en/reset-password?error=INVALID_TOKEN');
  await expect(page.locator('.auth-error')).toContainText('invalid or has expired');
  await expect(page.getByRole('button', { name: 'Save new password' })).toBeDisabled();
  await page.getByRole('button', { name: 'Request a new link' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
});

test('reject cross-site requests, unsafe redirects, short passwords and invalid tokens', async ({
  request,
}) => {
  const crossSite = await request.post('/api/auth/sign-up/email', {
    headers: { Origin: 'https://attacker.invalid' },
    data: { name: 'Attack', email: emailAddress(), password },
  });
  expect(crossSite.status()).toBe(403);
  const redirect = await post(request, 'sign-up/email', {
    email: emailAddress(),
    name: 'Redirect',
    password,
    callbackURL: 'https://attacker.invalid',
  });
  expect(redirect.status()).toBe(403);
  const short = await post(request, 'sign-up/email', {
    email: emailAddress(),
    name: 'Short',
    password: 'short',
  });
  expect(short.status()).toBe(400);
  expect(
    (await post(request, 'reset-password', { token: 'invalid-test-token', newPassword })).ok(),
  ).toBe(false);
  const rateContext = await apiRequest.newContext({
    baseURL: origin,
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${randomInt(1, 255)}.${randomInt(1, 255)}` },
  });
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const result = await post(rateContext, 'sign-in/email', {
      email: 'rate-test@example.test',
      password,
    });
    if (result.status() === 429) {
      expect(Number(result.headers()['x-retry-after'])).toBeGreaterThan(0);
      limited = true;
      break;
    }
  }
  expect(limited).toBe(true);
  await rateContext.dispose();
  await request.dispose();
});
