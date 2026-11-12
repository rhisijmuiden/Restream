#!/usr/bin/env bash
# Restream updater. Runs as root, started by restream-updater.service when the web console
# drops a request file, or by hand: restream-update [--channel production|test]
#
# Steps: fetch branch -> install dependencies -> build -> migrate -> restart -> health check.
# If anything fails after the code changed, the previous commit is restored and rebuilt.
set -Euo pipefail

APP_DIR="/opt/restream"
DATA_DIR="/var/lib/restream"
REQUEST="$DATA_DIR/update-request/request.json"
STATUS_DIR="/var/lib/restream-updater"
STATUS="$STATUS_DIR/status.json"
LOG="$STATUS_DIR/update.log"
CHANNEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-request) shift ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

install -d -m 0750 -o root -g restream "$STATUS_DIR"

if [[ -z "$CHANNEL" && -f "$REQUEST" ]]; then
  # The request file is written by the unprivileged app: read at most 1 KB and accept only known values.
  CHANNEL=$(head -c 1024 "$REQUEST" | grep -oE '"channel":"(production|test)"' | head -1 | cut -d'"' -f4 || true)
  REQUESTED_BY=$(head -c 1024 "$REQUEST" | grep -oE '"requestedBy":"[^"]{1,254}"' | head -1 | cut -d'"' -f4 | tr -cd '[:alnum:]@._+-' || true)
  rm -f "$REQUEST"
fi
if [[ -z "$CHANNEL" ]]; then
  CURRENT=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
  CHANNEL=$([[ "$CURRENT" == "main" ]] && echo production || echo test)
fi
[[ "$CHANNEL" == "production" || "$CHANNEL" == "test" ]] || { echo "invalid channel" >&2; exit 2; }
BRANCH=$([[ "$CHANNEL" == "production" ]] && echo main || echo test)

STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FROM=$(git -C "$APP_DIR" rev-parse HEAD)
TO=""

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }
status() { # status <state> <step> [message]
  local tmp="$STATUS.tmp"
  printf '{"state":"%s","step":"%s","channel":"%s","from":"%s","to":"%s","startedAt":"%s","finishedAt":"%s","message":"%s"}\n' \
    "$1" "$2" "$CHANNEL" "$FROM" "$TO" "$STARTED" \
    "$([[ "$1" == running ]] || date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "${3:-}")" > "$tmp"
  chmod 0640 "$tmp"; chown root:restream "$tmp"; mv -f "$tmp" "$STATUS"
}
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

: > "$LOG"; chmod 0640 "$LOG"; chown root:restream "$LOG"
exec >>"$LOG" 2>&1

build() {
  cd "$APP_DIR" || return 1
  log "npm ci"; npm ci --no-audit --no-fund --loglevel=error || return 1
  log "build"; npm run build --silent || return 1
  printf '{"version":"%s","commit":"%s","branch":"%s","builtAt":"%s"}\n' \
    "$(node -p "require('./package.json').version")" "$(git rev-parse HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build-info.json
}

healthy() {
  for _ in $(seq 1 45); do
    curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

rollback() {
  log "FAILED: $1. Rolling back to ${FROM:0:7}."
  status running "rollback" "$1"
  git -C "$APP_DIR" checkout -f "$FROM" && build && systemctl restart restream && healthy \
    && { status rolled_back "done" "$1"; log "Previous version restored."; exit 1; }
  status failed "rollback" "$1; rollback also failed, see journalctl -u restream"
  log "Rollback failed."
  exit 1
}

log "Update to channel $CHANNEL (branch $BRANCH) requested${REQUESTED_BY:+ by $REQUESTED_BY}. Current commit ${FROM:0:7}."
status running "fetch"
if ! git -C "$APP_DIR" fetch --prune origin "$BRANCH"; then
  status failed "fetch" "Could not reach the git repository"; log "fetch failed"; exit 1
fi
TO=$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")
CURRENT_BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)
if [[ "$TO" == "$FROM" && "$CURRENT_BRANCH" == "$BRANCH" ]]; then
  log "Already on the latest commit."
  status success "done" "Already up to date"
  exit 0
fi

log "Checking out ${TO:0:7}"
status running "checkout"
git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH" || rollback "checkout failed"

status running "build"
build || rollback "build failed"

status running "migrate"
log "migrate"
/usr/local/bin/restream-cli migrate || rollback "database migration failed"

status running "restart"
log "restart"
systemctl restart restream
healthy || rollback "the new version did not start"

# Refresh the updater units shipped with the new version.
install -m 0644 "$APP_DIR"/deploy/systemd/restream*.service "$APP_DIR"/deploy/systemd/restream-updater.path /etc/systemd/system/ && systemctl daemon-reload

log "Done: now on ${TO:0:7} ($CHANNEL)."
status success "done" ""
