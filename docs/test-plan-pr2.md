# Test plan — RemoteDesk PR #2

## What changed (user-visible)

1. **Sign-up / sign-in** in the web client. Anyone visiting `/signup` can create
   an account; `/login` issues a session cookie.
2. **Admin panel** at `/admin` (only visible to users with `is_admin=1`). Admins
   can ban / unban / delete other users. Bootstrap admin via `ADMIN_EMAIL` +
   `ADMIN_PASSWORD` env on first server start.
3. **Persistent host Connection ID.** Host agent now stores
   `~/.remotedesk/host.json`; on restart it presents the saved id+secret and
   the server returns the same 9-digit ID.
4. **Backward compat:** anonymous ID+PIN pairing still works (regression).

## Environment under test

Local: signaling server on `localhost:8090` with bootstrap admin
`admin@local / adminpass1`, host agent on the same VM (DISPLAY=:0), Chrome on
the same VM hitting `http://localhost:8090/`.

TURN/relay through real NAT remains out of scope (VPS-only test).

## Tests

### T1 — Sign-up creates a user; duplicate is rejected with the exact reason
**Steps**
1. Open `http://localhost:8090/#/signup`.
2. Submit `{email: "alice@local", password: "alicepass1"}`.
3. Verify navigation to `#/hosts` and the header shows the *Sign out* link.
4. Sign out, reopen `/#/signup`, submit the **same email** again.

**Pass criteria**
- After step 2, the URL hash becomes `#/hosts` and the **My hosts** page is
  visible (the toolbar item *My hosts* must be visible in the nav, the
  *Sign in / Sign up* links must be hidden).
- After step 4, the form's error line under the password field reads exactly
  **`Sign-up failed: email-taken`** (the literal string from
  `client/public/app.js:131-134` × `server/src/auth.js:registerUser`).

**Why this distinguishes a broken implementation:** if the email-uniqueness
constraint were missing, step 4 would silently succeed and route to `/hosts`.
If the error mapping were wrong, step 4 would show `bad-request` or no error.

### T2 — Login: wrong password rejected; correct password lands on /hosts
**Steps**
1. Visit `/#/login`.
2. Enter `alice@local` + a wrong password. Submit.
3. Without reloading, change the password to the correct one and submit.

**Pass criteria**
- After step 2, the error line reads exactly
  **`Sign-in failed: bad-credentials`** and the URL hash stays `#/login`.
- After step 3, URL hash becomes `#/hosts` and `GET /api/auth/me` (visible in
  the Network tab) returns `{"user":{...,"is_admin":false}}` with a
  `Set-Cookie: rd_session=...` set on the prior login response.

**Why this distinguishes a broken implementation:** any of (cookie not
issued / login route returning 200 on bad creds / bcrypt comparison broken)
would produce a different observable outcome here.

### T3 — Admin panel is gated; bootstrap admin can ban a user
**Steps**
1. Sign in as `alice@local` (non-admin). Manually visit `/#/admin`.
2. Sign out. Sign in as `admin@local / adminpass1` (the bootstrap admin).
3. Navigate to `/#/admin`. Find the row for `alice@local`. Click **Ban**.
4. Sign out. Open `/#/login` and try to sign in as `alice@local` with the
   correct password.

**Pass criteria**
- Step 1: the URL hash is forced back to `#/login` (alice is not admin) — the
  *Admin* link must be hidden in the nav (per `app.js:78-80`).
- Step 2: after sign-in, the *Admin* link **is** visible.
- Step 3: the table renders alice's row; her status pill changes from *active*
  to **`banned`** and `GET /api/admin/users` returns
  `{...,"email":"alice@local","is_banned":1,...}`.
- Step 4: the form error reads exactly **`Sign-in failed: banned`** and login
  fails. URL stays at `#/login`.

**Why this distinguishes a broken implementation:** if `setUserBanned` weren't
honoured by `authenticateUser`, alice would still be able to log in. If
`/admin` lacked the `requireAdmin()` middleware, alice would see the user
list directly. If the route guard in `app.js:navigate()` were absent, she'd
see the admin page even if the API rejected her requests.

### T4 — Host Connection ID survives an agent restart
**Steps**
1. Run the host agent. Note the 9-digit `Connection ID` printed at startup.
2. Inspect `~/.remotedesk/host.json`. Confirm it contains keys `id` and
   `secret` and that `id` matches step 1.
3. Kill the agent. Restart it with the same arguments.
4. Read the second printed `Connection ID`.

**Pass criteria**
- Steps 1 and 4 print **the same** 9-digit number.
- Server log line `secret_token verified` (or, equivalently, no
  `bad-token` rejection in stderr) for the second connection.
- File mode of `~/.remotedesk/host.json` is `0600`.

**Why this distinguishes a broken implementation:** if persistence were
broken, the host would get a fresh random ID on each restart (the symptom
of the v0.1.0 behaviour we're explicitly replacing).

### T5 — Regression: anonymous ID+PIN still streams the host's screen
**Steps**
1. Take the ID printed by the host in T4 and the printed PIN.
2. Open the web client at `/` (no login). Type the ID + PIN. Click *Connect*.

**Pass criteria**
- Status pill becomes exactly **`connected`** (green) within 10 s.
- The `<video>` shows non-black content; specifically a recursive
  picture-in-picture of itself (the host is capturing the same desktop the
  browser is rendering).
- WebSocket `/ws` exchange in DevTools Network tab includes `joined`,
  `offer`, `answer`, `candidate`.

**Why this distinguishes a broken implementation:** if the WebRTC plumbing
were broken by the routing/auth refactor, the video would stay black or the
status would stick on `paired, waiting for stream…`.

## Out of scope (will be reported as `untested`)

- Real STUN/TURN over public NAT — needs a VPS, covered by the deploy guide
  in `docs/deploy-vps.md`. The `?relay=1` URL flag is wired but cannot be
  exercised here.
- Windows desktop client (`RemoteDeskClient-Setup-0.2.0.exe`) — produced by
  CI workflow `build-client-windows.yml`. Local Linux build of the same
  Electron app was verified during development (AppImage built cleanly).
