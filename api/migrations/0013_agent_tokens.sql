-- Scoped API tokens, and which kind of client the anonymous install pings come from (docs/agent-friendly-plan.md,
-- phase 4). Tokens minted before scopes were enforced keep scoped = 0 and every power their user has, as before.
ALTER TABLE api_tokens ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0;

-- Counts only: a day, a client kind and a number. No IP, user or token.
CREATE TABLE install_clients (
  day TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('cli', 'mcp', 'ci', 'other')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, client)
);
