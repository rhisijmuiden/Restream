# shellcheck shell=bash
# Media stack for Restream: FFmpeg (outputs) and MediaMTX (RTMP/SRT ingest, HLS/WebRTC playback).
# Sourced by install.sh and update.sh, which run as root. Safe to run again: it only changes what differs.

MEDIAMTX_VERSION="v1.21.3"
# Public ports: RTMP ingest, SRT ingest, WebRTC media (UDP, with TCP as fallback).
MEDIA_PORTS=(1935/tcp 8890/udp 8189/udp 8189/tcp)
# MediaMTX config lives in its own directory: /etc/restream holds secrets and is closed to the mediamtx user,
# and MediaMTX needs to read the directory of its config file to watch it for changes.
MEDIA_ETC_DIR="/etc/restream-media"

media_log() { if declare -F log >/dev/null; then log "$@"; else echo "$@"; fi; }

media_arch() {
  case "$(dpkg --print-architecture)" in
    amd64) echo amd64 ;;
    arm64) echo arm64 ;;
    armhf) echo armv7 ;;
    *) return 1 ;;
  esac
}

# install_mediamtx: downloads the pinned MediaMTX release and verifies its checksum.
install_mediamtx() {
  local arch tmp file base
  arch=$(media_arch) || { media_log "MediaMTX: unsupported CPU architecture $(dpkg --print-architecture)"; return 1; }
  file="mediamtx_${MEDIAMTX_VERSION}_linux_${arch}.tar.gz"
  base="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}"
  tmp=$(mktemp -d)
  media_log "Downloading MediaMTX ${MEDIAMTX_VERSION} (${arch})"
  if ! curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file" || ! curl -fsSL --retry 3 -o "$tmp/checksums.sha256" "$base/checksums.sha256"; then
    rm -rf "$tmp"; media_log "MediaMTX download failed"; return 1
  fi
  if ! (cd "$tmp" && grep -E "[ *]${file}\$" checksums.sha256 | sha256sum -c --quiet -); then
    rm -rf "$tmp"; media_log "MediaMTX checksum mismatch"; return 1
  fi
  tar -xzf "$tmp/$file" -C "$tmp" mediamtx || { rm -rf "$tmp"; return 1; }
  install -m 0755 "$tmp/mediamtx" /usr/local/bin/mediamtx.new && mv -f /usr/local/bin/mediamtx.new /usr/local/bin/mediamtx
  rm -rf "$tmp"
}

# ensure_media <app_dir> <etc_dir>: FFmpeg, MediaMTX binary, user, config and service.
ensure_media() {
  local app_dir=$1 etc_dir=$2 changed=0 current host tmpcfg
  if ! command -v ffmpeg >/dev/null; then
    media_log "Installing FFmpeg"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null || return 1
  fi

  current=""
  [[ -x /usr/local/bin/mediamtx ]] && current=$(/usr/local/bin/mediamtx --version 2>/dev/null | head -1 | tr -d '[:space:]')
  if [[ "$current" != "$MEDIAMTX_VERSION" ]]; then
    install_mediamtx || return 1
    changed=1
  fi

  id mediamtx &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mediamtx

  # WebRTC viewers connect to the public host name (or IP) of this server.
  host=$(sed -n 's#^PUBLIC_URL=https\{0,1\}://\([^/:]*\).*#\1#p' "$etc_dir/restream.env" 2>/dev/null | head -1)
  [[ -n "$host" ]] || host=$(hostname -I 2>/dev/null | awk '{print $1}')
  install -d -m 0750 -o root -g mediamtx "$MEDIA_ETC_DIR"
  tmpcfg=$(mktemp)
  sed "s#__PUBLIC_HOST__#${host}#g" "$app_dir/deploy/mediamtx/mediamtx.yml" > "$tmpcfg"
  if ! cmp -s "$tmpcfg" "$MEDIA_ETC_DIR/mediamtx.yml"; then
    install -m 0640 -o root -g mediamtx "$tmpcfg" "$MEDIA_ETC_DIR/mediamtx.yml"
    changed=1
  fi
  rm -f "$tmpcfg"
  # Versions up to 1.2.0 put the config in $etc_dir, where MediaMTX could not read it.
  rm -f "$etc_dir/mediamtx.yml"

  if ! cmp -s "$app_dir/deploy/systemd/restream-media.service" /etc/systemd/system/restream-media.service; then
    install -m 0644 "$app_dir/deploy/systemd/restream-media.service" /etc/systemd/system/restream-media.service
    systemctl daemon-reload
    changed=1
  fi
  systemctl enable restream-media.service >/dev/null 2>&1
  if (( changed )) || ! systemctl is-active --quiet restream-media.service; then
    media_log "Starting the media server (MediaMTX ${MEDIAMTX_VERSION})"
    systemctl restart restream-media.service
  fi
}

# open_firewall: adds the web and media ports to an active ufw or firewalld. Never enables a firewall by itself.
open_firewall() {
  local p
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for p in 80/tcp 443/tcp "${MEDIA_PORTS[@]}"; do ufw allow "$p" >/dev/null; done
    media_log "Firewall (ufw): opened 80/tcp, 443/tcp, ${MEDIA_PORTS[*]}"
    return 0
  fi
  if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    for p in 80/tcp 443/tcp "${MEDIA_PORTS[@]}"; do firewall-cmd --quiet --permanent --add-port="$p"; done
    firewall-cmd --quiet --reload
    media_log "Firewall (firewalld): opened 80/tcp, 443/tcp, ${MEDIA_PORTS[*]}"
    return 0
  fi
  return 1
}

# enable_ufw: installs and enables ufw with SSH, web and media ports open (installer option --firewall).
enable_ufw() {
  local ports p
  command -v ufw >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null || return 1
  ports=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}')
  for p in ${ports:-22}; do ufw allow "${p}/tcp" >/dev/null; done
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  for p in 80/tcp 443/tcp "${MEDIA_PORTS[@]}"; do ufw allow "$p" >/dev/null; done
  ufw --force enable >/dev/null
  media_log "Firewall (ufw) enabled: SSH ${ports:-22}/tcp, 80/tcp, 443/tcp, ${MEDIA_PORTS[*]}"
}
