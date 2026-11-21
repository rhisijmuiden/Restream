#!/usr/bin/env bash
# Restream on Proxmox VE: creates an LXC container from the Restream CT template and sets it up.
# Run on the Proxmox host as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/proxmox/restream-ct.sh)"
#
# The wizard asks for the container (ID, name, CPU, memory, disk, storage, network) and Restream's settings
# (domain, administrator, channel). It downloads the template into CT Templates when needed, creates an
# unprivileged container with nesting, starts it and shows the address, user name and password.
#
# Options: --channel production|test, --lang en|nl, --refresh (download the template again), -h.
# The same template can be downloaded in the Proxmox GUI: <storage> > CT Templates > Download from URL.
set -Eeuo pipefail

REPO="rhisijmuiden/restream"
CHANNEL=""
UI_LANG=""
REFRESH=0

declare -A MSG_en=(
  [backtitle]="Restream for Proxmox VE"
  [lang_text]="Choose the language.\nKies de taal."
  [intro]="This creates a new LXC container with Restream:\n\n  - unprivileged, with nesting (needed by systemd in Debian 13)\n  - Debian 13 with PostgreSQL, nginx, Node.js, FFmpeg and MediaMTX\n  - set up on its first start (about two minutes)\n\nRecommended: 4 cores, 8 GB memory, 80 GB disk."
  [channel]="Which Restream version? You can switch later in the console under Info > Updates."
  [ch_prod]="Production (stable)"
  [ch_test]="Test (newest features)"
  [ctid]="Container ID:"
  [ctid_bad]="ID %s is not free or not a number from 100 upwards."
  [hostname]="Host name of the container:"
  [cores]="CPU cores:"
  [memory]="Memory in MB:"
  [disk]="Disk size in GB:"
  [number_bad]="Enter a whole number."
  [rstore]="Storage for the container disk:"
  [tstore]="Storage for the CT template (CT Templates):"
  [bridge]="Network bridge:"
  [ipmode]="IPv4 address of the container:"
  [dhcp]="DHCP (automatic)"
  [static]="Static address"
  [ip]="IPv4 address with prefix, for example 192.168.1.50/24:"
  [gw]="Gateway, for example 192.168.1.1:"
  [vlan]="VLAN tag (leave empty for none):"
  [domain]="Public domain name for Restream (optional), for example restream.example.com.\nWith a domain, Let's Encrypt is tried (ports 80 and 443 must reach this container).\n\nLeave empty to use the container's IP address with a self-signed certificate."
  [email]="Email address of the administrator (this is the user name):"
  [email_bad]="That is not a valid email address."
  [summary]="Create this container?\n\n  ID / name:   %s / %s\n  Resources:   %s cores, %s MB, %s GB on %s\n  Network:     %s, %s\n  Restream:    %s, %s\n  Admin:       %s"
  [yes]="Yes"
  [no]="No"
  [cancelled]="Cancelled. Nothing was created."
  [s_template]="Getting the CT template"
  [s_present]="Template already present: %s"
  [s_download]="Downloading %s"
  [s_verify]="Checking the download"
  [s_create]="Creating container %s"
  [s_start]="Starting the container; Restream sets itself up (about two minutes)"
  [waiting]="still setting up"
  [failed]="Setting up Restream failed. Last lines of /var/log/restream-firstboot.log in the container:"
  [timeout]="Restream is not ready after 20 minutes. Look inside the container: pct enter %s, then tail -f /var/log/restream-firstboot.log"
  [ready_title]="Restream is ready"
  [url]="Open"
  [user]="Username"
  [pass]="Password"
  [rootpw]="Root password of the container (for the Proxmox console and SSH), at least 8 characters:"
  [rootpw2]="Type the root password again:"
  [rootpw_bad]="The passwords differ or are shorter than 8 characters."
  [no_pct]="This script runs on a Proxmox VE host (pct not found)."
)
declare -A MSG_nl=(
  [backtitle]="Restream voor Proxmox VE"
  [lang_text]="Choose the language.\nKies de taal."
  [intro]="Dit maakt een nieuwe LXC-container met Restream:\n\n  - unprivileged, met nesting (nodig voor systemd in Debian 13)\n  - Debian 13 met PostgreSQL, nginx, Node.js, FFmpeg en MediaMTX\n  - ingericht bij de eerste start (ongeveer twee minuten)\n\nAanbevolen: 4 cores, 8 GB geheugen, 80 GB schijf."
  [channel]="Welke versie van Restream? Wisselen kan later in de console onder Info > Updates."
  [ch_prod]="Productie (stabiel)"
  [ch_test]="Test (nieuwste functies)"
  [ctid]="Container-ID:"
  [ctid_bad]="ID %s is niet vrij of geen getal vanaf 100."
  [hostname]="Hostnaam van de container:"
  [cores]="CPU-cores:"
  [memory]="Geheugen in MB:"
  [disk]="Schijfgrootte in GB:"
  [number_bad]="Vul een heel getal in."
  [rstore]="Opslag voor de containerschijf:"
  [tstore]="Opslag voor de CT-template (CT Templates):"
  [bridge]="Netwerkbridge:"
  [ipmode]="IPv4-adres van de container:"
  [dhcp]="DHCP (automatisch)"
  [static]="Vast adres"
  [ip]="IPv4-adres met prefix, bijvoorbeeld 192.168.1.50/24:"
  [gw]="Gateway, bijvoorbeeld 192.168.1.1:"
  [vlan]="VLAN-tag (leeg voor geen):"
  [domain]="Openbare domeinnaam voor Restream (optioneel), bijvoorbeeld restream.voorbeeld.nl.\nMet een domein wordt Let's Encrypt geprobeerd (poort 80 en 443 moeten deze container bereiken).\n\nLaat leeg om het IP-adres van de container te gebruiken met een zelfondertekend certificaat."
  [email]="E-mailadres van de beheerder (dit is de gebruikersnaam):"
  [email_bad]="Dat is geen geldig e-mailadres."
  [summary]="Deze container aanmaken?\n\n  ID / naam:   %s / %s\n  Middelen:    %s cores, %s MB, %s GB op %s\n  Netwerk:     %s, %s\n  Restream:    %s, %s\n  Beheerder:   %s"
  [yes]="Ja"
  [no]="Nee"
  [cancelled]="Afgebroken. Er is niets aangemaakt."
  [s_template]="CT-template ophalen"
  [s_present]="Template is er al: %s"
  [s_download]="%s downloaden"
  [s_verify]="Download controleren"
  [s_create]="Container %s aanmaken"
  [s_start]="Container starten; Restream richt zichzelf in (ongeveer twee minuten)"
  [waiting]="nog bezig"
  [failed]="Het inrichten van Restream is mislukt. Laatste regels van /var/log/restream-firstboot.log in de container:"
  [timeout]="Restream is na 20 minuten nog niet klaar. Kijk in de container: pct enter %s, en dan tail -f /var/log/restream-firstboot.log"
  [ready_title]="Restream is klaar"
  [url]="Openen"
  [user]="Gebruikersnaam"
  [pass]="Wachtwoord"
  [rootpw]="Root-wachtwoord van de container (voor de Proxmox-console en SSH), minstens 8 tekens:"
  [rootpw2]="Typ het root-wachtwoord nog een keer:"
  [rootpw_bad]="De wachtwoorden verschillen of zijn korter dan 8 tekens."
  [no_pct]="Dit script draait op een Proxmox VE-host (pct niet gevonden)."
)
t() {
  local key=$1 fmt; shift
  if [[ "$UI_LANG" == "nl" && -n "${MSG_nl[$key]:-}" ]]; then fmt=${MSG_nl[$key]}; else fmt=${MSG_en[$key]:-$key}; fi
  # shellcheck disable=SC2059
  printf "$fmt" "$@"
}

c_cyan=$'\e[36m'; c_red=$'\e[31m'; c_green=$'\e[32m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
step() { printf '\n%s==>%s %s%s%s\n' "$c_cyan" "$c_off" "$c_bold" "$*" "$c_off"; }
die()  { printf '%sx%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
trap 'die "Failed on line $LINENO."' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --lang) UI_LANG="${2:-}"; shift 2 ;;
    --refresh) REFRESH=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root on the Proxmox host."
command -v pct >/dev/null && command -v pvesm >/dev/null || die "$(t no_pct)"
command -v whiptail >/dev/null || die "whiptail is missing: apt install whiptail"

wt() { whiptail --backtitle "$(t backtitle)" "$@" 3>&1 1>/dev/tty 2>&3 </dev/tty; }
cancel() { clear >/dev/tty; echo "$(t cancelled)"; exit 1; }
# input <var> <text> <default>
input() { local __v; __v=$(wt --inputbox "$2" 14 74 "$3") || cancel; printf -v "$1" '%s' "$(tr -d '[:space:]' <<<"$__v")"; }
# menu <var> <text> <default> <tag> <label>...
menu() { local __var=$1 text=$2 def=$3 __v; shift 3; __v=$(wt --notags --default-item "$def" --menu "$text" 18 74 8 "$@") || cancel; printf -v "$__var" '%s' "$__v"; }
number() { # number <var> <text> <default>
  while true; do input "$1" "$2" "$3"; [[ "${!1}" =~ ^[0-9]+$ ]] && return; wt --msgbox "$(t number_bad)" 8 50 || cancel; done
}

# --- Wizard ---------------------------------------------------------------------
if [[ -z "$UI_LANG" ]]; then menu UI_LANG "$(t lang_text)" en en "English" nl "Nederlands"; fi
[[ "$UI_LANG" == "nl" ]] || UI_LANG=en
wt --title "Restream" --msgbox "$(t intro)" 16 74 || cancel
if [[ -z "$CHANNEL" ]]; then menu CHANNEL "$(t channel)" production production "$(t ch_prod)" test "$(t ch_test)"; fi
[[ "$CHANNEL" == "production" || "$CHANNEL" == "test" ]] || die "--channel must be production or test."

ctid_free() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 100 )) && ! pct status "$1" >/dev/null 2>&1 && ! qm status "$1" >/dev/null 2>&1; }
CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo 100)
while true; do input CTID "$(t ctid)" "$CTID"; ctid_free "$CTID" && break; wt --msgbox "$(t ctid_bad "$CTID")" 8 60 || cancel; done
input CT_HOSTNAME "$(t hostname)" "restream"; CT_HOSTNAME=${CT_HOSTNAME:-restream}
number CORES "$(t cores)" 4
number MEMORY "$(t memory)" 8192
number DISK "$(t disk)" 80

storage_items() { # storage_items <content>: "name" "name (type, free GB)" pairs
  pvesm status -content "$1" 2>/dev/null | awk 'NR > 1 && $3 == "active" {printf "%s\n%s (%s, %.0f GB free)\n", $1, $1, $2, $6 / 1048576}'
}
mapfile -t ritems < <(storage_items rootdir)
(( ${#ritems[@]} )) || die "No active storage for container disks (content type rootdir)."
menu RSTORE "$(t rstore)" "${ritems[0]}" "${ritems[@]}"
mapfile -t titems < <(storage_items vztmpl)
(( ${#titems[@]} )) || die "No active storage for CT templates (content type vztmpl)."
tdef=${titems[0]}; for ((i = 0; i < ${#titems[@]}; i += 2)); do [[ "${titems[i]}" == local ]] && tdef=local; done
menu TSTORE "$(t tstore)" "$tdef" "${titems[@]}"

mapfile -t bridges < <(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1)
(( ${#bridges[@]} )) || bridges=(vmbr0)
bitems=(); for b in "${bridges[@]}"; do bitems+=("$b" "$b"); done
bdef=${bridges[0]}; for b in "${bridges[@]}"; do [[ "$b" == vmbr0 ]] && bdef=vmbr0; done
menu BRIDGE "$(t bridge)" "$bdef" "${bitems[@]}"
menu IPMODE "$(t ipmode)" dhcp dhcp "$(t dhcp)" static "$(t static)"
IP=dhcp; GW=""
if [[ "$IPMODE" == static ]]; then
  while true; do input IP "$(t ip)" ""; [[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] && break; done
  while true; do input GW "$(t gw)" ""; [[ "$GW" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && break; done
fi
input VLAN "$(t vlan)" ""; [[ -z "$VLAN" || "$VLAN" =~ ^[0-9]+$ ]] || VLAN=""

input DOMAIN "$(t domain)" ""; DOMAIN=${DOMAIN,,}
ADMIN_EMAIL="admin@${DOMAIN:-restream.local}"
while true; do input ADMIN_EMAIL "$(t email)" "$ADMIN_EMAIL"; [[ "$ADMIN_EMAIL" =~ ^[^@]+@[^@]+$ ]] && break; wt --msgbox "$(t email_bad)" 8 50 || cancel; done

while true; do
  ROOT_PASSWORD=$(wt --passwordbox "$(t rootpw)" 12 74) || cancel
  pw2=$(wt --passwordbox "$(t rootpw2)" 10 74) || cancel
  [[ ${#ROOT_PASSWORD} -ge 8 && "$ROOT_PASSWORD" == "$pw2" ]] && break
  wt --msgbox "$(t rootpw_bad)" 8 60 || cancel
done
unset pw2

ch_label=$(t ch_prod); [[ "$CHANNEL" == test ]] && ch_label=$(t ch_test)
net_label="$IP${GW:+ via $GW}${VLAN:+, VLAN $VLAN}"
wt --title "Restream" --yes-button "$(t yes)" --no-button "$(t no)" --yesno \
  "$(t summary "$CTID" "$CT_HOSTNAME" "$CORES" "$MEMORY" "$DISK" "$RSTORE" "$BRIDGE" "$net_label" "$ch_label" "${DOMAIN:-IP}" "$ADMIN_EMAIL")" 18 74 || cancel
clear >/dev/tty

# --- Template -------------------------------------------------------------------
FILE="restream-${CHANNEL}-debian-13-amd64.tar.zst"
BASE_URL="https://github.com/${REPO}/releases/download/lxc-${CHANNEL}"
step "$(t s_template)"
TPATH=$(pvesm path "${TSTORE}:vztmpl/${FILE}")
remote_sum=$(curl -fsSL "${BASE_URL}/${FILE}.sha256" | awk '{print $1}') || die "Could not reach ${BASE_URL}/${FILE}.sha256"
[[ "$remote_sum" =~ ^[0-9a-f]{64}$ ]] || die "No valid checksum at ${BASE_URL}/${FILE}.sha256"
if [[ $REFRESH -eq 0 && -f "$TPATH" ]] && [[ "$(sha256sum "$TPATH" | awk '{print $1}')" == "$remote_sum" ]]; then
  t s_present "$TPATH"; echo
else
  t s_download "$FILE"; echo
  install -d "$(dirname "$TPATH")"
  curl -fL --retry 3 --progress-bar -o "${TPATH}.part" "${BASE_URL}/${FILE}"
  step "$(t s_verify)"
  [[ "$(sha256sum "${TPATH}.part" | awk '{print $1}')" == "$remote_sum" ]] || { rm -f "${TPATH}.part"; die "Checksum mismatch; try again."; }
  mv -f "${TPATH}.part" "$TPATH"
fi

# --- Container --------------------------------------------------------------------
step "$(t s_create "$CTID")"
net0="name=eth0,bridge=${BRIDGE},ip=${IP}${GW:+,gw=${GW}}${VLAN:+,tag=${VLAN}}"
pct create "$CTID" "${TSTORE}:vztmpl/${FILE}" \
  --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap 1024 \
  --rootfs "${RSTORE}:${DISK}" --net0 "$net0" \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --password "$ROOT_PASSWORD" --tags restream --description "Restream (${CHANNEL})"

# Answers for the first start. The container is unprivileged: its root is uid 100000 on the host.
mnt=$(pct mount "$CTID" | sed -n "s/.*'\(.*\)'.*/\1/p")
[[ -d "$mnt/etc/restream" ]] || { pct unmount "$CTID" || true; die "The template has no /etc/restream; is it a Restream template?"; }
{
  echo "DOMAIN=$DOMAIN"
  echo "ADMIN_EMAIL=$ADMIN_EMAIL"
  echo "LANGUAGE=$UI_LANG"
} > "$mnt/etc/restream/firstboot.conf"
chmod 0600 "$mnt/etc/restream/firstboot.conf"
chown 100000:100000 "$mnt/etc/restream/firstboot.conf"
pct unmount "$CTID"

step "$(t s_start)"
pct start "$CTID"
ready=0
for i in $(seq 1 240); do
  sleep 5
  if pct exec "$CTID" -- test -f /root/restream-credentials.txt 2>/dev/null \
     && ! pct exec "$CTID" -- test -f /etc/restream/firstboot-pending 2>/dev/null; then ready=1; break; fi
  if pct exec "$CTID" -- test -f /var/lib/restream/firstboot-failed 2>/dev/null; then
    echo; t failed; echo
    pct exec "$CTID" -- tail -n 25 /var/log/restream-firstboot.log || true
    exit 1
  fi
  last=$(pct exec "$CTID" -- sh -c "grep '==>' /var/log/restream-firstboot.log 2>/dev/null | tail -1" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' || true)
  printf '\r  %3ss  %-70.70s' "$((i * 5))" "${last:-$(t waiting)}"
done
echo
(( ready )) || die "$(t timeout "$CTID")"

creds=$(pct exec "$CTID" -- cat /root/restream-credentials.txt)
url=$(sed -n '1s/^ *[^:]*: *//p' <<<"$creds")
user=$(sed -n '2s/^ *[^:]*: *//p' <<<"$creds")
pass=$(sed -n '3s/^ *[^:]*: *//p' <<<"$creds")
pct set "$CTID" --description "Restream (${CHANNEL}): ${url}" >/dev/null 2>&1 || true

trap - ERR
printf '\n%s%s%s%s\n\n' "$c_bold" "$c_green" "$(t ready_title)" "$c_off"
printf '  %-16s %s\n' "$(t url):" "${c_bold}${url}${c_off}"
printf '  %-16s %s\n' "$(t user):" "${c_bold}${user}${c_off}"
printf '  %-16s %s\n\n' "$(t pass):" "${c_bold}${pass}${c_off}"
wt --title "$(t ready_title)" --msgbox "\n$(t url):  $url\n$(t user):  $user\n$(t pass):  $pass" 12 74 || true
