"""Remote-input dispatcher.

Translates JSON messages received on the WebRTC ``input`` DataChannel into
real OS-level mouse and keyboard events using ``pynput``.

Message shapes (all ``kind`` values):

  * ``mouse-move``  ``{x, y}`` (normalized 0..1)
  * ``mouse-down`` / ``mouse-up``  ``{x, y, button}`` (button: 0=left,1=middle,2=right)
  * ``wheel``      ``{dx, dy}``  (pixels; positive dy = scroll up in our convention)
  * ``key-down`` / ``key-up``  ``{key, code}``  (DOM ``KeyboardEvent`` fields)

NOTE: ``pynput`` opens an X11 connection at import time on Linux and crashes
in headless environments (CI without Xvfb, sandboxed test runners, etc).
We therefore import it *lazily* — only when the dispatcher is actually
constructed in enabled mode. This keeps ``import remotedesk.input`` safe
everywhere, including the unit-test environment.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - hints only
    from pynput.keyboard import Key, KeyCode

logger = logging.getLogger(__name__)


# DOM-key name -> attribute name on `pynput.keyboard.Key`. Resolved lazily
# inside `_to_pynput_key` so importing this module never touches pynput.
_DOM_KEY_NAMES: dict[str, str] = {
    "Enter": "enter",
    "Escape": "esc",
    "Backspace": "backspace",
    "Tab": "tab",
    " ": "space",
    "Shift": "shift",
    "Control": "ctrl",
    "Alt": "alt",
    "Meta": "cmd",
    "OS": "cmd",
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Home": "home",
    "End": "end",
    "PageUp": "page_up",
    "PageDown": "page_down",
    "Insert": "insert",
    "Delete": "delete",
    "CapsLock": "caps_lock",
    "PrintScreen": "print_screen",
    "Pause": "pause",
    "ContextMenu": "menu",
}
for _i in range(1, 25):
    _DOM_KEY_NAMES[f"F{_i}"] = f"f{_i}"


def _button_map() -> dict[int, Any]:
    from pynput.mouse import Button

    return {0: Button.left, 1: Button.middle, 2: Button.right}


def _to_pynput_key(key: str, code: str) -> Key | KeyCode | str | None:
    if not key:
        return None
    name = _DOM_KEY_NAMES.get(key)
    if name is not None:
        from pynput.keyboard import Key

        return getattr(Key, name, None)
    if len(key) == 1:
        return key
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
        self._mouse: Any = None
        self._keyboard: Any = None
        self._buttons: dict[int, Any] = {}
        if enabled:
            try:
                from pynput.keyboard import Controller as KeyboardController
                from pynput.mouse import Controller as MouseController

                self._mouse = MouseController()
                self._keyboard = KeyboardController()
                self._buttons = _button_map()
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
        btn = self._buttons.get(int(msg.get("button", 0))) or self._buttons[0]
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
