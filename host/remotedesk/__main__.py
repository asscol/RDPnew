"""Entry point: ``python -m remotedesk`` and ``remotedesk-host`` console-script."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import secrets
import sys

from .agent import run_agent


def _default_pin() -> str:
    # 6-digit numeric PIN.
    return f"{secrets.randbelow(1_000_000):06d}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="remotedesk-host", description="RemoteDesk host agent")
    parser.add_argument(
        "--server",
        default=os.environ.get("REMOTEDESK_SERVER", "ws://localhost:8080/ws"),
        help="Signaling WebSocket URL (default: %(default)s)",
    )
    parser.add_argument(
        "--pin",
        default=os.environ.get("REMOTEDESK_PIN") or _default_pin(),
        help="One-time PIN required from clients (default: random 6 digits)",
    )
    parser.add_argument(
        "--monitor",
        type=int,
        default=int(os.environ.get("REMOTEDESK_MONITOR", "1")),
        help="mss monitor index (1 = primary). 0 = entire desktop. (default: %(default)s)",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=int(os.environ.get("REMOTEDESK_FPS", "20")),
        help="Target capture frame rate (default: %(default)s)",
    )
    parser.add_argument(
        "--max-width",
        type=int,
        default=int(os.environ.get("REMOTEDESK_MAX_WIDTH", "1920")),
        help="Downscale frames wider than this many pixels (default: %(default)s)",
    )
    parser.add_argument(
        "--no-input",
        action="store_true",
        help="Stream the screen but ignore remote keyboard/mouse events",
    )
    parser.add_argument(
        "--ice-server",
        action="append",
        default=None,
        help="Override ICE servers (e.g. stun:stun.l.google.com:19302). Can repeat. "
        "By default the host fetches the list from the signaling server.",
    )
    parser.add_argument("-v", "--verbose", action="count", default=0)

    args = parser.parse_args(argv)

    level = logging.WARNING
    if args.verbose == 1:
        level = logging.INFO
    elif args.verbose >= 2:
        level = logging.DEBUG
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    try:
        return asyncio.run(run_agent(args))
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
