-- Better Auth 1.7: accessed only by the server database role.
CREATE TABLE auth_users (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (
  id text PRIMARY KEY, token text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, ip_address text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE TABLE auth_accounts (
  id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
  scope text, password text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);
CREATE UNIQUE INDEX auth_accounts_provider_idx ON auth_accounts(provider_id, account_id);
CREATE TABLE auth_verifications (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE TABLE auth_rate_limits (
  id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL
);
-- A signed guest cookie may be consumed only once, including across account switches.
CREATE TABLE guest_claims (
  owner text PRIMARY KEY, user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_claims ENABLE ROW LEVEL SECURITY;
