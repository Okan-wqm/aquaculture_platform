#!/usr/bin/env python3
"""Fail-closed FP measurement — absence of evidence is not a zero rate.

The 2026-09-01 audit reproduced the fail-open shapes in the Gate-B
harness: an absent finding store, an empty window, and a finding without
a placeable timestamp each produced either a pristine 0.0 or a silently
diluted denominator — and the gate passed. Every one of them must exit 1
with an explicit reason.

ARIA-MEDIUM-330 — the harness reads the finding-event fold, so a status
change reaches the rate and a file no event emitted is not a finding.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Lives under invariants/ so the aria-kernel workflow's
# `unittest discover tools/aria-poc/invariants` step runs it: beside the
# harness it was a test nothing invoked (ARIA-MEDIUM-330).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from measure_watchdog_fp_rate import main, measure_fp_rate  # noqa: E402

from aria_kernel.ledger import append_declared_jsonl  # noqa: E402


def _events(root: Path) -> Path:
    d = root / "aria-findings"
    d.mkdir(parents=True, exist_ok=True)
    return d / "finding-events.jsonl"


def _emit(root: Path, fid: str, *, created_at: str | None) -> None:
    record: dict[str, object] = {
        "finding_id": fid,
        "originating_skill": "aria-watchdog:probe",
        "status": "OPEN",
    }
    if created_at is not None:
        record["created_at"] = created_at
    append_declared_jsonl(_events(root), {
        "schema_version": 1, "event": "finding_emitted",
        "event_id": f"finding:{fid}:emitted", "finding_id": fid, "record": record,
    }, expected_surface="repo_finding_events", bypass_profile_gate=True)


def _change_status(root: Path, fid: str, to_status: str) -> None:
    append_declared_jsonl(_events(root), {
        "schema_version": 1, "event": "finding_status_changed",
        "event_id": f"finding:{fid}:status:{to_status}", "finding_id": fid,
        "to_status": to_status, "reason": "fixture", "actor": "test",
    }, expected_surface="repo_finding_events", bypass_profile_gate=True)


class FailClosedFpGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-fp-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.now = datetime.now(timezone.utc)

    def _iso(self, dt: datetime) -> str:
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_absent_finding_ledger_fails_the_gate(self) -> None:
        result = measure_fp_rate(workspace_root=self.root, until=self.now)
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["status"], "unmeasured")

    def test_empty_window_fails_the_gate(self) -> None:
        # Raised 30 minutes ago; the window ends an hour ago, so the
        # finding is outside it and the window itself holds no evidence.
        _emit(self.root, "F-001", created_at=self._iso(self.now - timedelta(minutes=30)))
        result = measure_fp_rate(
            workspace_root=self.root,
            since=self.now - timedelta(hours=2),
            until=self.now - timedelta(hours=1),
        )
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["total"], 0)

    def test_timestamp_less_finding_fails_the_gate(self) -> None:
        _emit(self.root, "F-001", created_at=None)
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertFalse(result["gate_passes"])
        self.assertEqual(result["unknown_timestamp"], 1)

    def test_measured_low_rate_passes_and_high_rate_fails(self) -> None:
        for i in range(1, 6):
            _emit(self.root, f"F-{i:03d}", created_at=self._iso(self.now))
        for i in range(1, 5):
            _change_status(self.root, f"F-{i:03d}", "RESOLVED")
        _change_status(self.root, "F-005", "WITHDRAWN")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertEqual(result["status"], "measured")
        self.assertTrue(result["gate_passes"])  # 1/5 = 0.2 <= 0.33

        for i in range(6, 8):
            _emit(self.root, f"F-{i:03d}", created_at=self._iso(self.now))
            _change_status(self.root, f"F-{i:03d}", "WITHDRAWN")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertFalse(result["gate_passes"])  # 3/7 > 0.33

    def test_withdrawal_is_read_from_the_fold_and_a_stray_file_is_not_a_finding(self) -> None:
        # ARIA-MEDIUM-330 — F-001.json is frozen at mint (OPEN) while the
        # fold says WITHDRAWN; F-101.json is the legacy seeder's file with
        # no event. The rate is 1/1 from the fold, never 0/2 from the files.
        _emit(self.root, "F-001", created_at=self._iso(self.now))
        _change_status(self.root, "F-001", "WITHDRAWN")
        frozen = {"finding_id": "F-001", "originating_skill": "aria-watchdog:probe",
                  "status": "OPEN", "created_at": self._iso(self.now)}
        (self.root / "aria-findings" / "F-001.json").write_text(json.dumps(frozen), encoding="utf-8")
        stray = {"id": "F-101", "originating_skill": "aria-watchdog:probe", "status": "OPEN",
                 "raised_at": self._iso(self.now), "created_at": self._iso(self.now)}
        (self.root / "aria-findings" / "F-101.json").write_text(json.dumps(stray), encoding="utf-8")
        result = measure_fp_rate(workspace_root=self.root, until=self.now + timedelta(hours=1))
        self.assertEqual((result["total"], result["withdrawn"]), (1, 1))

    def test_cli_exit_code_is_fail_closed(self) -> None:
        rc = main(["--workspace-root", str(self.root)])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
