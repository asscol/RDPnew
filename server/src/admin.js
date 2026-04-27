// Admin actions: list/ban/unban/delete users + force-disconnect hosts.
// HTTP routes in routes.js gate these on `is_admin`. The functions here
// are pure DB ops + audit-log writes so they're easy to unit-test.
import { getDb } from "./db.js";

export function listUsers() {
  return getDb()
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.is_banned,
              u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM hosts h WHERE h.owner_user_id = u.id) AS host_count,
              (SELECT COUNT(*) FROM sessions s
               WHERE s.user_id = u.id AND s.expires_at > strftime('%s','now')*1000) AS active_sessions
       FROM users u
       ORDER BY u.created_at DESC`,
    )
    .all();
}

export function setUserBanned({ userId, banned, actorId, now = Date.now() }) {
  const db = getDb();
  db.prepare("UPDATE users SET is_banned = ? WHERE id = ?").run(
    banned ? 1 : 0,
    userId,
  );
  if (banned) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
  audit({ actorId, action: banned ? "ban" : "unban", target: `user:${userId}`, now });
}

export function setUserAdmin({ userId, isAdmin, actorId, now = Date.now() }) {
  getDb()
    .prepare("UPDATE users SET is_admin = ? WHERE id = ?")
    .run(isAdmin ? 1 : 0, userId);
  audit({
    actorId,
    action: isAdmin ? "promote-admin" : "demote-admin",
    target: `user:${userId}`,
    now,
  });
}

export function deleteUser({ userId, actorId, now = Date.now() }) {
  // FK ON DELETE CASCADE removes sessions; hosts.owner_user_id becomes NULL.
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
  audit({ actorId, action: "delete-user", target: `user:${userId}`, now });
}

export function audit({ actorId = null, action, target = null, details = null, now = Date.now() }) {
  getDb()
    .prepare(
      `INSERT INTO audit_log (ts, actor_user_id, action, target, details)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(now, actorId, action, target, details ? JSON.stringify(details) : null);
}

export function listAuditLog({ limit = 100 } = {}) {
  return getDb()
    .prepare(
      `SELECT a.id, a.ts, a.action, a.target, a.details,
              a.actor_user_id, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.ts DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(1000, limit)));
}
