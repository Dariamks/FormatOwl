CREATE TABLE batches (
 id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL, tool text NOT NULL,
 asset_ids jsonb NOT NULL, options jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(owner, request_id)
);
ALTER TABLE jobs ADD COLUMN tool text NOT NULL DEFAULT 'video-compressor';
ALTER TABLE jobs ADD COLUMN batch_id uuid REFERENCES batches(id);
ALTER TABLE jobs ADD COLUMN output_name text;
ALTER TABLE jobs ADD COLUMN output_mime text;
ALTER TABLE jobs ADD COLUMN input_preview jsonb;
ALTER TABLE jobs ADD COLUMN output_preview jsonb;
ALTER TABLE jobs ADD COLUMN note text;
UPDATE jobs SET output_name = regexp_replace(assets.name, '\.[^.]*$', '') || '-filemorph.mp4', output_mime='video/mp4'
 FROM assets WHERE jobs.asset_id=assets.id AND jobs.output_key IS NOT NULL;
CREATE INDEX jobs_batch_idx ON jobs(batch_id);
CREATE TABLE archives (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES batches(id), version text NOT NULL,
 members jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', key text NOT NULL, error text,
 dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX archives_batch_idx ON archives(batch_id);
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE archives ENABLE ROW LEVEL SECURITY;
