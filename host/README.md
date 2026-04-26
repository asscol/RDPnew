# RemoteDesk Host Agent

Cross-platform Python agent that runs on the computer you want to control.
It captures the screen, advertises a 9-digit Connection ID, and accepts
WebRTC connections from a paired client.

## Quick start (from source)

```bash
cd host
python -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"
remotedesk-host --server ws://YOUR-SERVER:8080/ws --pin 1234 -v
```

The agent prints something like:

```
================================================
  RemoteDesk host is ready
  Connection ID : 482917563
  PIN           : 1234
================================================
```

Open `https://YOUR-SERVER/` in a browser, type the ID + PIN, and you're in.

## CLI flags

| Flag             | Default                       | Description                                            |
|------------------|-------------------------------|--------------------------------------------------------|
| `--server`       | `ws://localhost:8080/ws`      | Signaling WebSocket URL                                |
| `--pin`          | random 6 digits               | One-time PIN required from clients                     |
| `--monitor`      | `1`                           | mss monitor index (`0` = entire desktop)               |
| `--fps`          | `20`                          | Capture frame rate                                     |
| `--max-width`    | `1920`                        | Downscale frames wider than this                       |
| `--no-input`     | off                           | View-only mode (ignore remote keyboard/mouse)          |
| `--ice-server`   | fetched from server / Google STUN | Override ICE servers (repeatable)                  |
| `-v` / `-vv`     |                               | Increase logging                                       |

## Platform notes

* **Windows.** Works out of the box. For best performance run as a regular
  user (not SYSTEM) so `mss` can grab the active session. To inject input
  into UAC-elevated windows, run the agent as Administrator.
* **macOS.** Grant *Screen Recording* and *Accessibility* permissions to your
  terminal (or to the packaged app) under
  *System Settings → Privacy & Security*.
* **Linux (X11).** Requires a running X session and `python-xlib` (pulled in
  automatically by `pynput`). Wayland is not supported by `pynput` for input
  injection — use an X11 session. Install the X11 + screen-capture system
  libraries before `pip install`:
  ```bash
  sudo apt-get install -y libxcb1-dev libxtst-dev libx11-dev libxrandr-dev \
    libxext-dev libavdevice-dev libavfilter-dev libopus-dev libvpx-dev pkg-config
  ```
  `libxcb.so` (`libxcb1-dev`), `libX11.so` (`libx11-dev`) and
  `libXrandr.so` (`libxrandr-dev`) are what `mss` `dlopen`s at runtime for
  screen capture; `libxtst-dev` is required by `pynput` for input injection.

## Build a Windows installer

CI does this on every push; see
[`.github/workflows/build-host-windows.yml`](../.github/workflows/build-host-windows.yml).
Locally on Windows:

```powershell
cd host
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pyinstaller remotedesk-host.spec
# -> dist\remotedesk-host.exe
makensis ..\packaging\windows\installer.nsi
# -> packaging\windows\RemoteDeskHost-Setup.exe
```

## Tests / lint

```bash
pip install -e ".[dev]"
ruff check remotedesk
python -m pytest tests
```
