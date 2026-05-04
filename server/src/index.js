// RemoteDesk signaling server.
//
// Responsibilities:
//   * Serve the static web client (client/public).
//   * Maintain a registry of hosts keyed by a 9-digit connection ID.
//   * Verify that the client supplies the matching one-time PIN.
//   * Relay SDP offers/answers and ICE candidates between host and client.
//   * Persist users, hosts, sessions, and audit log in SQLite.
//   * Expose REST endpoints for auth, host management, admin, and ICE
//     servers (STUN + time-limited TURN credentials).
//
// Wire protocol (JSON over WebSocket, one message per frame):
//
//   Host (first run, no saved credentials) -> server:
//     {"type":"register","role":"host","pin":"1234"}
//   Server -> host:
//     {"type":"registered","id":"123456789","secret":"<token>"}
//
//   Host (subsequent runs) -> server:
//     {"type":"register","role":"host","pin":"1234","id":"123456789","secret":"<token>"}
//   Server -> host:
//     {"type":"registered","id":"123456789"}
//     {"type":"error","reason":"bad-token"}        (token mismatch)
//
//   Client -> server:
//     {"type":"join","id":"123456789","pin":"1234"}
//   Server -> client:
//     {"type":"joined"}
//     {"type":"error","reason":"not-found"|"bad-pin"|"busy"|"offline"}
//
//   After pairing, any other message is forwarded verbatim to the peer.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

import { initDb, ensureBootstrapAdmin } from "./db.js";
import { hashPassword } from "./auth.js";
import {
  registerNewHost,
  authenticateHost,
} from "./hosts.js";
import { audit } from "./admin.js";
import { handleApi } from "./routes.js";
import { buildIceServers } from "./turn.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.resolve(
  process.env.PUBLIC_DIR || path.join(__dirname, "..", "..", "client", "public"),
);

const STUN_URLS = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TURN_HOST = process.env.TURN_HOST || "";
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_TTL = Number(process.env.TURN_TTL || 3600);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

initDb();
await maybeBootstrapAdmin();

/** @type {Map<string, {ws: import('ws').WebSocket, pin: string, peer: import('ws').WebSocket | null}>} */
const liveHosts = new Map();

function safeJoin(base, target) {
  const resolved = path.resolve(base, "." + target);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url || "/");
  let pathname = parsed.pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = safeJoin(PUBLIC_DIR, pathname);
  if (!filePath) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

function handleIceServers(req, res) {
  const ice = buildIceServers({
    stunUrls: STUN_URLS,
    turnHost: TURN_HOST,
    turnPort: TURN_PORT,
    turnSecret: TURN_SECRET,
    ttlSeconds: TURN_TTL,
  });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(JSON.stringify({ iceServers: ice }));
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/ice-servers") {
    handleIceServers(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/")) {
    const handled = await handleApi(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sendError(ws, reason) {
  send(ws, { type: "error", reason });
}

wss.on("connection", (ws) => {
  /** @type {{role: 'host'|'client'|null, id: string|null}} */
  const state = { role: null, id: null };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(ws, "bad-json");
      return;
    }

    if (state.role === null) {
      if (msg.type === "register" && msg.role === "host") {
        const pin = String(msg.pin || "").trim();
        if (!/^\d{4,12}$/.test(pin)) {
          sendError(ws, "bad-pin-format");
          return;
        }
        // Re-register existing host: id+secret provided.
        if (msg.id && msg.secret) {
          const auth = authenticateHost({ id: String(msg.id), token: String(msg.secret) });
          if (auth.error) {
            sendError(ws, auth.error);
            return;
          }
          if (liveHosts.has(auth.host.id)) {
            // Replace previous live socket; old one will be closed below.
            const prev = liveHosts.get(auth.host.id);
            if (prev.peer) send(prev.peer, { type: "peer-left" });
            try { prev.ws.close(4001, "replaced"); } catch { /* ignore */ }
          }
          liveHosts.set(auth.host.id, { ws, pin, peer: null });
          state.role = "host";
          state.id = auth.host.id;
          send(ws, { type: "registered", id: auth.host.id });
          return;
        }
        // First-time registration: allocate a new id+secret.
        const { id, token } = registerNewHost({});
        liveHosts.set(id, { ws, pin, peer: null });
        state.role = "host";
        state.id = id;
        send(ws, { type: "registered", id, secret: token });
        audit({ action: "host-register", target: `host:${id}` });
        return;
      }
      if (msg.type === "join" && typeof msg.id === "string") {
        const id = msg.id.trim();
        const pin = String(msg.pin || "").trim();
        const entry = liveHosts.get(id);
        if (!entry) {
          sendError(ws, "offline");
          return;
        }
        if (
          !crypto.timingSafeEqual(
            Buffer.from(entry.pin.padEnd(12, "\0")),
            Buffer.from(pin.padEnd(12, "\0")),
          )
        ) {
          sendError(ws, "bad-pin");
          return;
        }
        if (entry.peer) {
          sendError(ws, "busy");
          return;
        }
        entry.peer = ws;
        state.role = "client";
        state.id = id;
        send(ws, { type: "joined" });
        send(entry.ws, { type: "peer-joined" });
        return;
      }
      sendError(ws, "bad-handshake");
      return;
    }

    const entry = state.id ? liveHosts.get(state.id) : null;
    if (!entry) {
      sendError(ws, "no-session");
      return;
    }
    const target = state.role === "host" ? entry.peer : entry.ws;
    if (!target) {
      sendError(ws, "peer-gone");
      return;
    }
    send(target, msg);
  });

  ws.on("close", () => {
    if (state.role === "host" && state.id) {
      const entry = liveHosts.get(state.id);
      if (entry && entry.ws === ws) {
        if (entry.peer) send(entry.peer, { type: "peer-left" });
        liveHosts.delete(state.id);
      }
    } else if (state.role === "client" && state.id) {
      const entry = liveHosts.get(state.id);
      if (entry && entry.peer === ws) {
        entry.peer = null;
        send(entry.ws, { type: "peer-left" });
      }
    }
  });

  ws.on("error", () => {
    // ws emits 'close' after 'error' so cleanup happens there.
  });
});

server.listen(PORT, () => {
  console.log(`[remotedesk-server] listening on :${PORT} (public=${PUBLIC_DIR})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[remotedesk-server] ${sig}, shutting down`);
    wss.clients.forEach((c) => c.terminate());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

async function maybeBootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const passwordHash = await hashPassword(password);
  const created = ensureBootstrapAdmin({ email: email.toLowerCase(), passwordHash });
  if (created) {
    console.log(`[remotedesk-server] bootstrap admin created: ${email}`);
  }
}

// Force-disconnect a live host (used by the admin endpoint via in-process call).
export function forceDisconnectHost(id) {
  const entry = liveHosts.get(id);
  if (!entry) return false;
  if (entry.peer) send(entry.peer, { type: "peer-left" });
  try { entry.ws.close(4002, "admin-disconnect"); } catch { /* ignore */ }
  liveHosts.delete(id);
  return true;
}
