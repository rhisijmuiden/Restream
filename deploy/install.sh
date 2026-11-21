#!/usr/bin/env bash
# Restream installer for a bare Debian 13 (trixie) server.
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | sudo bash
#
# On a terminal the installer walks you through the setup (language, domain, HTTPS, administrator,
# channel, ports, firewall). Options given on the command line are used as the answers' defaults;
# with -y it asks nothing and uses the options and defaults as they are.
#
# Options:
#   --domain <name>        Public host name. With a domain, a Let's Encrypt certificate is requested.
#                          Without one, a self-signed certificate for the server IP is generated.
#   --email <address>      Email of the first administrator (sign-in name, also used for Let's Encrypt).
#   --admin-name <name>    Display name of the first administrator (default Administrator).
#   --tls <mode>           auto (default: Let's Encrypt with a domain), letsencrypt or self-signed.
#   --channel <name>       Release channel: production (main branch, default) or test (test branch).
#   --rtmp-port <port>     Public RTMP ingest port (default 1935).
#   --srt-port <port>      Public SRT ingest port, UDP (default 8890).
#   --webrtc-port <port>   Public WebRTC media port, UDP and TCP (default 8189).
#   --firewall             Install and enable ufw with SSH, web and media ports open.
#                          Without it, an already active ufw or firewalld only gets the ports added.
#   --lang <en|nl>         Language of the installer (default en).
#   --repo <url>           Git repository (default https://github.com/rhisijmuiden/restream.git).
#   --skip-checks          Install even if the OS or the hardware is below the recommendation.
#   -y, --yes              Do not ask questions; use defaults for anything not given.
#
# Container templates (used by the Proxmox LXC build, see docs/INSTALL.md):
#   --build-image          Prepare an image without secrets: packages, code, build, media server. Nothing is started.
#   --no-fetch             With --build-image: use the code already in /opt/restream (a local checkout).
#   --firstboot            Finish a prepared image on its first start: secrets, database, administrator, HTTPS.
#                          Answers come from /etc/restream/firstboot.conf when it exists.
#
# Re-running the installer is safe: it keeps the database, secrets and users, and updates the code.
set -Eeuo pipefail

REPO_URL="https://github.com/rhisijmuiden/restream.git"
APP_DIR="/opt/restream"
ETC_DIR="/etc/restream"
DATA_DIR="/var/lib/restream"
STATUS_DIR="/var/lib/restream-updater"
ENV_FILE="$ETC_DIR/restream.env"
FIRSTBOOT_CONF="$ETC_DIR/firstboot.conf"
FIRSTBOOT_PENDING="$ETC_DIR/firstboot-pending"
FIRSTBOOT_FAILED="$DATA_DIR/firstboot-failed"
CREDENTIALS_FILE="/root/restream-credentials.txt"
NODE_MAJOR=22
DOMAIN=""
ADMIN_EMAIL=""
ADMIN_NAME=""
TLS_MODE="auto"
CHANNEL=""
RTMP_PORT=""
SRT_PORT=""
WEBRTC_PORT=""
UI_LANG=""
SKIP_CHECKS=0
ASSUME_YES=0
FIREWALL=0
MODE="install"
DOMAIN_GIVEN=0
LANG_GIVEN=0
NO_FETCH=0

c_cyan=$'\e[36m'; c_red=$'\e[31m'; c_yellow=$'\e[33m'; c_green=$'\e[32m'; c_bold=$'\e[1m'; c_off=$'\e[0m'

# --- Texts (English and Dutch) -------------------------------------------------
declare -A MSG_en=(
  [backtitle]="Restream installer"
  [lang_title]="Language / Taal"
  [lang_text]="Choose the language of the installer.\nKies de taal van de installer."
  [welcome_title]="Welcome"
  [welcome_text]="This wizard installs Restream on this server: PostgreSQL, nginx, Node.js, FFmpeg and the MediaMTX media server, all as native services.\n\nServer: %s CPU cores, %s GB RAM, %s GB free disk.\nRecommended: 4 vCPU, 8 GB RAM, 80 GB disk.\n\nYou can cancel at any time with Esc."
  [welcome_existing]="\n\nAn existing installation was found. Its database, secrets and users are kept; the code is updated."
  [low_title]="Below the recommendation"
  [low_text]="This server is below the recommendation (4 vCPU, 8 GB RAM, 80 GB disk). One 1080p50 stream to several platforms may not run smoothly.\n\nContinue anyway?"
  [domain_title]="Domain name"
  [domain_text]="Public domain name for Restream, for example restream.example.com.\nPoint an A record at this server first (with Cloudflare: 'DNS only', grey cloud).\n\nLeave empty to use the IP address %s with a self-signed certificate."
  [dns_none]="%s does not resolve yet. Let's Encrypt will fail until an A record points at this server.\n\nUse this domain anyway?"
  [dns_other]="%s points to %s, not to this server (%s).\nUsing Cloudflare? Set the record to 'DNS only' (grey cloud): its proxy does not pass RTMP, SRT or WebRTC.\n\nUse this domain anyway?"
  [tls_title]="HTTPS certificate"
  [tls_text]="How should Restream secure %s?"
  [tls_le]="Let's Encrypt (free, trusted; port 80 must be reachable)"
  [tls_self]="Self-signed (browsers show a warning)"
  [email_title]="Administrator"
  [email_text]="Email address of the first administrator. This is the user name you sign in with, and Let's Encrypt sends certificate notices to it."
  [email_bad]="That is not a valid email address."
  [name_text]="Display name of the administrator."
  [channel_title]="Release channel"
  [channel_text]="Which version do you want? You can switch later under Info > Updates in the console."
  [channel_prod]="Production (main branch, stable)"
  [channel_test]="Test (test branch, newest features)"
  [ports_title]="Ports"
  [ports_text]="Use the standard media ports?\n\n  RTMP ingest   %s/tcp\n  SRT ingest    %s/udp\n  WebRTC media  %s/udp and tcp\n\nThe web console always uses 80 and 443."
  [port_rtmp]="Public RTMP ingest port (TCP):"
  [port_srt]="Public SRT ingest port (UDP):"
  [port_webrtc]="Public WebRTC media port (UDP and TCP):"
  [port_bad]="Port %s cannot be used. Choose a number from 1 to 65535 that is not 80, 443 or one of Restream's internal ports (5432, 8080, 8322, 8554, 8888, 8889, 9997, 1936), and not the same as another media port."
  [fw_title]="Firewall"
  [fw_active]="An active firewall (%s) was found. The web and media ports will be opened in it."
  [fw_ask]="No active firewall was found. Install and enable ufw, with only SSH, web (80, 443) and the media ports open?\n\nChoose No if your provider has a firewall of its own; then open those ports there."
  [summary_title]="Ready to install"
  [summary_text]="Restream will be installed with these settings:\n\n  Address:      %s\n  HTTPS:        %s\n  Administrator: %s\n  Channel:      %s\n  Ports:        RTMP %s, SRT %s, WebRTC %s\n  Firewall:     %s\n\nStart the installation?"
  [yes]="Yes"
  [no]="No"
  [fw_enable]="enable ufw"
  [fw_keep]="leave as it is"
  [tls_sum_le]="Let's Encrypt"
  [tls_sum_self]="self-signed certificate"
  [kept]="(existing, kept)"
  [cancelled]="Installation cancelled. Nothing was changed."
  [s_check]="Checking the server"
  [s_packages]="Installing system packages"
  [s_node]="Installing Node.js %s (NodeSource)"
  [s_user]="Creating the restream user and directories"
  [s_code]="Fetching Restream (%s channel, branch %s)"
  [s_db]="Configuring PostgreSQL and secrets"
  [s_build]="Building Restream (this takes a few minutes)"
  [s_migrate]="Preparing the database"
  [s_media]="Installing the media server (MediaMTX) and FFmpeg"
  [s_services]="Installing services"
  [s_web]="Configuring nginx and HTTPS"
  [s_fw]="Firewall"
  [s_health]="Waiting for Restream to start"
  [s_network]="Waiting for the network"
  [le_failed]="Let's Encrypt failed (does DNS for %s point here, and is port 80 reachable?). Using a self-signed certificate for now; run restream-setup again later."
  [fw_none]="No active firewall found. If your provider has one, allow TCP 80, 443, %s and %s, and UDP %s and %s."
  [done_title]="Restream is installed"
  [done_url]="Open"
  [done_user]="Username"
  [done_pass]="Password"
  [fail]="Installation failed on line %s. Fix the problem above and run the installer again."
)
declare -A MSG_nl=(
  [backtitle]="Restream-installer"
  [lang_title]="Language / Taal"
  [lang_text]="Choose the language of the installer.\nKies de taal van de installer."
  [welcome_title]="Welkom"
  [welcome_text]="Deze wizard installeert Restream op deze server: PostgreSQL, nginx, Node.js, FFmpeg en de MediaMTX-mediaserver, allemaal als gewone services.\n\nServer: %s CPU-kernen, %s GB RAM, %s GB vrije schijfruimte.\nAanbevolen: 4 vCPU, 8 GB RAM, 80 GB schijf.\n\nAfbreken kan altijd met Esc."
  [welcome_existing]="\n\nEr is al een installatie gevonden. De database, geheimen en gebruikers blijven bewaard; de code wordt bijgewerkt."
  [low_title]="Onder de aanbeveling"
  [low_text]="Deze server zit onder de aanbeveling (4 vCPU, 8 GB RAM, 80 GB schijf). Eén 1080p50-stream naar meerdere platforms loopt dan mogelijk niet soepel.\n\nToch doorgaan?"
  [domain_title]="Domeinnaam"
  [domain_text]="Openbare domeinnaam voor Restream, bijvoorbeeld restream.voorbeeld.nl.\nLaat eerst een A-record naar deze server wijzen (bij Cloudflare: 'DNS only', grijze wolk).\n\nLaat leeg om het IP-adres %s te gebruiken met een zelfondertekend certificaat."
  [dns_none]="%s bestaat nog niet in DNS. Let's Encrypt lukt pas als een A-record naar deze server wijst.\n\nDit domein toch gebruiken?"
  [dns_other]="%s wijst naar %s, niet naar deze server (%s).\nGebruik je Cloudflare? Zet het record op 'DNS only' (grijze wolk): de proxy laat RTMP, SRT en WebRTC niet door.\n\nDit domein toch gebruiken?"
  [tls_title]="HTTPS-certificaat"
  [tls_text]="Hoe moet Restream %s beveiligen?"
  [tls_le]="Let's Encrypt (gratis, vertrouwd; poort 80 moet bereikbaar zijn)"
  [tls_self]="Zelfondertekend (browsers tonen een waarschuwing)"
  [email_title]="Beheerder"
  [email_text]="E-mailadres van de eerste beheerder. Dit is de gebruikersnaam waarmee je inlogt, en Let's Encrypt stuurt er meldingen over het certificaat naartoe."
  [email_bad]="Dat is geen geldig e-mailadres."
  [name_text]="Weergavenaam van de beheerder."
  [channel_title]="Releasekanaal"
  [channel_text]="Welke versie wil je? Wisselen kan later onder Info > Updates in de console."
  [channel_prod]="Productie (main-branch, stabiel)"
  [channel_test]="Test (test-branch, nieuwste functies)"
  [ports_title]="Poorten"
  [ports_text]="De standaard mediapoorten gebruiken?\n\n  RTMP-ingest    %s/tcp\n  SRT-ingest     %s/udp\n  WebRTC-media   %s/udp en tcp\n\nDe webconsole gebruikt altijd 80 en 443."
  [port_rtmp]="Openbare RTMP-ingestpoort (TCP):"
  [port_srt]="Openbare SRT-ingestpoort (UDP):"
  [port_webrtc]="Openbare WebRTC-mediapoort (UDP en TCP):"
  [port_bad]="Poort %s kan niet. Kies een getal van 1 tot 65535 dat niet 80, 443 of een interne poort van Restream is (5432, 8080, 8322, 8554, 8888, 8889, 9997, 1936), en niet gelijk aan een andere mediapoort."
  [fw_title]="Firewall"
  [fw_active]="Er is een actieve firewall (%s) gevonden. De web- en mediapoorten worden daarin opengezet."
  [fw_ask]="Er is geen actieve firewall gevonden. ufw installeren en aanzetten, met alleen SSH, web (80, 443) en de mediapoorten open?\n\nKies Nee als je provider zelf een firewall heeft; zet die poorten dan daar open."
  [summary_title]="Klaar om te installeren"
  [summary_text]="Restream wordt geïnstalleerd met deze instellingen:\n\n  Adres:        %s\n  HTTPS:        %s\n  Beheerder:    %s\n  Kanaal:       %s\n  Poorten:      RTMP %s, SRT %s, WebRTC %s\n  Firewall:     %s\n\nDe installatie starten?"
  [yes]="Ja"
  [no]="Nee"
  [fw_enable]="ufw aanzetten"
  [fw_keep]="laten zoals het is"
  [tls_sum_le]="Let's Encrypt"
  [tls_sum_self]="zelfondertekend certificaat"
  [kept]="(bestaand, blijft bewaard)"
  [cancelled]="Installatie afgebroken. Er is niets veranderd."
  [s_check]="Server controleren"
  [s_packages]="Systeempakketten installeren"
  [s_node]="Node.js %s installeren (NodeSource)"
  [s_user]="Gebruiker restream en mappen aanmaken"
  [s_code]="Restream ophalen (kanaal %s, branch %s)"
  [s_db]="PostgreSQL en geheimen instellen"
  [s_build]="Restream bouwen (dit duurt een paar minuten)"
  [s_migrate]="Database voorbereiden"
  [s_media]="Mediaserver (MediaMTX) en FFmpeg installeren"
  [s_services]="Services installeren"
  [s_web]="nginx en HTTPS instellen"
  [s_fw]="Firewall"
  [s_health]="Wachten tot Restream draait"
  [s_network]="Wachten op het netwerk"
  [le_failed]="Let's Encrypt is mislukt (wijst DNS voor %s hierheen en is poort 80 bereikbaar?). Voorlopig wordt een zelfondertekend certificaat gebruikt; draai later restream-setup opnieuw."
  [fw_none]="Geen actieve firewall gevonden. Heeft je provider er een, sta dan TCP 80, 443, %s en %s toe, en UDP %s en %s."
  [done_title]="Restream is geïnstalleerd"
  [done_url]="Openen"
  [done_user]="Gebruikersnaam"
  [done_pass]="Wachtwoord"
  [fail]="De installatie is mislukt op regel %s. Los het probleem hierboven op en start de installer opnieuw."
)

# t <key> [printf args...]: text in the chosen language.
t() {
  local key=$1 fmt; shift
  if [[ "$UI_LANG" == "nl" && -n "${MSG_nl[$key]:-}" ]]; then fmt=${MSG_nl[$key]}; else fmt=${MSG_en[$key]:-$key}; fi
  # shellcheck disable=SC2059
  printf "$fmt" "$@"
}

step() { printf '\n%s==>%s %s%s%s\n' "$c_cyan" "$c_off" "$c_bold" "$*" "$c_off"; }
warn() { printf '%s!%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%sx%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
on_error() {
  local line=$1
  if [[ "$MODE" == "firstboot" ]]; then install -d -m 0750 "$DATA_DIR" 2>/dev/null; date -u +%FT%TZ > "$FIRSTBOOT_FAILED" 2>/dev/null || true; fi
  die "$(t fail "$line")"
}
trap 'on_error $LINENO' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; DOMAIN_GIVEN=1; shift 2 ;;
    --email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --tls) TLS_MODE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --rtmp-port) RTMP_PORT="${2:-}"; shift 2 ;;
    --srt-port) SRT_PORT="${2:-}"; shift 2 ;;
    --webrtc-port) WEBRTC_PORT="${2:-}"; shift 2 ;;
    --lang) UI_LANG="${2:-}"; LANG_GIVEN=1; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --firewall) FIREWALL=1; shift ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --build-image) MODE="build-image"; ASSUME_YES=1; SKIP_CHECKS=1; shift ;;
    --firstboot) MODE="firstboot"; ASSUME_YES=1; SKIP_CHECKS=1; shift ;;
    --no-fetch) NO_FETCH=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run the installer as root (sudo)."

# --- Helpers --------------------------------------------------------------------
# env_get <key>: value from restream.env (empty when missing).
env_get() { sed -n "s#^$1=##p" "$ENV_FILE" 2>/dev/null | tail -1; }
# env_set <key> <value>: replaces or appends a line in restream.env.
env_set() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; }
valid_domain() { [[ -z "$1" || "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; }
# valid_port <port> [other media ports...]
valid_port() {
  local p=$1 o; shift
  [[ "$p" =~ ^[0-9]{1,5}$ ]] && (( p >= 1 && p <= 65535 )) || return 1
  case "$p" in 80|443|1936|5432|8080|8322|8554|8888|8889|9997) return 1 ;; esac
  for o in "$@"; do [[ "$p" != "$o" ]] || return 1; done
}
primary_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)
  [[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  printf '%s' "$ip"
}
active_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then echo ufw; return; fi
  if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then echo firewalld; return; fi
  return 1
}

# --- Wizard user interface (whiptail, or plain prompts when it is missing) --------
TTY_OK=0
if [[ $ASSUME_YES -eq 0 ]] && (exec </dev/tty >/dev/tty) 2>/dev/null; then TTY_OK=1; fi
USE_WT=0

wt() { whiptail --backtitle "$(t backtitle)" "$@" 3>&1 1>/dev/tty 2>&3 </dev/tty; }
cancelled() { [[ $USE_WT -eq 1 ]] && clear >/dev/tty; printf '%s\n' "$(t cancelled)" >&2; exit 1; }
plain() { printf '%b\n' "$*" >/dev/tty; }

# ui_msg <title> <text>
ui_msg() {
  if [[ $USE_WT -eq 1 ]]; then wt --title "$1" --msgbox "$2" 20 76 || cancelled
  else plain "\n== $1 ==\n$2"; fi
}
# ui_yesno <title> <text> [default yes|no]: status 0 for yes.
ui_yesno() {
  local def=${3:-yes} ans rc
  if [[ $USE_WT -eq 1 ]]; then
    local extra=(); [[ "$def" == "no" ]] && extra=(--defaultno)
    rc=0; wt --title "$1" --yes-button "$(t yes)" --no-button "$(t no)" "${extra[@]}" --yesno "$2" 20 76 || rc=$?
    (( rc == 255 )) && cancelled
    return $rc
  fi
  plain "\n== $1 ==\n$2"
  read -r -p "[$( [[ $def == yes ]] && echo "Y/n" || echo "y/N")] " ans </dev/tty || cancelled
  ans=${ans:-$def}
  [[ "$ans" =~ ^[yYjJ] ]]
}
# ui_input <var> <title> <text> [default]
ui_input() {
  local __var=$1 __ans
  if [[ $USE_WT -eq 1 ]]; then
    __ans=$(wt --title "$2" --inputbox "$3" 20 76 "${4:-}") || cancelled
  else
    plain "\n== $2 ==\n$3"
    read -r -p "${4:+[$4] }> " __ans </dev/tty || cancelled
    __ans=${__ans:-${4:-}}
  fi
  __ans=$(printf '%s' "$__ans" | tr -d '[:space:]')
  printf -v "$__var" '%s' "$__ans"
}
# ui_menu <var> <title> <text> <default tag> <tag> <label> [<tag> <label>...]
ui_menu() {
  local __var=$1 title=$2 text=$3 def=$4 __ans i; shift 4
  if [[ $USE_WT -eq 1 ]]; then
    __ans=$(wt --title "$title" --default-item "$def" --notags --menu "$text" 20 76 6 "$@") || cancelled
  else
    plain "\n== $title ==\n$text"
    local tags=(); i=1
    while [[ $# -gt 0 ]]; do tags+=("$1"); plain "  $i) $2$([[ $1 == "$def" ]] && echo ' *')"; shift 2; i=$((i + 1)); done
    read -r -p "> " __ans </dev/tty || cancelled
    if [[ "$__ans" =~ ^[0-9]+$ ]] && (( __ans >= 1 && __ans <= ${#tags[@]} )); then __ans=${tags[$((__ans - 1))]}; else __ans=$def; fi
  fi
  printf -v "$__var" '%s' "$__ans"
}

# --- Settings: defaults, existing installation, firstboot answers ----------------
EXISTING_ENV=0; [[ -f "$ENV_FILE" ]] && EXISTING_ENV=1

if [[ "$MODE" == "firstboot" && -f "$FIRSTBOOT_CONF" ]]; then
  # Written by the Proxmox helper (or by hand). Only known keys are read; the file is never executed.
  while IFS='=' read -r k v; do
    v=${v%$'\r'}; v=${v#\"}; v=${v%\"}
    case "$k" in
      DOMAIN) [[ $DOMAIN_GIVEN -eq 1 ]] || { DOMAIN=$v; DOMAIN_GIVEN=1; } ;;
      ADMIN_EMAIL) [[ -n "$ADMIN_EMAIL" ]] || ADMIN_EMAIL=$v ;;
      ADMIN_NAME) [[ -n "$ADMIN_NAME" ]] || ADMIN_NAME=$v ;;
      TLS) TLS_MODE=$v ;;
      RTMP_PORT) [[ -n "$RTMP_PORT" ]] || RTMP_PORT=$v ;;
      SRT_PORT) [[ -n "$SRT_PORT" ]] || SRT_PORT=$v ;;
      WEBRTC_PORT) [[ -n "$WEBRTC_PORT" ]] || WEBRTC_PORT=$v ;;
      LANGUAGE) [[ -n "$UI_LANG" ]] || UI_LANG=$v ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$FIRSTBOOT_CONF")
fi

if [[ $EXISTING_ENV -eq 1 ]]; then
  # Keep what the existing installation uses, unless an option says otherwise.
  existing_host=$(env_get PUBLIC_URL | sed -n 's#^https\{0,1\}://\([^/:]*\).*#\1#p')
  if [[ $DOMAIN_GIVEN -eq 0 && -n "$existing_host" && ! "$existing_host" =~ ^[0-9.]+$ ]]; then DOMAIN=$existing_host; fi
  [[ -n "$RTMP_PORT" ]] || RTMP_PORT=$(env_get RTMP_PORT)
  [[ -n "$SRT_PORT" ]] || SRT_PORT=$(env_get SRT_PORT)
  [[ -n "$WEBRTC_PORT" ]] || WEBRTC_PORT=$(env_get WEBRTC_PORT)
fi
if [[ -z "$CHANNEL" ]]; then
  if [[ -d "$APP_DIR/.git" ]]; then
    CHANNEL=$([[ "$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" == "test" ]] && echo test || echo production)
  else
    CHANNEL=production
  fi
fi
RTMP_PORT=${RTMP_PORT:-1935}; SRT_PORT=${SRT_PORT:-8890}; WEBRTC_PORT=${WEBRTC_PORT:-8189}
ADMIN_NAME=${ADMIN_NAME:-Administrator}
[[ "$UI_LANG" == "nl" ]] || UI_LANG=en

[[ "$CHANNEL" == "production" || "$CHANNEL" == "test" ]] || die "--channel must be production or test."
[[ "$TLS_MODE" =~ ^(auto|letsencrypt|self-signed)$ ]] || die "--tls must be auto, letsencrypt or self-signed."
valid_domain "$DOMAIN" || die "Not a valid domain name: $DOMAIN"
valid_port "$RTMP_PORT" || die "$(t port_bad "$RTMP_PORT")"
valid_port "$SRT_PORT" || die "$(t port_bad "$SRT_PORT")"
valid_port "$WEBRTC_PORT" "$RTMP_PORT" || die "$(t port_bad "$WEBRTC_PORT")"

# --- Checks -------------------------------------------------------------------
if [[ "$MODE" == "install" ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != "debian" || "${VERSION_CODENAME:-}" != "trixie" ]]; then
    [[ $SKIP_CHECKS -eq 1 ]] || die "Restream supports Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}. Use --skip-checks to try anyway."
    warn "Not Debian 13 (${PRETTY_NAME:-unknown}); continuing because of --skip-checks."
  fi
fi
cpus=$(nproc)
mem_gb=$(awk '/MemTotal/ {printf "%d", ($2/1024/1024)+0.5}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
low=0
(( cpus >= 4 && mem_gb >= 7 && disk_gb >= 75 )) || low=1

PUBLIC_IP=$(primary_ip)

# dns_problem <domain>: prints a warning text when the domain does not point at this server.
dns_problem() {
  local dns_ips mine
  dns_ips=$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  mine=$(hostname -I 2>/dev/null | xargs)
  if [[ -z "$dns_ips" ]]; then t dns_none "$1"; return 0; fi
  if ! grep -qwFf <(tr ' ' '\n' <<<"$mine" | grep -v '^$') <<<"$dns_ips"; then t dns_other "$1" "${dns_ips% }" "$mine"; return 0; fi
  return 1
}

# --- Wizard ---------------------------------------------------------------------
if [[ "$MODE" == "install" && $TTY_OK -eq 1 ]]; then
  if ! command -v whiptail >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq whiptail >/dev/null 2>&1 || true
  fi
  command -v whiptail >/dev/null && USE_WT=1

  if [[ $LANG_GIVEN -eq 0 ]]; then
    ui_menu UI_LANG "$(t lang_title)" "$(t lang_text)" en en "English" nl "Nederlands"
  fi

  ui_msg "$(t welcome_title)" "$(t welcome_text "$cpus" "$mem_gb" "$disk_gb")$([[ $EXISTING_ENV -eq 1 ]] && t welcome_existing)"
  if (( low )) && [[ $SKIP_CHECKS -eq 0 ]]; then
    ui_yesno "$(t low_title)" "$(t low_text)" no || cancelled
    SKIP_CHECKS=1
  fi

  while true; do
    ui_input DOMAIN "$(t domain_title)" "$(t domain_text "$PUBLIC_IP")" "$DOMAIN"
    DOMAIN=${DOMAIN,,}
    if ! valid_domain "$DOMAIN"; then ui_msg "$(t domain_title)" "Not a valid domain name: $DOMAIN"; continue; fi
    [[ -z "$DOMAIN" ]] && break
    if problem=$(dns_problem "$DOMAIN"); then
      ui_yesno "$(t domain_title)" "$problem" no && break
    else
      break
    fi
  done

  if [[ -n "$DOMAIN" ]]; then
    tls_def=letsencrypt; [[ "$TLS_MODE" == "self-signed" ]] && tls_def=self-signed
    ui_menu TLS_MODE "$(t tls_title)" "$(t tls_text "$DOMAIN")" "$tls_def" letsencrypt "$(t tls_le)" self-signed "$(t tls_self)"
  fi

  if [[ $EXISTING_ENV -eq 0 ]]; then
    [[ -n "$ADMIN_EMAIL" ]] || ADMIN_EMAIL="admin@${DOMAIN:-restream.local}"
    while true; do
      ui_input ADMIN_EMAIL "$(t email_title)" "$(t email_text)" "$ADMIN_EMAIL"
      valid_email "$ADMIN_EMAIL" && break
      ui_msg "$(t email_title)" "$(t email_bad)"
    done
    if [[ $USE_WT -eq 1 ]]; then
      ADMIN_NAME=$(wt --title "$(t email_title)" --inputbox "$(t name_text)" 12 76 "$ADMIN_NAME") || cancelled
    else
      plain "\n$(t name_text)"; read -r -p "[$ADMIN_NAME] > " n </dev/tty || cancelled; ADMIN_NAME=${n:-$ADMIN_NAME}
    fi
    ADMIN_NAME=${ADMIN_NAME:-Administrator}
  fi

  ui_menu CHANNEL "$(t channel_title)" "$(t channel_text)" "$CHANNEL" production "$(t channel_prod)" test "$(t channel_test)"

  if ! ui_yesno "$(t ports_title)" "$(t ports_text "$RTMP_PORT" "$SRT_PORT" "$WEBRTC_PORT")" yes; then
    while true; do ui_input RTMP_PORT "$(t ports_title)" "$(t port_rtmp)" "$RTMP_PORT"; valid_port "$RTMP_PORT" && break; ui_msg "$(t ports_title)" "$(t port_bad "$RTMP_PORT")"; done
    while true; do ui_input SRT_PORT "$(t ports_title)" "$(t port_srt)" "$SRT_PORT"; valid_port "$SRT_PORT" && break; ui_msg "$(t ports_title)" "$(t port_bad "$SRT_PORT")"; done
    while true; do ui_input WEBRTC_PORT "$(t ports_title)" "$(t port_webrtc)" "$WEBRTC_PORT"; valid_port "$WEBRTC_PORT" "$RTMP_PORT" && break; ui_msg "$(t ports_title)" "$(t port_bad "$WEBRTC_PORT")"; done
  fi

  if fw=$(active_firewall); then
    ui_msg "$(t fw_title)" "$(t fw_active "$fw")"
  elif [[ $FIREWALL -eq 0 ]]; then
    ui_yesno "$(t fw_title)" "$(t fw_ask)" no && FIREWALL=1
  fi

  if [[ -n "$DOMAIN" && "$TLS_MODE" != "self-signed" ]]; then tls_sum=$(t tls_sum_le); else tls_sum=$(t tls_sum_self); fi
  admin_sum=$ADMIN_EMAIL; [[ $EXISTING_ENV -eq 1 ]] && admin_sum=$(t kept)
  fw_sum=$(t fw_keep); [[ $FIREWALL -eq 1 ]] && fw_sum=$(t fw_enable)
  ch_sum=$(t channel_prod); [[ "$CHANNEL" == "test" ]] && ch_sum=$(t channel_test)
  ui_yesno "$(t summary_title)" "$(t summary_text "https://${DOMAIN:-$PUBLIC_IP}" "$tls_sum" "$admin_sum" "$ch_sum" "$RTMP_PORT" "$SRT_PORT" "$WEBRTC_PORT" "$fw_sum")" yes || cancelled
  [[ $USE_WT -eq 1 ]] && clear >/dev/tty
elif [[ "$MODE" == "install" ]]; then
  if (( low )) && [[ $SKIP_CHECKS -eq 0 ]]; then
    die "The server is below the recommendation (4 vCPU, 8 GB RAM, 80 GB disk). Use --skip-checks to install anyway."
  fi
  if [[ $EXISTING_ENV -eq 0 && -z "$ADMIN_EMAIL" ]]; then ADMIN_EMAIL="admin@${DOMAIN:-restream.local}"; fi
fi
if [[ "$MODE" == "firstboot" && -z "$ADMIN_EMAIL" ]]; then ADMIN_EMAIL="admin@${DOMAIN:-restream.local}"; fi
[[ -z "$ADMIN_EMAIL" ]] || valid_email "$ADMIN_EMAIL" || die "Not a valid email address: $ADMIN_EMAIL"

BRANCH=$([[ "$CHANNEL" == "production" ]] && echo main || echo test)
USE_LE=0; [[ -n "$DOMAIN" && "$TLS_MODE" != "self-signed" ]] && USE_LE=1

if [[ "$MODE" != "build-image" ]]; then
  step "$(t s_check)"
  echo "CPU cores: $cpus · RAM: ${mem_gb} GB · free disk: ${disk_gb} GB"
  (( low )) && warn "Recommended: 4 vCPU, 8 GB RAM and 80 GB disk (one 1080p50 ingest to several platforms)."
fi

if [[ "$MODE" == "firstboot" ]]; then
  # Proxmox creates SSH host keys for a new container; other hosts (or a copied image) may not have any.
  if command -v ssh-keygen >/dev/null && ! compgen -G '/etc/ssh/ssh_host_*_key' >/dev/null; then ssh-keygen -A >/dev/null; fi
  step "$(t s_network)"
  for _ in $(seq 1 60); do PUBLIC_IP=$(primary_ip); [[ -n "$PUBLIC_IP" ]] && break; sleep 2; done
  [[ -n "$PUBLIC_IP" ]] || die "No IPv4 address after two minutes. Check the network of the container."
  echo "IP address: $PUBLIC_IP"
fi
if [[ "$MODE" == "install" && -n "$DOMAIN" && $TTY_OK -eq 0 ]]; then
  if problem=$(dns_problem "$DOMAIN"); then warn "${problem%$'\n\n'*}"; fi
fi
HOST_NAME=${DOMAIN:-$PUBLIC_IP}
PUBLIC_URL="https://${HOST_NAME}"

# --- Packages -----------------------------------------------------------------
if [[ "$MODE" != "firstboot" ]]; then
  step "$(t s_packages)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git gnupg openssl nginx postgresql postgresql-contrib ffmpeg whiptail >/dev/null
  # Images always carry certbot, so a domain can be added later without extra downloads.
  if [[ $USE_LE -eq 1 || "$MODE" == "build-image" ]]; then apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; fi

  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
    step "$(t s_node "$NODE_MAJOR")"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
  fi
  echo "Node.js $(node -v), PostgreSQL $(psql --version | awk '{print $3}')"
elif [[ $USE_LE -eq 1 ]] && ! command -v certbot >/dev/null; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
fi

# --- User and directories -----------------------------------------------------
step "$(t s_user)"
id restream &>/dev/null || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin restream
install -d -m 0750 -o restream -g restream "$DATA_DIR" "$DATA_DIR/update-request"
install -d -m 0750 -o root -g restream "$ETC_DIR" "$STATUS_DIR"

# --- Code ---------------------------------------------------------------------
if [[ "$MODE" != "firstboot" ]]; then
  step "$(t s_code "$CHANNEL" "$BRANCH")"
  if [[ $NO_FETCH -eq 1 && -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" checkout -q -B "$BRANCH"
  elif [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch --prune origin "$BRANCH"
    git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  chown -R root:root "$APP_DIR"
fi

# --- Database and secrets -----------------------------------------------------
if [[ "$MODE" != "build-image" ]]; then
  step "$(t s_db)"
  systemctl enable --now postgresql >/dev/null 2>&1
  for _ in $(seq 1 30); do runuser -u postgres -- psql -tAc 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
  if [[ $EXISTING_ENV -eq 1 ]]; then
    echo "Keeping existing configuration in $ENV_FILE"
    # Update the public URL only when a domain was chosen (wizard or option).
    if [[ -n "$DOMAIN" ]]; then env_set PUBLIC_URL "$PUBLIC_URL"; fi
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
    cat > "$ENV_FILE" <<EOF
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
    chown root:restream "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
  # Public media ports: read by the console (ingest URLs) and by the media server setup.
  env_set RTMP_PORT "$RTMP_PORT"
  env_set SRT_PORT "$SRT_PORT"
  env_set WEBRTC_PORT "$WEBRTC_PORT"
fi

# --- Build --------------------------------------------------------------------
if [[ "$MODE" != "firstboot" ]]; then
  step "$(t s_build)"
  cd "$APP_DIR"
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent
  printf '{"version":"%s","commit":"%s","branch":"%s","builtAt":"%s"}\n' \
    "$(node -p "require('./package.json').version")" "$(git rev-parse HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build-info.json

  cat > /usr/local/bin/restream-cli <<'EOF'
#!/bin/sh
# Restream maintenance: create-admin, reset-password, reset-2fa, migrate, backup, backups, restore
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
  cat > /usr/local/sbin/restream-setup <<'EOF'
#!/bin/sh
# Run the Restream setup wizard again (domain, HTTPS, channel, ports, firewall). Keeps data and users.
exec /bin/bash /opt/restream/deploy/install.sh "$@"
EOF
  chmod 0755 /usr/local/sbin/restream-setup
  # Login message: sign-in details for root, the address before login.
  install -m 0644 "$APP_DIR/deploy/welcome.sh" /etc/profile.d/zz-restream-welcome.sh
fi

if [[ "$MODE" != "build-image" ]]; then
  step "$(t s_migrate)"
  restream-cli migrate
  ADMIN_PASSWORD=""
  if [[ -n "$ADMIN_EMAIL" ]]; then
    out=$(restream-cli create-admin --if-none --email "$ADMIN_EMAIL" --name "$ADMIN_NAME")
    ADMIN_PASSWORD=$(printf '%s\n' "$out" | awk '/^password:/ {print $2}')
    # A first boot that stopped halfway after creating the administrator: give it a new temporary password,
    # because the first one was never shown.
    if [[ -z "$ADMIN_PASSWORD" && "$MODE" == "firstboot" && ! -f "$CREDENTIALS_FILE" ]]; then
      out=$(restream-cli reset-password --email "$ADMIN_EMAIL" 2>/dev/null || true)
      ADMIN_PASSWORD=$(printf '%s\n' "$out" | awk '/^temporary password:/ {print $3}')
    fi
  fi
fi

# --- Media server -------------------------------------------------------------
step "$(t s_media)"
# shellcheck source=lib/media.sh
. "$APP_DIR/deploy/lib/media.sh"
if [[ "$MODE" == "build-image" ]]; then
  # Binary, user and unit only: the config needs the address and ports, which are known at first boot.
  install_mediamtx
  id mediamtx &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mediamtx
  install -m 0644 "$APP_DIR/deploy/systemd/restream-media.service" /etc/systemd/system/restream-media.service
else
  ensure_media "$APP_DIR" "$ETC_DIR"
fi
echo "MediaMTX $(/usr/local/bin/mediamtx --version | head -1), $(ffmpeg -version | head -1 | awk '{print $1, $3}')"

# --- Services -----------------------------------------------------------------
step "$(t s_services)"
cd "$APP_DIR"
install -m 0644 deploy/systemd/restream.service deploy/systemd/restream-updater.service deploy/systemd/restream-updater.path /etc/systemd/system/
if [[ "$MODE" == "build-image" ]]; then
  install -m 0644 deploy/systemd/restream-firstboot.service /etc/systemd/system/
  systemctl enable restream-updater.path restream-firstboot.service >/dev/null 2>&1
  : > "$FIRSTBOOT_PENDING"
  echo "Image prepared. Restream is set up on the first start of the container."
  exit 0
fi
systemctl daemon-reload
systemctl enable --now restream-updater.path >/dev/null 2>&1
systemctl enable restream.service >/dev/null 2>&1
systemctl restart restream.service

# --- Web server and TLS -------------------------------------------------------
step "$(t s_web)"
install -m 0644 deploy/nginx/restream-upgrade-map.conf /etc/nginx/conf.d/restream-upgrade-map.conf
rm -f /etc/nginx/sites-enabled/default
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
SELF_DIR="$ETC_DIR/tls"
install -d -m 0750 "$SELF_DIR"
# A self-signed certificate is used without a domain, by choice, and as a bootstrap until Let's Encrypt succeeds.
# It is made again when the host name changes.
self_cn=""
[[ -f "$SELF_DIR/self-signed.pem" ]] && self_cn=$(openssl x509 -in "$SELF_DIR/self-signed.pem" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')
if [[ "$self_cn" != "$HOST_NAME" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=${HOST_NAME}" \
    -addext "subjectAltName=$([[ -n "$DOMAIN" ]] && echo "DNS:${DOMAIN}" || echo "IP:${PUBLIC_IP}")" \
    -keyout "$SELF_DIR/self-signed.key" -out "$SELF_DIR/self-signed.pem" 2>/dev/null
fi
write_site() {
  sed -e "s#__SERVER_NAME__#${DOMAIN:-_}#g" -e "s#__CERT__#$1#g" -e "s#__KEY__#$2#g" \
    deploy/nginx/restream.conf > /etc/nginx/sites-available/restream.conf
  ln -sf /etc/nginx/sites-available/restream.conf /etc/nginx/sites-enabled/restream.conf
  nginx -t -q && systemctl enable nginx >/dev/null 2>&1 && systemctl reload-or-restart nginx
}
if [[ $USE_LE -eq 1 && -f "$CERT" ]]; then
  write_site "$CERT" "$KEY"
else
  write_site "$SELF_DIR/self-signed.pem" "$SELF_DIR/self-signed.key"
  if [[ $USE_LE -eq 1 ]]; then
    le_contact=(--register-unsafely-without-email)
    [[ -n "$ADMIN_EMAIL" ]] && le_contact=(-m "$ADMIN_EMAIL")
    if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos \
         "${le_contact[@]}" --deploy-hook "systemctl reload nginx"; then
      write_site "$CERT" "$KEY"
    else
      warn "$(t le_failed "$DOMAIN")"
    fi
  fi
fi

# --- Firewall -----------------------------------------------------------------
step "$(t s_fw)"
FIREWALL_NOTE=""
if [[ $FIREWALL -eq 1 ]]; then
  enable_ufw
elif ! open_firewall; then
  FIREWALL_NOTE=$(t fw_none "$RTMP_PORT" "$WEBRTC_PORT" "$SRT_PORT" "$WEBRTC_PORT")
  echo "$FIREWALL_NOTE"
fi

# --- Health -------------------------------------------------------------------
step "$(t s_health)"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ $ok == 1 ]] || die "Restream did not start. See: journalctl -u restream -n 100"

# --- Sign-in details ------------------------------------------------------------
# At the end only the address, the user name and the password are shown (also at every root login).
VERSION=$(node -p "require('$APP_DIR/package.json').version")
if [[ -n "$ADMIN_PASSWORD" ]]; then
  umask 077
  {
    printf '  %-16s %s\n' "$(t done_url):" "$PUBLIC_URL"
    printf '  %-16s %s\n' "$(t done_user):" "$ADMIN_EMAIL"
    printf '  %-16s %s\n' "$(t done_pass):" "$ADMIN_PASSWORD"
  } > "$CREDENTIALS_FILE"
  umask 022
  chmod 0600 "$CREDENTIALS_FILE"
fi

# Address before login on the console (no secrets: /etc/issue is readable by everyone).
install -d -m 0755 /etc/issue.d
printf 'Restream %s: %s\n\n' "$VERSION" "$PUBLIC_URL" > /etc/issue.d/restream.issue

if [[ "$MODE" == "firstboot" ]]; then
  rm -f "$FIRSTBOOT_PENDING" "$FIRSTBOOT_FAILED"
  systemctl disable restream-firstboot.service >/dev/null 2>&1 || true
fi

trap - ERR
printf '\n%s%s%s%s\n\n' "$c_bold" "$c_green" "$(t done_title)" "$c_off"
printf '  %-16s %s\n' "$(t done_url):" "${c_bold}${PUBLIC_URL}${c_off}"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  printf '  %-16s %s\n' "$(t done_user):" "${c_bold}${ADMIN_EMAIL}${c_off}"
  printf '  %-16s %s\n' "$(t done_pass):" "${c_bold}${ADMIN_PASSWORD}${c_off}"
fi
echo

if [[ $USE_WT -eq 1 ]]; then
  if [[ -n "$ADMIN_PASSWORD" ]]; then
    wt --title "$(t done_title)" --msgbox "\n$(t done_url):  $PUBLIC_URL\n$(t done_user):  $ADMIN_EMAIL\n$(t done_pass):  $ADMIN_PASSWORD" 12 76 || true
  else
    wt --title "$(t done_title)" --msgbox "\n$(t done_url):  $PUBLIC_URL" 10 76 || true
  fi
fi
exit 0
