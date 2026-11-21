#!/usr/bin/env bash
# Builds the Restream LXC container template (a Debian 13 root file system as .tar.zst) for Proxmox VE.
#
#   sudo deploy/lxc/build-template.sh --channel test --out dist/
#
# The image holds Debian 13, PostgreSQL, nginx, Node.js, FFmpeg, MediaMTX and a built Restream from this
# checkout, but no secrets: database password, APP_KEY, administrator and certificate are made on the first start
# of every container (restream-firstboot.service), so two containers from one template never share them.
#
# Needs: debootstrap, debian-archive-keyring, zstd, git, curl. Runs on Debian or Ubuntu, as root.
set -Eeuo pipefail

CHANNEL="production"
OUT_DIR="dist"
SUITE="trixie"
MIRROR="http://deb.debian.org/debian"
ROOTFS=""
KEEP=0
SRC_DIR=$(cd "$(dirname "$0")/../.." && pwd)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --mirror) MIRROR="${2:-}"; shift 2 ;;
    --rootfs) ROOTFS="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ "$CHANNEL" == "production" || "$CHANNEL" == "test" ]] || { echo "--channel must be production or test" >&2; exit 2; }
BRANCH=$([[ "$CHANNEL" == "production" ]] && echo main || echo test)
VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SRC_DIR/package.json" | head -1)
NAME="restream-${CHANNEL}-debian-13-amd64"
ROOTFS=${ROOTFS:-$(mktemp -d /var/tmp/restream-rootfs.XXXXXX)}
mkdir -p "$OUT_DIR"; OUT_DIR=$(cd "$OUT_DIR" && pwd)

log() { printf '\n\e[36m==>\e[0m \e[1m%s\e[0m\n' "$*"; }
unmount_all() {
  local m
  for m in dev/pts dev proc sys run; do mountpoint -q "$ROOTFS/$m" && umount -l "$ROOTFS/$m"; done
  return 0
}
cleanup() { unmount_all; if [[ $KEEP -eq 0 ]]; then rm -rf "$ROOTFS"; fi; }
trap cleanup EXIT

# Packages Proxmox expects in a Debian container (network via ifupdown, console via getty, SSH),
# plus what the installer needs to run.
PACKAGES=(
  systemd systemd-sysv dbus ifupdown isc-dhcp-client iproute2 iputils-ping openssh-server
  ca-certificates curl git gnupg openssl whiptail less nano procps cron logrotate tzdata
  bash-completion apt-utils
)

log "debootstrap Debian $SUITE"
keyring=()
[[ -f /usr/share/keyrings/debian-archive-keyring.gpg ]] && keyring=(--keyring /usr/share/keyrings/debian-archive-keyring.gpg)
script=()
[[ -e /usr/share/debootstrap/scripts/$SUITE ]] || script=(/usr/share/debootstrap/scripts/sid)
debootstrap --variant=minbase --arch=amd64 "${keyring[@]}" --include="$(IFS=,; echo "${PACKAGES[*]}")" \
  "$SUITE" "$ROOTFS" "$MIRROR" "${script[@]}"

log "Preparing the chroot"
cat > "$ROOTFS/etc/apt/sources.list" <<EOF
deb http://deb.debian.org/debian ${SUITE} main
deb http://deb.debian.org/debian ${SUITE}-updates main
deb http://security.debian.org/debian-security ${SUITE}-security main
EOF
# No services start inside the chroot.
printf '#!/bin/sh\nexit 101\n' > "$ROOTFS/usr/sbin/policy-rc.d"; chmod 0755 "$ROOTFS/usr/sbin/policy-rc.d"
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
mount -t proc proc "$ROOTFS/proc"
mount -t sysfs sys "$ROOTFS/sys"
mount --bind /dev "$ROOTFS/dev"
mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t tmpfs tmpfs "$ROOTFS/run"
echo "restream" > "$ROOTFS/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\trestream\n::1\t\tlocalhost ip6-localhost ip6-loopback\n' > "$ROOTFS/etc/hosts"
echo "LANG=C.UTF-8" > "$ROOTFS/etc/default/locale"

log "Copying Restream ($CHANNEL, branch $BRANCH, v$VERSION) from $SRC_DIR"
git clone -q --no-local "$SRC_DIR" "$ROOTFS/opt/restream"
git -C "$ROOTFS/opt/restream" remote set-url origin "https://github.com/rhisijmuiden/restream.git"

log "Running the installer in image mode"
chroot "$ROOTFS" /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 TERM=dumb \
  /bin/bash /opt/restream/deploy/install.sh --build-image --no-fetch --channel "$CHANNEL"

log "Cleaning up"
chroot "$ROOTFS" apt-get clean
rm -rf "$ROOTFS"/var/lib/apt/lists/* "$ROOTFS"/root/.npm "$ROOTFS"/root/.cache "$ROOTFS"/tmp/* "$ROOTFS"/var/tmp/*
rm -f "$ROOTFS/usr/sbin/policy-rc.d" "$ROOTFS"/etc/ssh/ssh_host_*
: > "$ROOTFS/etc/resolv.conf"
: > "$ROOTFS/etc/machine-id"; rm -f "$ROOTFS/var/lib/dbus/machine-id"
find "$ROOTFS/var/log" -type f -exec truncate -s 0 {} +
install -d -m 0755 "$ROOTFS/etc/issue.d"
printf 'Restream %s: being set up on this first start. Log in as root to see the address, user name and password.\n\n' "$VERSION" \
  > "$ROOTFS/etc/issue.d/restream.issue"
printf '{"name":"restream","version":"%s","channel":"%s","commit":"%s","builtAt":"%s"}\n' \
  "$VERSION" "$CHANNEL" "$(git -C "$ROOTFS/opt/restream" rev-parse HEAD)" "$(date -u +%FT%TZ)" > "$ROOTFS/etc/restream-template.json"
unmount_all

log "Packing $NAME.tar.zst"
tar --numeric-owner --xattrs --acls -C "$ROOTFS" \
  --exclude='./dev/*' --exclude='./proc/*' --exclude='./sys/*' --exclude='./run/*' \
  -cf - . | zstd -q -T0 -19 -o "$OUT_DIR/$NAME.tar.zst" -f
(cd "$OUT_DIR" && sha256sum "$NAME.tar.zst" > "$NAME.tar.zst.sha256")
ls -lh "$OUT_DIR/$NAME.tar.zst"
cat "$OUT_DIR/$NAME.tar.zst.sha256"
