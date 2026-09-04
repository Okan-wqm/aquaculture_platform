"""G-7 (new-aria CORE-DELTAS) — the watchdog sweep result is a JSON payload.

WHY: `cycle run` stores `run_watchdog_sweep(...)` under the cycle result's
``watchdog_sweep`` key and `cli.py` prints the whole result with `json.dumps`.
A `datetime` in ``latest_governance_ts`` made every full cycle exit non-zero
with ``TypeError: Object of type datetime is not JSON serializable`` after all
ledgers had already been written (measured 2026-09-03 in the new-aria container
probe). The daemon loop is the only consumer that needs a datetime; it parses
the string back. These tests pin both halves so the leak cannot return.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.aria_watchdog import _parse_iso, run_watchdog_sweep
from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir


class WatchdogSweepJsonSerializable(unittest.TestCase):
    def test_latest_governance_ts_is_iso_string_and_result_dumps(self) -> None:
        """SCENARIO: governance rows exist inside the sweep window.
        EXPECTS: latest_governance_ts is an ISO string, round-trips through
        _parse_iso, and json.dumps accepts the whole result without a default."""
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            append_tools_governance(root, "cycle_started", {"cycle_id": "c-1"})
            now = datetime.now(timezone.utc)
            result = run_watchdog_sweep(
                workspace_root=Path(tmp), tools_dir=root, now=now, since=now - timedelta(hours=1)
            )
        value = result["latest_governance_ts"]
        self.assertIsInstance(value, str, f"expected ISO string, got {type(value).__name__}")
        parsed = _parse_iso(value)
        self.assertIsNotNone(parsed)
        self.assertLessEqual(abs((parsed - now).total_seconds()), 3600)
        json.dumps(result)

    def test_empty_window_keeps_none_and_dumps(self) -> None:
        """SCENARIO: the sweep window starts after every governance row
        (bootstrap itself writes rows, so the window is what makes it empty).
        EXPECTS: latest_governance_ts is None and the result still dumps."""
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            now = datetime.now(timezone.utc)
            result = run_watchdog_sweep(
                workspace_root=Path(tmp), tools_dir=root, now=now, since=now + timedelta(hours=1)
            )
        self.assertIsNone(result["latest_governance_ts"])
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
