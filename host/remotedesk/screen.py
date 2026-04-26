"""Screen-capture VideoStreamTrack for aiortc, backed by `mss`.

Runs the synchronous mss capture in a thread executor so the asyncio event
loop is never blocked while sending frames to the WebRTC encoder.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time

import av
import mss
import numpy as np
from aiortc import VideoStreamTrack
from PIL import Image

logger = logging.getLogger(__name__)


class ScreenTrack(VideoStreamTrack):
    """Captures the desktop and yields ``av.VideoFrame``s at a target fps."""

    kind = "video"

    def __init__(self, monitor: int = 1, fps: int = 20, max_width: int = 1920) -> None:
        super().__init__()
        self._monitor_index = monitor
        self._fps = max(1, fps)
        self._max_width = max(320, max_width)
        self._frame_interval = 1.0 / self._fps
        self._next_frame_at = 0.0
        self._loop = asyncio.get_event_loop()
        # `mss` instances aren't thread-safe. Create one per worker thread.
        self._tls: dict[int, mss.base.MSSBase] = {}

    def _get_sct(self) -> mss.base.MSSBase:
        import threading

        tid = threading.get_ident()
        sct = self._tls.get(tid)
        if sct is None:
            sct = mss.mss()
            self._tls[tid] = sct
        return sct

    def _capture(self) -> np.ndarray:
        sct = self._get_sct()
        monitors = sct.monitors
        idx = self._monitor_index
        if idx < 0 or idx >= len(monitors):
            idx = 1 if len(monitors) > 1 else 0
        bbox = monitors[idx]
        raw = sct.grab(bbox)
        # mss returns BGRA. Convert to a contiguous RGB array.
        img = np.frombuffer(raw.bgra, dtype=np.uint8).reshape(raw.height, raw.width, 4)
        rgb = img[:, :, :3][:, :, ::-1]  # BGRA -> RGB
        rgb = np.ascontiguousarray(rgb)
        if rgb.shape[1] > self._max_width:
            scale = self._max_width / rgb.shape[1]
            new_h = max(2, int(rgb.shape[0] * scale)) & ~1  # even for yuv420
            new_w = self._max_width & ~1
            pil = Image.fromarray(rgb).resize((new_w, new_h), Image.BILINEAR)
            rgb = np.asarray(pil)
        else:
            # Force even dimensions (yuv420p requirement).
            h, w, _ = rgb.shape
            if h & 1 or w & 1:
                rgb = rgb[: h & ~1, : w & ~1]
        return rgb

    async def recv(self) -> av.VideoFrame:
        now = time.monotonic()
        if self._next_frame_at == 0.0:
            self._next_frame_at = now
        else:
            delay = self._next_frame_at - now
            if delay > 0:
                await asyncio.sleep(delay)
        self._next_frame_at += self._frame_interval

        rgb = await self._loop.run_in_executor(None, self._capture)
        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
        pts, time_base = await self.next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        return frame

    @property
    def frame_size(self) -> tuple[int, int] | None:
        # Probe once so the input handler can convert normalized coords to pixels.
        try:
            arr = self._capture()
            return arr.shape[1], arr.shape[0]
        except Exception:
            logger.exception("failed to probe screen size")
            return None

    def stop_capture(self) -> None:
        for sct in self._tls.values():
            try:
                sct.close()
            except Exception:
                pass
        self._tls.clear()

    # The base class's stop() is the public API used by aiortc.
    def stop(self) -> None:  # type: ignore[override]
        super().stop()
        self.stop_capture()


# Time fractions used by aiortc; expose for tests.
TIME_BASE = fractions.Fraction(1, 90000)
