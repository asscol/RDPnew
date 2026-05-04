// Persistent host registry: register, re-auth with token, link, list.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { initDb, closeDb } from "../src/db.js";
import {
  registerNewHost,
  authenticateHost,
  listHostsForUser,
  linkHostToUser,
} from "../src/hosts.js";
import { registerUser } from "../src/auth.js";

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-hosts-"));
  initDb(path.join(tmpDir, "test.sqlite"));
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerNewHost", () => {
  test("returns a 9-digit id and an opaque secret", () => {
    const { id, token } = registerNewHost({});
    assert.match(id, /^\d{9}$/);
    assert.ok(token.length >= 32);
  });

  test("ids are unique across calls", () => {
    const ids = new Set();
    for (let i = 0; i < 50; i += 1) {
      const { id } = registerNewHost({});
      assert.equal(ids.has(id), false, "duplicate id");
      ids.add(id);
    }
  });
});

describe("authenticateHost", () => {
  test("accepts the right token", () => {
    const { id, token } = registerNewHost({});
    const r = authenticateHost({ id, token });
    assert.equal(r.host.id, id);
  });

  test("rejects wrong token", () => {
    const { id } = registerNewHost({});
    const r = authenticateHost({ id, token: "definitely-not-the-real-token" });
    assert.equal(r.error, "bad-token");
  });

  test("rejects unknown id", () => {
    const r = authenticateHost({ id: "999999999", token: "anything" });
    assert.equal(r.error, "not-found");
  });
});

describe("link host to user", () => {
  test("listHostsForUser shows linked host", async () => {
    const u = await registerUser({ email: "owner@example.com", password: "ownerpw01" });
    const { id, token } = registerNewHost({});
    const link = linkHostToUser({ hostId: id, token, userId: u.userId });
    assert.equal(link.ok, true);
    const hosts = listHostsForUser(u.userId);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].id, id);
  });

  test("linking with bad token fails", async () => {
    const u = await registerUser({ email: "x@example.com", password: "ownerpw01" });
    const { id } = registerNewHost({});
    const link = linkHostToUser({ hostId: id, token: "wrong", userId: u.userId });
    assert.equal(link.error, "bad-token");
    assert.equal(listHostsForUser(u.userId).length, 0);
  });
});
