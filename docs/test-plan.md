# Test plan — RemoteDesk PR #1

## What changed
A brand-new self-hosted TeamViewer alternative: Node signaling server +
coturn relay packaging + Python host agent (`aiortc` + `mss` + `pynput`) +
browser web client. The PR introduces all three components from scratch.

## Environment under test
- Same VM. Signaling server on `localhost:8080`. Host agent runs as the
  user with `DISPLAY=:0` (the GUI of this VM). Web client is opened in
  Chrome on the same VM and points at `http://localhost:8080/`.
- Loopback only: STUN/TURN are not exercised (the user explicitly needs to
  validate that on a real VPS — out of scope here).

## Tests

### T1 — Bad PIN is rejected by the signaling server
**Steps**
1. Host agent prints `Connection ID = $ID` and `PIN = $PIN`.
2. In the web client, type `$ID` and a deliberately wrong PIN, click *Connect*.

**Pass criteria**
- The `<span id="status">` text becomes exactly **`error: bad-pin`** with the
  red `error` class.
- The `<section id="session">` stays hidden (`display: none`).
- Host stdout does NOT print `client paired, starting WebRTC`.

**Why this distinguishes a broken implementation:** if PIN comparison were
removed or done on the wrong side, the client would either move past the
"connecting…" state or report a generic error like `not-found`. We assert
the exact reason string.

### T2 — Correct PIN pairs and host's screen appears in the browser
**Steps**
1. Reload the page, enter `$ID` + correct `$PIN`, click *Connect*.
2. Wait up to 10 s.

**Pass criteria**
- Status pill becomes **`connected`** with the green `ok` class.
- The `<video>` element shows non-black content. Specifically: a
  screenshot of the browser must contain the title bar of the Konsole that
  was previously opened on the desktop. (The video literally shows itself
  recursively, so it's an obvious "yes the stream works" signal.)
- Network tab shows the WebSocket `/ws` connection upgraded to 101 and
  exchanged `joined`, `offer`, `answer`, `candidate` messages.

**Why this distinguishes a broken implementation:** if WebRTC offer/answer
or video track plumbing were broken, the video would stay black; the status
would stuck on `paired, waiting for stream…`.

### T3 — Mouse moves from web client are injected on host
**Steps**
1. Inside the running session, move the mouse cursor over the `<video>`.
2. Watch the **outer** desktop's real cursor — captured in the recording.

**Pass criteria**
- The host's cursor follows the web-client's pointer to within ~5 pixels.
- Specifically: hover over the *top-right* of the video; host cursor moves
  to the top-right of the screen. Then hover over *bottom-left*; host
  cursor moves to bottom-left.

**Why this distinguishes a broken implementation:** if `pynput` injection
or normalized-coords math were wrong, the host cursor would either not move,
or land in the wrong quadrant. Two diagonal extremes catch sign/scaling bugs.

### T4 — Keyboard input from web client appears on host
**Steps**
1. On the host desktop, ensure a Konsole window is focused (visible inside
   the captured video).
2. From the web client, click on the video to focus the stage, then type
   `hello`.

**Pass criteria**
- The character sequence **`hello`** appears at the Konsole prompt
  (visible both in the host's real desktop and inside the recursive video
  feed).

**Why this distinguishes a broken implementation:** if the DataChannel
weren't wired up or `pynput.keyboard` injection broke, no characters would
appear. We assert the exact string, not just "some text".

## Out of scope (will be reported as untested)
- Real STUN / TURN over public NAT — needs a VPS.
- Windows MSI installer — needs a Windows runner; CI artifact build is
  proven via the green `build` job in CI.
- macOS notarised binary.
- Wayland input injection (known unsupported by `pynput`).
