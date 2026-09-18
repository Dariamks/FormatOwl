CREATE TABLE billing_price_books (
  version text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_settings (
  id text PRIMARY KEY CHECK(id='default'), mode text NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow','enforced')),
  price_version text, payment_verified boolean NOT NULL DEFAULT false,
  payment_fee_rate numeric, payment_fixed_cny numeric, production_verified boolean NOT NULL DEFAULT false,
  sales_enabled boolean NOT NULL DEFAULT false CHECK(NOT sales_enabled OR (payment_verified AND production_verified AND mode='enforced')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings(id) VALUES ('default');
CREATE TABLE credit_accounts (
  owner text PRIMARY KEY, available bigint NOT NULL DEFAULT 0 CHECK(available>=0),
  reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_probes (
  asset_id uuid PRIMARY KEY REFERENCES assets(id), owner text NOT NULL,
  state text NOT NULL DEFAULT 'queued', facts jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_quotes (
  id uuid PRIMARY KEY, owner text NOT NULL, fingerprint text NOT NULL, operation jsonb NOT NULL,
  snapshot jsonb NOT NULL, mode text NOT NULL, state text NOT NULL,
  estimated_credits bigint, maximum_credits bigint, known_credits bigint NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_quotes_owner_idx ON billing_quotes(owner,created_at);
CREATE TABLE billing_operations (
  id uuid PRIMARY KEY, owner text NOT NULL, quote_id uuid UNIQUE REFERENCES billing_quotes(id),
  mode text NOT NULL, state text NOT NULL DEFAULT 'open', price_book jsonb NOT NULL,
  reserved_credits bigint NOT NULL DEFAULT 0 CHECK(reserved_credits>=0), charged_credits bigint NOT NULL DEFAULT 0 CHECK(charged_credits>=0),
  maximum_micro_cny bigint, allowed_stages jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_targets (
  key text PRIMARY KEY, operation_id uuid NOT NULL REFERENCES billing_operations(id),
  kind text NOT NULL, target_id uuid NOT NULL, attempt integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending', error text,
  UNIQUE(kind,target_id,attempt)
);
CREATE INDEX billing_targets_operation_idx ON billing_targets(operation_id);
CREATE TABLE cost_usage (
  id uuid PRIMARY KEY, operation_id uuid REFERENCES billing_operations(id), target_key text,
  event_key text NOT NULL UNIQUE, meter text NOT NULL, stage text NOT NULL,
  rate_id text, route text, model text, request_id text,
  quantity double precision NOT NULL DEFAULT 0 CHECK(quantity>=0), maximum_quantity double precision NOT NULL DEFAULT 0 CHECK(maximum_quantity>=0),
  cost_micro_cny bigint, maximum_micro_cny bigint, category text NOT NULL DEFAULT 'variable', verified boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'started', raw_usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_usage_operation_idx ON cost_usage(operation_id);
CREATE INDEX cost_usage_day_idx ON cost_usage(created_at);
CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY, owner text NOT NULL REFERENCES credit_accounts(owner), operation_id uuid REFERENCES billing_operations(id),
  kind text NOT NULL CHECK(kind IN ('grant','reserve','settle','release','refund')),
  available_delta bigint NOT NULL, reserved_delta bigint NOT NULL, amount bigint NOT NULL CHECK(amount>=0),
  idempotency_key text NOT NULL UNIQUE, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_owner_idx ON credit_ledger(owner,created_at);
CREATE TABLE billing_alerts (
  key text PRIMARY KEY, operation_id uuid REFERENCES billing_operations(id), kind text NOT NULL,
  detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
ALTER TABLE billing_price_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alerts ENABLE ROW LEVEL SECURITY;
