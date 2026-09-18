import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { db, eq, and, sql } from './db';
import { billingOperations, billingTargets, billingQuotes, costUsage } from './schema';
import { billingAlert, billingConfig, billingTargetKey, type BillingTx } from './billing';
import { findRate, microCny, type Meter, type PriceBook } from './billing-model';
import { MediaError } from './media-error';
export interface MeterContext {
  operationId: string;
  targetKey: string;
  mode: 'shadow' | 'enforced';
  book: PriceBook;
}
export const meterContext = new AsyncLocalStorage<MeterContext>();
export async function withUsage<T>(
  kind: string,
  id: string,
  attempt: number,
  run: () => Promise<T>,
) {
  const key = billingTargetKey(kind, id, attempt);
  const [target] = await db().select().from(billingTargets).where(eq(billingTargets.key, key));
  if (!target) return run();
  const [op] = await db()
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.id, target.operationId));
  if (!op || op.state !== 'open') return undefined;
  return meterContext.run(
    { operationId: op.id, targetKey: key, mode: op.mode, book: op.priceBook },
    run,
  );
}
export interface UsageInput {
  meter: Meter;
  stage: string;
  maximum: number;
  route?: string;
  model?: string;
  inputTokens?: number;
  eventKey?: string;
}
export async function startUsage(input: UsageInput) {
  const ctx = meterContext.getStore();
  if (!ctx) return null;
  const rate = findRate(ctx.book, input.meter, input.route, input.model, input.inputTokens);
  const maximum = rate?.cnyPerUnit == null ? null : microCny(input.maximum, rate.cnyPerUnit);
  return db().transaction(async (tx) => {
    const [op] = await tx
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.id, ctx.operationId))
      .for('update');
    if (!op || op.state !== 'open')
      throw new MediaError('BILLING_PAUSED', 'Billing authorization is not active');
    if (input.eventKey) {
      const [old] = await tx.select().from(costUsage).where(eq(costUsage.eventKey, input.eventKey));
      if (old) {
        if (old.operationId !== op.id || old.state === 'settled')
          throw new MediaError(
            'BILLING_RECONCILING',
            'Previously submitted operation requires reconciliation',
          );
        return old.id;
      }
    }
    if (ctx.mode === 'enforced') {
      if (!rate?.verified || maximum === null)
        throw new MediaError('PRICE_UNVERIFIED', 'Unverified price');
      if (!op.allowedStages.includes(input.stage))
        throw new MediaError('BILLING_STAGE_REQUIRED', 'Confirm the next processing stage');
      const rows = await tx.select().from(costUsage).where(eq(costUsage.operationId, op.id));
      if (rows.some((u) => u.state === 'unknown'))
        throw new MediaError('BILLING_RECONCILING', 'An earlier provider result is uncertain');
      const spent = rows.reduce(
        (n, u) => n + (u.state === 'settled' ? u.costMicroCny || 0 : u.maximumMicroCny || 0),
        0,
      );
      if (spent + maximum > (op.maximumMicroCny || 0))
        throw new MediaError(
          'BILLING_BUDGET_EXCEEDED',
          'Confirm a new quote before additional work',
        );
    }
    const id = randomUUID();
    await tx.insert(costUsage).values({
      id,
      operationId: ctx.operationId,
      targetKey: ctx.targetKey,
      eventKey: input.eventKey || randomUUID(),
      meter: input.meter,
      stage: input.stage,
      route: input.route,
      model: input.model,
      rateId: rate?.id,
      maximumQuantity: input.maximum,
      maximumMicroCny: maximum,
      verified: !!rate?.verified,
      category: rate?.category || 'variable',
    });
    return id;
  });
}
export async function completeUsage(
  id: string | null,
  quantity: number,
  rawUsage?: Record<string, unknown>,
  requestId?: string | null,
) {
  if (!id) return;
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Invalid metering quantity');
  const [u] = await db().select().from(costUsage).where(eq(costUsage.id, id));
  if (!u || u.state === 'settled') return;
  const [op] = await db()
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.id, u.operationId!));
  const rate = op?.priceBook.rates.find((r) => r.id === u.rateId);
  const cost = rate?.cnyPerUnit == null ? null : microCny(quantity, rate.cnyPerUnit);
  await db()
    .update(costUsage)
    .set({
      quantity,
      costMicroCny: cost,
      rawUsage,
      requestId,
      state: 'settled',
      updatedAt: new Date(),
    })
    .where(and(eq(costUsage.id, id), sql`${costUsage.state}<>'settled'`));
  if (
    quantity > u.maximumQuantity ||
    (cost !== null && u.maximumMicroCny !== null && cost > u.maximumMicroCny)
  )
    await billingAlert(
      'USAGE_OVERRUN',
      u.operationId,
      { meter: u.meter, quantity, maximum: u.maximumQuantity },
      id,
    );
}
export async function unknownUsage(ids: (string | null)[], reason: string) {
  for (const id of ids)
    if (id)
      await db()
        .update(costUsage)
        .set({ state: 'unknown', rawUsage: { reason }, updatedAt: new Date() })
        .where(and(eq(costUsage.id, id), sql`${costUsage.state}<>'settled'`));
}
export async function observedUsage(input: UsageInput, quantity: number) {
  const id = await startUsage(input);
  await completeUsage(id, quantity);
  return id;
}
export async function runtimeAllowance(requestedMs: number, quotedRuntimeOnly = false) {
  const ctx = meterContext.getStore();
  if (!ctx || ctx.mode === 'shadow') return requestedMs;
  const rate = findRate(ctx.book, 'runtime_ms');
  if (!rate?.verified || rate.cnyPerUnit === null)
    throw new MediaError('PRICE_UNVERIFIED', 'Runtime price is not verified');
  const [op] = await db()
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.id, ctx.operationId));
  if (quotedRuntimeOnly && op?.quoteId) {
    const [quote] = await db().select().from(billingQuotes).where(eq(billingQuotes.id, op.quoteId));
    if (quote)
      requestedMs = Math.min(
        requestedMs,
        quote.snapshot.lines
          .filter((l) => l.meter === 'runtime_ms')
          .reduce((sum, l) => sum + l.maximum, 0),
      );
  }
  const rows = await db()
    .select()
    .from(costUsage)
    .where(eq(costUsage.operationId, ctx.operationId));
  const used = rows.reduce(
    (n, u) => n + (u.state === 'settled' ? u.costMicroCny || 0 : u.maximumMicroCny || 0),
    0,
  );
  const remaining = (op?.maximumMicroCny || 0) - used;
  if (remaining <= 0) throw new MediaError('BILLING_BUDGET_EXCEEDED', 'Budget exhausted');
  return rate.cnyPerUnit === 0
    ? requestedMs
    : Math.min(requestedMs, Math.floor(remaining / (rate.cnyPerUnit * 1e6)));
}
export async function startProviderUsage(
  route: { baseURL: string; model: string },
  purpose: string,
  body: any,
) {
  const stage =
    purpose === 'repair'
      ? 'repair'
      : purpose === 'reading'
        ? 'reading'
        : purpose === 'translate'
          ? 'translate'
          : 'ocr';
  if (stage === 'repair')
    return {
      stage,
      ids: [
        await startUsage({
          meter: 'repair_images',
          stage,
          maximum: 1,
          route: route.baseURL,
          model: route.model,
        }),
      ],
    };
  // UTF-8 bytes conservatively bound text tokens. Image requests reserve the model's token ceiling.
  const text = JSON.stringify(body, (_k, v) =>
    typeof v === 'string' && v.startsWith('data:image/') ? '[image]' : v,
  );
  const maximumInput =
    stage === 'ocr'
      ? Math.max(32000, Buffer.byteLength(text))
      : Math.max(2048, Buffer.byteLength(text));
  const maximumOutput = Number(body.max_tokens || body.parameters?.max_tokens || 8192);
  const ids: (string | null)[] = [];
  try {
    ids.push(
      await startUsage({
        meter: 'input_tokens',
        stage,
        maximum: maximumInput,
        route: route.baseURL,
        model: route.model,
        inputTokens: maximumInput,
      }),
    );
    ids.push(
      await startUsage({
        meter: 'output_tokens',
        stage,
        maximum: maximumOutput,
        route: route.baseURL,
        model: route.model,
        inputTokens: maximumInput,
      }),
    );
  } catch (error) {
    for (const id of ids) await completeUsage(id, 0);
    throw error;
  }
  return { stage, ids };
}
export async function finishProviderUsage(
  ticket: { stage: string; ids: (string | null)[] },
  data: any,
) {
  if (ticket.stage === 'repair') {
    await completeUsage(ticket.ids[0], 1, data.usage, data.id || data.request_id);
    return;
  }
  const u = data.usage || {},
    input = u.input_tokens ?? u.prompt_tokens,
    output = u.output_tokens ?? u.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    await unknownUsage(ticket.ids, 'PROVIDER_USAGE_MISSING');
    return;
  }
  for (const id of ticket.ids)
    if (id) {
      const [event] = await db().select().from(costUsage).where(eq(costUsage.id, id));
      if (event) {
        const [op] = await db()
          .select()
          .from(billingOperations)
          .where(eq(billingOperations.id, event.operationId!));
        const actual =
          op &&
          findRate(
            op.priceBook,
            event.meter,
            event.route || undefined,
            event.model || undefined,
            input,
          );
        if (!actual) {
          await unknownUsage(ticket.ids, 'TOKEN_TIER_UNPRICED');
          return;
        }
        await db()
          .update(costUsage)
          .set({ rateId: actual.id, verified: actual.verified })
          .where(eq(costUsage.id, id));
      }
    }
  await completeUsage(ticket.ids[0], input, u, data.id || data.request_id);
  await completeUsage(ticket.ids[1], output, u, data.id || data.request_id);
}

/** Platform overhead is recorded separately from customer-authorized processing. */
export async function recordPlatformUsage(
  eventKey: string,
  meter: Meter,
  quantity: number,
  detail: Record<string, unknown>,
  store: ReturnType<typeof db> | BillingTx = db(),
) {
  const { book } = await billingConfig(store),
    rate = findRate(book, meter);
  const cost = rate?.cnyPerUnit == null ? null : microCny(quantity, rate.cnyPerUnit);
  await store
    .insert(costUsage)
    .values({
      id: randomUUID(),
      eventKey,
      meter,
      stage: 'platform',
      quantity,
      maximumQuantity: quantity,
      costMicroCny: cost,
      maximumMicroCny: cost,
      rateId: rate?.id,
      verified: !!rate?.verified,
      category: rate?.category || 'variable',
      state: 'settled',
      rawUsage: { ...detail, priceVersion: book.version },
    })
    .onConflictDoNothing();
}
