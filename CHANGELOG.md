# Changelog

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
