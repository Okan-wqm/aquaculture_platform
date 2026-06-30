"""Live cycle-progress emitter tests (ORPHAN-MEDIUM-256).

A cycle is otherwise a black box — nothing is observable until it finishes. The
emitter streams per-phase JSON lines to stderr when ARIA_CYCLE_PROGRESS is set,
default off (zero behaviour change), and NEVER raises.
"""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel import cycle_progress as cp  # noqa: E402


class CycleProgressTests(unittest.TestCase):
    def test_disabled_by_default_emits_nothing(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(cp.PROGRESS_ENV_VAR, None)
            self.assertFalse(cp.progress_enabled())
            buf = io.StringIO()
            with redirect_stderr(buf):
                cp.emit_progress("memory", cycle_id="c1")
            self.assertEqual(buf.getvalue(), "")

    def test_enabled_emits_one_structured_json_line(self) -> None:
        with patch.dict(os.environ, {cp.PROGRESS_ENV_VAR: "1"}, clear=False):
            self.assertTrue(cp.progress_enabled())
            buf = io.StringIO()
            with redirect_stderr(buf):
                cp.emit_progress("discovery_scan", cycle_id="c1", scanned=2000, total=9553)
            lines = [l for l in buf.getvalue().splitlines() if l.strip()]
            self.assertEqual(len(lines), 1)
            row = json.loads(lines[0])
            self.assertEqual(row["aria_progress"], "discovery_scan")
            self.assertEqual(row["cycle_id"], "c1")
            self.assertEqual(row["scanned"], 2000)
            self.assertEqual(row["total"], 9553)
            self.assertIn("at", row)

    def test_truthy_parsing(self) -> None:
        for val, expected in (("1", True), ("true", True), ("on", True),
                              ("0", False), ("", False), ("no", False)):
            with patch.dict(os.environ, {cp.PROGRESS_ENV_VAR: val}, clear=False):
                self.assertEqual(cp.progress_enabled(), expected, f"{val!r}")

    def test_never_raises_even_on_unserializable_fields(self) -> None:
        with patch.dict(os.environ, {cp.PROGRESS_ENV_VAR: "1"}, clear=False):
            buf = io.StringIO()
            with redirect_stderr(buf):
                # An unserializable value must NOT propagate — progress is
                # observability, never a failure surface.
                cp.emit_progress("phase", payload=object())
            # no exception == pass; output may be empty (swallowed)


if __name__ == "__main__":
    unittest.main()
