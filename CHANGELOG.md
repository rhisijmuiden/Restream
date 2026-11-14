# Changelog

## 1.7.0 · More destinations: TikTok, Vimeo, Dailymotion, Rumble, Trovo, Owncast, PeerTube, and LinkedIn Live as a connected account

- **New destinations with a stream key**, each with its own preset (server, bitrate, resolution, frame rate, keyframe interval, audio):
  - **TikTok LIVE**: portrait 9:16 (1080x1920), 30 fps, up to 6 Mbps, 44.1 kHz audio, transcoded. TikTok only gives a stream key to accounts it has approved for it (usually 18+, at least 1,000 followers, supported region); the form explains this plainly, and the key changes for every LIVE.
  - **Vimeo** (RTMPS, server filled in, up to 1080p60), **Dailymotion** (RTMP, the key with its `?auth=` part is kept as it is), **Rumble** (CBR, 2 s keyframes, at most 8 Mbps, 44.1 kHz; transcoded by default), **Trovo** (RTMP, up to 1080p60).
  - **Your own servers**: **Owncast** (RTMP on port 1935) and **PeerTube** (RTMP 1935 or RTMPS 1936, permanent lives keep their key), next to custom RTMP(S) and **SRT** (caller mode, optional stream ID and passphrase, latency via `?latency=` in the server URL).
- **LinkedIn Live via a connected account** (LinkedIn Live Events API): connect your own profile, or the company pages you administer (a separate button, as LinkedIn does not combine both permissions). On Go live Restream registers a new live video (RTMPS, ingest region from the server's time zone, West Europe by default), publishes the public post with the stream's title and description as soon as LinkedIn receives the video, and ends the live video ten seconds after Stop. The dashboard shows "waiting for LinkedIn", and explains when LinkedIn refuses (app not approved for Live Events) or receives no usable video. Setup guide on the Accounts page, step by step, with the redirect URL to copy. Events, viewers, chat and title changes during a broadcast are not available for LinkedIn.
- **Platform picker in groups** (social media, streaming and gaming, video platforms, your own servers) and a **guide per platform** in the destination form: "Where do I find the server URL and stream key?", with the steps and a link to the right page.
- Migration 010 (new platforms and LinkedIn accounts). All texts in English and Dutch.
## 1.6.1 · Stopwatch after Go live

- After **Go live** a panel shows a running stopwatch and, per destination, whether it is still connecting or already **sending data**, and how long that took ("Sending after 4.8 s"). A progress bar fills as destinations come up; the stopwatch stops when the last one sends data or fails.
- The panel turns green when everything is on air and closes by itself 20 seconds later (or with ×). Times come from the server, corrected for the browser's clock, so a reload during the start shows the same timer.
- `/api/streams` returns `serverTime`.

## 1.6.0 · Health monitor, check before Go live, one title for every platform

- **Health page** (Broadcast › Health) with 15 minutes of history, refreshed every 2 seconds:
  - **Incoming feed** (main and backup): bitrate, measured frame rate against the expected one, key-frame interval, damaged frames and time stamp errors, and for SRT the round trip, resent data, line capacity and lost packets. A light FFmpeg probe per online feed copies the video packets without decoding (next to no CPU).
  - **Every live destination**: bitrate against its target, speed (below 1.00x it falls behind real time) and the CPU of its FFmpeg process.
  - **Server**: CPU, memory, upload and download, free disk.
- **Warnings in plain words** on the health page and on the dashboard: incoming bitrate dropped, frames missing, key frames too far apart, damaged frames, SRT packets lost, a destination that cannot keep up, CPU, memory, upload or disk almost full. Each says what to check. A warning needs a few seconds to be raised and to clear, so a single bad sample causes nothing.
- **Mail and webhooks**: new notification "Broadcast health problem" (on by default; at most one mail per problem every 15 minutes, several problems in one mail) and webhook events `health.warning` and `health.cleared`.
- **Check before Go live**: Go live first checks the stream, and goes live at once when everything is fine. Otherwise it shows what is wrong, with "Go live anyway". The **Check** button runs the same check without going live. It checks the media server and the feed, the backup feed, every included destination (stream key and server, whether the server answers, whether a connected account still works), whether a passed-through feed fits the platform (bitrate, resolution, frame rate, key frames, portrait), whether the CPU can handle the transcoded destinations, the upload against the capacity in Settings, and the disk when recording.
- **One title for every platform**: the dashboard card "Title and description" changes title, description and thumbnail at once. During a broadcast it updates YouTube (title, description, thumbnail), Facebook (title, description) and Twitch (title) right away, shows the result per destination and says which destinations (stream key, X) you change on the platform yourself. During a live event its title changes too. The thumbnail is also set on every new YouTube broadcast.
- **Settings › Upload capacity** of the server (Mbit/s): used by the health monitor and the check.
- API: `GET /api/monitor`, `POST /api/streams/:id/preflight`, `PUT /api/streams/:id/broadcast-info`, `PUT|GET|DELETE /api/streams/:id/thumbnail`, webhook event `broadcast.info.updated`.
- Fix: kicking an encoder (key rotation, stream switched off) uses the MediaMTX v1.21 routes (`/v3/rtmp/conns/kick/…`, `/v3/srt/conns/kick/…`).

## 1.5.1 · Clear live status per destination after Go live

- **Status per destination** on the dashboard: Connecting, Live, Reconnecting or **Error**, with a summary line above the tiles ("2 online · 1 error"). The console refreshes every second while a destination is starting.
- **Why it fails, in plain words**: instead of FFmpeg's "Input/output error" the tile says what to check: the server address does not exist, the server refuses the connection, no answer (firewall), the secure connection failed, or the platform closed the connection (usually a wrong or expired stream key, or live streaming not enabled on the account). FFmpeg's own message stays under "Technical details", with a countdown to the next attempt.
- A wrong address or key shows as an error at once; other failures after three attempts. Restream keeps retrying in the background, so a destination comes on air by itself once the problem is fixed.
- The output status in the API has two new fields: `errorCode` and `nextRetryAt`.

## 1.5.0 · Connect X as an account

- **X on the Accounts page**: "Connect with X" opens X's own sign-in and permission screen in a pop-up (OAuth 2.0 with PKCE), like YouTube, Facebook and Twitch. A setup guide walks the administrator through the X Developer Console (Web App, callback URI, website URL, client ID and secret, API credit) with every value to copy.
- **X destinations via account**: Restream creates a stream source on the X account once (X Livestream API, `/2/sources`) and reuses it. On Go live it sends the video and publishes the broadcast as soon as X receives it (`POST /2/broadcasts`, with the stream's title; X announces it in a post); Stop ends it. The dashboard shows "X publishes the broadcast in a few seconds" until then, and the watch link afterwards. Events are not announced on X.
- **Paid X account required**: X only lets X Premium (or verified organisation) accounts that are not protected go live from streaming software. The Accounts page, the setup guide and the destination form say so, and when X refuses the account the dashboard shows "X refused to go live with this account" instead of a raw error.
- The X preset no longer says the key changes per broadcast: a Media Studio Producer source keeps its URL and key. The stream-key route explains the Producer steps.
- A destination on a connected account no longer needs a server URL when the platform hands it out.

## 1.4.0 · Light theme

- **Light theme** next to the dark one, in the same "Signal" brand: white surfaces, a deeper signal cyan and deeper status colours so text stays readable (WCAG AA) on white. Video previews stay dark.
- **Theme switch** in the left menu (Light · Dark · System) and under My account. "System" follows the device's light or dark setting and changes along with it.
- The choice is saved per user (new `theme` column, default dark, so nothing changes for existing users) and follows them to every browser; it is applied before the first paint, so there is no dark flash. The sign-in screen has a light/dark button too.
- Brand tokens: `brand/tokens.css` has a `:root[data-theme="light"]` block; `.rs-dark` keeps a region dark inside the light theme.

## 1.3.3 · Clear "Connect with YouTube / Facebook / Twitch"

- **Connect in a pop-up**: the Accounts page has a "Connect with YouTube", "Connect with Facebook" and "Connect with Twitch" button. It opens the platform's own sign-in and permission screen ("… wants access to your Google Account") in a pop-up; after Allow the pop-up closes and the channel or pages appear. A blocked pop-up falls back to the old full-page flow.
- **How it works** at the top of the page: the three steps (public URL, register the platform app once, connect) with their status.
- **"What happens when I connect?"** explains every screen of the pop-up, with an example of the permission screen and the platform's requirements (YouTube: live streaming enabled; Facebook: 100 followers and an account older than 60 days).
- **Setup guide per platform** for administrators: every step in Google Cloud, Meta for Developers and the Twitch console with a direct link, the values to copy (domain, JavaScript origin, redirect URL, the exact permissions Restream asks for), the client ID and secret, and a button to connect the first account as a test.

## 1.3.2 · Real-time preview with sound, whatever the encoder sends

- **Light preview**: when someone watches the dashboard preview, the server encodes a light copy of the feed (up to 540p, 30 fps, no B-frames, Opus sound) and plays it over WebRTC, so the preview is real time and has sound with any encoder settings. It runs only while the preview is open (stops 20 seconds after the last viewer) and costs about a third to half of a CPU core. The destinations still get the original feed.
- Order of the preview: WebRTC of the feed itself when it already has no B-frames and no AAC sound, otherwise the light preview, and LL-HLS as the last resort (blocked UDP).

## 1.3.1 · Fixes from the first real install: preview, caching, DNS check

- API answers now carry `Cache-Control: private, no-store`, so a browser or a CDN never shows an old stream status.
- The dashboard preview falls back to LL-HLS (a few seconds delay, with sound) when WebRTC cannot play the feed: MediaMTX refuses H264 with B-frames over WebRTC, which is the OBS x264 default. A badge explains how to get the low-latency preview back (B-frames 0). HLS also works where UDP 8189 is blocked.
- The installer warns when the domain does not point at this server, for example behind Cloudflare's proxy (orange cloud), which does not pass RTMP, SRT or WebRTC and can break Let's Encrypt.

## 1.3.0 · Phase 5: more platforms, backup feed with failover, API and webhooks

- **Instagram, Kick, X and LinkedIn** as destinations, each with a preset checked against the platform's own guidance (November 2026): Instagram 720×1280 portrait at 30 fps, up to 6 Mbps, 44.1 kHz audio; Kick up to 1080p60 and 8 Mbps (RTMPS); X 720p30 up to 4 Mbps with 3-second keyframes; LinkedIn up to 1080p30 and 6 Mbps. The form fills in mode, bitrate, resolution and frame rate from the preset, limits the choices to what the platform accepts and explains where to find the server URL and key (Instagram, X and LinkedIn give a new one per broadcast; LinkedIn Live needs LinkedIn's approval).
- **Portrait output**: per transcoded destination, "Portrait 9:16" cuts the middle of the picture out for platforms that show vertical video.
- Transcoding now uses a constant bitrate (`nal-hrd=cbr`, Kick requires it) and the keyframe interval and audio sample rate of the platform.
- **Backup feed**: a second stream key per stream for a backup encoder or a second line. When the main feed drops, live destinations switch to the backup feed by themselves and switch back once the main feed has been stable for a set time (default 10 s). Recordings follow the feed that is on air. The dashboard shows which feed is on air and previews the backup feed while it is used.
- **Fallback image**: when no feed comes in while destinations are live, they show the standard "We'll be right back / We zijn zo terug" image or your own PNG/JPEG with silence, for at most a set time (default 30 minutes), so the platforms keep the broadcast open. Uploaded images are stored in `DATA_DIR/assets` and included in backups.
- The "stream lost its ingest" notification says whether the backup feed or the fallback image took over.
- **API keys** (Administration › API & webhooks): `Authorization: Bearer rsk_…`, with a role (never more than the role of the person who made it), optional expiry, last use, and revocation. Keys cannot sign in, manage users or keys, or restore backups; their changes are in the audit log with the key's name. Only a fingerprint is stored.
- **Webhooks**: signed JSON (`X-Restream-Signature: t=…,v1=<HMAC-SHA256>`) for stream ingest, feed switches, outputs, broadcasts (with viewer figures), recordings, events and backups. Per webhook all events or a selection, a test button, a 14-day delivery log with payloads, redelivery, and retries after 30 s, 2 min, 10 min, 30 min, 2 h and 6 h. Webhooks never call this server itself or link-local addresses, also not through DNS.
- API reference with examples in [docs/API.md](docs/API.md).

## 1.2.1 · Fix: media server did not start on a fresh install

- MediaMTX could not open its config: it ran as the `mediamtx` user but the file was in `/etc/restream`, which only root and `restream` may enter. The config now lives in `/etc/restream-media` (root:mediamtx, 0750), so `/etc/restream` stays closed for secrets. Updating, or **Repair media server** in the console, moves it on existing servers.

## 1.2.0 · Phase 4: live viewers, combined chat and statistics

- **Live viewers** on the dashboard: total right now, the peak of this broadcast and a bar per destination; each destination tile shows its own count. Read every 30 seconds from YouTube (concurrent viewers), Facebook (`live_views`) and Twitch (Helix streams) for destinations on a connected account. Destinations with a typed stream key show "n/a".
- **Combined chat**: YouTube live chat (including Super Chat amounts), Facebook comments on the live video and Twitch chat (read anonymously over IRC/WebSocket) in one list, on the dashboard and full screen on the Chat page. Filter per platform, stays at the newest message unless you scroll up. Read only; replying and moderating stays on the platforms.
- **Analytics**: every broadcast is recorded automatically from the first destination on air until Stop (a reconnect within 10 minutes continues it), with duration, peak and average viewers, chat count, a viewer graph with the split per destination, the full chat and a CSV export (spreadsheet-safe). Administrators can delete a broadcast.
- Facebook now also asks for `pages_read_user_content` (to read comments). Pages connected before 1.2.0 show "connect again" on the Accounts page.
- YouTube chat is polled at most every 10 seconds (`LIVE_YOUTUBE_CHAT_MS`): each poll costs 5 of the 10,000 daily API units, about 1,800 units per broadcast hour. Other intervals: `LIVE_VIEWERS_MS`, `LIVE_FACEBOOK_CHAT_MS`, `LIVE_GRACE_MS`.

## 1.1.0 · Phase 3: embed, recording, connected accounts and events

- **Embed player** at `/embed/<id>`: house-style player with live badge, title, volume, picture-in-picture and full screen; LL-HLS by default (hls.js or native), WebRTC with `?mode=webrtc` and automatic fallback to HLS; waits for the broadcast and starts by itself; English and Dutch. Copyable iframe code with autoplay, title and low-latency options and a preview in the console.
- **Playback access** per stream: everyone, only listed websites (CSP `frame-ancestors`, referrer check, and `Origin` check for direct HLS/WHEP), or only with signed links (HMAC tokens in the path, optional expiry, revoke all at once). Applies to embed, HLS and WebRTC alike.
- **Recording**: Record button on the dashboard (running time and size), automatic recording on Go live per stream, and per event. Fragmented MP4 without re-encoding (HEVC tagged for Apple), new part when the ingest drops, refuses to start with less than 1 GB free, closes recordings cut off by a crash. Recordings page: watch in the browser (with seeking), download with a readable file name, rename, delete, retention in days, disk usage.
- **Connected accounts** via OAuth: YouTube channels (Google, PKCE, refresh tokens), Facebook pages (long-lived page tokens, Graph API v26.0) and Twitch channels. Tokens are stored encrypted and refreshed automatically; accounts that lose access are marked. Administrators register the platform apps in the console with step-by-step instructions and the redirect URL.
- **Destinations via connected account**: no stream key needed. Go live creates the broadcast with the stream's title and description (YouTube visibility per destination), shows a "watch" link on the dashboard, and Stop ends it on the platform. Platform errors are shown on the destination and retried.
- **Events**: plan title, description, start, end, visibility, recording and destinations. Announced on YouTube (scheduled broadcast), Facebook (scheduled live video) and Twitch (stream schedule) with watch links; edits and cancellations are pushed to the platforms. Goes live automatically at the start (or by hand) and stops at the end; the dashboard shows the next event.

## 1.0.0 · Phase 2: mail, notifications and backups

- **Mail server**: your own SMTP server with STARTTLS (required, TLS 1.2 or newer), implicit TLS or a plain local relay, certificate checking, sign-in, sender and reply-to. Test the connection without sending, or send a test message.
- **DKIM**: generate a 2048-bit signing key in the console and publish the TXT record shown; outgoing mail is then signed.
- **Notifications** to all administrators and extra addresses: stream lost its ingest while live, destination keeps failing, media server down (each with a follow-up when it recovers), backup failed or completed, update installed or rolled back, update available. In the instance language (English or Dutch), in the house style, with a log of sent messages.
- **Backups**: full and incremental to SCP (SSH key generated by Restream, host key pinned), FTPS (explicit and implicit) or FTP. Always encrypted with AES-256-GCM from a passphrase. Database, configuration (`APP_KEY`) and recordings; incremental file archives with GNU tar snapshots. Schedule (full daily/weekly/monthly, incremental daily/6-hourly/hourly) and retention by number of full backups. Checksums in a manifest per backup.
- **Restore** from the remote location, also of an incremental (full backup plus every step up to it), with a safety copy of the current database first. Restoring onto a new server re-encrypts all secrets for that server's `APP_KEY`.
- `restream-cli backup`, `backups` and `restore` for the shell.
- Error messages from mail and backup servers are shown under the translated error.

## 0.2.0 · Phase 1: restreaming core

- RTMP (1935/tcp) and SRT (8890/udp) ingest through MediaMTX. A stream is only accepted with the stream key of an enabled stream; keys can be rotated, which disconnects the encoder.
- Streams & keys page: RTMP server, stream key and SRT address to copy into OBS, vMix or a hardware encoder.
- Destinations: YouTube, Facebook (RTMPS), Twitch, custom RTMP(S) and custom SRT (with stream ID and passphrase). Keys are stored encrypted and never shown again.
- Per destination: passthrough (no re-encode) or transcode with its own bitrate, resolution, frame rate and audio bitrate.
- Go live and Stop for the whole stream and per destination. Outputs reconnect automatically with backoff, wait for the ingest when it drops, and resume after a restart.
- Dashboard with a live WebRTC preview, ingest details (protocol, codec, resolution, bitrate), output status, bitrate and running time, and a warning above 1080p.
- Hotlink: public HLS and WebRTC (WHEP) URLs and player pages per stream, with a playback id that is separate from the stream key and can be switched off.
- Installer and updater install FFmpeg and MediaMTX (pinned version, checksum verified) and its systemd service, open the media ports in an active ufw or firewalld, and offer `--firewall` to enable ufw. The dashboard offers administrators a repair button when the media server is down.
- Info dialog shows the MediaMTX and FFmpeg versions.

## 0.1.0 · Phase 0: foundation

- Installer for a bare Debian 13 server: PostgreSQL, Node.js 22, nginx with Let's Encrypt (or a self-signed certificate without a domain), systemd services. Checks the recommended hardware (4 vCPU, 8 GB RAM, 80 GB disk).
- Sign-in with password and mandatory TOTP two-factor authentication, single-use recovery codes, account lockout after repeated failures.
- Microsoft 365 (Entra ID) single sign-on via OpenID Connect, with optional group restriction and automatic account creation.
- Users with roles (administrator, operator, viewer), temporary passwords, 2FA reset, audit log.
- Admin console with the menu on the left, in the new "Signal" house style (see `brand/`).
- English by default, Dutch translation included; language per user.
- Info button with version, commit and server details.
- Update check against GitHub, update from the UI with automatic rollback, switching between the production (`main`) and test (`test`) channels.
