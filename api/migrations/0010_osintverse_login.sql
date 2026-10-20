-- Sign in with OSINTverse: a third sign-in provider, and the device logins `ot login --osintverse` uses.

-- SQLite can't change a CHECK constraint in place, so accounts is rebuilt with 'osintverse' allowed.
-- Nothing references accounts, so dropping the old table is safe.
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'osintverse')),
  provider_user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  scopes TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);
INSERT INTO accounts_new (id, user_id, provider, provider_user_id, login, email, access_token_enc, refresh_token_enc, scopes, expires_at, created_at)
  SELECT id, user_id, provider, provider_user_id, login, email, access_token_enc, refresh_token_enc, scopes, expires_at, created_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- OSINTverse has a single confidential client, so the CLI cannot use its device flow directly. The
-- registry runs its own: the CLI gets a code, the user signs in on the web and then approves the CLI
-- on a confirmation page, and the CLI's next poll receives an ot_ token.
CREATE TABLE device_logins (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  -- pending -> authorized (signed in, waiting for approval) -> approved -> consumed; or denied.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'approved', 'denied', 'consumed')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  confirm_token_hash TEXT,
  client_info TEXT,
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_logins_expires ON device_logins (expires_at);
