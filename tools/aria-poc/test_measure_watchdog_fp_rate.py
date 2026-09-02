#!/usr/bin/env python3
"""Fail-closed FP measurement — absence of evidence is not a zero rate.

The 2026-09-01 audit reproduced all four fail-open shapes in the Gate-B
harness: an absent aria-findings/ tree, an empty window, an unreadable
finding file, and a finding without a placeable timestamp each produced
either a pristine 0.0 or a silently diluted denominator — and the gate
passed. Every one of them must now exit 1 with an explicit reason.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_watchdog_fp_rate import main, measure_fp_rate  # noqa: E402


def _write_finding(root: Path, fid: str, *, raised_at: str | None, status: str = "OPEN", raw: str | None = None) -> None:
    d = root / "aria-findings"
    d.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        (d / f"{fid}.json").write_text(raw, encoding="utf-8")
        return
    doc = {
        "id": fid,
        "originating_skill": "aria-watchdog:probe",
        "status": status,
    }
    if raised_at is not None:
        doc["raised_at"] = raised_at
    (d / f"{fid}.json").write_text(json.dumps(doc), encoding="utf-8")


class FailClosedFpGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-fp-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.now = datetime.now(timezone.utc)

    def _iso(self, dt: datetime) -> str:
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_absent_findings_tree_fails_the_gate(self) -> None:
        result = measure_fp_rate(workspace_root=self.root, until=self.now)
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["status"], "unmeasured")

    def test_empty_window_fails_the_gate(self) -> None:
        # Raised 30 minutes ago; the window ends an hour ago, so the
        # finding is outside it and the window itself holds no evidence.
        _write_finding(self.root, "F-001", raised_at=self._iso(self.now - timedelta(minutes=30)))
        result = measure_fp_rate(
            workspace_root=self.root,
            since=self.now - timedelta(hours=2),
            until=self.now - timedelta(hours=1),
        )
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["total"], 0)

    def test_unreadable_finding_fails_the_gate(self) -> None:
        _write_finding(self.root, "F-001", raised_at=self._iso(self.now))
        _write_finding(self.root, "F-002", raised_at=None, raw="{not json")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["unreadable"], 1)

    def test_timestamp_less_finding_fails_the_gate(self) -> None:
        _write_finding(self.root, "F-001", raised_at=None)
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["unknown_timestamp"], 1)

    def test_measured_low_rate_passes_and_high_rate_fails(self) -> None:
        for i in range(4):
            _write_finding(self.root, f"F-{i:03d}", raised_at=self._iso(self.now), status="RESOLVED")
        _write_finding(self.root, "F-004", raised_at=self._iso(self.now), status="WITHDRAWN")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertEqual(result["status"], "measured")
        self.assertTrue(result["gate_passes"])  # 1/5 = 0.2 <= 0.33

        for i in range(5, 7):
            _write_finding(self.root, f"F-{i:03d}", raised_at=self._iso(self.now), status="WITHDRAWN")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertFalse(result["gate_passes"])  # 3/7 > 0.33

    def test_cli_exit_code_is_fail_closed(self) -> None:
        rc = main(["--workspace-root", str(self.root)])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
