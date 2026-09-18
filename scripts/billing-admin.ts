import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, eq, sqlClient } from '@filemorph/core/db';
import {
  billingPriceBooks,
  billingSettings,
  costUsage,
  billingTargets,
} from '@filemorph/core/schema';
import { billingConfig, grantCredits, finishBillingTarget } from '@filemorph/core/billing';
import { initialPriceBook, billingDefaults, type PriceBook } from '@filemorph/core/billing-model';
import { completeUsage } from '@filemorph/core/billing-usage';
import { costReport } from '@filemorph/core/billing-report';
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'report') {
    const report = await costReport(args[0]);
    await mkdir('.data/billing', { recursive: true });
    const path = resolve(`.data/billing/${report.month}.json`);
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(path);
    console.log(
      JSON.stringify(
        {
          revenueCny: report.revenueCny,
          knownVariableCostCny: report.knownVariableCostCny,
          unverifiedEvents: report.unverifiedEvents,
          provisionalProfitCny: report.provisionalProfitCny,
        },
        null,
        2,
      ),
    );
  } else if (command === 'grant') {
    const [owner, amount, receiptId, ...note] = args;
    await grantCredits(owner, Number(amount), receiptId, note.join(' '));
    console.log('Credit grant recorded idempotently. This does not verify a payment.');
  } else if (command === 'price-template') {
    console.log(JSON.stringify(initialPriceBook, null, 2));
  } else if (command === 'publish-prices') {
    const schema = z
      .object({
        version: z.string().min(1).max(100),
        effectiveAt: z.string().datetime(),
        rates: z
          .array(
            z
              .object({
                id: z.string().min(1),
                meter: z.enum([
                  'runtime_ms',
                  'storage_gib_day',
                  'storage_read',
                  'storage_write',
                  'transfer_gib',
                  'asr_seconds',
                  'input_tokens',
                  'output_tokens',
                  'repair_images',
                ]),
                cnyPerUnit: z.number().finite().nonnegative().nullable(),
                verified: z.boolean(),
                evidence: z.string().min(8),
                category: z.enum(['variable', 'allocated']),
                route: z.string().url().optional(),
                model: z.string().optional(),
                purpose: z.string().optional(),
                minInputTokens: z.number().nonnegative().optional(),
                maxInputTokens: z.number().positive().optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict();
    const book = schema.parse(JSON.parse(await readFile(args[0], 'utf8'))) as PriceBook;
    if (Date.parse(book.effectiveAt) > Date.now())
      throw new Error('Price book cannot take effect in the future');
    if (
      new Set(book.rates.map((r) => r.id)).size !== book.rates.length ||
      book.rates.some((r) => r.verified && r.cnyPerUnit === null)
    )
      throw new Error('Invalid verified rate');
    await db().transaction(async (tx) => {
      await tx.insert(billingPriceBooks).values({ version: book.version, data: book });
      await tx
        .update(billingSettings)
        .set({ priceVersion: book.version, updatedAt: new Date() })
        .where(eq(billingSettings.id, 'default'));
    });
    console.log('Published an immutable price version. Existing quotes retain their snapshot.');
  } else if (command === 'configure') {
    const config = z
      .object({
        mode: z.enum(['shadow', 'enforced']),
        productionVerified: z.boolean(),
        paymentVerified: z.boolean(),
        paymentFeeRate: z.number().min(0).max(0.1),
        paymentFixedCny: z.number().min(0),
        evidence: z.string().min(12),
      })
      .strict()
      .parse(JSON.parse(await readFile(args[0], 'utf8')));
    const { book } = await billingConfig();
    if (config.mode === 'enforced') {
      if (!config.productionVerified || !config.paymentVerified)
        throw new Error('Production benchmark and payment evidence required');
      for (const meter of [
        'runtime_ms',
        'storage_gib_day',
        'storage_read',
        'storage_write',
        'transfer_gib',
      ])
        if (
          !book.rates.some(
            (r) => r.meter === meter && r.verified && r.cnyPerUnit !== null && !r.route,
          )
        )
          throw new Error('Missing verified infrastructure rate: ' + meter);
      if (
        billingDefaults.packs.some((p) => config.paymentFeeRate + config.paymentFixedCny / p > 0.1)
      )
        throw new Error('Payment fees exceed the reserved 10% for a pack');
    }
    await db()
      .update(billingSettings)
      .set({
        evidence: config.evidence,
        mode: config.mode,
        productionVerified: config.productionVerified,
        paymentVerified: config.paymentVerified,
        paymentFeeRate: String(config.paymentFeeRate),
        paymentFixedCny: String(config.paymentFixedCny),
        salesEnabled: false,
        updatedAt: new Date(),
      })
      .where(eq(billingSettings.id, 'default'));
    const audit = sqlClient();
    await audit`insert into billing_admin_audit(id,action,detail) values(${randomUUID()},'configure',${JSON.stringify(config)}::jsonb)`;
    console.log(
      'Billing mode updated. Sales remain disabled until a verified payment integration exists.',
    );
  } else if (command === 'reconcile') {
    const [eventId, quantity, ...evidence] = args;
    z.string().uuid().parse(eventId);
    z.number().finite().nonnegative().parse(Number(quantity));
    if (evidence.join(' ').length < 12)
      throw new Error('Provide supplier invoice/reconciliation evidence');
    const [u] = await db().select().from(costUsage).where(eq(costUsage.id, eventId));
    if (!u || u.state === 'settled') throw new Error('Usage is missing or already settled');
    await completeUsage(
      eventId,
      Number(quantity),
      { reconciliation: evidence.join(' ') },
      u.requestId,
    );
    if (u.operationId)
      for (const t of await db()
        .select()
        .from(billingTargets)
        .where(eq(billingTargets.operationId, u.operationId)))
        await finishBillingTarget(t.key, t.state, t.error);
    console.log('Supplier usage reconciled using the original price version.');
  } else if (command === 'balance') {
    const [provider, amount, ...source] = args;
    const balance = Number(amount);
    if (!provider || !Number.isFinite(balance) || source.join(' ').length < 8)
      throw new Error('Expected provider, CNY balance and receipt/source');
    const sql = sqlClient();
    await sql`insert into billing_provider_balances(provider,balance_cny,verified,source) values(${provider},${balance},true,${source.join(' ')}) on conflict(provider) do update set balance_cny=excluded.balance_cny,verified=true,source=excluded.source,observed_at=now()`;
    console.log('Balance observation recorded; it is not a live balance connection.');
  } else
    throw new Error(
      'Commands: report [YYYY-MM], price-template, publish-prices FILE, configure FILE, grant OWNER CREDITS RECEIPT NOTE, reconcile EVENT QUANTITY EVIDENCE, balance PROVIDER CNY SOURCE',
    );
} finally {
  await sqlClient().end();
}
