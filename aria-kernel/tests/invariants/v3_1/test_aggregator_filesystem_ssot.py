"""Plan ARIA-V3.1 §B3.1-HIGH-002 + §2b — aggregator filesystem-SSoT invariant.

Pre-V3.1 ``reflection._committed_findings_and_debts`` read
``aria-findings/_index.json`` + ``aria-debts/_index.json`` as
authoritative snapshots. Both accumulated drift relative to disk
(F-008 + F-009 invisible to the daily report; DEBT-2026-05-08-001
stuck at OPEN seven days after its retirement in B1).

V3.1 §2b pivots: each ``F-*.json`` / ``DEBT-*.json`` file IS the
authoritative state. The aggregator re-derives the summary on
every reflection cycle.

I-V3.1-06..09 invariants:

  * I-V3.1-06 — aggregator reads findings from filesystem, not from
    the (possibly-stale) ``_index.json`` snapshot.
  * I-V3.1-07 — aggregator reads debts from filesystem, not from the
    (possibly-stale) ``_index.json`` snapshot.
  * I-V3.1-08 — aggregator succeeds when ``_index.json`` files are
    absent (the index is optimization-only, never on the critical
    path).
  * I-V3.1-09 — debt state-machine ``RESOLVED`` state visible in
    aggregator: a debt with current_status=RESOLVED counts toward
    ``total`` but NOT toward ``open`` nor ``overdue``.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _write_finding(
    findings_dir: Path,
    finding_id: str,
    *,
    status_field: str,
    status_value: str,
    created_at: str,
) -> None:
    """Plan ARIA-V3.1 §2b — write a finding file using either the
    ``status`` (F-001..F-007) or ``state`` (F-008+) schema variant.
    """
    findings_dir.mkdir(parents=True, exist_ok=True)
    row = {
        "$schema": "aria/finding/v1",
        "finding_id": finding_id,
        "created_at": created_at,
        "severity": "MEDIUM",
        status_field: status_value,
    }
    (findings_dir / f"{finding_id}.json").write_text(
        json.dumps(row, indent=2), encoding="utf-8",
    )


def _write_debt(
    debts_dir: Path,
    debt_id: str,
    *,
    current_status: str,
    due_date: str,
) -> None:
    debts_dir.mkdir(parents=True, exist_ok=True)
    row = {
        "$schema": "aria/architectural-debt/v1",
        "debt_id": debt_id,
        "current_status": current_status,
        "due_date": due_date,
        "severity": "MEDIUM",
    }
    (debts_dir / f"{debt_id}.json").write_text(
        json.dumps(row, indent=2), encoding="utf-8",
    )


class AggregatorFilesystemSsot(unittest.TestCase):
    # I-V3.1-06 — findings from filesystem, not stale index.
    def test_i_v3_1_06_aggregator_reads_findings_from_filesystem(self) -> None:
        from aria_kernel.reflection import _committed_findings_and_debts

        with tempfile.TemporaryDirectory(prefix="aria-v31-fs-find-") as tmp:
            repo = Path(tmp)
            findings = repo / "aria-findings"
            # 3 findings on disk:
            #  - F-001 OPEN (status schema)
            #  - F-002 RESOLVED (status schema)
            #  - F-003 OPEN (state schema — V3 plan style)
            _write_finding(
                findings, "F-001",
                status_field="status", status_value="OPEN",
                created_at="2026-05-10T00:00:00Z",
            )
            _write_finding(
                findings, "F-002",
                status_field="status", status_value="RESOLVED",
                created_at="2026-05-11T00:00:00Z",
            )
            _write_finding(
                findings, "F-003",
                status_field="state", status_value="OPEN",
                created_at="2026-05-12T00:00:00Z",
            )
            # Plan ARIA-V3.1 §2b — write a STALE _index.json that
            # claims only F-001 exists. The fs-scan SSoT MUST
            # ignore it and surface all 3 disk files.
            (findings / "_index.json").write_text(
                json.dumps({"findings": [{"finding_id": "F-001"}]}),
                encoding="utf-8",
            )
            result = _committed_findings_and_debts(
                repo / "aria-tools", repo_root_override=repo,
            )
            self.assertEqual(result["findings"]["total"], 3)
            self.assertEqual(result["findings"]["open"], 2)
            self.assertEqual(len(result["findings"]["recent"]), 3)
            # The newest finding (F-003) appears first.
            self.assertEqual(
                result["findings"]["recent"][0]["finding_id"], "F-003",
            )

    # I-V3.1-07 — debts from filesystem, not stale index.
    def test_i_v3_1_07_aggregator_reads_debts_from_filesystem(self) -> None:
        from aria_kernel.reflection import _committed_findings_and_debts

        with tempfile.TemporaryDirectory(prefix="aria-v31-fs-debt-") as tmp:
            repo = Path(tmp)
            debts = repo / "aria-debts"
            _write_debt(
                debts, "DEBT-2026-05-01-001",
                current_status="OPEN",
                due_date="2027-01-01T00:00:00Z",
            )
            _write_debt(
                debts, "DEBT-2026-05-02-001",
                current_status="RESOLVED",
                due_date="2027-02-01T00:00:00Z",
            )
            # Stale index claims everything OPEN; fs-scan must
            # override.
            (debts / "_index.json").write_text(
                json.dumps({"debts": [
                    {"debt_id": "DEBT-2026-05-01-001", "current_status": "OPEN"},
                    {"debt_id": "DEBT-2026-05-02-001", "current_status": "OPEN"},
                ]}),
                encoding="utf-8",
            )
            result = _committed_findings_and_debts(
                repo / "aria-tools", repo_root_override=repo,
            )
            self.assertEqual(result["debts"]["total"], 2)
            self.assertEqual(result["debts"]["open"], 1)
            self.assertEqual(result["debts"]["overdue"], 0)

    # I-V3.1-08 — succeeds with missing index files.
    def test_i_v3_1_08_aggregator_succeeds_with_missing_index_files(self) -> None:
        from aria_kernel.reflection import _committed_findings_and_debts

        with tempfile.TemporaryDirectory(prefix="aria-v31-no-index-") as tmp:
            repo = Path(tmp)
            findings = repo / "aria-findings"
            debts = repo / "aria-debts"
            _write_finding(
                findings, "F-001",
                status_field="status", status_value="OPEN",
                created_at="2026-05-10T00:00:00Z",
            )
            _write_debt(
                debts, "DEBT-2026-05-01-001",
                current_status="OPEN",
                due_date="2027-01-01T00:00:00Z",
            )
            # No _index.json files exist.
            self.assertFalse((findings / "_index.json").exists())
            self.assertFalse((debts / "_index.json").exists())
            result = _committed_findings_and_debts(
                repo / "aria-tools", repo_root_override=repo,
            )
            self.assertEqual(result["findings"]["total"], 1)
            self.assertEqual(result["findings"]["open"], 1)
            self.assertEqual(result["debts"]["total"], 1)
            self.assertEqual(result["debts"]["open"], 1)

    # I-V3.1-09 — RESOLVED state visible in aggregator.
    def test_i_v3_1_09_resolved_state_visible_in_aggregator(self) -> None:
        from aria_kernel.reflection import _committed_findings_and_debts

        with tempfile.TemporaryDirectory(prefix="aria-v31-resolved-") as tmp:
            repo = Path(tmp)
            debts = repo / "aria-debts"
            # 3 debts: 2 OPEN, 1 RESOLVED. RESOLVED must:
            #   - count toward total
            #   - NOT count toward open
            #   - NOT count toward overdue
            _write_debt(
                debts, "DEBT-A", current_status="OPEN",
                due_date="2027-01-01T00:00:00Z",
            )
            _write_debt(
                debts, "DEBT-B", current_status="OPEN",
                due_date="2025-01-01T00:00:00Z",  # past → overdue
            )
            _write_debt(
                debts, "DEBT-C", current_status="RESOLVED",
                due_date="2025-01-01T00:00:00Z",  # past but RESOLVED
            )
            result = _committed_findings_and_debts(
                repo / "aria-tools", repo_root_override=repo,
            )
            self.assertEqual(result["debts"]["total"], 3)
            self.assertEqual(result["debts"]["open"], 2)
            self.assertEqual(result["debts"]["overdue"], 1)


if __name__ == "__main__":
    unittest.main()
