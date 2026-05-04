"""Persistent host identity: stable 9-digit ID + secret_token.

The agent stores its ID and secret in ``~/.remotedesk/host.json`` (override with
``REMOTEDESK_IDENTITY_FILE``). On first run the file does not exist; the
signaling server allocates a fresh ID and returns the secret, which we save.
On subsequent runs we present the saved credentials and get the same ID back.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


def default_identity_path() -> Path:
    override = os.environ.get("REMOTEDESK_IDENTITY_FILE")
    if override:
        return Path(override)
    return Path.home() / ".remotedesk" / "host.json"


@dataclass
class HostIdentity:
    id: str
    secret: str

    def to_json(self) -> str:
        return json.dumps({"id": self.id, "secret": self.secret}, indent=2)


def load_identity(path: Path | None = None) -> HostIdentity | None:
    p = path or default_identity_path()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("identity file %s unreadable: %s", p, exc)
        return None
    host_id = str(data.get("id", "")).strip()
    secret = str(data.get("secret", "")).strip()
    if not host_id or not secret:
        return None
    return HostIdentity(id=host_id, secret=secret)


def save_identity(identity: HostIdentity, path: Path | None = None) -> None:
    p = path or default_identity_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(identity.to_json(), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def reset_identity(path: Path | None = None) -> bool:
    p = path or default_identity_path()
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return False
