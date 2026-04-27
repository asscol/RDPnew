"""Persistent host identity round-trip."""

from __future__ import annotations

from pathlib import Path

import pytest

from remotedesk.identity import HostIdentity, load_identity, save_identity, reset_identity


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "host.json"
    save_identity(HostIdentity(id="123456789", secret="abc.def"), path=p)
    loaded = load_identity(p)
    assert loaded is not None
    assert loaded.id == "123456789"
    assert loaded.secret == "abc.def"


def test_load_returns_none_when_file_missing(tmp_path: Path) -> None:
    assert load_identity(tmp_path / "nope.json") is None


def test_load_returns_none_for_garbage(tmp_path: Path) -> None:
    p = tmp_path / "host.json"
    p.write_text("not json", encoding="utf-8")
    assert load_identity(p) is None


def test_load_returns_none_when_fields_missing(tmp_path: Path) -> None:
    p = tmp_path / "host.json"
    p.write_text('{"id": "", "secret": ""}', encoding="utf-8")
    assert load_identity(p) is None


def test_reset_identity_removes_file(tmp_path: Path) -> None:
    p = tmp_path / "host.json"
    save_identity(HostIdentity(id="111111111", secret="t"), path=p)
    assert p.exists()
    assert reset_identity(p) is True
    assert not p.exists()
    assert reset_identity(p) is False
