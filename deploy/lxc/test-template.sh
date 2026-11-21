#!/usr/bin/env bash
# Boots a built Restream CT template with systemd-nspawn and checks that the first start sets it up:
# sign-in details written, API healthy behind nginx, HTTPS answering. Used by CI; needs systemd-container.
#
#   sudo deploy/lxc/test-template.sh dist/restream-test-debian-13-amd64.tar.zst
set -Eeuo pipefail
TARBALL=$1
DIR=$(mktemp -d /var/tmp/restream-ct-test.XXXXXX)
MACHINE="restream-ct-test"
cleanup() {
  machinectl poweroff "$MACHINE" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do machinectl status "$MACHINE" >/dev/null 2>&1 || break; sleep 1; done
  machinectl terminate "$MACHINE" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "Extracting $TARBALL"
tar --numeric-owner -xaf "$TARBALL" -C "$DIR"
test -f "$DIR/etc/restream/firstboot-pending"
test ! -e "$DIR/etc/restream/restream.env"
printf 'ADMIN_EMAIL=ci@restream.local\nLANGUAGE=en\n' > "$DIR/etc/restream/firstboot.conf"
chmod 0600 "$DIR/etc/restream/firstboot.conf"

echo "Booting the container (host network)"
systemd-run --unit="$MACHINE" --quiet \
  systemd-nspawn --quiet --boot --machine="$MACHINE" --directory="$DIR" --console=passive

ok=0
for i in $(seq 1 180); do
  sleep 5
  if [[ -f "$DIR/root/restream-credentials.txt" && ! -f "$DIR/etc/restream/firstboot-pending" ]]; then ok=1; break; fi
  if [[ -f "$DIR/var/lib/restream/firstboot-failed" ]]; then break; fi
  (( i % 6 == 0 )) && { echo "  ${i}x5 s: $(grep '==>' "$DIR/var/log/restream-firstboot.log" 2>/dev/null | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"; }
done
echo "---- firstboot log ----"
sed 's/\x1b\[[0-9;]*m//g' "$DIR/var/log/restream-firstboot.log" || true
echo "-----------------------"
[[ $ok -eq 1 ]] || { echo "first start did not finish"; journalctl -u "$MACHINE" -n 100 --no-pager || true; exit 1; }

echo "Sign-in details (test container only):"
cat "$DIR/root/restream-credentials.txt"
lines=$(wc -l < "$DIR/root/restream-credentials.txt")
[[ $lines -eq 3 ]] || { echo "expected exactly URL, username and password"; exit 1; }
grep -q 'ci@restream.local' "$DIR/root/restream-credentials.txt"

curl -fsS http://127.0.0.1:8080/api/health; echo
curl -kfsS -o /dev/null -w 'HTTPS %{http_code}\n' https://127.0.0.1/
curl -kfsS https://127.0.0.1/api/health; echo
grep -q '^RTMP_PORT=1935$' "$DIR/etc/restream/restream.env"
grep -q 'rtmpAddress: :1935' "$DIR/etc/restream-media/mediamtx.yml"
echo "Template boots and sets itself up."
