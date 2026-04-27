// Persistent host registry: 9-digit IDs survive process restarts and rotate
// only when explicitly reset. Each host stores a hashed secret_token; the
// agent presents the cleartext token on every reconnect to prove ownership.
import { getDb, generateToken, hashToken } from "./db.js";
import { generateConnectionId } from "./ids.js";

export function registerNewHost({ label = null, ownerUserId = null, now = Date.now() }) {
  const db = getDb();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const stmt = db.prepare(
    `INSERT INTO hosts (id, secret_hash, label, owner_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 25; i += 1) {
    const id = generateConnectionId();
    try {
      stmt.run(id, tokenHash, label, ownerUserId, now, now);
      return { id, token };
    } catch (err) {
      // UNIQUE constraint failed — collision; retry.
      if (err && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") continue;
      throw err;
    }
  }
  throw new Error("failed to allocate unique host id");
}

export function authenticateHost({ id, token, now = Date.now() }) {
  if (!id || !token) return { error: "bad-credentials" };
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, secret_hash, owner_user_id, label
       FROM hosts WHERE id = ?`,
    )
    .get(id);
  if (!row) return { error: "not-found" };
  if (row.secret_hash !== hashToken(token)) return { error: "bad-token" };
  db.prepare("UPDATE hosts SET last_seen_at = ? WHERE id = ?").run(now, id);
  return {
    host: {
      id: row.id,
      ownerUserId: row.owner_user_id,
      label: row.label,
    },
  };
}

export function listHosts() {
  return getDb()
    .prepare(
      `SELECT h.id, h.label, h.owner_user_id, h.created_at, h.last_seen_at,
              u.email AS owner_email
       FROM hosts h
       LEFT JOIN users u ON u.id = h.owner_user_id
       ORDER BY h.created_at DESC`,
    )
    .all();
}

export function listHostsForUser(userId) {
  return getDb()
    .prepare(
      `SELECT id, label, created_at, last_seen_at
       FROM hosts
       WHERE owner_user_id = ?
       ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
    )
    .all(userId);
}

export function deleteHost(id) {
  return getDb().prepare("DELETE FROM hosts WHERE id = ?").run(id);
}

export function updateHostLabel(id, label) {
  return getDb().prepare("UPDATE hosts SET label = ? WHERE id = ?").run(label, id);
}

// Link an unlinked host to a user, validated by the host's token.
export function linkHostToUser({ hostId, token, userId, now = Date.now() }) {
  const auth = authenticateHost({ id: hostId, token, now });
  if (auth.error) return auth;
  getDb()
    .prepare("UPDATE hosts SET owner_user_id = ? WHERE id = ?")
    .run(userId, hostId);
  return { ok: true };
}
