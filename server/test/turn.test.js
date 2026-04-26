import test from "node:test";
import assert from "node:assert/strict";
import { buildIceServers } from "../src/turn.js";
import { generateConnectionId } from "../src/ids.js";

test("STUN-only when TURN not configured", () => {
  const ice = buildIceServers({
    stunUrls: ["stun:stun.l.google.com:19302"],
    turnHost: "",
    turnPort: 3478,
    turnSecret: "",
    ttlSeconds: 3600,
  });
  assert.equal(ice.length, 1);
  assert.equal(ice[0].urls, "stun:stun.l.google.com:19302");
});

test("TURN entry includes time-limited credentials", () => {
  const ice = buildIceServers({
    stunUrls: [],
    turnHost: "turn.example.com",
    turnPort: 3478,
    turnSecret: "topsecret",
    ttlSeconds: 60,
  });
  assert.equal(ice.length, 1);
  const entry = ice[0];
  assert.ok(Array.isArray(entry.urls));
  assert.match(entry.username, /^\d+:remotedesk$/);
  assert.ok(entry.credential.length > 0);
});

test("connection ID is 9 digits", () => {
  for (let i = 0; i < 100; i++) {
    const id = generateConnectionId();
    assert.match(id, /^\d{9}$/);
  }
});
