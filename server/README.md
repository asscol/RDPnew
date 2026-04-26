# RemoteDesk Signaling Server

Lightweight Node.js (>=18) WebSocket signaling server. Pairs hosts and clients
by 9-digit connection ID + PIN, then relays WebRTC SDP/ICE between them.
Also serves the browser client (`client/public`) and exposes
`/api/ice-servers` for STUN+TURN discovery.

## Local run

```bash
cd server
npm install
npm start
# server on http://localhost:8080
# WebSocket: ws://localhost:8080/ws
```

## Configuration (env)

| Variable      | Default                       | Description                                      |
|---------------|-------------------------------|--------------------------------------------------|
| `PORT`        | `8080`                        | HTTP/WebSocket port                              |
| `PUBLIC_DIR`  | `../client/public`            | Static dir for the web client                    |
| `STUN_URLS`   | `stun:stun.l.google.com:19302`| Comma-separated STUN URLs                        |
| `TURN_HOST`   | _(empty)_                     | Public hostname of your coturn                   |
| `TURN_PORT`   | `3478`                        | coturn port                                      |
| `TURN_SECRET` | _(empty)_                     | Shared secret for coturn `use-auth-secret`       |
| `TURN_TTL`    | `3600`                        | TURN credential lifetime (seconds)               |

## Production deploy

See [`packaging/linux`](../packaging/linux) for `docker-compose.yml`,
`coturn.conf`, and `systemd` units.

## Tests / lint

```bash
npm test
npm run lint
```
