-- 026_admin_sessions.sql
-- Auth Stage 3: minimal custom admin sessions.
-- Pure schema only: no users, passwords, hashes, or secrets are inserted here.

BEGIN;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  last_seen_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_sessions_session_hash
  ON admin_sessions (session_hash);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id
  ON admin_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

COMMIT;
