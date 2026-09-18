import { billingRequest } from '@filemorph/core/billing';
import { chargeablePath } from '@filemorph/core/billing-model';
import {
  operationFingerprint,
  parseBillingOperation,
  assertOperationAllowed,
} from '@filemorph/core/billing-quotes';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { newSession, verifySession } from '@filemorph/core/session';
import { sessionSecret } from '@filemorph/core/config';
import { ServiceError } from '@filemorph/core/jobs';
import { getAuth } from './auth';
import { claimGuest, guestWasClaimed } from '@filemorph/core/guest-claims';
import { assertOwnerNotBlocked } from '@filemorph/core/access';
export async function owner() {
  const jar = await cookies(),
    secret = sessionSecret(),
    id = verifySession(jar.get('fm-session')?.value, secret);
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session) {
    if (id) {
      await claimGuest(`anon:${id}`, session.user.id);
      jar.delete('fm-session');
    }
    return `user:${session.user.id}`;
  }
  if (id && !(await guestWasClaimed(`anon:${id}`))) return `anon:${id}`;
  const guest = newSession(secret);
  jar.set('fm-session', guest.token, {
    httpOnly: true,
    secure: new URL(process.env.APP_URL || 'http://localhost:3000').protocol === 'https:',
    sameSite: 'lax',
    maxAge: 30 * 86400,
    path: '/',
  });
  return guest.owner;
}
export async function jsonBody(request: Request, maxBytes = 32768) {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new ServiceError(415, 'JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError(400, 'INVALID_REQUEST');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ServiceError(413, 'REQUEST_TOO_LARGE');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, 'INVALID_REQUEST');
  }
}
export function api(
  handler: (request: Request, path: string[], ownerId: string) => Promise<unknown>,
) {
  return async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
    try {
      if (request.method !== 'GET') {
        const allowed = [new URL(process.env.APP_URL || 'http://localhost:3000').origin];
        if (process.env.NODE_ENV !== 'production')
          allowed.push('http://127.0.0.1:3000', 'http://localhost:3000');
        if (!allowed.includes(request.headers.get('origin') || ''))
          throw new ServiceError(403, 'INVALID_ORIGIN');
      }
      const ownerId = await owner();
      const { path } = await context.params;
      const cleanup =
        request.method === 'DELETE' || (request.method === 'POST' && path.at(-1) === 'cancel');
      if (request.method !== 'GET' && !cleanup) await assertOwnerNotBlocked(ownerId);
      let result: unknown;
      if (request.method === 'POST' && chargeablePath(path.join('/'))) {
        const body = await jsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new ServiceError(400, 'INVALID_REQUEST');
        const { billingQuoteId, billingReuseOnly, ...payload } = body;
        if (billingReuseOnly !== undefined && billingReuseOnly !== true)
          throw new ServiceError(400, 'INVALID_REQUEST');
        if (
          billingQuoteId !== undefined &&
          (typeof billingQuoteId !== 'string' || !/^[a-f0-9-]{36}$/i.test(billingQuoteId))
        )
          throw new ServiceError(400, 'INVALID_REQUEST');
        const operation = parseBillingOperation({ path: path.join('/'), body: payload });
        await assertOperationAllowed(ownerId, operation);
        const hash = billingQuoteId ? await operationFingerprint(ownerId, operation) : '';
        const clean = new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(payload),
        });
        result = await billingRequest.run(
          {
            owner: ownerId,
            quoteId: billingQuoteId,
            reuseOnly: billingReuseOnly === true,
            fingerprint: hash,
          },
          () => handler(clean, path, ownerId),
        );
      } else result = await handler(request, path, ownerId);
      return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof ServiceError)
        return Response.json(
          { error: error.code },
          { status: error.status, headers: { 'Cache-Control': 'no-store' } },
        );
      if (
        error instanceof ZodError ||
        (error instanceof Error && error.name === 'ZodError' && 'issues' in error)
      )
        return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
      console.error('API request failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
    }
  };
}
