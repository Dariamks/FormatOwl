CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE admin_user_profiles (
  user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  blocked boolean NOT NULL DEFAULT false,
  blocked_reason text,
  blocked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_recharges (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  receipt text NOT NULL UNIQUE,
  amount_cny numeric(12,2) NOT NULL CHECK(amount_cny >= 0),
  credits bigint NOT NULL CHECK(credits > 0),
  note text,
  admin_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_recharges_user_idx ON admin_recharges(user_id, created_at);

CREATE TABLE tool_visibility (
  tool_id text PRIMARY KEY,
  published boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tool_visibility(tool_id, published) VALUES
  ('image-watermark-remover', true),
  ('pdf-watermark-remover', true),
  ('word-watermark-remover', true),
  ('ppt-watermark-remover', true),
  ('video-compressor', true),
  ('image-compressor', true),
  ('pdf-compressor', true),
  ('audio-compressor', true),
  ('video-cutter', true),
  ('video-cropper', true),
  ('audio-cutter', true),
  ('video-to-mp3', true),
  ('video-converter', true),
  ('audio-converter', true),
  ('image-converter', true),
  ('transcription', true),
  ('video-translator', true),
  ('document-translator', true),
  ('image-translator', true)
ON CONFLICT (tool_id) DO NOTHING;

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_recharges ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_visibility ENABLE ROW LEVEL SECURITY;
