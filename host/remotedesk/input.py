"""Remote-input dispatcher.

Translates JSON messages received on the WebRTC ``input`` DataChannel into
real OS-level mouse and keyboard events using ``pynput``.

Message shapes (all ``kind`` values):

  * ``mouse-move``  ``{x, y}`` (normalized 0..1)
  * ``mouse-down`` / ``mouse-up``  ``{x, y, button}`` (button: 0=left,1=middle,2=right)
  * ``wheel``      ``{dx, dy}``  (pixels; positive dy = scroll up in our convention)
  * ``key-down`` / ``key-up``  ``{key, code}``  (DOM ``KeyboardEvent`` fields)
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pynput.keyboard import Controller as KeyboardController
from pynput.keyboard import Key, KeyCode
from pynput.mouse import Button
from pynput.mouse import Controller as MouseController

logger = logging.getLogger(__name__)


# Mapping for non-printable DOM `key` values to pynput `Key` members.
_DOM_KEY_MAP: dict[str, Key] = {
    "Enter": Key.enter,
    "Escape": Key.esc,
    "Backspace": Key.backspace,
    "Tab": Key.tab,
    " ": Key.space,
    "Shift": Key.shift,
    "Control": Key.ctrl,
    "Alt": Key.alt,
    "Meta": Key.cmd,
    "OS": Key.cmd,
    "ArrowUp": Key.up,
    "ArrowDown": Key.down,
    "ArrowLeft": Key.left,
    "ArrowRight": Key.right,
    "Home": Key.home,
    "End": Key.end,
    "PageUp": Key.page_up,
    "PageDown": Key.page_down,
    "Insert": Key.insert,
    "Delete": Key.delete,
    "CapsLock": Key.caps_lock,
    "PrintScreen": Key.print_screen,
    "Pause": Key.pause,
    "ContextMenu": Key.menu,
}
for i in range(1, 25):
    fkey = getattr(Key, f"f{i}", None)
    if fkey is not None:
        _DOM_KEY_MAP[f"F{i}"] = fkey

_BUTTON_MAP = {0: Button.left, 1: Button.middle, 2: Button.right}


def _to_pynput_key(key: str, code: str) -> Key | KeyCode | str | None:
    if not key:
        return None
    if key in _DOM_KEY_MAP:
        return _DOM_KEY_MAP[key]
    if len(key) == 1:
        return key
    # Unknown special key.
    logger.debug("unknown key: %r (code=%r)", key, code)
    return None


class InputDispatcher:
    """Apply remote input events using pynput.

    Parameters
    ----------
    frame_size : tuple[int, int] | None
        ``(width, height)`` of the captured screen. Used to convert normalized
        mouse coordinates into absolute pixel positions on the host.
    enabled : bool
        If False, all events are silently dropped (``--no-input`` mode).
    """

    def __init__(self, frame_size: tuple[int, int] | None, enabled: bool = True) -> None:
        self._frame_size = frame_size
        self._enabled = enabled
        self._mouse: MouseController | None = None
        self._keyboard: KeyboardController | None = None
        if enabled:
            try:
                self._mouse = MouseController()
                self._keyboard = KeyboardController()
            except Exception:
                logger.exception("failed to init pynput controllers; input disabled")
                self._enabled = False

    def _abs_xy(self, nx: float, ny: float) -> tuple[int, int] | None:
        if not self._frame_size:
            return None
        w, h = self._frame_size
        x = max(0, min(w - 1, int(nx * w)))
        y = max(0, min(h - 1, int(ny * h)))
        return x, y

    def handle_raw(self, data: str | bytes) -> None:
        if not self._enabled:
            return
        try:
            if isinstance(data, bytes):
                data = data.decode("utf-8")
            msg: dict[str, Any] = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            logger.warning("ignoring malformed input message")
            return
        kind = msg.get("kind")
        try:
            if kind == "mouse-move":
                self._move(msg)
            elif kind == "mouse-down":
                self._button(msg, press=True)
            elif kind == "mouse-up":
                self._button(msg, press=False)
            elif kind == "wheel":
                self._wheel(msg)
            elif kind == "key-down":
                self._key(msg, press=True)
            elif kind == "key-up":
                self._key(msg, press=False)
            else:
                logger.debug("unknown input kind: %r", kind)
        except Exception:
            logger.exception("input handler error for %r", kind)

    def _move(self, msg: dict[str, Any]) -> None:
        if not self._mouse:
            return
        pos = self._abs_xy(float(msg.get("x", 0)), float(msg.get("y", 0)))
        if pos:
            self._mouse.position = pos

    def _button(self, msg: dict[str, Any], press: bool) -> None:
        if not self._mouse:
            return
        pos = self._abs_xy(float(msg.get("x", 0)), float(msg.get("y", 0)))
        if pos:
            self._mouse.position = pos
        btn = _BUTTON_MAP.get(int(msg.get("button", 0)), Button.left)
        if press:
            self._mouse.press(btn)
        else:
            self._mouse.release(btn)

    def _wheel(self, msg: dict[str, Any]) -> None:
        if not self._mouse:
            return
        # DOM deltaY > 0 means scrolling down; pynput dy > 0 means scrolling up.
        dy = float(msg.get("dy", 0)) / 100.0
        dx = float(msg.get("dx", 0)) / 100.0
        self._mouse.scroll(dx, -dy)

    def _key(self, msg: dict[str, Any], press: bool) -> None:
        if not self._keyboard:
            return
        key = _to_pynput_key(str(msg.get("key", "")), str(msg.get("code", "")))
        if key is None:
            return
        if press:
            self._keyboard.press(key)
        else:
            self._keyboard.release(key)
