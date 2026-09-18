CREATE TABLE translation_documents (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  data jsonb,
  stage text NOT NULL DEFAULT 'queued',
  completed_units integer NOT NULL DEFAULT 0,
  total_units integer NOT NULL DEFAULT 0,
  operation jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE translation_steps (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  result jsonb,
  request_id text,
  provider_config jsonb,
  usage jsonb,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, step_key)
);
CREATE TABLE translation_exports (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  options jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 1,
  key text, name text, mime text, error text,
  dispatched_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX translation_exports_job_idx ON translation_exports(job_id);
CREATE TABLE worker_capabilities (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
