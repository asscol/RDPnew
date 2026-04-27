// Authentication primitives: password hashing, signup/login, session cookies,
// and a small middleware-ish helper for HTTP handlers.
//
// Sessions are opaque random tokens stored in the `sessions` table and set as
// a httpOnly cookie. Bcrypt cost is 10 — fine for a self-hosted box with
// modest signup rates.
import bcrypt from "bcryptjs";
import * as cookie from "cookie";
import { getDb, generateToken } from "./db.js";

const SESSION_COOKIE = "rd_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function validateEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email) && email.length <= 254;
}

export function validatePassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 200;
}

export async function registerUser({ email, password, now = Date.now() }) {
  if (!validateEmail(email)) return { error: "bad-email" };
  if (!validatePassword(password)) return { error: "bad-password" };
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email.toLowerCase());
  if (existing) return { error: "email-taken" };
  const passwordHash = await hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, is_admin, is_banned, created_at)
       VALUES (?, ?, 0, 0, ?)`,
    )
    .run(email.toLowerCase(), passwordHash, now);
  return { userId: info.lastInsertRowid };
}

export async function authenticateUser({ email, password }) {
  if (!validateEmail(email) || !validatePassword(password)) {
    return { error: "bad-credentials" };
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, password_hash, is_admin, is_banned
       FROM users WHERE email = ?`,
    )
    .get(email.toLowerCase());
  if (!row) return { error: "bad-credentials" };
  if (row.is_banned) return { error: "banned" };
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return { error: "bad-credentials" };
  return {
    user: {
      id: row.id,
      email: email.toLowerCase(),
      is_admin: !!row.is_admin,
    },
  };
}

export function createSession({ userId, now = Date.now() }) {
  const db = getDb();
  const token = generateToken();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(token, userId, now, expiresAt);
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(
    now,
    userId,
  );
  return { token, expiresAt };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions(now = Date.now()) {
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
}

export function loadSession(token, now = Date.now()) {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.token, s.user_id, s.expires_at,
              u.email, u.is_admin, u.is_banned
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < now) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  if (row.is_banned) return null;
  return {
    token: row.token,
    user: {
      id: row.user_id,
      email: row.email,
      is_admin: !!row.is_admin,
    },
  };
}

export function getRequestSession(req) {
  const header = req.headers?.cookie || "";
  const parsed = cookie.parse(header);
  const token = parsed[SESSION_COOKIE];
  return loadSession(token);
}

export function buildSessionCookie({ token, expiresAt, secure = false }) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  });
}

export function buildClearCookie({ secure = false }) {
  return cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}

export function readSessionCookie(req) {
  const header = req.headers?.cookie || "";
  const parsed = cookie.parse(header);
  return parsed[SESSION_COOKIE] || null;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
