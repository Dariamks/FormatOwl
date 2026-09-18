import { chargeablePath, type QuoteView } from '@filemorph/core/billing-model';
export interface BillingConfirmation {
  quote: QuoteView;
  resolve: (accepted: boolean) => void;
}
let confirmation: ((request: BillingConfirmation) => void) | undefined;
export function setBillingConfirmation(handler: typeof confirmation) {
  confirmation = handler;
}
export async function quoteForRequest(
  path: string,
  body: unknown,
  send: (path: string, body?: unknown) => Promise<any>,
) {
  if (!chargeablePath(path)) return null;
  let q: QuoteView = await send('quote', { operation: { path, body: body || {} } });
  const end = Date.now() + 65000;
  while (q.state === 'probing' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 800));
    q = await send(`quotes/${q.id}`);
  }
  window.dispatchEvent(new CustomEvent('filemorph-quote', { detail: q }));
  if (q.mode === 'enforced') {
    if (!confirmation) throw new Error('Billing confirmation unavailable');
    const accepted = await new Promise<boolean>((resolve) => confirmation!({ quote: q, resolve }));
    if (!accepted) return false;
  }
  return q;
}
