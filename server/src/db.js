// SQLite persistence for RemoteDesk: users, hosts, sessions, audit log.
//
// The signaling server uses one SQLite file (DB_PATH, default
// `data/remotedesk.sqlite`) for everything that has to outlive a server
// restart: registered users, persistent host IDs (TeamViewer-style), browser
// session cookies, and an admin audit log.
//
// Schema is created idempotently on import via `initDb()` — there is no
// separate migration tool for v0.x.
import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DB_PATH = path.resolve(
  process.env.DB_PATH ||
    path.join(__dirname, "..", "data", "remotedesk.sqlite"),
);

let db = null;

export function initDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      label TEXT,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_hosts_owner ON hosts(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error("database not initialised; call initDb() first");
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Hash a host secret_token (or any opaque token) for at-rest storage.
// Tokens are 256-bit URL-safe randoms; SHA-256 is sufficient and fast,
// no need for bcrypt overhead here.
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Insert a one-time bootstrap admin if ADMIN_EMAIL / ADMIN_PASSWORD env vars
// are set and the users table is empty. Idempotent.
export function ensureBootstrapAdmin({ email, passwordHash, now = Date.now() }) {
  const d = getDb();
  const count = d.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return false;
  d.prepare(
    `INSERT INTO users (email, password_hash, is_admin, is_banned, created_at)
     VALUES (?, ?, 1, 0, ?)`,
  ).run(email, passwordHash, now);
  return true;
}
