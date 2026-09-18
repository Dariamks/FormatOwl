import { assertOwnerNotBlocked, assertToolPublished } from './access';
import { pagination } from './pagination';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { db, eq, and, sql, desc, isNull } from './db';
import {
  billingPriceBooks,
  billingSettings,
  billingQuotes,
  billingOperations,
  billingTargets,
  creditAccounts,
  creditLedger,
  costUsage,
  billingAlerts,
  jobs,
  preparations,
  archives,
  batches,
  transcriptExports,
  translationExports,
  translationActivities,
  watermarkRuns,
} from './schema';
import {
  initialPriceBook,
  creditsForMicroCny,
  billingDefaults,
  findRate,
  microCny,
} from './billing-model';
import { ServiceError } from './service-error';
export type BillingTx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];
type Store = ReturnType<typeof db> | BillingTx;
export const billingRequest = new AsyncLocalStorage<{
  owner: string;
  quoteId?: string;
  reuseOnly?: boolean;
  fingerprint: string;
}>();
export const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex');
export async function billingConfig(store: Store = db()) {
  const [settings] = await store
    .select()
    .from(billingSettings)
    .where(eq(billingSettings.id, 'default'));
  if (!settings) throw new ServiceError(503, 'BILLING_UNAVAILABLE');
  const version = settings.priceVersion || initialPriceBook.version;
  await store
    .insert(billingPriceBooks)
    .values({ version: initialPriceBook.version, data: initialPriceBook })
    .onConflictDoNothing();
  const [row] = await store
    .select()
    .from(billingPriceBooks)
    .where(eq(billingPriceBooks.version, version));
  if (!row) throw new ServiceError(503, 'BILLING_UNAVAILABLE');
  return { settings, book: row.data };
}
export async function account(owner: string) {
  const [a] = await db().select().from(creditAccounts).where(eq(creditAccounts.owner, owner));
  return { available: a?.available || 0, reserved: a?.reserved || 0 };
}
async function moveCredits(
  tx: BillingTx,
  owner: string,
  operationId: string | null,
  kind: string,
  amount: number,
  availableDelta: number,
  reservedDelta: number,
  key: string,
  note: string,
) {
  if (![amount, availableDelta, reservedDelta].every(Number.isSafeInteger) || amount < 0)
    throw new Error('Invalid credit amount');
  await tx.insert(creditAccounts).values({ owner }).onConflictDoNothing();
  await tx.execute(sql`select owner from credit_accounts where owner=${owner} for update`);
  const [old] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, key));
  if (old) {
    if (
      old.owner !== owner ||
      old.operationId !== operationId ||
      old.kind !== kind ||
      old.amount !== amount
    )
      throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
    return;
  }
  const [updated] = await tx
    .update(creditAccounts)
    .set({
      available: sql`${creditAccounts.available}+${availableDelta}`,
      reserved: sql`${creditAccounts.reserved}+${reservedDelta}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.owner, owner),
        sql`${creditAccounts.available}+${availableDelta}>=0`,
        sql`${creditAccounts.reserved}+${reservedDelta}>=0`,
      ),
    )
    .returning();
  if (!updated) throw new ServiceError(402, 'INSUFFICIENT_CREDITS');
  await tx.insert(creditLedger).values({
    id: randomUUID(),
    owner,
    operationId,
    kind,
    amount,
    availableDelta,
    reservedDelta,
    idempotencyKey: key,
    note,
  });
}
/** Only trusted server code and authenticated administrators may grant credits. */
export async function grantCreditsInTransaction(
  tx: BillingTx,
  owner: string,
  amount: number,
  receiptId: string,
  note: string,
) {
  if (
    !owner.startsWith('user:') ||
    amount <= 0 ||
    !Number.isSafeInteger(amount) ||
    amount > 1e9 ||
    !receiptId ||
    !note
  )
    throw new ServiceError(400, 'INVALID_REQUEST');
  await moveCredits(tx, owner, null, 'grant', amount, amount, 0, `grant:${receiptId}`, note);
}

export async function grantCredits(owner: string, amount: number, receiptId: string, note: string) {
  await db().transaction((tx) => grantCreditsInTransaction(tx, owner, amount, receiptId, note));
}
export function billingTargetKey(kind: string, id: string, attempt = 1) {
  return `${kind}:${id}:${attempt}`;
}
/** Call inside the same transaction that creates/requeues the actual work. Cached returns never call this. */
export async function admitBilling(
  tx: BillingTx,
  owner: string,
  kind: string,
  id: string,
  attempt = 1,
) {
  await assertOwnerNotBlocked(owner, tx);
  let admissionTool: string | undefined;
  if (kind === 'job') {
    const [row] = await tx.select({ tool: jobs.tool }).from(jobs).where(eq(jobs.id, id));
    admissionTool = row?.tool;
  } else if (kind === 'archive') {
    const [row] = await tx
      .select({ tool: batches.tool })
      .from(archives)
      .innerJoin(batches, eq(batches.id, archives.batchId))
      .where(eq(archives.id, id));
    admissionTool = row?.tool;
  } else {
    const table = (
      {
        'transcript-export': transcriptExports,
        'translation-export': translationExports,
        reading: translationActivities,
        'watermark-run': watermarkRuns,
      } as const
    )[kind as 'reading'];
    if (table) {
      const [row] = await tx
        .select({ tool: jobs.tool })
        .from(table)
        .innerJoin(jobs, eq(jobs.id, table.jobId))
        .where(eq(table.id, id));
      admissionTool = row?.tool;
    }
  }
  if (admissionTool) await assertToolPublished(admissionTool, tx);
  const key = billingTargetKey(kind, id, attempt);
  if ((await tx.select().from(billingTargets).where(eq(billingTargets.key, key))).length) return;
  const { settings, book } = await billingConfig(tx),
    ctx = billingRequest.getStore();
  if (ctx?.reuseOnly) throw new ServiceError(409, 'BILLING_NEW_WORK_REQUIRED');
  if (
    settings.mode === 'shadow' &&
    process.env.NODE_ENV === 'production' &&
    process.env.BILLING_SHADOW_EXECUTION !== 'true'
  )
    throw new ServiceError(503, 'BILLING_PREVIEW_ONLY');
  // A user can retry before the maintenance loop settles the previous attempt.
  // Close that attempt within this same transaction before replacing its job state.
  if (attempt > 1) {
    const table = (
      {
        job: jobs,
        prepare: preparations,
        archive: archives,
        'transcript-export': transcriptExports,
        'translation-export': translationExports,
        reading: translationActivities,
        'watermark-run': watermarkRuns,
      } as const
    )[kind as 'job'];
    if (table) {
      const [previous] = await tx.select().from(table).where(eq(table.id, id));
      if (previous && ['failed', 'cancelled', 'expired'].includes(previous.state)) {
        const prior = await tx
          .select()
          .from(billingTargets)
          .where(
            and(
              eq(billingTargets.kind, kind),
              eq(billingTargets.targetId, id),
              eq(billingTargets.state, 'pending'),
            ),
          );
        const error = previous.error;
        const paused =
          error &&
          ((error.startsWith('BILLING_') && error !== 'BILLING_RECONCILING') ||
            error === 'PRICE_UNVERIFIED');
        for (const target of prior)
          await settleTarget(
            tx,
            target,
            paused ? 'paused' : previous.state === 'expired' ? 'cancelled' : previous.state,
            error,
          );
      }
    }
  }
  if (settings.mode === 'enforced') {
    const unresolved = await tx
      .select({ id: billingOperations.id })
      .from(billingTargets)
      .innerJoin(billingOperations, eq(billingTargets.operationId, billingOperations.id))
      .where(
        and(
          eq(billingTargets.kind, kind),
          eq(billingTargets.targetId, id),
          eq(billingOperations.state, 'reconciling'),
        ),
      );
    if (unresolved.length) throw new ServiceError(409, 'BILLING_RECONCILING');
  }
  const [quote] = ctx?.quoteId
    ? await tx
        .select()
        .from(billingQuotes)
        .where(and(eq(billingQuotes.id, ctx.quoteId), eq(billingQuotes.owner, owner)))
        .for('update')
    : [];
  if (ctx?.quoteId && (!quote || ctx.owner !== owner || quote.fingerprint !== ctx.fingerprint))
    throw new ServiceError(409, 'QUOTE_MISMATCH');
  if (quote && quote.expiresAt <= new Date()) throw new ServiceError(409, 'QUOTE_EXPIRED');
  if (settings.mode === 'enforced') {
    if (!owner.startsWith('user:')) throw new ServiceError(401, 'BILLING_LOGIN_REQUIRED');
    if (!quote) throw new ServiceError(402, 'QUOTE_REQUIRED');
    if (
      quote.mode !== 'enforced' ||
      quote.state !== 'ready' ||
      quote.maximumCredits === null ||
      quote.snapshot.missingPrices.length
    )
      throw new ServiceError(409, 'PRICE_UNVERIFIED');
  }
  let [op] = quote
    ? await tx
        .select()
        .from(billingOperations)
        .where(eq(billingOperations.quoteId, quote.id))
        .for('update')
    : [];
  if (op && op.state !== 'open') throw new ServiceError(409, 'QUOTE_USED');
  if (op && quote) {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(billingTargets)
      .where(eq(billingTargets.operationId, op.id));
    if (count >= quote.snapshot.maxTargets) throw new ServiceError(409, 'QUOTE_USED');
  }
  if (!op) {
    const opId = randomUUID(),
      held = settings.mode === 'enforced' ? quote!.maximumCredits! : 0;
    [op] = await tx
      .insert(billingOperations)
      .values({
        id: opId,
        owner,
        quoteId: quote?.id,
        mode: settings.mode,
        priceBook: quote?.snapshot.book || book,
        reservedCredits: held,
        maximumMicroCny: held ? Math.floor((held * 5000) / 3) : null,
        allowedStages: quote?.snapshot.allowedStages || [],
      })
      .returning();
    if (held)
      await moveCredits(
        tx,
        owner,
        opId,
        'reserve',
        held,
        -held,
        held,
        `reserve:${opId}`,
        'Confirmed maximum credits',
      );
  }
  await tx.insert(billingTargets).values({ key, operationId: op.id, kind, targetId: id, attempt });
  if (quote) {
    let assetIds = quote.snapshot.assetIds;
    if (kind === 'job') {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id));
      if (job) assetIds = job.sourceIds.length ? job.sourceIds : [job.assetId];
    }
    // Attribute already-recorded upload/probe overhead exactly once. Its original
    // platform event remains the actual expense; the attributed row is billing only.
    const overhead = await tx
      .select()
      .from(costUsage)
      .where(
        and(
          isNull(costUsage.operationId),
          sql`${costUsage.rawUsage}->>'assetId'=any(array[${sql.join(
            assetIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])`,
        ),
      )
      .orderBy(costUsage.id)
      .for('update');
    const used = await tx.select().from(costUsage).where(eq(costUsage.operationId, op.id));
    let spent = used.reduce((n, u) => n + (u.costMicroCny || u.maximumMicroCny || 0), 0);
    for (const event of overhead) {
      const allocationKey = `allocation:${event.id}`;
      if ((await tx.select().from(costUsage).where(eq(costUsage.eventKey, allocationKey))).length)
        continue;
      const rate = findRate(op.priceBook, event.meter),
        cost = rate?.cnyPerUnit == null ? null : microCny(event.quantity, rate.cnyPerUnit);
      if (op.mode === 'enforced' && (!rate?.verified || cost === null))
        throw new ServiceError(409, 'PRICE_UNVERIFIED');
      if (op.mode === 'enforced' && spent + (cost || 0) > (op.maximumMicroCny || 0))
        throw new ServiceError(409, 'QUOTE_MISMATCH');
      spent += cost || 0;
      await tx.insert(costUsage).values({
        id: randomUUID(),
        operationId: op.id,
        targetKey: key,
        eventKey: allocationKey,
        meter: event.meter,
        stage: 'preparation',
        rateId: rate?.id,
        quantity: event.quantity,
        maximumQuantity: event.quantity,
        costMicroCny: cost,
        maximumMicroCny: cost,
        verified: !!rate?.verified,
        category: 'attributed',
        state: 'settled',
        rawUsage: { sourceCostEvent: event.id, measurement: 'attributed_platform_overhead' },
      });
    }
  }
}
export async function billingAlert(
  kind: string,
  operationId: string | null,
  detail: Record<string, unknown>,
  suffix = '',
) {
  await db()
    .insert(billingAlerts)
    .values({ key: `${kind}:${operationId || 'system'}:${suffix}`, operationId, kind, detail })
    .onConflictDoNothing();
}
export async function finishBillingTarget(key: string, state: string, error: string | null = null) {
  const [target] = await db().select().from(billingTargets).where(eq(billingTargets.key, key));
  if (!target) return; // Work created before billing was introduced remains free.
  await db().transaction((tx) => settleTarget(tx, target, state, error));
}
async function settleTarget(
  tx: BillingTx,
  target: typeof billingTargets.$inferSelect,
  state: string,
  error: string | null,
) {
  const key = target.key;
  const [op] = await tx
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.id, target.operationId))
    .for('update');
  if (!op || !['open', 'reconciling'].includes(op.state)) return;
  await tx.update(billingTargets).set({ state, error }).where(eq(billingTargets.key, key));
  const targets = await tx
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.operationId, op.id));
  if (targets.some((t) => t.state === 'pending')) return;
  const usage = await tx.select().from(costUsage).where(eq(costUsage.operationId, op.id));
  const unknown = usage.some((u) => ['started', 'unknown'].includes(u.state));
  if (unknown || (op.mode === 'enforced' && usage.some((u) => u.costMicroCny === null))) {
    await tx
      .update(billingOperations)
      .set({ state: 'reconciling', updatedAt: new Date() })
      .where(eq(billingOperations.id, op.id));
    return;
  }
  const delivered = new Set(
    targets.filter((t) => ['completed', 'cancelled', 'paused'].includes(t.state)).map((t) => t.key),
  );
  const billable = usage
    .filter((u) => u.targetKey && delivered.has(u.targetKey))
    .reduce((n, u) => n + (u.costMicroCny || 0), 0);
  const anyCompleted = targets.some((t) => t.state === 'completed');
  const computed = creditsForMicroCny(billable, anyCompleted);
  const charged = op.mode === 'enforced' ? Math.min(op.reservedCredits, computed) : 0;
  if (charged)
    await moveCredits(
      tx,
      op.owner,
      op.id,
      'settle',
      charged,
      0,
      -charged,
      `settle:${op.id}`,
      'Measured usage at the confirmed price version',
    );
  const release = op.reservedCredits - charged;
  const failed = targets.every((t) => t.state === 'failed');
  if (release)
    await moveCredits(
      tx,
      op.owner,
      op.id,
      failed ? 'refund' : 'release',
      release,
      release,
      -release,
      `release:${op.id}`,
      failed ? 'No deliverable; platform bears failed costs' : 'Unused reservation returned',
    );
  await tx
    .update(billingOperations)
    .set({
      chargedCredits: charged,
      state: targets.some((t) => t.state === 'paused')
        ? 'needs_quote'
        : failed
          ? 'refunded'
          : 'settled',
      updatedAt: new Date(),
    })
    .where(eq(billingOperations.id, op.id));
  if (op.mode === 'enforced' && computed > op.reservedCredits)
    await tx
      .insert(billingAlerts)
      .values({
        key: `overrun:${op.id}`,
        operationId: op.id,
        kind: 'COST_OVERRUN',
        detail: { computed, maximum: op.reservedCredits },
      })
      .onConflictDoNothing();
}
export async function billingOverview(owner: string, requestedPage = 1) {
  const { settings, book } = await billingConfig();
  const ledger = await db()
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.owner, owner))
    .orderBy(desc(creditLedger.createdAt))
    .limit(100);
  const [{ total }] = await db()
    .select({ total: sql<number>`count(*)::integer` })
    .from(billingOperations)
    .where(eq(billingOperations.owner, owner));
  const page = pagination(total, requestedPage);
  const operations = await db()
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.owner, owner))
    .orderBy(desc(billingOperations.createdAt), desc(billingOperations.id))
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize);
  return {
    mode: settings.mode,
    salesEnabled: settings.salesEnabled,
    priceVersion: book.version,
    balance: await account(owner),
    packs: billingDefaults.packs.map((cny, i) => ({
      cny,
      credits: billingDefaults.packCredits[i],
      displayUsd: billingDefaults.packDisplayUsd[i],
    })),
    ledger,
    pagination: page,
    operations: operations.map(
      ({ id, state, mode, reservedCredits, chargedCredits, createdAt }) => ({
        id,
        state,
        mode,
        reservedCredits,
        chargedCredits,
        createdAt,
      }),
    ),
  };
}
export async function billingReceipt(owner: string, id: string) {
  const [op] = await db()
    .select()
    .from(billingOperations)
    .where(and(eq(billingOperations.id, id), eq(billingOperations.owner, owner)));
  if (!op) throw new ServiceError(404, 'NOT_FOUND');
  const usage = await db().select().from(costUsage).where(eq(costUsage.operationId, id));
  const targets = await db()
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.operationId, id));
  return {
    id: op.id,
    mode: op.mode,
    state: op.state,
    maximumCredits: op.reservedCredits,
    chargedCredits: op.chargedCredits,
    priceVersion: op.priceBook.version,
    lines: usage.map((u) => ({
      meter: u.meter,
      stage: u.stage,
      quantity: u.quantity,
      state: u.state,
      platformLoss: targets.some((t) => t.key === u.targetKey && t.state === 'failed'),
      costMicroCny: u.costMicroCny,
      credits: u.costMicroCny === null ? null : creditsForMicroCny(u.costMicroCny, false),
    })),
    ledger: await db().select().from(creditLedger).where(eq(creditLedger.operationId, id)),
  };
}
