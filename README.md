# RemoteDesk

A self-hosted, cross-platform alternative to TeamViewer / AnyDesk.
Made of three pieces:

```
┌─────────────────┐    WebSocket signaling    ┌──────────────────────────┐
│  Web client     │ ◄───────────────────────► │  Signaling + TURN relay  │
│  (any browser)  │ ◄═══════════════════════► │  (Linux daemon, Docker)  │
└────────┬────────┘   WebRTC media + input    └────────────┬─────────────┘
         │                                                  │
         │           WebRTC (DTLS-SRTP, P2P or TURN-relayed) │
         ▼                                                  ▼
                                                ┌────────────────────┐
                                                │  Host agent        │
                                                │  (Win/macOS/Linux) │
                                                └────────────────────┘
```

* **`server/`** — Node.js signaling + ICE-server provider. Pairs hosts and
  clients by 9-digit Connection ID + PIN, then relays WebRTC SDP/ICE between
  them. Also serves the browser client.
* **`client/`** — Pure HTML/JS web client, opens in any modern browser.
* **`host/`** — Python agent that runs on the computer being controlled.
  Captures the screen with `mss`, ships frames over WebRTC via `aiortc`,
  injects remote input via `pynput`. Cross-platform.
* **`packaging/linux/`** — `docker-compose.yml` + coturn config + systemd
  unit + `install.sh` for one-shot VPS deployment.
* **`packaging/windows/`** — NSIS installer script + PowerShell build script.
  Built automatically on every push by the
  [`build-host-windows`](.github/workflows/build-host-windows.yml) workflow.
* **`packaging/macos/`** — PyInstaller build script for a standalone macOS
  binary (signing/notarisation up to you).

> **MVP scope:** screen view + mouse/keyboard control + multi-monitor pick by
> index. File transfer, audio, chat, and a host system-tray UI are scaffolded
> via the WebRTC DataChannel and can be added later.

---

## Quick start (development)

You need: Python ≥3.10, Node ≥18, `ffmpeg` headers (for `aiortc`/`av`),
and an X11 desktop on Linux.

```bash
# 1. Signaling + web client
cd server
npm install
npm start                       # http://localhost:8080

# 2. Host agent (in another terminal)
cd host
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
remotedesk-host --server ws://localhost:8080/ws --pin 1234 -v
# -> prints a 9-digit Connection ID

# 3. Open http://localhost:8080/ in a browser, type the ID + PIN, click Connect.
```

For a real deployment over the internet you need the signaling server reachable
on a public host. See [`packaging/linux/install.sh`](packaging/linux/install.sh)
for the one-line VPS install:

```bash
sudo PUBLIC_HOST=remote.example.com bash install.sh
```

## Production deploy (Linux VPS, like TeamViewer's relay)

The `packaging/linux` deployment runs **two** services on your VPS:

| Service                | Image                  | Ports                                |
|------------------------|------------------------|--------------------------------------|
| `remotedesk-signaling` | built from `server/`   | `8080/tcp` (HTTP+WS, put nginx in front for HTTPS) |
| `remotedesk-coturn`    | `coturn/coturn:4.6.2`  | `3478/udp+tcp` (STUN+TURN), `5349/tcp` (TURNS), `49160-49200/udp` (relay) |

The signaling server hands out **time-limited TURN credentials** (HMAC-signed
with `TURN_SECRET`) so clients never see a static password. coturn is configured
in `use-auth-secret` mode with the same secret.

Steps on a fresh Ubuntu 22.04+ VPS (port 8080 + the ports above open):

```bash
sudo PUBLIC_HOST=remote.example.com bash <(curl -fsSL \
  https://raw.githubusercontent.com/asscol/RDPnew/main/packaging/linux/install.sh)
```

This installs Docker, clones the repo to `/opt/remotedesk`, generates a random
`TURN_SECRET` in `/etc/remotedesk.env`, renders coturn config, opens UFW
firewall ports, and enables `remotedesk-server.service`.

For HTTPS, terminate TLS in nginx in front of `:8080` (Let's Encrypt).
The web client auto-upgrades the WebSocket to `wss://` whenever served over
HTTPS, so no client changes are needed.

## Windows host installer

CI builds the installer on every push:
[Actions → Build Windows host installer](.github/workflows/build-host-windows.yml)
→ download the `remotedesk-host-windows-setup` artifact.

Or build locally on Windows (PowerShell as admin):

```powershell
.\packaging\windows\build.ps1
# -> packaging\windows\RemoteDeskHost-Setup-0.1.0.exe
```

The installer:
* drops `remotedesk-host.exe` into `%PROGRAMFILES%\RemoteDesk`
* adds Start menu + desktop shortcuts
* registers an uninstaller in *Apps & Features*

By default the agent connects to `ws://localhost:8080/ws`. To point Windows
clients at your VPS, edit the shortcut target to:

```
"C:\Program Files\RemoteDesk\remotedesk-host.exe" --server wss://remote.example.com/ws
```

Or set the `REMOTEDESK_SERVER` environment variable system-wide.

## macOS host

```bash
bash packaging/macos/build.sh
# -> host/dist/remotedesk-host
```

Then grant the binary **Screen Recording** and **Accessibility** permissions
in *System Settings → Privacy & Security*.

## Linux host

Either run from source (`pip install -e ".[dev]"`) or use the same PyInstaller
spec on Linux to get a standalone binary. Wayland is not currently supported
for input injection (limitation of `pynput`); use an X11 session.

## Security model

* Each host advertises a **random 9-digit Connection ID** + a **PIN you set**.
  Clients must present both to be paired by the signaling server.
* Once paired, all media + input flows over **WebRTC (DTLS-SRTP)** — the
  signaling server never sees the screen or the keystrokes.
* TURN credentials are **time-limited (default 1 h)** and signed by the
  signaling server's HMAC secret, never stored in the database (because there
  is no database).
* The host accepts a **single** active client at a time (`busy` error otherwise).
* `--no-input` runs the host in view-only mode.

> **Hardening tips for production:** put the signaling server behind nginx
> with HTTPS + HTTP basic auth or OAuth, run the host agent as a dedicated
> non-admin user, and consider IP allow-lists at the firewall level.

## Project layout

```
.
├── client/public/         # Browser client (HTML/JS, no build step)
├── server/
│   ├── src/               # Node signaling + REST + static
│   ├── test/              # node:test unit tests
│   └── Dockerfile
├── host/
│   ├── remotedesk/        # Python package
│   ├── tests/
│   ├── pyproject.toml
│   └── remotedesk-host.spec   # PyInstaller config
├── packaging/
│   ├── linux/             # docker-compose, coturn, systemd, install.sh
│   ├── windows/           # NSIS + PowerShell build
│   └── macos/             # build script
├── docs/
└── .github/workflows/     # Server CI, Host CI (Linux), Windows installer build
```

## Roadmap

- [x] Screen view + mouse + keyboard
- [x] 9-digit Connection ID + PIN auth
- [x] STUN + TURN with time-limited credentials
- [x] One-shot VPS installer (Docker + systemd)
- [x] Windows installer built in CI
- [ ] System-tray UI for the host (Tauri/Electron wrapper)
- [ ] File transfer over a separate DataChannel
- [ ] Audio
- [ ] Multi-monitor switcher in the client
- [ ] Wayland support (via PipeWire screen capture + libei input injection)

## License

MIT.
