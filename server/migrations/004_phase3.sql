-- Phase 3: embed player access, recordings, connected platform accounts and scheduled events.

ALTER TABLE streams
  -- Embed and hotlink access. Empty list = any site may embed; require_token = every playback URL needs a signed token.
  ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN require_token   boolean NOT NULL DEFAULT false,
  -- Part of every playback token signature; replacing it revokes all tokens of the stream.
  ADD COLUMN token_secret    text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  -- Desired recording state, kept across restarts (like destinations.live).
  ADD COLUMN record          boolean NOT NULL DEFAULT false,
  -- Start recording automatically on Go live (and stop on Stop all).
  ADD COLUMN auto_record     boolean NOT NULL DEFAULT false,
  -- Who asked for the recording, and the event it belongs to (shown with the recording).
  ADD COLUMN record_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN record_event    uuid,
  -- Title and description used when Restream creates a broadcast on a connected account.
  ADD COLUMN title           text NOT NULL DEFAULT '',
  ADD COLUMN description     text NOT NULL DEFAULT '';

CREATE TABLE recordings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id        uuid REFERENCES streams(id) ON DELETE SET NULL,
  -- Kept so a recording stays recognisable after its stream is deleted.
  stream_name      text NOT NULL,
  event_id         uuid,
  title            text NOT NULL DEFAULT '',
  -- File name inside DATA_DIR/recordings.
  file             text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'finished', 'failed')),
  size_bytes       bigint NOT NULL DEFAULT 0,
  duration_seconds integer NOT NULL DEFAULT 0,
  video            text,
  audio            text,
  error            text,
  started_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX recordings_started_idx ON recordings (started_at DESC);

-- A YouTube channel, Facebook page or Twitch channel connected with OAuth.
CREATE TABLE platform_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL CHECK (provider IN ('youtube', 'facebook', 'twitch')),
  external_id       text NOT NULL,
  name              text NOT NULL,
  -- Channel handle / login (Twitch login, YouTube custom URL) for watch links.
  handle            text NOT NULL DEFAULT '',
  image_url         text NOT NULL DEFAULT '',
  access_token_enc  text NOT NULL,
  refresh_token_enc text NOT NULL DEFAULT '',
  expires_at        timestamptz,
  scopes            text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error        text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

ALTER TABLE destinations
  -- 'key' = stream key typed in; 'account' = Restream gets the ingest from the connected account.
  ADD COLUMN auth             text NOT NULL DEFAULT 'key' CHECK (auth IN ('key', 'account')),
  ADD COLUMN account_id       uuid REFERENCES platform_accounts(id) ON DELETE SET NULL,
  ADD COLUMN privacy          text NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'unlisted', 'private')),
  -- Runtime state of an account destination: full publish URL, broadcast/live video id, reusable YouTube stream.
  ADD COLUMN remote_url_enc   text,
  ADD COLUMN remote_id        text,
  ADD COLUMN remote_stream_id text,
  ADD COLUMN watch_url        text,
  ADD COLUMN prepare_error    text,
  ADD COLUMN prepared_event   uuid;

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id   uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  auto_start  boolean NOT NULL DEFAULT true,
  auto_stop   boolean NOT NULL DEFAULT true,
  record      boolean NOT NULL DEFAULT false,
  privacy     text NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'unlisted', 'private')),
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  started_at  timestamptz,
  ended_at    timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_starts_idx ON events (starts_at);

-- The destinations an event goes live on, and what was registered on each platform.
CREATE TABLE event_targets (
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  -- pending: still to register; registered: announced on the platform; used: went live and was ended;
  -- skipped: stream key only, nothing to announce; failed: see error; removed: to be deleted on the platform.
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'registered', 'used', 'skipped', 'failed', 'removed')),
  remote_id      text,
  watch_url      text,
  error          text,
  -- Set when the remote item must be updated after the event changed.
  dirty          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, destination_id)
);
