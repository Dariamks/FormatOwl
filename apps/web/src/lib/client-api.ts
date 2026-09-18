import { quoteForRequest } from './billing-client';
import { chargeablePath } from '@filemorph/core/billing-model';
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
async function rawRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || 'SERVICE_UNAVAILABLE', response.status);
  return data;
}
export async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  if (method === 'POST' && typeof window !== 'undefined' && chargeablePath(path)) {
    // Cached results need neither a new authorization nor another reservation.
    // The service transaction rolls back if admitting any new work would be needed.
    try {
      return await rawRequest<T>(path, { ...(body as object), billingReuseOnly: true }, method);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'BILLING_NEW_WORK_REQUIRED') throw error;
    }
    const quote = await quoteForRequest(path, body, (p, b) => rawRequest(p, b));
    if (quote === false) throw new ApiError('BILLING_CANCELLED', 409);
    if (quote) body = { ...(body as object), billingQuoteId: quote.id };
  }
  const result = await rawRequest<T>(path, body, method);
  if (method === 'POST' && typeof window !== 'undefined' && chargeablePath(path))
    window.dispatchEvent(new Event('filemorph-balance'));
  return result;
}
export function errorMessage(error: unknown, translate: (key: string) => string) {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : '';
  return translate(code);
}
