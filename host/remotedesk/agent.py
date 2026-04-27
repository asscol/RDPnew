"""Top-level agent: connects to signaling, negotiates WebRTC, streams screen."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from contextlib import suppress
from urllib.parse import urlparse, urlunparse

import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription

from .identity import HostIdentity, load_identity, save_identity
from .input import InputDispatcher
from .screen import ScreenTrack

logger = logging.getLogger(__name__)


def _ice_servers_from_args_or_default(
    overrides: list[str] | None,
) -> list[RTCIceServer]:
    if overrides:
        return [RTCIceServer(urls=u) for u in overrides]
    return [RTCIceServer(urls="stun:stun.l.google.com:19302")]


async def _fetch_ice_from_server(ws_url: str) -> list[RTCIceServer] | None:
    """Convert ws[s]:// signaling URL into http[s]:///api/ice-servers and fetch."""
    parsed = urlparse(ws_url)
    if parsed.scheme not in {"ws", "wss"}:
        return None
    http_scheme = "https" if parsed.scheme == "wss" else "http"
    api = urlunparse((http_scheme, parsed.netloc, "/api/ice-servers", "", "", ""))
    try:
        # Lazy import so tests don't pull aiohttp.
        import aiohttp  # noqa: WPS433
    except ImportError:
        return None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(api, timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status != 200:
                    return None
                payload = await r.json()
        servers = []
        for entry in payload.get("iceServers", []):
            urls = entry.get("urls")
            if not urls:
                continue
            servers.append(
                RTCIceServer(
                    urls=urls,
                    username=entry.get("username"),
                    credential=entry.get("credential"),
                )
            )
        return servers or None
    except Exception:
        logger.warning("could not fetch ICE servers from %s", api, exc_info=True)
        return None


async def _ws_send(ws: websockets.WebSocketClientProtocol, obj: dict) -> None:
    await ws.send(json.dumps(obj))


async def _serve_one_client(
    ws: websockets.WebSocketClientProtocol,
    ice_servers: list[RTCIceServer],
    args: argparse.Namespace,
) -> None:
    """Handle a single paired client session until disconnect."""
    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))

    track = ScreenTrack(monitor=args.monitor, fps=args.fps, max_width=args.max_width)
    pc.addTrack(track)
    frame_size = track.frame_size
    logger.info("capture frame size: %s", frame_size)

    dispatcher = InputDispatcher(frame_size=frame_size, enabled=not args.no_input)
    input_chan = pc.createDataChannel("input", ordered=True)

    @input_chan.on("message")
    def _on_input(message: str | bytes) -> None:
        dispatcher.handle_raw(message)

    @pc.on("icecandidate")
    async def _on_ice(candidate) -> None:
        if candidate is None:
            return
        await _ws_send(ws, {
            "type": "candidate",
            "candidate": {
                "candidate": candidate.candidate,
                "sdpMid": candidate.sdpMid,
                "sdpMLineIndex": candidate.sdpMLineIndex,
            },
        })

    @pc.on("connectionstatechange")
    def _on_state() -> None:
        logger.info("rtc connection state: %s", pc.connectionState)

    # We are the offerer.
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await _ws_send(ws, {"type": "offer", "sdp": pc.localDescription.sdp})

    session_done = asyncio.Event()

    async def _drain() -> None:
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = msg.get("type")
                if t == "answer":
                    await pc.setRemoteDescription(
                        RTCSessionDescription(sdp=msg["sdp"], type="answer")
                    )
                elif t == "candidate":
                    cand = msg.get("candidate") or {}
                    sdp = cand.get("candidate")
                    if not sdp:
                        continue
                    from aiortc.sdp import candidate_from_sdp

                    try:
                        ice = candidate_from_sdp(sdp.split(":", 1)[1] if sdp.startswith("candidate:") else sdp)
                        ice.sdpMid = cand.get("sdpMid")
                        ice.sdpMLineIndex = cand.get("sdpMLineIndex")
                        await pc.addIceCandidate(ice)
                    except Exception:
                        logger.exception("failed to add remote ICE candidate")
                elif t == "peer-left":
                    logger.info("client disconnected")
                    session_done.set()
                    return
                elif t == "error":
                    logger.warning("signaling error: %s", msg.get("reason"))
                    session_done.set()
                    return
        except websockets.ConnectionClosed:
            session_done.set()

    drain_task = asyncio.create_task(_drain())
    try:
        await session_done.wait()
    finally:
        drain_task.cancel()
        with suppress(BaseException):
            await drain_task
        track.stop()
        await pc.close()


async def run_agent(args: argparse.Namespace) -> int:
    ice_servers = _ice_servers_from_args_or_default(args.ice_server)
    fetched = await _fetch_ice_from_server(args.server)
    if fetched and not args.ice_server:
        ice_servers = fetched

    identity = load_identity()
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(args.server, max_size=4 * 1024 * 1024) as ws:
                backoff = 1.0
                register_msg: dict = {
                    "type": "register",
                    "role": "host",
                    "pin": args.pin,
                }
                if identity is not None:
                    register_msg["id"] = identity.id
                    register_msg["secret"] = identity.secret
                await _ws_send(ws, register_msg)
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get("type") != "registered":
                    reason = msg.get("reason")
                    if reason in {"not-found", "bad-token"} and identity is not None:
                        logger.warning(
                            "saved identity rejected (%s); requesting a new one",
                            reason,
                        )
                        identity = None
                        continue
                    logger.error("registration failed: %r", msg)
                    return 1

                conn_id = msg.get("id", "?")
                if identity is None:
                    secret = msg.get("secret")
                    if secret:
                        identity = HostIdentity(id=conn_id, secret=secret)
                        save_identity(identity)
                        logger.info("saved persistent host identity")
                _print_banner(conn_id, args.pin)

                # Wait for clients in a loop. After each client leaves, we
                # accept the next one with the same ID/PIN.
                while True:
                    raw = await ws.recv()
                    msg = json.loads(raw)
                    t = msg.get("type")
                    if t == "peer-joined":
                        logger.info("client paired, starting WebRTC")
                        await _serve_one_client(ws, ice_servers, args)
                        # After the session ends, loop and wait for next peer.
                    elif t == "error":
                        logger.error("server error: %s", msg.get("reason"))
                        return 1
                    else:
                        logger.debug("unexpected message: %r", msg)
        except (websockets.ConnectionClosed, OSError) as e:
            logger.warning("connection lost (%s); retrying in %.1fs", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def _print_banner(conn_id: str, pin: str) -> None:
    bar = "=" * 48
    print()
    print(bar)
    print("  RemoteDesk host is ready")
    print(f"  Connection ID : {conn_id}")
    print(f"  PIN           : {pin}")
    print("  Share these with the person who will connect.")
    print(bar)
    print(flush=True)
