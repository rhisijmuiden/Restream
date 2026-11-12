-- Phase 2: mail log and backup/restore jobs.

CREATE TABLE mail_log (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  recipients text[] NOT NULL,
  subject    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('sent', 'failed')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_log_created_idx ON mail_log (created_at DESC);

CREATE TABLE backup_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('backup', 'restore')),
  -- Backups: 'full' or 'incremental'. Restores: the type of the restored backup.
  type        text CHECK (type IN ('full', 'incremental')),
  trigger     text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'cli')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  -- Name of the backup on the remote (written or restored).
  backup_id   text,
  step        text,
  size_bytes  bigint,
  error       text,
  log         text NOT NULL DEFAULT '',
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX backup_jobs_started_idx ON backup_jobs (started_at DESC);
