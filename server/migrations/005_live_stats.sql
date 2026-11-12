-- Phase 4: live viewer counts, combined chat and statistics per broadcast.

-- One broadcast = one period a stream was on air on at least one destination
-- (from the first output that goes live until Stop, or until it stayed off air for the grace period).
CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id     uuid REFERENCES streams(id) ON DELETE SET NULL,
  -- Kept so a broadcast stays recognisable after its stream is deleted.
  stream_name   text NOT NULL,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  title         text NOT NULL DEFAULT '',
  started_at    timestamptz NOT NULL DEFAULT now(),
  -- Last moment an output was on air; becomes the end of the broadcast.
  last_live_at  timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  -- Filled in when the broadcast ends (computed from the samples while it runs).
  peak_viewers  integer NOT NULL DEFAULT 0,
  avg_viewers   integer NOT NULL DEFAULT 0,
  chat_messages integer NOT NULL DEFAULT 0
);
CREATE INDEX broadcasts_started_idx ON broadcasts (started_at DESC);
-- At most one running broadcast per stream.
CREATE UNIQUE INDEX broadcasts_open_idx ON broadcasts (stream_id) WHERE ended_at IS NULL;

-- A destination that was on air during a broadcast.
CREATE TABLE broadcast_outputs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id   uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  destination_id uuid REFERENCES destinations(id) ON DELETE SET NULL,
  platform       text NOT NULL,
  name           text NOT NULL,
  watch_url      text,
  -- True when Restream can read viewers/chat for it (destination on a connected account).
  stats          boolean NOT NULL DEFAULT false,
  peak_viewers   integer NOT NULL DEFAULT 0,
  avg_viewers    integer NOT NULL DEFAULT 0,
  chat_messages  integer NOT NULL DEFAULT 0,
  UNIQUE (broadcast_id, destination_id)
);

-- Viewer counts; all outputs of a broadcast are sampled together, so rows with the same "at" add up to the total.
CREATE TABLE viewer_samples (
  broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  output_id    uuid NOT NULL REFERENCES broadcast_outputs(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  viewers      integer NOT NULL,
  PRIMARY KEY (broadcast_id, at, output_id)
);

CREATE TABLE chat_messages (
  seq          bigserial PRIMARY KEY,
  broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  output_id    uuid NOT NULL REFERENCES broadcast_outputs(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  -- The platform's message id, so a message polled twice is stored once.
  external_id  text NOT NULL,
  author       text NOT NULL,
  text         text NOT NULL,
  -- Super Chat amount and the like ("€5.00").
  highlight    text,
  at           timestamptz NOT NULL,
  UNIQUE (output_id, external_id)
);
CREATE INDEX chat_messages_broadcast_idx ON chat_messages (broadcast_id, seq);
