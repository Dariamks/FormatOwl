ALTER TABLE billing_settings ADD COLUMN evidence text;
CREATE TABLE billing_admin_audit (
  id uuid PRIMARY KEY, action text NOT NULL, detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_admin_audit ENABLE ROW LEVEL SECURITY;
