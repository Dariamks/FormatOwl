CREATE TABLE transcripts (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcription_chunks (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  range jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  claim uuid,
  request_id text,
  result jsonb,
  usage jsonb,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transcription_chunk_index ON transcription_chunks(job_id, chunk_index);
CREATE TABLE transcript_exports (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  format text NOT NULL,
  options jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 1,
  key text, name text, mime text, error text,
  dispatched_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX transcript_exports_job_idx ON transcript_exports(job_id);
