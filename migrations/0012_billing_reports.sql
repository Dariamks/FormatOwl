CREATE VIEW billing_daily_costs AS
SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  count(*)::bigint AS events,
  coalesce(sum(cost_micro_cny) FILTER (WHERE category='variable'),0)::bigint AS variable_micro_cny,
  coalesce(sum(cost_micro_cny) FILTER (WHERE category='allocated'),0)::bigint AS allocated_micro_cny,
  count(*) FILTER (WHERE cost_micro_cny IS NULL OR NOT verified OR state<>'settled')::bigint AS unverified_events,
  count(*) FILTER (WHERE state IN ('started','unknown'))::bigint AS unresolved_events
FROM cost_usage GROUP BY 1;
CREATE VIEW billing_daily_revenue AS
SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  coalesce(sum(amount) FILTER (WHERE kind='settle'),0)::bigint AS consumed_credits,
  coalesce(sum(amount) FILTER (WHERE kind='grant'),0)::bigint AS issued_credits,
  coalesce(sum(amount) FILTER (WHERE kind='refund'),0)::bigint AS released_after_failure
FROM credit_ledger GROUP BY 1;
CREATE TABLE billing_daily_reports (
  day date PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_provider_balances (
  provider text PRIMARY KEY, balance_cny numeric, verified boolean NOT NULL DEFAULT false,
  source text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_daily_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_provider_balances ENABLE ROW LEVEL SECURITY;
