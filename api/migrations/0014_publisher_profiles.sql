-- Publisher profiles: what a namespace's page shows about who runs it. Host values are copied from the GitHub user or
-- org, or the GitLab user or group, the namespace is bound to (and from linked secondary hosts); owners can override
-- any field, and an override wins until it is cleared. Only fields the host shows publicly are stored; never emails.
CREATE TABLE namespace_profiles (
  namespace_id TEXT PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  -- From the host, refreshed by sync. socials_json: [{provider, url}]; members_json: [{login, avatar_url, url}]
  -- (public org or group members only).
  -- The account's current handle and page on its host (logins change; provider_owner_id does not).
  host_login TEXT,
  host_url TEXT,
  host_name TEXT,
  host_bio TEXT,
  host_location TEXT,
  host_website TEXT,
  host_company TEXT,
  host_avatar_url TEXT,
  host_socials_json TEXT NOT NULL DEFAULT '[]',
  host_members_json TEXT NOT NULL DEFAULT '[]',
  host_created_at INTEGER,
  -- The owner's overrides: {field: value}. A field that is absent uses the host value.
  custom_json TEXT NOT NULL DEFAULT '{}',
  -- The owner's About section: Markdown, and the sanitized HTML rendered from it (raw HTML is never kept).
  about_md TEXT,
  about_html TEXT,
  -- Up to 6 package names in this namespace, in the order shown.
  pins_json TEXT NOT NULL DEFAULT '[]',
  -- Hides the host details (bio, location, website, company, social links, members); name, avatar and hosts stay.
  hide_details INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'never' CHECK (sync_status IN ('never', 'ok', 'error')),
  sync_error TEXT,
  synced_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX namespace_profiles_synced ON namespace_profiles (synced_at);

-- Secondary hosts shown on a profile, e.g. the GitLab account of a namespace bound to a GitHub user. The namespace's
-- own (provider, provider_owner_id) stays its one key; these only add links and profile data.
CREATE TABLE namespace_hosts (
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  provider_owner_id TEXT NOT NULL,
  login TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'org', 'group')),
  linked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, provider)
);

-- The profile's Activity tab reads audit rows by target (a version or package of the namespace).
CREATE INDEX audit_log_target ON audit_log (target_id, target_kind);
