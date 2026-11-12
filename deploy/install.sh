#!/usr/bin/env bash
# Restream installer for a bare Debian 13 (trixie) server.
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | sudo bash -s -- \
#        --domain restream.example.com --email you@example.com
#
# Options:
#   --domain <name>        Public host name. With a domain, a Let's Encrypt certificate is requested.
#                          Without one, a self-signed certificate for the server IP is generated.
#   --email <address>      Email of the first administrator (also used for Let's Encrypt).
#   --channel <name>       Release channel: production (main branch, default) or test (test branch).
#   --repo <url>           Git repository (default https://github.com/rhisijmuiden/restream.git).
#   --skip-checks          Install even if the OS or the hardware is below the recommendation.
#   -y, --yes              Do not ask questions; use defaults for anything not given.
#
# Re-running the installer is safe: it keeps the database, secrets and users, and updates the code.
set -Eeuo pipefail

REPO_URL="https://github.com/rhisijmuiden/restream.git"
APP_DIR="/opt/restream"
ETC_DIR="/etc/restream"
DATA_DIR="/var/lib/restream"
STATUS_DIR="/var/lib/restream-updater"
NODE_MAJOR=22
DOMAIN=""
ADMIN_EMAIL=""
CHANNEL="production"
SKIP_CHECKS=0
ASSUME_YES=0

c_cyan=$'\e[36m'; c_red=$'\e[31m'; c_yellow=$'\e[33m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
step() { printf '\n%s==>%s %s%s%s\n' "$c_cyan" "$c_off" "$c_bold" "$*" "$c_off"; }
warn() { printf '%s!%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%sx%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
trap 'die "Installation failed on line $LINENO. Fix the problem above and run the installer again."' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run the installer as root (sudo)."
[[ "$CHANNEL" == "production" || "$CHANNEL" == "test" ]] || die "--channel must be production or test."
BRANCH=$([[ "$CHANNEL" == "production" ]] && echo main || echo test)

ask() { # ask <var> <prompt> [default]
  local __var=$1 __prompt=$2 __def=${3:-} __ans=""
  if [[ $ASSUME_YES -eq 1 || ! -t 0 && ! -e /dev/tty ]]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__prompt${__def:+ [$__def]}: " __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# --- Checks -------------------------------------------------------------------
step "Checking the server"
. /etc/os-release
if [[ "${ID:-}" != "debian" || "${VERSION_CODENAME:-}" != "trixie" ]]; then
  [[ $SKIP_CHECKS -eq 1 ]] || die "Restream supports Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}. Use --skip-checks to try anyway."
  warn "Not Debian 13 (${PRETTY_NAME:-unknown}); continuing because of --skip-checks."
fi
cpus=$(nproc)
mem_gb=$(awk '/MemTotal/ {printf "%d", ($2/1024/1024)+0.5}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "CPU cores: $cpus · RAM: ${mem_gb} GB · free disk: ${disk_gb} GB"
low=0
(( cpus >= 4 )) || { warn "Recommended: 4 vCPU or more (one 1080p50 ingest to several platforms)."; low=1; }
(( mem_gb >= 7 )) || { warn "Recommended: 8 GB RAM or more."; low=1; }
(( disk_gb >= 75 )) || { warn "Recommended: 80 GB disk (recordings need space)."; low=1; }
if (( low )) && [[ $SKIP_CHECKS -eq 0 ]]; then
  cont=""; ask cont "The server is below the recommendation. Continue? (y/N)" "n"
  [[ "$cont" =~ ^[yYjJ] ]] || die "Stopped. Use --skip-checks to install anyway."
fi

if [[ -z "$DOMAIN" ]]; then ask DOMAIN "Domain name for Restream (leave empty to use the IP address)" ""; fi
EXISTING_ENV=0; [[ -f "$ETC_DIR/restream.env" ]] && EXISTING_ENV=1
if [[ -z "$ADMIN_EMAIL" && $EXISTING_ENV -eq 0 ]]; then ask ADMIN_EMAIL "Email of the first administrator" "admin@${DOMAIN:-restream.local}"; fi

PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
HOST_NAME=${DOMAIN:-$PUBLIC_IP}
PUBLIC_URL="https://${HOST_NAME}"

# --- Packages -----------------------------------------------------------------
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg openssl nginx postgresql postgresql-contrib >/dev/null
if [[ -n "$DOMAIN" ]]; then apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  step "Installing Node.js $NODE_MAJOR (NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v), PostgreSQL $(psql --version | awk '{print $3}')"

# --- User and directories -----------------------------------------------------
step "Creating the restream user and directories"
id restream &>/dev/null || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin restream
install -d -m 0750 -o restream -g restream "$DATA_DIR" "$DATA_DIR/update-request"
install -d -m 0750 -o root -g restream "$ETC_DIR" "$STATUS_DIR"

# --- Code ---------------------------------------------------------------------
step "Fetching Restream ($CHANNEL channel, branch $BRANCH)"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R root:root "$APP_DIR"

# --- Database and secrets -----------------------------------------------------
step "Configuring PostgreSQL and secrets"
systemctl enable --now postgresql >/dev/null
if [[ $EXISTING_ENV -eq 1 ]]; then
  echo "Keeping existing configuration in $ETC_DIR/restream.env"
  # Update the public URL only when a domain was given explicitly.
  if [[ -n "$DOMAIN" ]]; then sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=${PUBLIC_URL}#" "$ETC_DIR/restream.env"; fi
else
  DB_PASS=$(openssl rand -hex 24)
  APP_KEY=$(openssl rand -hex 32)
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='restream'" | grep -q 1; then
    runuser -u postgres -- psql -qc "ALTER ROLE restream WITH LOGIN PASSWORD '${DB_PASS}'"
  else
    runuser -u postgres -- psql -qc "CREATE ROLE restream WITH LOGIN PASSWORD '${DB_PASS}'"
  fi
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='restream'" | grep -q 1 \
    || runuser -u postgres -- createdb -O restream restream
  runuser -u postgres -- psql -q -d restream -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
  umask 027
  cat > "$ETC_DIR/restream.env" <<EOF
# Restream configuration. Created by the installer on $(date -u +%Y-%m-%d).
NODE_ENV=production
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://restream:${DB_PASS}@127.0.0.1:5432/restream
APP_KEY=${APP_KEY}
PUBLIC_URL=${PUBLIC_URL}
COOKIE_SECURE=true
APP_DIR=${APP_DIR}
DATA_DIR=${DATA_DIR}
UPDATER_ENABLED=true
UPDATE_REQUEST_DIR=${DATA_DIR}/update-request
UPDATE_STATUS_DIR=${STATUS_DIR}
EOF
  umask 022
  chown root:restream "$ETC_DIR/restream.env"
  chmod 0640 "$ETC_DIR/restream.env"
fi

# --- Build --------------------------------------------------------------------
step "Building Restream (this takes a minute)"
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
printf '{"version":"%s","commit":"%s","branch":"%s","builtAt":"%s"}\n' \
  "$(node -p "require('./package.json').version")" "$(git rev-parse HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build-info.json

cat > /usr/local/bin/restream-cli <<'EOF'
#!/bin/sh
# Restream maintenance: create-admin, reset-password, reset-2fa, migrate
set -a; . /etc/restream/restream.env; set +a
exec runuser -u restream -- /usr/bin/node /opt/restream/server/dist/cli.js "$@"
EOF
chmod 0755 /usr/local/bin/restream-cli
cat > /usr/local/sbin/restream-update <<'EOF'
#!/bin/sh
# Update Restream from the shell: restream-update [--channel production|test]
install -m 0700 /opt/restream/deploy/update.sh /run/restream-update.sh && exec /bin/bash /run/restream-update.sh "$@"
EOF
chmod 0755 /usr/local/sbin/restream-update

step "Preparing the database"
restream-cli migrate
ADMIN_PASSWORD=""
if [[ -n "$ADMIN_EMAIL" ]]; then
  out=$(restream-cli create-admin --if-none --email "$ADMIN_EMAIL" --name "Administrator")
  ADMIN_PASSWORD=$(printf '%s\n' "$out" | awk '/^password:/ {print $2}')
fi

# --- Services -----------------------------------------------------------------
step "Installing services"
install -m 0644 deploy/systemd/restream.service deploy/systemd/restream-updater.service deploy/systemd/restream-updater.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now restream-updater.path >/dev/null
systemctl enable restream.service >/dev/null
systemctl restart restream.service

# --- Web server and TLS -------------------------------------------------------
step "Configuring nginx and HTTPS"
install -m 0644 deploy/nginx/restream-upgrade-map.conf /etc/nginx/conf.d/restream-upgrade-map.conf
rm -f /etc/nginx/sites-enabled/default
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
if [[ -z "$DOMAIN" || ! -f "$CERT" ]]; then
  # Self-signed certificate: used without a domain, and as a bootstrap until Let's Encrypt succeeds.
  install -d -m 0750 "$ETC_DIR/tls"
  if [[ ! -f "$ETC_DIR/tls/self-signed.pem" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=${HOST_NAME}" \
      -addext "subjectAltName=$([[ -n "$DOMAIN" ]] && echo "DNS:${DOMAIN}" || echo "IP:${PUBLIC_IP}")" \
      -keyout "$ETC_DIR/tls/self-signed.key" -out "$ETC_DIR/tls/self-signed.pem" 2>/dev/null
  fi
  CERT_IN_USE="$ETC_DIR/tls/self-signed.pem"; KEY_IN_USE="$ETC_DIR/tls/self-signed.key"
else
  CERT_IN_USE="$CERT"; KEY_IN_USE="$KEY"
fi
write_site() {
  sed -e "s#__SERVER_NAME__#${DOMAIN:-_}#g" -e "s#__CERT__#$1#g" -e "s#__KEY__#$2#g" \
    deploy/nginx/restream.conf > /etc/nginx/sites-available/restream.conf
  ln -sf /etc/nginx/sites-available/restream.conf /etc/nginx/sites-enabled/restream.conf
  nginx -t -q && systemctl reload-or-restart nginx
}
write_site "$CERT_IN_USE" "$KEY_IN_USE"
if [[ -n "$DOMAIN" && ! -f "$CERT" ]]; then
  le_contact=(--register-unsafely-without-email)
  [[ -n "$ADMIN_EMAIL" ]] && le_contact=(-m "$ADMIN_EMAIL")
  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos \
       "${le_contact[@]}" --deploy-hook "systemctl reload nginx"; then
    write_site "$CERT" "$KEY"
  else
    warn "Let's Encrypt failed (is DNS for $DOMAIN pointing here and port 80 open?). Using a self-signed certificate for now; run the installer again later."
  fi
fi

# --- Health -------------------------------------------------------------------
step "Waiting for Restream to start"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ "${ok:-0}" == 1 ]] || die "Restream did not start. See: journalctl -u restream -n 100"

trap - ERR
printf '\n%s%sRestream is installed.%s\n\n' "$c_bold" "$c_cyan" "$c_off"
echo "  Open:      ${PUBLIC_URL}"
echo "  Channel:   ${CHANNEL} (branch ${BRANCH}), version $(node -p "require('$APP_DIR/package.json').version")"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo "  Sign in:   ${ADMIN_EMAIL}"
  echo "  Password:  ${ADMIN_PASSWORD}   (temporary: you choose your own and set up 2FA at first sign-in)"
fi
echo
echo "  Maintenance: restream-cli reset-password --email <email> | reset-2fa --email <email>"
echo "  Logs:        journalctl -u restream -f"
echo "  Firewall:    allow TCP 80 and 443 (later releases also use 1935/RTMP and 8890/UDP for SRT)."
