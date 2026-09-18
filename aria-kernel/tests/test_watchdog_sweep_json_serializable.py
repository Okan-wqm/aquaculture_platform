"""E24-b — the watchdog sweep's report must survive json.dumps.

`run_watchdog_sweep` returned `latest_governance_ts` as a raw ``datetime``.
Every consumer of that dict either serialises it (``cli.py`` prints the cycle
result with ``json.dumps``) or parses it back, and the kernel's own fixtures
already spell the value as an ISO string — so the raw datetime was wrong for
every reader. The failure mode was the expensive kind: the sweep emitted its
findings and appended its ledger rows, and only THEN did the process die with
``TypeError: Object of type datetime is not JSON serializable``, so the work
landed and the report did not.
"""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel.aria_watchdog import run_watchdog_sweep  # noqa: E402


class WatchdogSweepJsonSerializable(unittest.TestCase):
    def _sweep(self, governance_lines: str) -> dict:
        tmp = Path(tempfile.mkdtemp())
        tools = tmp / "aria-tools"
        tools.mkdir()
        (tools / "governance.jsonl").write_text(governance_lines, encoding="utf-8")
        (tools / "autonomy_state.jsonl").write_text("", encoding="utf-8")
        # `since` is pinned: the sweep's default window is the last 24 hours,
        # so a fixture timestamp would otherwise age out of the test.
        return run_watchdog_sweep(
            workspace_root=str(tmp),
            tools_dir=str(tools),
            now=datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc),
            since=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
            suppress_emission=True,
        )

    def test_latest_governance_ts_is_an_iso_string(self) -> None:
        result = self._sweep('{"ts":"2026-08-17T00:00:00+00:00","event":"x"}\n')
        self.assertIsInstance(result["latest_governance_ts"], str)
        self.assertEqual(result["latest_governance_ts"], "2026-08-17T00:00:00+00:00")

    def test_the_whole_report_is_json_serialisable(self) -> None:
        result = self._sweep('{"ts":"2026-08-17T00:00:00+00:00","event":"x"}\n')
        # The assertion IS json.dumps: this is the call that used to raise.
        json.dumps(result, indent=2, sort_keys=True)

    def test_an_empty_governance_log_reports_none_and_still_serialises(self) -> None:
        result = self._sweep("")
        self.assertIsNone(result["latest_governance_ts"])
        json.dumps(result, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
