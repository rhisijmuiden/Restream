# Restream API and webhooks

Other projects can control Restream over its REST API and hear what happens through webhooks. Both are set up under **Administration → API & webhooks**.

## Authentication

Create an API key in the console and send it with every request:

```http
Authorization: Bearer rsk_…
```

- A key has a role: **viewer** (read only), **operator** (go live, stop, record, manage streams, destinations and events) or **administrator**. It never gets more than the current role of the person who made it, and it stops working when that person is disabled or removed.
- A key cannot use `/api/auth/*` (except `GET /api/auth/me`), `/api/users`, `/api/api-keys`, the OAuth flows of `/api/accounts/oauth/*`, or `POST /api/backups/restore`.
- Changes made with a key are in the audit log with the key's name.
- Requests with a key do not need the `x-restream: 1` header that the console sends.
- Keys can expire and can be revoked at any time. Restream only stores a fingerprint, so a lost key cannot be shown again: make a new one.

Errors come back as JSON with an HTTP status and a code, for example `401 {"error":"invalid_api_key"}`, `403 {"error":"forbidden"}` or `400 {"error":"validation","issues":[…]}`.

## Common endpoints

All paths are relative to your Restream address, for example `https://restream.example.com`. Bodies are JSON.

| Method and path | Role | What it does |
| --- | --- | --- |
| `GET /api/streams` | viewer | All streams with ingest status, the feed on air (`source.active`: `main`, `backup`, `fallback` or `none`), destinations and their output status. Stream keys only for operators and up. |
| `POST /api/streams` | operator | New stream: `{"name":"Studio"}` |
| `PATCH /api/streams/:id` | operator | Change `name`, `enabled`, `title`, `description`, `autoRecord`, `fallbackMode` (`off`, `standard`, `image`), `fallbackMinutes`, `switchBackSeconds` and more |
| `POST /api/streams/:id/live` | operator | Go live or stop all destinations marked "In Go live": `{"live":true}` |
| `POST /api/destinations/:id/live` | operator | Go live or stop one destination: `{"live":false}` |
| `POST /api/streams/:id/record` | operator | Start or stop recording: `{"record":true}` |
| `POST /api/streams/:id/backup-key` | operator | Create or replace (`{"enabled":true}`) or remove (`{"enabled":false}`) the backup ingest key |
| `PUT /api/streams/:id/fallback-image` | operator | Upload the fallback image as the raw body with `Content-Type: image/png` or `image/jpeg` (8 MB max) |
| `POST /api/streams/:id/destinations` | operator | Add a destination, see below |
| `PUT /api/destinations/:id` | operator | Change a destination (same body; leave out `streamKey` to keep it) |
| `GET /api/platforms` | viewer | Presets per platform: default server, limits, orientation, keyframe interval |
| `GET /api/events` / `POST /api/events` | viewer / operator | Scheduled events |
| `POST /api/events/:id/start` / `stop` | operator | Start or stop an event now |
| `GET /api/streams/:id/live` | viewer | Live viewers per destination, the total and recent chat |
| `GET /api/broadcasts` | viewer | Past broadcasts with duration, peak and average viewers |
| `GET /api/recordings` | viewer | Recordings; `GET /api/recordings/:id/file` downloads one |
| `GET /api/system/info` | viewer | Version, channel and component versions |
| `GET /api/monitor` | viewer | Health: server (CPU, memory, upload, disk), every online feed (bitrate, frame rate, key-frame interval, errors, SRT link), every live destination (bitrate, speed, CPU) and the open `issues`, with 15 minutes of history (`?history=0` leaves it out) |
| `POST /api/streams/:id/preflight` | operator | The check before Go live; changes nothing. Returns `ok`, `fails`, `warnings` and `checks` (`code`, `status` `ok`/`info`/`warn`/`fail`, `params`, optional `destinationId`) |
| `PUT /api/streams/:id/broadcast-info` | operator | `{"title":"…","description":"…"}`: saves the title and pushes it to the live broadcasts on YouTube, Facebook and Twitch; `results` per destination (`updated`, `pending`, `next`, `manual`, `unsupported`, `failed`). `"apply":false` only saves |
| `PUT /api/streams/:id/thumbnail` | operator | YouTube thumbnail as the raw body (`image/png` or `image/jpeg`, 2 MB max); set on live YouTube broadcasts right away. `GET` and `DELETE` too |

Add a destination:

```json
{
  "name": "Instagram",
  "platform": "instagram",
  "serverUrl": "rtmps://edgetee-upload-…fbcdn.net:443/rtmp/",
  "streamKey": "…",
  "mode": "transcode",
  "videoBitrate": 4000,
  "audioBitrate": 128,
  "maxHeight": 720,
  "fps": 30,
  "orientation": "portrait",
  "enabled": true
}
```

`platform` is one of `youtube`, `facebook`, `twitch`, `instagram`, `kick`, `x`, `linkedin`, `rtmp` or `srt`. YouTube, Facebook and Twitch can also use `"auth":"account","accountId":"…"` for a connected account.

Example: go live from a script.

```bash
curl -X POST https://restream.example.com/api/streams/$STREAM/live \
  -H "Authorization: Bearer $RESTREAM_KEY" -H 'Content-Type: application/json' \
  -d '{"live":true}'
```

## Webhooks

A webhook is a URL that Restream POSTs a JSON message to when something happens. Choose all events or a selection per webhook.

| Event | When |
| --- | --- |
| `stream.ingest.started` / `stream.ingest.stopped` | An encoder starts or stops sending; `data.input` is `main` or `backup` |
| `stream.source.changed` | The destinations switch feed; `data.from` and `data.to` are `main`, `backup`, `fallback` or `none` |
| `output.live` | A destination is on air (`data.source` says which feed) |
| `output.reconnecting` | A destination that was on air lost its connection and is retrying |
| `output.stopped` | A destination was stopped |
| `broadcast.started` / `broadcast.ended` | A broadcast starts, or ends with duration, peak and average viewers and chat count |
| `recording.started` / `recording.finished` | A recording starts, or ends (`status` `finished` or `failed`, size, duration) |
| `event.started` / `event.ended` | A scheduled event starts or ends |
| `backup.finished` | A backup completes or fails |
| `health.warning` / `health.cleared` | The health monitor raises or clears a problem: `data.code` (e.g. `feed_bitrate_drop`, `output_slow`, `server_cpu`), `severity`, `params`, and the stream, feed or destination it concerns |
| `broadcast.info.updated` | A new title was pushed to the live broadcasts; `data.destinations` lists where it was updated |
| `ping` | The test button in the console |

The message:

```json
{
  "id": "4c1f0c4e-…",
  "type": "stream.source.changed",
  "createdAt": "2026-11-12T20:15:03.120Z",
  "instance": { "name": "Restream", "url": "https://restream.example.com" },
  "data": { "stream": { "id": "…", "name": "Studio" }, "from": "main", "to": "backup" }
}
```

Headers: `Content-Type: application/json`, `User-Agent: Restream-Webhooks/<version>`, `X-Restream-Event`, `X-Restream-Event-Id` (the same on every retry, so you can drop duplicates), `X-Restream-Delivery` and `X-Restream-Signature`.

Answer with any 2xx status within 10 seconds. Anything else counts as a failure and is retried after 30 s, 2 min, 10 min, 30 min, 2 h and 6 h; after that the delivery is marked failed. Redirects are not followed. The console shows the deliveries of the last 14 days with their payload, and can send one again.

Restream never calls an address on its own server (127.0.0.0/8, ::1), link-local addresses (169.254.0.0/16, fe80::/10, which is where cloud metadata lives), multicast or 0.0.0.0, also not when a hostname resolves to one. Addresses in your local network are allowed.

### Checking the signature

`X-Restream-Signature` is `t=<unix seconds>,v1=<hex>`, where `<hex>` is the HMAC-SHA256 of `<t>.<raw body>` with the webhook's signing secret (`whsec_…`, shown in the console). Check it against the raw body, before parsing, and refuse messages that are more than five minutes old.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

PHP:

```php
function restream_verify(string $rawBody, string $header, string $secret): bool {
    parse_str(str_replace(',', '&', $header), $p);
    if (empty($p['t']) || empty($p['v1']) || abs(time() - (int) $p['t']) > 300) return false;
    $expected = hash_hmac('sha256', $p['t'] . '.' . $rawBody, $secret);
    return hash_equals($expected, $p['v1']);
}
```
