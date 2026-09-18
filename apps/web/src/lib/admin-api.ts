import { ZodError } from 'zod';
import { ServiceError } from '@filemorph/core/service-error';
import { requireAdminSession } from './admin-auth';
import { jsonBody } from './api';
import { authBaseURL } from './auth-config';

export function assertAdminOrigin(request: Request) {
  if (request.method === 'GET') return;
  const allowed = [authBaseURL()];
  if (process.env.NODE_ENV !== 'production')
    allowed.push('http://localhost:3000', 'http://127.0.0.1:3000');
  if (!allowed.includes(request.headers.get('origin') || ''))
    throw new ServiceError(403, 'INVALID_ORIGIN');
}
export function adminResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
export function adminError(error: unknown) {
  if (error instanceof ServiceError) return adminResponse({ error: error.code }, error.status);
  if (error instanceof ZodError) return adminResponse({ error: 'INVALID_REQUEST' }, 400);
  console.error('Admin request failed', error instanceof Error ? error.name : 'UnknownError');
  return adminResponse({ error: 'SERVICE_UNAVAILABLE' }, 503);
}
export function adminApi(
  handler: (request: Request, path: string[], admin: { username: string }) => Promise<unknown>,
) {
  return async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
    try {
      assertAdminOrigin(request);
      const admin = await requireAdminSession();
      return adminResponse(await handler(request, (await context.params).path, admin));
    } catch (error) {
      return adminError(error);
    }
  };
}
export const adminJsonBody = jsonBody;
