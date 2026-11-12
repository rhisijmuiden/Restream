CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL,
  name                 text NOT NULL DEFAULT '',
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator', 'viewer')),
  language             text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'nl')),
  totp_secret_enc      text,
  totp_enabled         boolean NOT NULL DEFAULT false,
  totp_last_step       bigint,
  recovery_codes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  must_change_password boolean NOT NULL DEFAULT false,
  disabled             boolean NOT NULL DEFAULT false,
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  -- 'local' (password + TOTP) or 'microsoft' (Entra ID single sign-on)
  auth_source          text NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'microsoft')),
  sso_subject          text
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_sso_subject_key ON users (sso_subject) WHERE sso_subject IS NOT NULL;

CREATE TABLE sessions (
  id               text PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage            text NOT NULL CHECK (stage IN ('mfa', 'mfa_setup', 'full')),
  pending_totp_enc text,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
