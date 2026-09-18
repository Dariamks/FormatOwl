import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { db, eq, sql, lt } from '@filemorph/core/db';
import { adminSessions } from '@filemorph/core/schema';
import { ServiceError } from '@filemorph/core/service-error';

const cookieName = 'fm-admin-session';
const sessionHours = 12;

function username() {
  return process.env.ADMIN_USERNAME || 'admin';
}

function password() {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

function secret() {
  const value = process.env.ADMIN_SESSION_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!value || value.length < 32)
    throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters');
  return value;
}

function hashToken(token: string) {
  return createHmac('sha256', secret())
    .update(`${username()}:${password()}:${token}`)
    .digest('hex');
}

export function checkAdminCredentials(inputUsername: string, inputPassword: string) {
  const hash = (value: string) => createHmac('sha256', secret()).update(value).digest();
  const nameMatches = timingSafeEqual(hash(inputUsername), hash(username()));
  const passwordMatches = timingSafeEqual(hash(inputPassword), hash(password()));
  return nameMatches && passwordMatches;
}

export async function createAdminSession() {
  await destroyAdminSession();
  await db().delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);
  await db()
    .insert(adminSessions)
    .values({
      tokenHash: hashToken(token),
      username: username(),
      expiresAt,
    });
  const jar = await cookies();
  jar.set(cookieName, token, {
    httpOnly: true,
    secure: new URL(process.env.APP_URL || 'http://localhost:3000').protocol === 'https:',
    sameSite: 'strict',
    expires: expiresAt,
    path: '/',
  });
  return { username: username(), expiresAt };
}

export async function getAdminSession() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [session] = await db()
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, hashToken(token)));
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await db().delete(adminSessions).where(eq(adminSessions.tokenHash, session.tokenHash));
    return null;
  }
  return { username: session.username, expiresAt: session.expiresAt };
}

export async function requireAdminSession() {
  const session = await getAdminSession();
  if (!session) throw new ServiceError(401, 'ADMIN_REQUIRED');
  return session;
}

export async function destroyAdminSession() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token)
    await db()
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashToken(token)));
  jar.delete(cookieName);
}

/** Atomic database counter shared by every web process; never trusts forwarded IP headers. */
export async function limitAdminLogin() {
  const window = Math.floor(Date.now() / 60000);
  const [row] = await db().execute(sql`
    insert into auth_rate_limits(id, key, count, last_request)
    values('admin-login', 'admin-login', 1, ${window})
    on conflict(key) do update set
      count = case when auth_rate_limits.last_request = ${window} then auth_rate_limits.count + 1 else 1 end,
      last_request = ${window}
    returning count
  `);
  if (Number(row.count) > 10) throw new ServiceError(429, 'ADMIN_RATE_LIMITED');
}
