# Installing Restream

*Nederlands: [INSTALL.nl.md](INSTALL.nl.md)*

Restream installs in one of two ways. Both end the same way: you see **the address, the user name and the password** of the first administrator, and nothing else. At first sign-in you choose your own password and set up two-factor authentication.

| | Debian 13 server | Proxmox LXC container |
| --- | --- | --- |
| For | A VPS or a bare metal server | A Proxmox VE 8.4 or 9 host |
| How | `install.sh`, a guided setup | CT template via **Download from URL**, or the helper script |
| Updates and channel switch | In the console (Info › Updates) | The same: the container is an ordinary Restream installation |

Recommended for one 1080p50 stream to several platforms: 4 vCPU, 8 GB RAM, 80 GB disk, 100 Mbps upload or more.

## 1. Debian 13 server

As root on a fresh Debian 13 (trixie):

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash
```

For the test channel before it is on `main`, fetch the script from the `test` branch: `.../restream/test/deploy/install.sh`.

The wizard asks, in English or Dutch:

1. **Language** of the installer.
2. **Domain name**, for example `restream.example.com`. Point an A record at the server first; with Cloudflare set it to *DNS only* (grey cloud), because its proxy does not pass RTMP, SRT or WebRTC. Leave it empty to use the IP address.
3. **HTTPS**: Let's Encrypt (port 80 must be reachable) or a self-signed certificate. Without a domain it is always self-signed; the browser warns once.
4. **Administrator**: email address (the user name) and display name.
5. **Channel**: production (`main`) or test (`test`). You can switch later in the console.
6. **Ports**: the standard media ports (RTMP 1935/tcp, SRT 8890/udp, WebRTC 8189/udp+tcp) or your own. The console always uses 80 and 443.
7. **Firewall**: an active ufw or firewalld gets the ports added; otherwise you can let it install and enable ufw.
8. A **summary** to confirm.

Then it installs PostgreSQL, nginx, Node.js 22, FFmpeg and MediaMTX as native services, builds Restream, and shows:

```
Restream is installed

  Open:            https://restream.example.com
  Username:        you@example.com
  Password:        Kx7…
```

The same three lines are saved in `/root/restream-credentials.txt` (root only) and shown at every root login until you delete that file.

### Without questions

Every answer is also an option; `-y` asks nothing and uses defaults for the rest:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/install.sh | bash -s -- -y \
  --domain restream.example.com --email you@example.com --channel production --firewall
```

| Option | Meaning |
| --- | --- |
| `--domain <name>` | Public host name (empty: the IP address) |
| `--email <address>`, `--admin-name <name>` | First administrator |
| `--tls auto\|letsencrypt\|self-signed` | Certificate (auto: Let's Encrypt with a domain) |
| `--channel production\|test` | Release channel |
| `--rtmp-port`, `--srt-port`, `--webrtc-port` | Public media ports |
| `--firewall` | Install and enable ufw |
| `--lang en\|nl` | Language of the installer |
| `--skip-checks` | Install below the recommendation or on another OS |

### Later changes

`restream-setup` runs the wizard again: change the domain, switch from self-signed to Let's Encrypt, change ports or channel. It keeps the database, secrets and users.

## 2. Proxmox VE: LXC container

There is a ready CT template per channel, rebuilt for every release:

| Channel | URL for "Download from URL" |
| --- | --- |
| Production | `https://github.com/rhisijmuiden/restream/releases/download/lxc-production/restream-production-debian-13-amd64.tar.zst` |
| Test | `https://github.com/rhisijmuiden/restream/releases/download/lxc-test/restream-test-debian-13-amd64.tar.zst` |

The checksum is next to it (`….tar.zst.sha256`). The template contains Debian 13 with everything installed and built, but no secrets: the database password, the app key, the administrator and the certificate are created on the first start of each container.

### a. With the Proxmox GUI

1. Datacenter › your node › storage `local` › **CT Templates** › **Download from URL**. Paste the URL, click **Query URL**, then **Download**.
2. **Create CT**: keep **Unprivileged container** and **Nesting** on (Debian 13's systemd needs nesting), set a root password, choose the template, 80 GB disk, 4 cores, 8192 MB memory, and a network (DHCP or static).
3. Start the container. On its first start it sets itself up (about two minutes; log: `/var/log/restream-firstboot.log`).
4. Open the **Console** and log in as root. You see:

```
Restream
  Open:            https://192.168.1.50
  Username:        admin@restream.local
  Password:        Kx7…
```

Without the helper, the administrator is `admin@restream.local` and the address is the container's IP address. Run `restream-setup` in the container to set a domain, Let's Encrypt, other ports or another administrator email.

### b. With the helper script

On the Proxmox host, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/restream/main/deploy/proxmox/restream-ct.sh)"
```

It asks for language, channel, container ID, host name, cores, memory, disk, storage, bridge, DHCP or a static address, VLAN, an optional domain, the administrator email and the container's root password. It downloads the template into CT Templates (or reuses it when the checksum matches), creates an unprivileged container with nesting that starts at boot, waits for the first start and shows the address, user name and password.

### Reaching the container from outside

For streaming from the internet, forward to the container: TCP 80 and 443 (console, Let's Encrypt), TCP 1935 (RTMP), UDP 8890 (SRT) and UDP+TCP 8189 (WebRTC), or the ports you chose.

## Updates and the production/test channel

Both ways install Restream as a git checkout in `/opt/restream` with the same updater. **Info › Updates** in the console checks for updates, installs them and switches between production (`main`) and test (`test`); a failed update is rolled back. From the shell: `restream-update [--channel production|test]`. A container made from the test template is on the test channel; switch in the console like on any server.

## Building the template yourself

The GitHub workflow `LXC template` builds it on every push to `main` and `test` and boots it once in systemd-nspawn to check the first start. By hand, on Debian or Ubuntu as root:

```bash
apt install debootstrap debian-archive-keyring zstd git curl
deploy/lxc/build-template.sh --channel test --out dist/
deploy/lxc/test-template.sh dist/restream-test-debian-13-amd64.tar.zst   # needs systemd-container
```
