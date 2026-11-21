# Restream installeren

*English: [INSTALL.md](INSTALL.md)*

Restream installeer je op een van twee manieren. Beide eindigen hetzelfde: je ziet **het adres, de gebruikersnaam en het wachtwoord** van de eerste beheerder, en verder niets. Bij de eerste keer inloggen kies je je eigen wachtwoord en stel je tweestapsverificatie in.

| | Debian 13-server | Proxmox LXC-container |
| --- | --- | --- |
| Voor | Een VPS of een fysieke server | Een Proxmox VE 8.4- of 9-host |
| Hoe | `install.sh`, met een wizard | CT-template via **Download from URL**, of het hulpscript |
| Updates en kanaal wisselen | In de console (Info › Updates) | Hetzelfde: de container is een gewone Restream-installatie |

Aanbevolen voor één 1080p50-stream naar meerdere platforms: 4 vCPU, 8 GB RAM, 80 GB schijf, 100 Mbps upload of meer.

## 1. Debian 13-server

Als root op een verse Debian 13 (trixie):

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash
```

Wil je het testkanaal voordat het op `main` staat, haal het script dan van de `test`-branch: `.../restream/test/deploy/install.sh`.

De wizard vraagt, in het Engels of Nederlands:

1. **Taal** van de installer.
2. **Domeinnaam**, bijvoorbeeld `restream.voorbeeld.nl`. Laat eerst een A-record naar de server wijzen; zet het bij Cloudflare op *DNS only* (grijze wolk), want de proxy laat RTMP, SRT en WebRTC niet door. Leeg laten = het IP-adres gebruiken.
3. **HTTPS**: Let's Encrypt (poort 80 moet bereikbaar zijn) of een zelfondertekend certificaat. Zonder domein altijd zelfondertekend; de browser waarschuwt één keer.
4. **Beheerder**: e-mailadres (de gebruikersnaam) en weergavenaam.
5. **Kanaal**: productie (`main`) of test (`test`). Later wisselen kan in de console.
6. **Poorten**: de standaard mediapoorten (RTMP 1935/tcp, SRT 8890/udp, WebRTC 8189/udp+tcp) of eigen poorten. De console gebruikt altijd 80 en 443.
7. **Firewall**: bij een actieve ufw of firewalld worden de poorten toegevoegd; anders kun je ufw laten installeren en aanzetten.
8. Een **overzicht** om te bevestigen.

Daarna installeert hij PostgreSQL, nginx, Node.js 22, FFmpeg en MediaMTX als gewone services, bouwt Restream en toont:

```
Restream is geïnstalleerd

  Openen:          https://restream.voorbeeld.nl
  Gebruikersnaam:  jij@voorbeeld.nl
  Wachtwoord:      Kx7…
```

Dezelfde drie regels staan in `/root/restream-credentials.txt` (alleen root) en worden bij elke root-login getoond tot je dat bestand verwijdert.

### Zonder vragen

Elk antwoord is ook een optie; `-y` vraagt niets en gebruikt voor de rest de standaardwaarden:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash -s -- -y \
  --domain restream.voorbeeld.nl --email jij@voorbeeld.nl --channel production --firewall --lang nl
```

| Optie | Betekenis |
| --- | --- |
| `--domain <naam>` | Openbare hostnaam (leeg: het IP-adres) |
| `--email <adres>`, `--admin-name <naam>` | Eerste beheerder |
| `--tls auto\|letsencrypt\|self-signed` | Certificaat (auto: Let's Encrypt bij een domein) |
| `--channel production\|test` | Releasekanaal |
| `--rtmp-port`, `--srt-port`, `--webrtc-port` | Openbare mediapoorten |
| `--firewall` | ufw installeren en aanzetten |
| `--lang en\|nl` | Taal van de installer |
| `--skip-checks` | Installeren onder de aanbeveling of op een ander OS |

### Later wijzigen

`restream-setup` start de wizard opnieuw: domein wijzigen, van zelfondertekend naar Let's Encrypt, andere poorten of een ander kanaal. Database, geheimen en gebruikers blijven bewaard.

## 2. Proxmox VE: LXC-container

Per kanaal staat er een kant-en-klare CT-template klaar, bij elke release opnieuw gebouwd:

| Kanaal | URL voor "Download from URL" |
| --- | --- |
| Productie | `https://github.com/rhisijmuiden/restream/releases/download/lxc-production/restream-production-debian-13-amd64.tar.zst` |
| Test | `https://github.com/rhisijmuiden/restream/releases/download/lxc-test/restream-test-debian-13-amd64.tar.zst` |

De checksum staat ernaast (`….tar.zst.sha256`). De template bevat Debian 13 met alles geïnstalleerd en gebouwd, maar zonder geheimen: het databasewachtwoord, de app-sleutel, de beheerder en het certificaat worden bij de eerste start van elke container gemaakt.

### a. Via de Proxmox-GUI

1. Datacenter › je node › opslag `local` › **CT Templates** › **Download from URL**. Plak de URL, klik **Query URL** en dan **Download**.
2. **Create CT**: laat **Unprivileged container** en **Nesting** aan (systemd in Debian 13 heeft nesting nodig), stel een root-wachtwoord in, kies de template, 80 GB schijf, 4 cores, 8192 MB geheugen en een netwerk (DHCP of vast).
3. Start de container. Bij de eerste start richt hij zichzelf in (ongeveer twee minuten; log: `/var/log/restream-firstboot.log`).
4. Open de **Console** en log in als root. Je ziet:

```
Restream
  Openen:          https://192.168.1.50
  Gebruikersnaam:  admin@restream.local
  Wachtwoord:      Kx7…
```

Zonder hulpscript is de beheerder `admin@restream.local` en is het adres het IP-adres van de container. Draai `restream-setup` in de container voor een domein, Let's Encrypt, andere poorten of een ander e-mailadres voor de beheerder.

### b. Met het hulpscript

Op de Proxmox-host, als root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/proxmox/restream-ct.sh)"
```

Het vraagt naar taal, kanaal, container-ID, hostnaam, cores, geheugen, schijf, opslag, bridge, DHCP of een vast adres, VLAN, een optioneel domein, het e-mailadres van de beheerder en het root-wachtwoord van de container. Het downloadt de template naar CT Templates (of hergebruikt hem als de checksum klopt), maakt een unprivileged container met nesting die met de host meestart, wacht op de eerste start en toont het adres, de gebruikersnaam en het wachtwoord.

### De container van buitenaf bereiken

Om vanaf internet te streamen stuur je door naar de container: TCP 80 en 443 (console, Let's Encrypt), TCP 1935 (RTMP), UDP 8890 (SRT) en UDP+TCP 8189 (WebRTC), of de poorten die je koos.

## Updates en het productie-/testkanaal

Beide manieren installeren Restream als git-checkout in `/opt/restream` met dezelfde updater. **Info › Updates** in de console zoekt naar updates, installeert ze en wisselt tussen productie (`main`) en test (`test`); een mislukte update wordt teruggedraaid. Vanuit de shell: `restream-update [--channel production|test]`. Een container van de testtemplate staat op het testkanaal; wisselen gaat in de console zoals op elke server.

## Zelf de template bouwen

De GitHub-workflow `LXC template` bouwt hem bij elke push naar `main` en `test` en start hem één keer in systemd-nspawn om de eerste start te controleren. Met de hand, op Debian of Ubuntu als root:

```bash
apt install debootstrap debian-archive-keyring zstd git curl
deploy/lxc/build-template.sh --channel test --out dist/
deploy/lxc/test-template.sh dist/restream-test-debian-13-amd64.tar.zst   # vereist systemd-container
```
