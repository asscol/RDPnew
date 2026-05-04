// RemoteDesk web client.
//
// Three-area SPA:
//   * Pairing form (Connection ID + PIN, no auth required)
//   * Auth pages (sign in / sign up) and "My hosts" / "Admin" once signed in
//   * Live session (video + input forwarding once paired)
//
// Routing is hash-based so the static file server doesn't need to know about
// it. Auth state is fetched from /api/auth/me on load and on every nav.

const $ = (id) => document.getElementById(id);
const idInput = $("id");
const pinInput = $("pin");
const connectBtn = $("connect");
const disconnectBtn = $("disconnect");
const fullscreenBtn = $("fullscreen");
const statusEl = $("status");
const sessionPanel = $("session");
const stage = $("stage");
const video = $("screen");
const info = $("info");

const PAGES = {
  "/": "login",
  "/login": "page-login",
  "/signup": "page-signup",
  "/hosts": "page-hosts",
  "/admin": "page-admin",
};

let currentUser = null;
let ws = null;
let pc = null;
let inputChan = null;
let inputAbort = null;

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

function showSession(show) {
  sessionPanel.classList.toggle("hidden", !show);
  for (const id of Object.values(PAGES)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", show || pageId(currentRoute()) !== id);
  }
}

function currentRoute() {
  const h = location.hash.replace(/^#/, "") || "/";
  return PAGES[h] ? h : "/";
}

function pageId(route) {
  return PAGES[route] || PAGES["/"];
}

// HTML-escape a string for safe interpolation into innerHTML or attribute
// values. Server-supplied fields (email, label, id) may contain markup
// metacharacters; this prevents stored XSS in the admin and hosts tables.
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "content-type": "application/json" } : {},
    ...opts,
  });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body };
}

async function refreshMe() {
  const r = await api("/api/auth/me");
  currentUser = r.body && r.body.user ? r.body.user : null;
  document.querySelectorAll(".auth-only-in").forEach((el) =>
    el.classList.toggle("hidden", !currentUser),
  );
  document.querySelectorAll(".auth-only-out").forEach((el) =>
    el.classList.toggle("hidden", !!currentUser),
  );
  document.querySelectorAll(".admin-only").forEach((el) =>
    el.classList.toggle("hidden", !(currentUser && currentUser.is_admin)),
  );
}

function navigate() {
  const route = currentRoute();
  // Block /admin if not admin, /hosts if not signed in.
  if (route === "/admin" && !(currentUser && currentUser.is_admin)) {
    location.hash = "#/login";
    return;
  }
  if (route === "/hosts" && !currentUser) {
    location.hash = "#/login";
    return;
  }
  for (const [r, id] of Object.entries(PAGES)) {
    document.getElementById(id).classList.toggle("hidden", r !== route);
  }
  if (route === "/hosts") loadHosts();
  if (route === "/admin") loadAdmin();
}

window.addEventListener("hashchange", navigate);

// ---- auth forms ----

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
  });
  const errEl = document.getElementById("login-error");
  if (!r.ok) {
    errEl.textContent = "Sign-in failed: " + (r.body?.error || r.status);
    errEl.classList.add("error-text");
    return;
  }
  errEl.textContent = "";
  await refreshMe();
  location.hash = "#/hosts";
});

document.getElementById("form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
  });
  const errEl = document.getElementById("signup-error");
  if (!r.ok) {
    errEl.textContent = "Sign-up failed: " + (r.body?.error || r.status);
    errEl.classList.add("error-text");
    return;
  }
  errEl.textContent = "";
  await refreshMe();
  location.hash = "#/hosts";
});

document.getElementById("logout").addEventListener("click", async (e) => {
  e.preventDefault();
  await api("/api/auth/logout", { method: "POST" });
  await refreshMe();
  location.hash = "#/";
});

// ---- my hosts ----

async function loadHosts() {
  const r = await api("/api/me/hosts");
  const tbody = document.querySelector("#hosts-table tbody");
  tbody.innerHTML = "";
  if (!r.ok) return;
  for (const h of r.body.hosts || []) {
    const tr = document.createElement("tr");
    const lastSeen = h.last_seen_at ? new Date(h.last_seen_at).toLocaleString() : "—";
    const id = esc(h.id);
    tr.innerHTML = `
      <td><code>${id}</code></td>
      <td><input class="label-input" data-id="${id}" value="${esc(h.label || "")}" /></td>
      <td>${esc(lastSeen)}</td>
      <td>
        <button class="connect-host" data-id="${id}">Connect</button>
        <button class="danger del-host" data-id="${id}">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".label-input").forEach((el) =>
    el.addEventListener("change", async (e) => {
      await api(`/api/me/hosts/${e.target.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label: e.target.value }),
      });
    }),
  );
  tbody.querySelectorAll(".del-host").forEach((el) =>
    el.addEventListener("click", async (e) => {
      if (!confirm("Remove this host from your account?")) return;
      await api(`/api/me/hosts/${e.target.dataset.id}`, { method: "DELETE" });
      loadHosts();
    }),
  );
  tbody.querySelectorAll(".connect-host").forEach((el) =>
    el.addEventListener("click", (e) => {
      idInput.value = e.target.dataset.id;
      location.hash = "#/";
      pinInput.focus();
    }),
  );
}

// ---- admin ----

async function loadAdmin() {
  const r = await api("/api/admin/users");
  const tbody = document.querySelector("#users-table tbody");
  tbody.innerHTML = "";
  if (!r.ok) return;
  for (const u of r.body.users || []) {
    const tr = document.createElement("tr");
    const status = u.is_banned ? "<span class='status error'>banned</span>"
      : u.is_admin ? "<span class='status warn'>admin</span>"
      : "<span class='status ok'>active</span>";
    const uid = esc(u.id);
    tr.innerHTML = `
      <td>${uid}</td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.host_count)}</td>
      <td>${esc(u.active_sessions)}</td>
      <td>${status}</td>
      <td>
        ${u.is_banned
          ? `<button class="unban" data-id="${uid}">Unban</button>`
          : `<button class="danger ban" data-id="${uid}">Ban</button>`}
        ${u.is_admin
          ? `<button class="demote" data-id="${uid}">Demote</button>`
          : `<button class="promote" data-id="${uid}">Promote</button>`}
        <button class="danger del-user" data-id="${uid}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  const adminAction = (selector, path) => {
    tbody.querySelectorAll(selector).forEach((el) =>
      el.addEventListener("click", async (e) => {
        await api(`/api/admin/users/${e.target.dataset.id}${path}`, { method: "POST" });
        loadAdmin();
      }),
    );
  };
  adminAction(".ban", "/ban");
  adminAction(".unban", "/unban");
  adminAction(".promote", "/promote");
  adminAction(".demote", "/demote");
  tbody.querySelectorAll(".del-user").forEach((el) =>
    el.addEventListener("click", async (e) => {
      if (!confirm("Delete this user permanently?")) return;
      await api(`/api/admin/users/${e.target.dataset.id}`, { method: "DELETE" });
      loadAdmin();
    }),
  );
}

// ---- pairing + WebRTC ----

async function fetchIceServers() {
  try {
    const r = await fetch("/api/ice-servers");
    if (!r.ok) throw new Error("ice-servers " + r.status);
    const j = await r.json();
    return j.iceServers || [];
  } catch (e) {
    console.warn("ice-servers fetch failed, falling back to public STUN", e);
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function startSession() {
  const id = idInput.value.trim();
  const pin = pinInput.value.trim();
  if (!/^\d{9}$/.test(id)) {
    setStatus("ID must be 9 digits", "error");
    return;
  }
  if (!/^\d{4,12}$/.test(pin)) {
    setStatus("PIN must be 4-12 digits", "error");
    return;
  }

  setStatus("connecting…", "warn");

  const iceServers = await fetchIceServers();
  const params = new URLSearchParams(location.search);
  const rtcConfig = { iceServers };
  if (params.get("relay") === "1") {
    rtcConfig.iceTransportPolicy = "relay";
    info.textContent = "relay-only mode";
  }
  pc = new RTCPeerConnection(rtcConfig);

  pc.ontrack = (ev) => {
    if (ev.track.kind === "video") {
      video.srcObject = ev.streams[0];
    }
  };

  pc.ondatachannel = (ev) => {
    if (ev.channel.label === "input") {
      inputChan = ev.channel;
      inputChan.onopen = () => setStatus("connected", "ok");
      inputChan.onclose = () => setStatus("input channel closed", "warn");
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      wsSend({ type: "candidate", candidate: ev.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    info.textContent = "rtc: " + s + (rtcConfig.iceTransportPolicy === "relay" ? " (relay-only)" : "");
    if (s === "failed" || s === "disconnected") {
      setStatus("rtc " + s, "error");
    }
  };

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);

  ws.onopen = () => {
    wsSend({ type: "join", id, pin });
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "joined":
        setStatus("paired, waiting for stream…", "warn");
        showSession(true);
        attachInputForwarding();
        break;
      case "offer": {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: "answer", sdp: answer.sdp });
        break;
      }
      case "candidate":
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (e) { console.warn("addIceCandidate", e); }
        break;
      case "peer-left":
        setStatus("host disconnected", "error");
        teardown();
        break;
      case "error":
        setStatus("error: " + msg.reason, "error");
        teardown();
        break;
    }
  };

  ws.onclose = () => {
    if (statusEl.textContent === "paired, waiting for stream…") {
      setStatus("signaling closed", "warn");
    }
  };
}

function teardown() {
  if (inputAbort) { try { inputAbort.abort(); } catch { /* ignore */ } inputAbort = null; }
  if (inputChan) { try { inputChan.close(); } catch { /* ignore */ } inputChan = null; }
  if (pc) { try { pc.close(); } catch { /* ignore */ } pc = null; }
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  video.srcObject = null;
  showSession(false);
}

function attachInputForwarding() {
  // teardown() aborts this controller, removing every listener attached
  // here. Without this, repeated connect/disconnect cycles stack listeners
  // and each input event fires N times after N reconnects.
  if (inputAbort) { try { inputAbort.abort(); } catch { /* ignore */ } }
  inputAbort = new AbortController();
  const signal = inputAbort.signal;

  function rect() { return video.getBoundingClientRect(); }
  function normCoords(ev) {
    const r = rect();
    if (!r.width || !r.height || !video.videoWidth) return null;
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
  }
  function send(obj) {
    if (inputChan && inputChan.readyState === "open") {
      try { inputChan.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  video.addEventListener("mousemove", (e) => {
    const c = normCoords(e);
    if (c) send({ kind: "mouse-move", x: c.x, y: c.y });
  }, { signal });
  video.addEventListener("mousedown", (e) => {
    const c = normCoords(e); if (!c) return;
    e.preventDefault();
    send({ kind: "mouse-down", button: e.button, x: c.x, y: c.y });
  }, { signal });
  video.addEventListener("mouseup", (e) => {
    const c = normCoords(e); if (!c) return;
    e.preventDefault();
    send({ kind: "mouse-up", button: e.button, x: c.x, y: c.y });
  }, { signal });
  video.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
  video.addEventListener("wheel", (e) => {
    e.preventDefault();
    send({ kind: "wheel", dx: e.deltaX, dy: e.deltaY });
  }, { passive: false, signal });

  stage.addEventListener("keydown", (e) => {
    e.preventDefault();
    send({ kind: "key-down", key: e.key, code: e.code });
  }, { signal });
  stage.addEventListener("keyup", (e) => {
    e.preventDefault();
    send({ kind: "key-up", key: e.key, code: e.code });
  }, { signal });
  stage.focus();
}

connectBtn.addEventListener("click", startSession);
disconnectBtn.addEventListener("click", teardown);
fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    stage.requestFullscreen();
  }
});

for (const el of [idInput, pinInput]) {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSession();
  });
}

setStatus("disconnected");

// boot
(async () => {
  await refreshMe();
  navigate();
})();
