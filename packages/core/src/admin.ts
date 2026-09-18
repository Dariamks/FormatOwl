import { randomUUID } from 'node:crypto';
import { db, desc, eq, sql } from './db';
import { grantCreditsInTransaction } from './billing';
import { ServiceError } from './service-error';
import {
  adminRecharges,
  adminUserProfiles,
  authUsers,
  creditAccounts,
  creditLedger,
} from './schema';

export {
  listPublishedToolIds,
  isToolPublished,
  assertToolPublished,
  listAdminTools,
  setToolPublished,
  isUserBlocked,
  assertOwnerNotBlocked,
} from './access';

function toNumber(value: unknown) {
  return value == null ? 0 : Number(value);
}

export async function setUserBlocked(userId: string, blocked: boolean, reason?: string | null) {
  const [user] = await db()
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, userId));
  if (!user) throw new ServiceError(404, 'NOT_FOUND');
  const [row] = await db()
    .insert(adminUserProfiles)
    .values({
      userId,
      blocked,
      blockedReason: blocked ? reason?.trim() || null : null,
      blockedAt: blocked ? new Date() : null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: adminUserProfiles.userId,
      set: {
        blocked,
        blockedReason: blocked ? reason?.trim() || null : null,
        blockedAt: blocked ? new Date() : null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function adminRechargeUser(input: {
  userId: string;
  receipt: string;
  amountCny: number;
  credits: number;
  note?: string;
  adminUsername: string;
}) {
  const receipt = input.receipt.trim();
  const note = input.note?.trim() || '管理员手动充值';
  if (
    !receipt ||
    receipt.length > 200 ||
    !Number.isFinite(input.amountCny) ||
    input.amountCny < 0 ||
    input.amountCny > 9999999999.99 ||
    Math.abs(input.amountCny * 100 - Math.round(input.amountCny * 100)) > 0.0001 ||
    !Number.isSafeInteger(input.credits) ||
    input.credits <= 0 ||
    input.credits > 1e9
  )
    throw new ServiceError(400, 'INVALID_REQUEST');

  return db().transaction(async (tx) => {
    const [user] = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, input.userId));
    if (!user) throw new ServiceError(404, 'NOT_FOUND');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receipt}, 14))`);
    const [existing] = await tx
      .select()
      .from(adminRecharges)
      .where(eq(adminRecharges.receipt, receipt));
    if (existing) {
      if (
        existing.userId !== input.userId ||
        Number(existing.amountCny) !== input.amountCny ||
        existing.credits !== input.credits ||
        existing.note !== note
      )
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const id = randomUUID();
    const [recharge] = await tx
      .insert(adminRecharges)
      .values({
        id,
        userId: input.userId,
        receipt,
        amountCny: input.amountCny.toFixed(2),
        credits: input.credits,
        note,
        adminUsername: input.adminUsername,
      })
      .returning();
    await grantCreditsInTransaction(
      tx,
      `user:${input.userId}`,
      input.credits,
      id,
      `管理员充值 ${input.amountCny.toFixed(2)} CNY（${receipt}）${note ? `：${note}` : ''}`,
    );
    return recharge;
  });
}

export async function adminOverview() {
  const [summary] = (await db().execute(sql`
    SELECT
      (SELECT count(*)::int FROM auth_users) AS user_count,
      (SELECT count(*)::int FROM admin_user_profiles WHERE blocked) AS blocked_count,
      (SELECT coalesce(sum(available), 0)::bigint FROM credit_accounts WHERE owner LIKE 'user:%') AS available_credits,
      (SELECT coalesce(sum(credits), 0)::bigint FROM admin_recharges) AS granted_credits,
      (SELECT coalesce(sum(amount), 0)::bigint FROM credit_ledger WHERE kind = 'settle' AND owner LIKE 'user:%') AS consumed_credits,
      (SELECT count(*)::int FROM admin_recharges WHERE created_at >= now() - interval '30 days') AS recent_recharges,
      (SELECT coalesce(sum(amount_cny), 0) FROM admin_recharges WHERE created_at >= now() - interval '30 days') AS recent_amount_cny,
      (SELECT count(*)::int FROM billing_operations WHERE created_at >= now() - interval '30 days' AND owner LIKE 'user:%') AS recent_operations
  `)) as unknown as [Record<string, unknown>];
  return {
    users: toNumber(summary?.user_count),
    blockedUsers: toNumber(summary?.blocked_count),
    availableCredits: toNumber(summary?.available_credits),
    grantedCredits: toNumber(summary?.granted_credits),
    consumedCredits: toNumber(summary?.consumed_credits),
    recentRecharges: toNumber(summary?.recent_recharges),
    recentAmountCny: toNumber(summary?.recent_amount_cny),
    recentOperations: toNumber(summary?.recent_operations),
  };
}

export async function listAdminUsers(input: {
  query?: string;
  status?: 'all' | 'active' | 'blocked';
  page?: number;
  pageSize?: number;
}) {
  const pageSize = Math.min(Math.max(input.pageSize || 20, 1), 100);
  const page = Math.max(input.page || 1, 1);
  const offset = (page - 1) * pageSize;
  const conditions = [];
  const query = input.query?.trim();
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(sql`(u.email ILIKE ${pattern} OR u.name ILIKE ${pattern})`);
  }
  if (input.status === 'blocked') conditions.push(sql`coalesce(p.blocked, false) = true`);
  if (input.status === 'active') conditions.push(sql`coalesce(p.blocked, false) = false`);
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const rows = (await db().execute(sql`
    SELECT
      u.id, u.name, u.email, u.created_at,
      coalesce(p.blocked, false) AS blocked,
      p.blocked_reason,
      coalesce(a.available, 0)::bigint AS available,
      coalesce(a.reserved, 0)::bigint AS reserved,
      coalesce((SELECT sum(amount) FROM credit_ledger WHERE owner = 'user:' || u.id AND kind = 'grant'), 0)::bigint AS granted,
      coalesce((SELECT sum(amount) FROM credit_ledger WHERE owner = 'user:' || u.id AND kind = 'settle'), 0)::bigint AS consumed
    FROM auth_users u
    LEFT JOIN admin_user_profiles p ON p.user_id = u.id
    LEFT JOIN credit_accounts a ON a.owner = 'user:' || u.id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as Record<string, unknown>[];
  const [countRow] = (await db().execute(sql`
    SELECT count(*)::int AS count
    FROM auth_users u
    LEFT JOIN admin_user_profiles p ON p.user_id = u.id
    ${where}
  `)) as unknown as [Record<string, unknown>];
  return {
    page,
    pageSize,
    total: toNumber(countRow?.count),
    users: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      createdAt: row.created_at,
      blocked: row.blocked === true,
      blockedReason: row.blocked_reason || null,
      available: toNumber(row.available),
      reserved: toNumber(row.reserved),
      granted: toNumber(row.granted),
      consumed: toNumber(row.consumed),
    })),
  };
}

export async function adminUserDetail(userId: string, historyPage = 1) {
  const page = Math.max(1, Math.min(1_000_000, Math.floor(historyPage) || 1));
  const pageSize = 50,
    offset = (page - 1) * pageSize;
  const [user] = await db()
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      createdAt: authUsers.createdAt,
      blocked: adminUserProfiles.blocked,
      blockedReason: adminUserProfiles.blockedReason,
      blockedAt: adminUserProfiles.blockedAt,
      available: creditAccounts.available,
      reserved: creditAccounts.reserved,
    })
    .from(authUsers)
    .leftJoin(adminUserProfiles, eq(adminUserProfiles.userId, authUsers.id))
    .leftJoin(creditAccounts, eq(creditAccounts.owner, sql`'user:' || ${authUsers.id}`))
    .where(eq(authUsers.id, userId));
  if (!user) throw new ServiceError(404, 'NOT_FOUND');

  const owner = `user:${userId}`;
  const targetToolJoins = sql`
    LEFT JOIN transcript_exports txe ON t.kind='transcript-export' AND txe.id=t.target_id
    LEFT JOIN translation_exports tle ON t.kind='translation-export' AND tle.id=t.target_id
    LEFT JOIN translation_activities ra ON t.kind='reading' AND ra.id=t.target_id
    LEFT JOIN watermark_runs wr ON t.kind='watermark-run' AND wr.id=t.target_id
    LEFT JOIN jobs j ON j.id=coalesce(CASE WHEN t.kind='job' THEN t.target_id END, txe.job_id, tle.job_id, ra.job_id, wr.job_id)
    LEFT JOIN archives ar ON t.kind='archive' AND ar.id=t.target_id
    LEFT JOIN batches b ON b.id=ar.batch_id
  `;
  const [recharges, ledger, operations, usage, tasks, totals] = await Promise.all([
    db()
      .select()
      .from(adminRecharges)
      .where(eq(adminRecharges.userId, userId))
      .orderBy(desc(adminRecharges.createdAt), desc(adminRecharges.id))
      .limit(pageSize)
      .offset(offset),
    db()
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.owner, owner))
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(pageSize)
      .offset(offset),
    db().execute(sql`
      SELECT
        o.id, o.state, o.reserved_credits, o.charged_credits, o.created_at,
        coalesce(string_agg(DISTINCT coalesce(j.tool, b.tool, t.kind), ', '), 'platform') AS tools
      FROM billing_operations o
      LEFT JOIN billing_targets t ON t.operation_id = o.id
      ${targetToolJoins}
      WHERE o.owner = ${owner}
      GROUP BY o.id
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db().execute(sql`
      SELECT
        u.id, u.operation_id, u.target_key, u.meter, u.stage, u.quantity,
        u.cost_micro_cny, u.state, u.created_at,
        coalesce(j.tool, b.tool, t.kind, 'platform') AS tool
      FROM cost_usage u
      LEFT JOIN billing_targets t ON t.key = u.target_key
      ${targetToolJoins}
      JOIN billing_operations o ON o.id = u.operation_id
      WHERE o.owner = ${owner}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db().execute(sql`
      SELECT j.id, j.tool, j.state, j.error, j.created_at, j.expires_at, j.attempt, a.name
      FROM jobs j JOIN assets a ON a.id=j.asset_id WHERE j.owner=${owner}
      ORDER BY j.created_at DESC, j.id DESC LIMIT ${pageSize} OFFSET ${offset}
    `),
    db().execute(sql`
      SELECT
        (select coalesce(sum(amount_cny),0) from admin_recharges where user_id=${userId}) as amount_cny,
        (select coalesce(sum(amount),0) from credit_ledger where owner=${owner} and kind='grant') as granted,
        (select coalesce(sum(amount),0) from credit_ledger where owner=${owner} and kind='settle') as consumed,
        (select count(*) from jobs where owner=${owner}) as tasks_count,
        (select count(*) from admin_recharges where user_id=${userId}) as recharges_count,
        (select count(*) from credit_ledger where owner=${owner}) as ledger_count,
        (select count(*) from billing_operations where owner=${owner}) as operations_count,
        (select count(*) from cost_usage u join billing_operations o on o.id=u.operation_id where o.owner=${owner}) as usage_count
    `),
  ]);

  return {
    user: {
      ...user,
      blocked: user.blocked === true,
      available: user.available || 0,
      reserved: user.reserved || 0,
    },
    history: {
      page,
      pageSize,
      total: {
        tasks: toNumber(totals[0]?.tasks_count),
        recharges: toNumber(totals[0]?.recharges_count),
        ledger: toNumber(totals[0]?.ledger_count),
        operations: toNumber(totals[0]?.operations_count),
        usage: toNumber(totals[0]?.usage_count),
      },
    },
    recharges,
    ledger,
    tasks: Array.from(tasks as Iterable<Record<string, unknown>>),
    totals: {
      amountCny: toNumber(totals[0]?.amount_cny),
      granted: toNumber(totals[0]?.granted),
      consumed: toNumber(totals[0]?.consumed),
    },
    operations: Array.from(operations as Iterable<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      state: row.state,
      tools: row.tools,
      reservedCredits: toNumber(row.reserved_credits),
      chargedCredits: toNumber(row.charged_credits),
      createdAt: row.created_at,
    })),
    usage: Array.from(usage as Iterable<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      operationId: row.operation_id,
      targetKey: row.target_key,
      tool: row.tool,
      meter: row.meter,
      stage: row.stage,
      quantity: toNumber(row.quantity),
      costMicroCny: row.cost_micro_cny === null ? null : toNumber(row.cost_micro_cny),
      state: row.state,
      createdAt: row.created_at,
    })),
  };
}
