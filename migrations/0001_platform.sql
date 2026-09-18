CREATE TABLE IF NOT EXISTS assets (
 id uuid PRIMARY KEY, owner text NOT NULL, key text NOT NULL UNIQUE,
 name text NOT NULL, mime text NOT NULL, size bigint NOT NULL CHECK (size > 0),
 upload_id text, state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','deleting','expired')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_owner_idx ON assets(owner);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL, asset_id uuid NOT NULL REFERENCES assets(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','completed','failed','cancelling','cancelled','expired')),
 progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), options jsonb NOT NULL,
 attempt integer NOT NULL DEFAULT 1, output_key text, output_size bigint, media jsonb, error text, error_detail text,
 deleting boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx ON jobs(owner,request_id);
CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner);
CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs(expires_at);
CREATE TABLE IF NOT EXISTS outbox (job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, attempt integer NOT NULL, dispatched_at timestamptz);
-- Only the server database role accesses these tables. Supabase browser clients have no policies.
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
