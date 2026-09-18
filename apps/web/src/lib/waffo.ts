import { billingPack, billingPackIds, type BillingPackId } from '@filemorph/core/billing-model';
import { ServiceError } from '@filemorph/core/service-error';
import { WaffoPancake } from '@waffo/pancake-ts';
import { randomUUID } from 'node:crypto';

export type WaffoEnvironment = 'test' | 'prod';

const productEnvKeys: Record<BillingPackId, string> = {
  basic: 'WAFFO_PRODUCT_BASIC_ID',
  pro: 'WAFFO_PRODUCT_PRO_ID',
  premium: 'WAFFO_PRODUCT_PREMIUM_ID',
};

export function waffoConfig() {
  const environment: WaffoEnvironment = process.env.WAFFO_ENVIRONMENT === 'prod' ? 'prod' : 'test';
  const products = Object.fromEntries(
    billingPackIds.map((id) => [id, process.env[productEnvKeys[id]]?.trim() || undefined]),
  ) as Record<BillingPackId, string | undefined>;
  return {
    merchantId: process.env.WAFFO_MERCHANT_ID?.trim() || undefined,
    storeId: process.env.WAFFO_STORE_ID?.trim() || undefined,
    privateKey: process.env.WAFFO_PRIVATE_KEY?.trim() || undefined,
    environment,
    products,
  };
}

export function waffoOverview(salesEnabled: boolean) {
  const config = waffoConfig();
  const configured = Boolean(config.merchantId && config.storeId && config.privateKey);
  const testOverride =
    config.environment === 'test' && process.env.WAFFO_TEST_CHECKOUT_ENABLED === 'true';
  return {
    configured,
    enabled: configured && (salesEnabled || testOverride),
    environment: config.environment,
    availablePacks: billingPackIds.filter((id) => Boolean(config.products[id])),
  };
}

function requiredConfig(pack: BillingPackId) {
  const config = waffoConfig();
  const productId = config.products[pack];
  const merchantId = config.merchantId;
  const privateKey = config.privateKey;
  const storeId = config.storeId;
  if (!merchantId || !privateKey || !storeId || !productId)
    throw new ServiceError(503, 'PAYMENT_NOT_CONFIGURED');
  return { ...config, merchantId, privateKey, storeId, productId };
}

export async function createWaffoCheckout(owner: string, packId: BillingPackId) {
  if (!owner.startsWith('user:')) throw new ServiceError(401, 'BILLING_LOGIN_REQUIRED');
  const config = requiredConfig(packId);
  const client = new WaffoPancake({
    merchantId: config.merchantId,
    privateKey: config.privateKey,
  });
  const session = await client.checkout.createSession({
    productId: config.productId,
    currency: 'USD',
    successUrl: new URL(
      '/zh/pricing?payment=success',
      process.env.APP_URL || 'http://127.0.0.1:3000',
    ).toString(),
    metadata: { owner, pack: packId },
    orderMerchantExternalId: `formatowl-${packId}-${randomUUID()}`,
  });
  return { ...session, pack: billingPack(packId) };
}

export function waffoStoreId() {
  return waffoConfig().storeId;
}
