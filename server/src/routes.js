// REST API endpoints: auth (signup/login/logout/me), my hosts, admin.
//
// All handlers are plain (req, res, body) -> Promise<void> functions. The
// dispatcher in index.js parses URL + body, then routes to the right handler.
// Returning JSON responses is uniform via `json()`.
import {
  registerUser,
  authenticateUser,
  createSession,
  destroySession,
  getRequestSession,
  buildSessionCookie,
  buildClearCookie,
  readSessionCookie,
} from "./auth.js";
import { listHostsForUser, deleteHost, updateHostLabel } from "./hosts.js";
import {
  listUsers,
  setUserBanned,
  setUserAdmin,
  deleteUser,
  listAuditLog,
  audit,
} from "./admin.js";

const SECURE_COOKIES = process.env.SECURE_COOKIES === "1";

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (total === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const session = getRequestSession(req);
  if (!session) {
    json(res, 401, { error: "unauthenticated" });
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = requireAuth(req, res);
  if (!session) return null;
  if (!session.user.is_admin) {
    json(res, 403, { error: "forbidden" });
    return null;
  }
  return session;
}

// ---- handlers ----

async function postRegister(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: "bad-request" });
  }
  const result = await registerUser({ email: body.email, password: body.password });
  if (result.error) return json(res, 400, { error: result.error });
  const { token, expiresAt } = createSession({ userId: result.userId });
  res.setHeader(
    "set-cookie",
    buildSessionCookie({ token, expiresAt, secure: SECURE_COOKIES }),
  );
  audit({ actorId: result.userId, action: "register" });
  json(res, 200, { ok: true, user: { id: result.userId, email: body.email.toLowerCase(), is_admin: false } });
}

async function postLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: "bad-request" });
  }
  const result = await authenticateUser({ email: body.email, password: body.password });
  if (result.error) return json(res, 401, { error: result.error });
  const { token, expiresAt } = createSession({ userId: result.user.id });
  res.setHeader(
    "set-cookie",
    buildSessionCookie({ token, expiresAt, secure: SECURE_COOKIES }),
  );
  audit({ actorId: result.user.id, action: "login" });
  json(res, 200, { ok: true, user: result.user });
}

async function postLogout(req, res) {
  const token = readSessionCookie(req);
  if (token) destroySession(token);
  res.setHeader("set-cookie", buildClearCookie({ secure: SECURE_COOKIES }));
  json(res, 200, { ok: true });
}

async function getMe(req, res) {
  const session = getRequestSession(req);
  if (!session) return json(res, 200, { user: null });
  json(res, 200, { user: session.user });
}

async function getMyHosts(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  json(res, 200, { hosts: listHostsForUser(session.user.id) });
}

async function patchMyHost(req, res, params) {
  const session = requireAuth(req, res);
  if (!session) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: "bad-request" });
  }
  const label = String(body.label || "").slice(0, 80) || null;
  // ensure host belongs to caller
  const owned = listHostsForUser(session.user.id).some((h) => h.id === params.id);
  if (!owned) return json(res, 404, { error: "not-found" });
  updateHostLabel(params.id, label);
  json(res, 200, { ok: true });
}

async function deleteMyHost(req, res, params) {
  const session = requireAuth(req, res);
  if (!session) return;
  const owned = listHostsForUser(session.user.id).some((h) => h.id === params.id);
  if (!owned) return json(res, 404, { error: "not-found" });
  deleteHost(params.id);
  audit({ actorId: session.user.id, action: "delete-host", target: `host:${params.id}` });
  json(res, 200, { ok: true });
}

// ---- admin ----

async function adminListUsers(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  json(res, 200, { users: listUsers() });
}

async function adminBanUser(req, res, params) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const userId = Number(params.id);
  if (!userId) return json(res, 400, { error: "bad-id" });
  if (userId === session.user.id) return json(res, 400, { error: "cant-ban-self" });
  setUserBanned({ userId, banned: true, actorId: session.user.id });
  json(res, 200, { ok: true });
}

async function adminUnbanUser(req, res, params) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const userId = Number(params.id);
  if (!userId) return json(res, 400, { error: "bad-id" });
  setUserBanned({ userId, banned: false, actorId: session.user.id });
  json(res, 200, { ok: true });
}

async function adminPromoteUser(req, res, params) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const userId = Number(params.id);
  if (!userId) return json(res, 400, { error: "bad-id" });
  setUserAdmin({ userId, isAdmin: true, actorId: session.user.id });
  json(res, 200, { ok: true });
}

async function adminDemoteUser(req, res, params) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const userId = Number(params.id);
  if (!userId) return json(res, 400, { error: "bad-id" });
  if (userId === session.user.id) return json(res, 400, { error: "cant-demote-self" });
  setUserAdmin({ userId, isAdmin: false, actorId: session.user.id });
  json(res, 200, { ok: true });
}

async function adminDeleteUser(req, res, params) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const userId = Number(params.id);
  if (!userId) return json(res, 400, { error: "bad-id" });
  if (userId === session.user.id) return json(res, 400, { error: "cant-delete-self" });
  deleteUser({ userId, actorId: session.user.id });
  json(res, 200, { ok: true });
}

async function adminAuditLog(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  json(res, 200, { entries: listAuditLog({ limit: 200 }) });
}

// ---- routing ----

const ROUTES = [
  { method: "POST", path: "/api/auth/register", handler: postRegister },
  { method: "POST", path: "/api/auth/login", handler: postLogin },
  { method: "POST", path: "/api/auth/logout", handler: postLogout },
  { method: "GET", path: "/api/auth/me", handler: getMe },
  { method: "GET", path: "/api/me/hosts", handler: getMyHosts },
  {
    method: "PATCH",
    pattern: /^\/api\/me\/hosts\/(\d{9})$/,
    handler: patchMyHost,
    keys: ["id"],
  },
  {
    method: "DELETE",
    pattern: /^\/api\/me\/hosts\/(\d{9})$/,
    handler: deleteMyHost,
    keys: ["id"],
  },
  { method: "GET", path: "/api/admin/users", handler: adminListUsers },
  { method: "GET", path: "/api/admin/audit", handler: adminAuditLog },
  {
    method: "POST",
    pattern: /^\/api\/admin\/users\/(\d+)\/ban$/,
    handler: adminBanUser,
    keys: ["id"],
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/users\/(\d+)\/unban$/,
    handler: adminUnbanUser,
    keys: ["id"],
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/users\/(\d+)\/promote$/,
    handler: adminPromoteUser,
    keys: ["id"],
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/users\/(\d+)\/demote$/,
    handler: adminDemoteUser,
    keys: ["id"],
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/users\/(\d+)$/,
    handler: adminDeleteUser,
    keys: ["id"],
  },
];

export async function handleApi(req, res) {
  if (!req.url || !req.url.startsWith("/api/")) return false;
  const url = req.url.split("?")[0];
  for (const route of ROUTES) {
    if (route.method && route.method !== req.method) continue;
    if (route.path && route.path === url) {
      try {
        await route.handler(req, res);
      } catch (err) {
        console.error("[api] error", err);
        if (!res.headersSent) json(res, 500, { error: "internal" });
      }
      return true;
    }
    if (route.pattern) {
      const m = url.match(route.pattern);
      if (m) {
        const params = {};
        (route.keys || []).forEach((k, i) => (params[k] = m[i + 1]));
        try {
          await route.handler(req, res, params);
        } catch (err) {
          console.error("[api] error", err);
          if (!res.headersSent) json(res, 500, { error: "internal" });
        }
        return true;
      }
    }
  }
  json(res, 404, { error: "not-found" });
  return true;
}
