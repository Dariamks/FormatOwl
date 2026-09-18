import { sqlClient } from './db';
import { billingDefaults, pricingScenario } from './billing-model';
export async function costReport(month = new Date().toISOString().slice(0, 7)) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Expected YYYY-MM');
  const sql = sqlClient();
  const costs =
    await sql`select * from billing_daily_costs where to_char(day,'YYYY-MM')=${month} order by day`;
  const revenue =
    await sql`select * from billing_daily_revenue where to_char(day,'YYYY-MM')=${month} order by day`;
  const consumedCredits = revenue.reduce((n, r) => n + Number(r.consumed_credits), 0),
    revenueCny = consumedCredits / 100;
  const variableCny = costs.reduce((n, r) => n + Number(r.variable_micro_cny), 0) / 1e6;
  const allocatedCny = costs.reduce((n, r) => n + Number(r.allocated_micro_cny), 0) / 1e6;
  const unverifiedEvents = costs.reduce((n, r) => n + Number(r.unverified_events), 0);
  const balances =
    await sql`select provider,balance_cny,verified,source,observed_at from billing_provider_balances order by provider`;
  const alerts =
    await sql`select kind,count(*)::int as count from billing_alerts where resolved_at is null group by kind`;
  const [failed] =
    await sql`select coalesce(sum(u.cost_micro_cny),0)::bigint as loss from cost_usage u join billing_targets t on t.key=u.target_key where t.state='failed' and u.category='variable' and to_char(u.created_at at time zone 'Asia/Shanghai','YYYY-MM')=${month}`;
  const varianceRows = await sql`
    select (o.created_at at time zone 'Asia/Shanghai')::date as day,
      count(*)::int as operations,
      sum(q.estimated_credits)::bigint as estimated_credits,
      sum(o.charged_credits)::bigint as charged_credits,
      sum(u.actual_micro_cny)::bigint as actual_micro_cny,
      count(*) filter(where q.estimated_credits is null or u.unknown_events>0)::int as incomplete_operations
    from billing_operations o join billing_quotes q on q.id=o.quote_id
    join lateral (select coalesce(sum(cost_micro_cny),0) as actual_micro_cny,
      count(*) filter(where cost_micro_cny is null or not verified or state<>'settled') as unknown_events
      from cost_usage where operation_id=o.id) u on true
    where to_char(o.created_at at time zone 'Asia/Shanghai','YYYY-MM')=${month} and o.state<>'open'
    group by 1 order by 1`;
  const usageByTool = await sql`
    select coalesce(j.tool,t.kind,'platform') as tool,u.meter,u.category,
      count(*)::int as events,sum(u.quantity) as quantity,
      coalesce(sum(u.cost_micro_cny),0)::bigint as known_micro_cny,
      count(*) filter(where not u.verified or u.cost_micro_cny is null or u.state<>'settled')::int as unverified_events
    from cost_usage u left join billing_targets t on t.key=u.target_key
    left join jobs j on t.kind='job' and j.id=t.target_id
    where to_char(u.created_at at time zone 'Asia/Shanghai','YYYY-MM')=${month}
    group by 1,2,3 order by 1,2,3`;
  return {
    month,
    quoteVariance: varianceRows.map((r) => ({
      ...r,
      actualEquivalentCredits: Number(r.incomplete_operations)
        ? null
        : Math.ceil((Number(r.actual_micro_cny) * 600) / 1e6),
      varianceCredits: Number(r.incomplete_operations)
        ? null
        : Math.ceil((Number(r.actual_micro_cny) * 600) / 1e6) - Number(r.estimated_credits),
    })),
    usageByTool,

    consumedCredits,
    revenueCny,
    knownVariableCostCny: variableCny,
    allocatedResourceCostCny: allocatedCny,
    fixedCny: billingDefaults.monthlyFixedCny,
    paymentReserveCny: revenueCny * 0.1,
    provisionalProfitCny: unverifiedEvents
      ? null
      : revenueCny * 0.9 - variableCny - billingDefaults.monthlyFixedCny,
    profitStatus:
      'Payment fees are a reserve, not a verified settlement. Allocated resources are already inside the 300 CNY fixed budget. Missing prices suppress profit figures.',
    knownFailedVariableCostCny: Number(failed.loss) / 1e6,
    unverifiedEvents,
    providerBalances: balances.map((b) => ({
      ...b,
      stale: Date.now() - new Date(b.observed_at).getTime() > 86400000,
    })),
    providerBalanceStatus: balances.length
      ? 'Only verified, recent observations are usable'
      : 'Not connected; balance unavailable',
    alerts,
    costs,
    revenue,
    scenarios: [1000, 2000, 3000, 5000].map(pricingScenario),
  };
}
export async function saveDailyBillingReport() {
  const sql = sqlClient();
  const [{ day }] =
    await sql`select to_char(now() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day`;
  const report = await costReport(day.slice(0, 7));
  await sql`insert into billing_daily_reports(day,data) values(${day},${JSON.stringify(report)}::jsonb) on conflict(day) do update set data=excluded.data,updated_at=now()`;
  return report;
}
