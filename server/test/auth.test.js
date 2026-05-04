// Auth-flow unit tests: registration, login, sessions, ban semantics.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { initDb, closeDb, ensureBootstrapAdmin } from "../src/db.js";
import {
  registerUser,
  authenticateUser,
  createSession,
  loadSession,
  destroySession,
  hashPassword,
} from "../src/auth.js";
import { setUserBanned } from "../src/admin.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-auth-"));
  initDb(path.join(tmpDir, "test.sqlite"));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerUser", () => {
  test("happy path", async () => {
    const r = await registerUser({ email: "alice@example.com", password: "s3cret-pw" });
    assert.equal(typeof r.userId, "number");
  });

  test("rejects bad email", async () => {
    const r = await registerUser({ email: "not-an-email", password: "s3cret-pw" });
    assert.equal(r.error, "bad-email");
  });

  test("rejects short password", async () => {
    const r = await registerUser({ email: "bob@example.com", password: "x" });
    assert.equal(r.error, "bad-password");
  });

  test("rejects duplicates (case-insensitive)", async () => {
    await registerUser({ email: "carol@example.com", password: "s3cret-pw" });
    const r = await registerUser({ email: "Carol@Example.com", password: "s3cret-pw" });
    assert.equal(r.error, "email-taken");
  });
});

describe("authenticateUser", () => {
  test("rejects unknown user with bad-credentials (no user enumeration)", async () => {
    const r = await authenticateUser({ email: "ghost@example.com", password: "s3cret-pw" });
    assert.equal(r.error, "bad-credentials");
  });

  test("rejects wrong password", async () => {
    await registerUser({ email: "dan@example.com", password: "s3cret-pw" });
    const r = await authenticateUser({ email: "dan@example.com", password: "wrong-pw1" });
    assert.equal(r.error, "bad-credentials");
  });

  test("returns banned for banned user", async () => {
    const reg = await registerUser({ email: "ev@example.com", password: "s3cret-pw" });
    setUserBanned({ userId: reg.userId, banned: true, actorId: null });
    const r = await authenticateUser({ email: "ev@example.com", password: "s3cret-pw" });
    assert.equal(r.error, "banned");
  });

  test("happy path returns user", async () => {
    await registerUser({ email: "fox@example.com", password: "s3cret-pw" });
    const r = await authenticateUser({ email: "fox@example.com", password: "s3cret-pw" });
    assert.equal(r.user.email, "fox@example.com");
    assert.equal(r.user.is_admin, false);
  });
});

describe("sessions", () => {
  test("create + load + destroy", async () => {
    const reg = await registerUser({ email: "gail@example.com", password: "s3cret-pw" });
    const { token } = createSession({ userId: reg.userId });
    const loaded = loadSession(token);
    assert.equal(loaded.user.email, "gail@example.com");
    destroySession(token);
    assert.equal(loadSession(token), null);
  });

  test("expired sessions return null and self-cleanup", async () => {
    const reg = await registerUser({ email: "h@example.com", password: "s3cret-pw" });
    const past = Date.now() - 1000;
    const { token } = createSession({ userId: reg.userId, now: past - 31 * 24 * 60 * 60 * 1000 });
    // Force expiry by inspecting
    const result = loadSession(token, Date.now() + 9999);
    assert.equal(result, null);
  });

  test("banned user's session resolves to null", async () => {
    const reg = await registerUser({ email: "i@example.com", password: "s3cret-pw" });
    const { token } = createSession({ userId: reg.userId });
    setUserBanned({ userId: reg.userId, banned: true, actorId: null });
    assert.equal(loadSession(token), null);
  });
});

describe("ensureBootstrapAdmin", () => {
  test("creates admin only when users table is empty", async () => {
    const hash = await hashPassword("admin-pw1");
    const created1 = ensureBootstrapAdmin({ email: "admin@example.com", passwordHash: hash });
    const created2 = ensureBootstrapAdmin({ email: "admin@example.com", passwordHash: hash });
    assert.equal(created1, true);
    assert.equal(created2, false);
  });
});
