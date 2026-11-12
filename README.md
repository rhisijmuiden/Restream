# Restream

Self-hosted stream multiplexer for Debian 13. Send one RTMP or SRT stream to the server, press **Go live**, and Restream distributes it to YouTube, Facebook, Twitch, Instagram, Kick, X and your own RTMP/SRT servers, each in its own bitrate and resolution.

> Status: planning. See [docs/ROADMAP.md](docs/ROADMAP.md) (Dutch) for phases and priorities.

## Planned features

- RTMP and SRT ingest, only accepted with a configured stream key
- Live dashboard with ingest health and preview
- Destinations via stream key or linked account (OAuth), with per-destination encoding profiles
- Go live / end broadcast per stream and per destination, with automatic reconnect
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

## Planned stack

| Part | Choice |
| --- | --- |
| Ingest | MediaMTX (RTMP + SRT) |
| Distribution | FFmpeg, one process per destination |
| Backend | Node.js 22, TypeScript, Fastify |
| Database | PostgreSQL 17 |
| Jobs & scheduling | Redis + BullMQ |
| Frontend | React, Vite, Tailwind CSS, shadcn/ui, i18next |
| Web server | Nginx + Let's Encrypt |
| OS | Debian 13 (trixie), native systemd services |

## Branches

- `main`: production releases
- `test`: test releases; all work lands here first

## Design

Interface sketches (Design Component files) live in [docs/design](docs/design).

## License

GPL-3.0, see [LICENSE](LICENSE).
