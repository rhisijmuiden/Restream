-- Phase 1: ingest streams and restream destinations.

CREATE TABLE streams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  -- The ingest key is a secret: looked up by hash, shown to operators from the encrypted copy.
  ingest_key_hash  text NOT NULL UNIQUE,
  ingest_key_enc   text NOT NULL,
  -- Public id used in hotlink URLs, so the ingest key never appears in a playback URL.
  playback_id      text NOT NULL UNIQUE,
  playback_enabled boolean NOT NULL DEFAULT true,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE destinations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id       uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  name            text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('youtube', 'facebook', 'twitch', 'rtmp', 'srt')),
  server_url      text NOT NULL,
  stream_key_enc  text NOT NULL DEFAULT '',
  passphrase_enc  text NOT NULL DEFAULT '',
  -- Included when the operator presses "Go live" for the whole stream.
  enabled         boolean NOT NULL DEFAULT true,
  -- 'copy' passes the ingest through untouched; 'transcode' re-encodes with the settings below.
  mode            text NOT NULL DEFAULT 'copy' CHECK (mode IN ('copy', 'transcode')),
  video_bitrate   integer NOT NULL DEFAULT 6000 CHECK (video_bitrate BETWEEN 300 AND 20000),
  audio_bitrate   integer NOT NULL DEFAULT 160 CHECK (audio_bitrate BETWEEN 64 AND 320),
  max_height      integer NOT NULL DEFAULT 1080 CHECK (max_height IN (480, 720, 1080)),
  fps             integer CHECK (fps IN (25, 30, 50, 60)),
  -- Desired state, kept across restarts: Restream (re)connects while this is true and the ingest is online.
  live            boolean NOT NULL DEFAULT false,
  live_since      timestamptz,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX destinations_stream_idx ON destinations (stream_id, position);
