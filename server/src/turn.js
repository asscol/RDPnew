// Build the iceServers array sent to web clients.
//
// For TURN with coturn `use-auth-secret` mode, the username is
// `<unix-expiry>:<arbitrary>` and the password is HMAC-SHA1(secret, username)
// base64-encoded. See https://datatracker.ietf.org/doc/html/draft-uberti-rtcweb-turn-rest-00.

import crypto from "node:crypto";

/**
 * @param {{stunUrls: string[], turnHost: string, turnPort: number,
 *          turnSecret: string, ttlSeconds: number}} opts
 */
export function buildIceServers(opts) {
  const ice = [];
  for (const url of opts.stunUrls) {
    if (url) ice.push({ urls: url });
  }
  if (opts.turnHost && opts.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    const username = `${expiry}:remotedesk`;
    const credential = crypto
      .createHmac("sha1", opts.turnSecret)
      .update(username)
      .digest("base64");
    const turnUrl = `turn:${opts.turnHost}:${opts.turnPort}`;
    const turnsUrl = `turns:${opts.turnHost}:${opts.turnPort}`;
    ice.push({ urls: [turnUrl, turnsUrl], username, credential });
  }
  return ice;
}
