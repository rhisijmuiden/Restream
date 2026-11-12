# Changelog

## 0.1.0 · Phase 0: foundation

- Installer for a bare Debian 13 server: PostgreSQL, Node.js 22, nginx with Let's Encrypt (or a self-signed certificate without a domain), systemd services. Checks the recommended hardware (4 vCPU, 8 GB RAM, 80 GB disk).
- Sign-in with password and mandatory TOTP two-factor authentication, single-use recovery codes, account lockout after repeated failures.
- Microsoft 365 (Entra ID) single sign-on via OpenID Connect, with optional group restriction and automatic account creation.
- Users with roles (administrator, operator, viewer), temporary passwords, 2FA reset, audit log.
- Admin console with the menu on the left, in the new "Signal" house style (see `brand/`).
- English by default, Dutch translation included; language per user.
- Info button with version, commit and server details.
- Update check against GitHub, update from the UI with automatic rollback, switching between the production (`main`) and test (`test`) channels.
