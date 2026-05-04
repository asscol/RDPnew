# Deploy RemoteDesk on a VPS (signaling + TURN)

End result: a public URL like `https://remote.example.com/` that any host
agent and any web/desktop client can reach, with NAT traversal handled by
your own coturn TURN relay.

## 1. Choose a VPS

Anything cheap with a public IPv4 works. ~1 vCPU / 1 GB RAM / 25 GB disk.
The TURN relay is the part that uses bandwidth — pick a tariff with
unmetered or generous traffic if you'll relay a lot of video.

Tested: Ubuntu 22.04 / 24.04. Hetzner CX11, DigitalOcean Basic, Aeza,
Timeweb Cloud, Vultr Cloud Compute — all fine.

## 2. Point DNS at it

Create an `A` record:

```
remote.example.com.  A  203.0.113.10     ; your VPS IP
```

(You can use a free subdomain via DuckDNS / Cloudflare if you don't have
your own domain. You can also skip DNS and use the bare IP — works,
but the browser will warn about HTTPS later.)

## 3. SSH into the box

```bash
ssh root@remote.example.com
# or
ssh ubuntu@remote.example.com
```

If you're prompted to add the host key, type `yes`.

## 4. Open the firewall

If the provider gives you a control-panel firewall (Hetzner Cloud,
DigitalOcean, AWS Security Groups…), open these:

| Port            | Proto    | What                               |
|-----------------|----------|------------------------------------|
| `22`            | TCP      | SSH (you)                          |
| `80`, `443`     | TCP      | HTTPS / web client                 |
| `8080`          | TCP      | signaling server (HTTP fallback)   |
| `3478`          | TCP+UDP  | STUN / TURN                        |
| `5349`          | TCP+UDP  | TURN over TLS                      |
| `49160-49200`   | UDP      | TURN relay allocations             |

`install.sh` also configures `ufw` inside the VM with the same rules,
in case there's no provider firewall.

## 5. Run the installer

On the VPS, as root or with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/asscol/RDPnew/main/packaging/linux/install.sh \
  | sudo PUBLIC_HOST=remote.example.com bash
```

What this does (~3 minutes on a fresh box):

1. Installs Docker + Compose plugin (idempotent).
2. Clones the repo to `/opt/remotedesk`.
3. Generates a random `TURN_SECRET` and writes it to `/opt/remotedesk/.env`.
4. Renders `coturn.conf` with your `PUBLIC_HOST`.
5. Opens `ufw` ports listed above.
6. Installs the systemd unit `remotedesk-server.service` and starts it.

If you'd rather inspect first:

```bash
git clone https://github.com/asscol/RDPnew.git /opt/remotedesk
cd /opt/remotedesk
sudo PUBLIC_HOST=remote.example.com bash packaging/linux/install.sh
```

## 6. Bootstrap an admin account

Edit `/opt/remotedesk/.env` and add:

```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=change-this-strong-pass
```

Then restart:

```bash
sudo systemctl restart remotedesk-server
sudo journalctl -u remotedesk-server -e --no-pager | tail -20
# look for: bootstrap admin created: you@example.com
```

After first start you can remove these env vars (the user persists in
SQLite). To create more admins, log in to `/admin` and click *Promote*.

## 7. Front it with HTTPS (recommended)

Cookies from the auth API are `Secure`-flag-friendly when `SECURE_COOKIES=1`
and the web client auto-upgrades WebSocket to `wss://` when the page is
served over HTTPS. The simplest setup is nginx + Let's Encrypt:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/remotedesk <<'EOF'
server {
    listen 80;
    server_name remote.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1d;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/remotedesk /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d remote.example.com --redirect -m you@example.com --agree-tos -n
```

Then in `/opt/remotedesk/.env` set `SECURE_COOKIES=1` and restart.

## 8. Verify it's up

```bash
# signaling responds
curl -s https://remote.example.com/api/ice-servers | jq
# you should see your TURN server in the list:
#   { "iceServers": [
#       { "urls": "stun:stun.l.google.com:19302" },
#       { "urls": "turn:remote.example.com:3478", "username": "...", "credential": "..." }
#   ]}

# coturn answering on UDP/3478
sudo apt-get install -y stun-client
stun -v remote.example.com 3478
# expect: "Primary: ... Returned IP" lines, no timeouts.
```

## 9. Connect your machines

**Host (the PC being controlled):**

```bash
# Linux:
remotedesk-host --server wss://remote.example.com/ws --pin 1234

# Windows:
# Install RemoteDeskHost-Setup-0.1.0.exe (from Releases),
# launch RemoteDesk Host, set server = wss://remote.example.com/ws and PIN.
```

The host prints its 9-digit Connection ID. From this point on the same ID
is reused on every restart (stored in `~/.remotedesk/host.json`).

**Client:** open `https://remote.example.com/` in any browser, type the
Connection ID + PIN.

## 10. Force-relay test (optional, to prove TURN works)

To prove TURN itself is working without depending on whether direct p2p
also happens to succeed, append `?relay=1` to the URL — the web client
sets `iceTransportPolicy: "relay"`, which forbids direct p2p and forces
all traffic through your coturn. Stream still works = TURN is healthy.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` from browser | service not running | `sudo systemctl status remotedesk-server` |
| `error: offline` in client UI | host not registered | re-check host's `--server` URL and that it printed `client paired` |
| Video stuck black, RTC stuck `checking` | firewall blocking UDP 3478/49160-49200 | open ports in cloud firewall, not just `ufw` |
| Browser warns "WebSocket failed" | mixed http/https | put nginx + Let's Encrypt in front (step 7) |
| `bad-pin` | typo or PIN was rotated by host | check host stdout for current PIN |

## Updating

```bash
cd /opt/remotedesk
sudo git pull
sudo systemctl restart remotedesk-server
```
