ALTER TABLE translation_documents ADD COLUMN waiting_until timestamptz;
CREATE TABLE ai_rate_buckets (
  id text PRIMARY KEY,
  request_at timestamptz NOT NULL DEFAULT now(),
  token_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE translation_activities (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  revision integer NOT NULL,
  content_hash text NOT NULL,
  options jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  history jsonb NOT NULL DEFAULT '[]',
  result jsonb,
  state text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 1,
  completed_units integer NOT NULL DEFAULT 0,
  total_units integer NOT NULL DEFAULT 0,
  waiting_until timestamptz,
  error text,
  files jsonb NOT NULL DEFAULT '{}',
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX translation_activities_job_idx ON translation_activities(job_id, created_at);
ALTER TABLE translation_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rate_buckets ENABLE ROW LEVEL SECURITY;
