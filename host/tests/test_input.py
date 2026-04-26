"""Smoke-tests for InputDispatcher that don't require a real display."""

from __future__ import annotations

import json

from remotedesk.input import InputDispatcher


def test_disabled_dispatcher_drops_all_events() -> None:
    d = InputDispatcher(frame_size=(1920, 1080), enabled=False)
    # Should not raise even though no controllers are initialized.
    d.handle_raw(json.dumps({"kind": "mouse-move", "x": 0.5, "y": 0.5}))
    d.handle_raw(json.dumps({"kind": "key-down", "key": "a", "code": "KeyA"}))


def test_malformed_payload_is_ignored() -> None:
    d = InputDispatcher(frame_size=(1920, 1080), enabled=False)
    d.handle_raw("not-json")
    d.handle_raw(b"\xff\xfe")


def test_abs_xy_is_clamped() -> None:
    d = InputDispatcher(frame_size=(800, 600), enabled=False)
    assert d._abs_xy(0.0, 0.0) == (0, 0)
    assert d._abs_xy(1.0, 1.0) == (799, 599)
    assert d._abs_xy(-1.0, 2.0) == (0, 599)
