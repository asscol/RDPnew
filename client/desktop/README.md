# RemoteDesk Desktop Client

Native desktop client (Windows / macOS / Linux) built with Electron. It wraps
the same web client found in `../public/`, so all auth, signaling, and
WebRTC code is shared.

## What it does

* On first run, asks for the URL of your RemoteDesk signaling server (e.g.
  `https://remote.example.com/`). The URL is persisted to the app's
  user-data directory.
* Loads that URL in a fullscreen-capable window.
* From the menu: change server URL, sign out (clears cookies), reload,
  toggle fullscreen, open dev tools.

## Development

```bash
cd client/desktop
npm install
npm start
```

## Build installers

```bash
npm run dist:win     # Windows NSIS .exe (requires wine on Linux/macOS)
npm run dist:mac     # macOS .dmg (must run on macOS)
npm run dist:linux   # Linux AppImage
```

CI builds the Windows installer on every push:
[`build-client-windows.yml`](../../.github/workflows/build-client-windows.yml).
Output artifact: `RemoteDeskClient-Setup-<version>.exe`.
