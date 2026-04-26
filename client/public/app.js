// RemoteDesk web client.
//
// Flow:
//   1. User enters Connection ID + PIN, clicks Connect.
//   2. We GET /api/ice-servers to discover STUN/TURN servers.
//   3. Open WebSocket to /ws, send {type:"join", id, pin}.
//   4. On {type:"joined"}, create RTCPeerConnection. We are the answerer:
//      the host sends an offer.
//   5. Display the inbound video track on <video>.
//   6. Open a DataChannel labelled "input" (host creates it). Forward
//      mouse/keyboard events as JSON over that channel.

const $ = (id) => document.getElementById(id);
const idInput = $("id");
const pinInput = $("pin");
const connectBtn = $("connect");
const disconnectBtn = $("disconnect");
const fullscreenBtn = $("fullscreen");
const statusEl = $("status");
const loginPanel = $("login");
const sessionPanel = $("session");
const stage = $("stage");
const video = $("screen");
const info = $("info");

let ws = null;
let pc = null;
let inputChan = null;

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

function showSession(show) {
  loginPanel.classList.toggle("hidden", show);
  sessionPanel.classList.toggle("hidden", !show);
}

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
  pc = new RTCPeerConnection({ iceServers });

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
    info.textContent = "rtc: " + pc.connectionState;
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus("rtc " + pc.connectionState, "error");
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
      case "offer":
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: "answer", sdp: answer.sdp });
        break;
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
  if (inputChan) { try { inputChan.close(); } catch {} inputChan = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  video.srcObject = null;
  showSession(false);
}

function attachInputForwarding() {
  function rect() {
    return video.getBoundingClientRect();
  }
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
      try { inputChan.send(JSON.stringify(obj)); } catch {}
    }
  }

  video.addEventListener("mousemove", (e) => {
    const c = normCoords(e);
    if (c) send({ kind: "mouse-move", x: c.x, y: c.y });
  });
  video.addEventListener("mousedown", (e) => {
    const c = normCoords(e); if (!c) return;
    e.preventDefault();
    send({ kind: "mouse-down", button: e.button, x: c.x, y: c.y });
  });
  video.addEventListener("mouseup", (e) => {
    const c = normCoords(e); if (!c) return;
    e.preventDefault();
    send({ kind: "mouse-up", button: e.button, x: c.x, y: c.y });
  });
  video.addEventListener("contextmenu", (e) => e.preventDefault());
  video.addEventListener("wheel", (e) => {
    e.preventDefault();
    send({ kind: "wheel", dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });

  // Keyboard: focus must be on .stage container.
  stage.addEventListener("keydown", (e) => {
    e.preventDefault();
    send({ kind: "key-down", key: e.key, code: e.code });
  });
  stage.addEventListener("keyup", (e) => {
    e.preventDefault();
    send({ kind: "key-up", key: e.key, code: e.code });
  });
  // Auto-focus the stage so keyboard works immediately.
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

// Allow Enter to submit.
for (const el of [idInput, pinInput]) {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSession();
  });
}

setStatus("disconnected");
