import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
export function signSession(id: string, secret: string) {
  return `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`;
}
export function verifySession(token: string | undefined, secret: string) {
  if (!token) return null;
  const [id, mac, ...extra] = token.split('.');
  if (extra.length || !id || !mac || !/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(mac))
    return null;
  const expected = signSession(id, secret).split('.')[1];
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? id : null;
}
export function newSession(secret: string) {
  const id = randomUUID();
  return { owner: `anon:${id}`, token: signSession(id, secret) };
}
