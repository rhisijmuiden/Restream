# Restream

Self-hosted stream multiplexer for Debian 13, installed with a single installer script on a bare server. Send one RTMP or SRT stream to the server, press **Go live**, and Restream distributes it to YouTube, Facebook, Twitch, Instagram, Kick, X and your own RTMP/SRT servers, each in its own bitrate and resolution.

> Status: v1.0 (phases 0 to 2) is on the test channel. Phase 2 added your own SMTP mail server with DKIM and notifications when streams, destinations or the media server fail, and encrypted full and incremental backups to SCP, FTPS or FTP with restore from that location. Phase 1 brought RTMP/SRT ingest, destinations, Go live and hotlinks; phase 0 the installer, 2FA and Microsoft 365 sign-in, users, EN/NL and updates from the UI. See [docs/ROADMAP.md](docs/ROADMAP.md) (Dutch) and [CHANGELOG.md](CHANGELOG.md).

## Install

On a fresh Debian 13 server (recommended: 4 vCPU, 8 GB RAM, 80 GB SSD, 100 Mbps or more), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash -s -- \
  --domain restream.example.com --email you@example.com
```

- Without `--domain` the server uses its IP address and a self-signed certificate.
- `--firewall` installs and enables ufw with SSH, web and media ports open. Without it, an active ufw or firewalld only gets the ports added.
- `--channel test` installs the test channel (`test` branch) instead of production (`main`). To try the test channel before anything is on `main`, fetch the script from the `test` branch as well.
- At the end the installer prints the sign-in address and a temporary password. At first sign-in you choose your own password and set up two-factor authentication.
- Running the installer again is safe; it keeps the database, secrets and users.

Maintenance on the server:

| Command | What it does |
| --- | --- |
| `restream-cli reset-password --email <e>` | New temporary password for a user |
| `restream-cli reset-2fa --email <e>` | User sets up 2FA again at next sign-in |
| `restream-update [--channel production\|test]` | Update from the shell (same as the Updates page) |
| `restream-cli backup [--full]` | Make a backup now (incremental when a chain exists) |
| `restream-cli backups` | List the backups on the remote location |
| `restream-cli restore --id <id> --yes` | Restore a backup (replaces database and recordings) |
| `journalctl -u restream -f` | Application log (including the FFmpeg outputs) |
| `journalctl -u restream-media -f` | Media server log (MediaMTX: ingest connections, playback) |

### Ports

| Port | Used for |
| --- | --- |
| 80, 443 TCP | Web console, HLS and WebRTC signalling (nginx) |
| 1935 TCP | RTMP ingest |
| 8890 UDP | SRT ingest |
| 8189 UDP and TCP | WebRTC media for viewers and the console preview |

## Streaming

1. **Streams & keys** → **New stream**. You get an RTMP server (`rtmp://<host>/live`), a stream key, and an SRT address (`srt://<host>:8890?streamid=publish:live/<key>`). Only connections with a valid key of an enabled stream are accepted; **New stream key** revokes the old one and disconnects the encoder.
2. **Destinations** → **Add destination**: YouTube, Facebook (RTMPS), Twitch, or any RTMP(S) or SRT server. Stream keys and SRT passphrases are stored encrypted and never sent back to the browser.
   - **Passthrough** (default) sends the ingest unchanged: no extra CPU. Set a 2-second keyframe interval in your encoder.
   - **Transcode** re-encodes for that destination with its own bitrate, resolution (1080p/720p/480p) and frame rate, H.264 + AAC with 2-second keyframes. Roughly 1 to 2 CPU cores per 1080p output.
3. On the dashboard, **Go live** starts every destination marked "In Go live"; each destination also has its own Go live / Stop. Outputs that drop are restarted with backoff (2 to 30 seconds), and outputs that are live wait for the ingest and start by themselves when it comes back, also after a server restart.
4. **Hotlink**: each stream has public HLS (`https://<host>/live/<id>/index.m3u8`) and WebRTC/WHEP (`https://<host>/live/<id>/whep`) URLs plus ready-made player pages. The id is separate from the stream key, and playback can be switched off per stream.

How it fits together: MediaMTX receives the ingest and asks Restream (`/api/internal/mediamtx/auth`, local only) whether the key is valid. Each live destination is one FFmpeg process that reads the local RTSP feed from MediaMTX and publishes to the platform. Public playback goes through Restream, which maps the playback id to the stream, so MediaMTX itself only listens on 127.0.0.1 apart from the ingest and WebRTC media ports. Restream v1 supports up to 1080p50; the dashboard warns when the ingest is larger.

### How updates work

The web console never runs privileged commands. When an administrator clicks **Install update** or switches channel, the app writes a small request file. A root-owned systemd path unit (`restream-updater.path`) picks it up and runs `deploy/update.sh`: fetch the branch, `npm ci`, build, migrate, restart, health check. If any step fails, the previous version is rebuilt and restored automatically. Progress and the log are shown live on the Updates page.

### Mail server and notifications

**Administration → Mail server**: enter your SMTP server with STARTTLS (587, required, TLS 1.2+), implicit TLS (465) or none (local relay only), sign-in and sender. **Test connection** connects and authenticates without sending; **Send test message** sends a real one. Under **DKIM signing** Restream generates a 2048-bit key and shows the TXT record (`<selector>._domainkey.<domain>`) to publish; once it is in DNS, switch signing on.

Notifications go to all administrators (optional) and extra addresses, for: a stream losing its ingest while destinations are live (after 20 s), a destination failing three times in a row, the media server not answering for a minute (each with a follow-up when it recovers), backups failing or completing, updates installed or rolled back, and new versions on your channel. Every message is in the house style and in the default language of the instance; the last 50 are listed with their result.

### Backups and restore

**Administration → Backups**:

1. Choose **SCP (SSH)** (recommended), **FTPS** (explicit, port 21), **FTPS implicit** (port 990) or **FTP**. For SCP, click **Generate key** and add the public key to `~/.ssh/authorized_keys` of the backup user; the host key is pinned at the first connection and a changed key is refused. FTPS verifies the certificate unless you switch that off.
2. Set an **encryption passphrase** (12+ characters) and keep it in your password manager. Every backup is AES-256-GCM encrypted with a key derived from it (scrypt) before it leaves the server.
3. **Save and test** writes and removes a probe file. Then switch on the **schedule**: a full backup daily, weekly or monthly, with incrementals in between (daily, every 6 hours or hourly), keeping the last *n* full backups with their incrementals.

A backup contains the database (complete in every backup, it is small), `/etc/restream/restream.env` (with `APP_KEY`) and the files in `/var/lib/restream/recordings` and `assets`, which are incremental (GNU tar snapshots). On the remote each backup is `restream-<id>.rsbk` plus a readable `restream-<id>.json` manifest, uploaded last.

**Restore** picks any backup on the location; for an incremental Restream downloads the full backup and every incremental up to it, checks the SHA-256 of each file, decrypts, saves a copy of the current database to `/var/lib/restream/backups/pre-restore`, and replaces the database and recordings in one go. The backup location configured on the server is kept. Everyone is signed out and signs in with the accounts from the backup.

**Restore onto a new server**: install Restream, sign in with the new admin account, enter the same backup location and passphrase, and restore. Secrets in the backup (stream keys, 2FA secrets, passwords) are re-encrypted with the new server's `APP_KEY` automatically. A backup made by a newer Restream version is refused until the server is updated.

### Microsoft 365 sign-in

In Entra ID, create an app registration (type Web) with the redirect URI shown on **Settings → Microsoft 365 sign-in**, create a client secret, and enter tenant ID, client ID and secret in Restream. Optionally restrict sign-in to one group (add the `groups` claim to the token). Local accounts with 2FA keep working next to SSO.

## Development

```bash
npm install
# PostgreSQL with a database "restream" (user/password restream) on localhost
npm run dev:server   # API on :8080
npm run dev:web      # UI on :5173 with /api proxied
npm test             # needs database restream_test
npm run build
```

Create a first user with `node server/dist/cli.js create-admin --email you@example.com` after a build.

The media engine is off in development. To try streaming locally, run MediaMTX with `deploy/mediamtx/mediamtx.yml` (replace `__PUBLIC_HOST__` with `127.0.0.1`), install FFmpeg, and start the server with `MEDIA_ENABLED=true`.

## Planned features

- Destinations via linked account (OAuth) next to stream keys
- An embeddable player for websites, optionally restricted to allowed domains or tokens
- Scheduled live events, registered on the platforms as upcoming broadcasts
- One-click recording of the broadcast
- Live viewer counts per platform and a unified chat
- Login-only web interface with users, roles and 2FA

Standard for every release:

- Configurable SMTP mail server (TLS / STARTTLS, DKIM) with notifications
- Encrypted full and incremental backups to FTP, FTPS and SCP, with restore from the remote location
- Info button with the current version, update check and update from the UI
- `main` (production) and `test` release channels, switchable in the UI
- English by default, Dutch translation included

## Stack

| Part | Choice |
| --- | --- |
| Ingest and playback | MediaMTX (RTMP + SRT in, HLS + WebRTC out) |
| Distribution | FFmpeg, one process per destination, supervised by the Node.js server |
| Backend | Node.js 22, TypeScript, Fastify, argon2id, otplib, openid-client |
| Database | PostgreSQL 17 |
| Jobs & scheduling (phase 3) | Redis + BullMQ |
| Frontend | React 19, Vite, Tailwind CSS 4, TanStack Query, i18next |
| Web server | Nginx + Let's Encrypt |
| OS | Debian 13 (trixie), native systemd services |

## Branches

- `main`: production releases
- `test`: test releases; all work lands here first

## Design

The house style "Signal" (colours, type, logo) lives in [brand/](brand/README.md); the web app imports `brand/tokens.css` directly. Interface sketches live in [docs/design](docs/design).

## License

GPL-3.0, see [LICENSE](LICENSE).
