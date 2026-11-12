# Restream

Self-hosted stream multiplexer for Debian 13, installed with a single installer script on a bare server. Send one RTMP or SRT stream to the server, press **Go live**, and Restream distributes it to YouTube, Facebook, Twitch, Instagram, Kick, X and your own RTMP/SRT servers, each in its own bitrate and resolution.

> Status: phase 0 (foundation) is done: installer, sign-in with 2FA and Microsoft 365, users, admin console, EN/NL, updates from the UI. Streaming arrives in phase 1. See [docs/ROADMAP.md](docs/ROADMAP.md) (Dutch) and [CHANGELOG.md](CHANGELOG.md).

## Install

On a fresh Debian 13 server (recommended: 4 vCPU, 8 GB RAM, 80 GB SSD, 100 Mbps or more), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash -s -- \
  --domain restream.example.com --email you@example.com
```

- Without `--domain` the server uses its IP address and a self-signed certificate.
- `--channel test` installs the test channel (`test` branch) instead of production (`main`). To try the test channel before anything is on `main`, fetch the script from the `test` branch as well.
- At the end the installer prints the sign-in address and a temporary password. At first sign-in you choose your own password and set up two-factor authentication.
- Running the installer again is safe; it keeps the database, secrets and users.

Maintenance on the server:

| Command | What it does |
| --- | --- |
| `restream-cli reset-password --email <e>` | New temporary password for a user |
| `restream-cli reset-2fa --email <e>` | User sets up 2FA again at next sign-in |
| `restream-update [--channel production\|test]` | Update from the shell (same as the Updates page) |
| `journalctl -u restream -f` | Application log |

### How updates work

The web console never runs privileged commands. When an administrator clicks **Install update** or switches channel, the app writes a small request file. A root-owned systemd path unit (`restream-updater.path`) picks it up and runs `deploy/update.sh`: fetch the branch, `npm ci`, build, migrate, restart, health check. If any step fails, the previous version is rebuilt and restored automatically. Progress and the log are shown live on the Updates page.

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

## Planned features

- RTMP and SRT ingest, only accepted with a configured stream key
- Live dashboard with ingest health and preview
- Destinations via stream key or linked account (OAuth), with per-destination encoding profiles
- Go live / end broadcast per stream and per destination, with automatic reconnect
- Hotlink URLs (HLS / WebRTC) and an embeddable player for websites, optionally restricted to allowed domains or tokens
- Scheduled live events, registered on the platforms as upcoming broadcasts
- One-click recording of the broadcast
- Live viewer counts per platform and a unified chat
- Login-only web interface with users, roles and 2FA

Standard for every release:

- Configurable SMTP mail server (TLS / STARTTLS)
- Full and incremental backups to FTP, FTPS and SCP, with restore from the remote location
- Info button with the current version, update check and update from the UI
- `main` (production) and `test` release channels, switchable in the UI
- English by default, Dutch translation included

## Stack

| Part | Choice |
| --- | --- |
| Ingest (phase 1) | MediaMTX (RTMP + SRT) |
| Distribution (phase 1) | FFmpeg, one process per destination |
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
