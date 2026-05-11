"""Plan 026R §A.3 — runs.jsonl strict reader (closes ORPHAN-HIGH-061).

2 tests:

* read_runs_rows filters by tool_id AFTER strict parse; corrupt row
  still raises even if the filter would have excluded it.
* latest_run_for_tool returns last matching row or None on missing /
  empty file.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.runs_reader import latest_run_for_tool, read_runs_rows
from aria_kernel.tool_registry import GovernanceError


class RunsReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a3-runs-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_filter_applied_after_strict_parse_raises_on_corrupt(self) -> None:
        path = self.tmp / "runs.jsonl"
        # Three rows: matching tool, corrupt row (would NOT match filter
        # if it were JSON), matching tool. Strict mode must raise on the
        # corrupt row even though filter would drop it.
        path.write_text(
            json.dumps({"tool_id": "x", "run_id": "1"})
            + "\n"
            + "{not valid\n"
            + json.dumps({"tool_id": "x", "run_id": "2"})
            + "\n",
            encoding="utf-8",
        )
        it = read_runs_rows(path, tool_id="x")
        first = next(it)
        self.assertEqual(first["run_id"], "1")
        with self.assertRaises(GovernanceError):
            next(it)

    def test_latest_run_for_tool_returns_last_match_or_none(self) -> None:
        path = self.tmp / "runs.jsonl"
        path.write_text(
            json.dumps({"tool_id": "x", "run_id": "1"})
            + "\n"
            + json.dumps({"tool_id": "y", "run_id": "y1"})
            + "\n"
            + json.dumps({"tool_id": "x", "run_id": "2"})
            + "\n",
            encoding="utf-8",
        )
        latest_x = latest_run_for_tool(path, tool_id="x")
        self.assertIsNotNone(latest_x)
        self.assertEqual(latest_x["run_id"], "2")
        latest_z = latest_run_for_tool(path, tool_id="z")
        self.assertIsNone(latest_z)
        # Missing file → None
        self.assertIsNone(
            latest_run_for_tool(self.tmp / "nope.jsonl", tool_id="x")
        )


if __name__ == "__main__":
    unittest.main()
