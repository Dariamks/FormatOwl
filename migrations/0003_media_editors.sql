ALTER TABLE jobs ADD COLUMN purpose text NOT NULL DEFAULT 'export' CHECK(purpose IN ('export','preview'));
ALTER TABLE jobs ADD COLUMN source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN input_size bigint;
ALTER TABLE jobs ADD COLUMN input_media jsonb;
ALTER TABLE jobs ADD COLUMN output_media jsonb;
UPDATE jobs SET source_ids=jsonb_build_array(asset_id);
CREATE TABLE job_inputs (
 job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES assets(id),
 PRIMARY KEY(job_id, asset_id)
);
CREATE INDEX job_inputs_asset_idx ON job_inputs(asset_id);
INSERT INTO job_inputs(job_id,asset_id) SELECT id,asset_id FROM jobs;
CREATE TABLE preparations (
 id uuid PRIMARY KEY, owner text NOT NULL, asset_id uuid NOT NULL REFERENCES assets(id),
 profile text NOT NULL CHECK(profile IN ('video','audio')), stream_index integer NOT NULL DEFAULT -1,
 state text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0, attempt integer NOT NULL DEFAULT 1,
 media jsonb, preview_key text, peaks_key text, thumbnails_key text, error text,
 dispatched_at timestamptz, expires_at timestamptz NOT NULL,
 UNIQUE(asset_id,profile,stream_index)
);
CREATE INDEX preparations_owner_idx ON preparations(owner);
ALTER TABLE job_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE preparations ENABLE ROW LEVEL SECURITY;
