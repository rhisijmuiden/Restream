-- Phase 5: more platforms, backup ingest with automatic failover and a fallback image, API keys and webhooks.

-- More platforms; portrait output (9:16) for Instagram and the like.
ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_platform_check;
ALTER TABLE destinations ADD CONSTRAINT destinations_platform_check
  CHECK (platform IN ('youtube', 'facebook', 'twitch', 'instagram', 'kick', 'x', 'linkedin', 'rtmp', 'srt'));
ALTER TABLE destinations
  ADD COLUMN orientation text NOT NULL DEFAULT 'landscape' CHECK (orientation IN ('landscape', 'portrait'));

ALTER TABLE streams
  -- Second ingest key: an encoder (or a second encoder) sends a backup feed that takes over when the main feed drops.
  ADD COLUMN backup_key_hash  text UNIQUE,
  ADD COLUMN backup_key_enc   text,
  -- What the live destinations get while neither feed comes in: nothing ('off'), the standard image or an uploaded image.
  ADD COLUMN fallback_mode    text NOT NULL DEFAULT 'off' CHECK (fallback_mode IN ('off', 'standard', 'image')),
  -- File name of the uploaded image inside DATA_DIR/assets/fallback.
  ADD COLUMN fallback_image   text,
  -- The fallback image stays on air at most this long; after that the destinations wait for the encoder.
  ADD COLUMN fallback_minutes integer NOT NULL DEFAULT 30 CHECK (fallback_minutes BETWEEN 1 AND 720),
  -- After a failover, Restream switches back to the main feed once it has been stable this long.
  ADD COLUMN switch_back_seconds integer NOT NULL DEFAULT 10 CHECK (switch_back_seconds BETWEEN 0 AND 600);

-- Personal API keys for other projects. Only the hash is stored; the key is shown once.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  -- First characters of the key, so people can recognise it.
  prefix       text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  -- Requests made with the key act on behalf of this user (audit log); deleting the user removes the key.
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  revoked_at   timestamptz
);

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  url         text NOT NULL,
  -- HMAC-SHA256 signing secret, encrypted with APP_KEY.
  secret_enc  text NOT NULL,
  -- Event types to send; empty = all.
  events      text[] NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  -- Same for every webhook that gets the event, so receivers can drop duplicates.
  event_id        uuid NOT NULL,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_code   integer,
  error           text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);
