CREATE TABLE watermark_documents (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1, data jsonb,
  selection jsonb NOT NULL DEFAULT '{"candidates":[],"regions":[]}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE watermark_runs (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  request_id uuid NOT NULL, revision integer NOT NULL, options jsonb NOT NULL, snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued', attempt integer NOT NULL DEFAULT 1,
  progress integer NOT NULL DEFAULT 0, error text, result jsonb,
  dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, request_id)
);
CREATE INDEX watermark_runs_job_idx ON watermark_runs(job_id);
CREATE TABLE watermark_steps (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, step_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending', result jsonb, provider_config jsonb, request_id text,
  usage jsonb, error text, PRIMARY KEY(job_id, step_key)
);
