import { billingPack, isBillingPackId, type BillingPackId } from '@filemorph/core/billing-model';
import { grantCredits } from '@filemorph/core/billing';
import { verifyWebhook, WebhookEventType, type WebhookEventData } from '@waffo/pancake-ts';
import { waffoConfig } from '@/lib/waffo';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const config = waffoConfig();
  const signature = request.headers.get('x-waffo-signature');

  let event;
  try {
    event = verifyWebhook<WebhookEventData>(rawBody, signature, {
      environment: config.environment,
    });
  } catch {
    return new Response('Invalid signature', { status: 401 });
  }

  if (!config.storeId || event.storeId !== config.storeId || event.mode !== config.environment)
    return new Response('Invalid store or environment', { status: 400 });
  if (event.eventType !== WebhookEventType.OrderCompleted) return new Response('OK');

  const metadata = event.data.orderMetadata;
  const owner = metadata?.owner;
  const packId = metadata?.pack;
  if (!owner?.startsWith('user:') || !isBillingPackId(packId))
    return new Response('Invalid order metadata', { status: 400 });
  if (event.data.currency !== 'USD') return new Response('Unsupported currency', { status: 400 });

  const pack = billingPack(packId as BillingPackId);
  await grantCredits(
    owner,
    pack.credits,
    `waffo:${event.mode}:${event.eventId}`,
    `Waffo Pancake ${pack.id} credit pack (${event.data.orderId})`,
  );
  return Response.json({ received: true });
}
