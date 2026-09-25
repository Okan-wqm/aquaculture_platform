"""ARIA-HIGH-192 — the large-backfill guard bounds the work, not the registry.

``report_ingestion_scan`` raised ``large_backfill_requires_confirm_large_backfill
_and_acknowledge`` whenever the review registry held more than 500 rows —
before the cache and before the per-call cap. The learning hook passes no flags
and the registry has 2 159 rows, so 42 of 44 live ``learning_hook_failed``
rows are this error and no Lane-A/B finding has ever reached ARIA. Yet the
first call only baselines (ingests nothing) and every later call ingests at
most ``backfill_limit`` (default 100): a large registry is never a large
backfill unless the CALLER asks for one.

These tests pin:
1. A registry above the threshold baselines on the first call and ingests
   within the default cap on the next, with no confirmation flags.
2. A call that asks to ingest more than the threshold in one go
   (``backfill_limit`` above it) still requires confirm + acknowledge.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.report_ingestion import (
    DEFAULT_BACKFILL_LIMIT,
    LARGE_BACKFILL_THRESHOLD,
    report_ingestion_scan,
)
from aria_kernel.workspace import workspace_paths


def _row(index: int) -> dict[str, object]:
    return {
        "id": f"F-EXT-{index:04d}",
        "finding_id": f"F-EXT-{index:04d}",
        "summary": f"external finding {index}",
        "status": "RESOLVED",
        "owner_agent": "ext",
        "severity": "LOW",
        "concept": f"concept-{index}",
        "ref": "docs/reviews/_registry/findings.jsonl",
    }


class BackfillGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-h192-")
        self.repo = Path(self.tmp.name) / "repo"
        self.registry = self.repo / "docs" / "reviews" / "_registry" / "findings.jsonl"
        self.registry.parent.mkdir(parents=True)
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "ws")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, count: int) -> None:
        self.registry.write_text("".join(json.dumps(_row(i)) + "\n" for i in range(count)), encoding="utf-8")

    def test_large_registry_baselines_then_ingests_within_the_cap(self) -> None:
        self._write(LARGE_BACKFILL_THRESHOLD + 100)
        first = report_ingestion_scan(self.paths, cycle_id="cyc-1")
        self.assertEqual(first["status"], "baselined")
        self.assertEqual(first["ingested_count"], 0)

        self._write(LARGE_BACKFILL_THRESHOLD + 101)
        second = report_ingestion_scan(self.paths, cycle_id="cyc-2")
        self.assertEqual(second["status"], "ok")
        self.assertLessEqual(second["ingested_count"] + second["skipped_count"], DEFAULT_BACKFILL_LIMIT)

    def test_an_explicitly_large_backfill_still_requires_confirmation(self) -> None:
        self._write(10)
        report_ingestion_scan(self.paths, cycle_id="cyc-1")
        with self.assertRaises(ValueError) as ctx:
            report_ingestion_scan(
                self.paths, cycle_id="cyc-2", backfill_limit=LARGE_BACKFILL_THRESHOLD + 1,
            )
        self.assertIn("large_backfill_requires_confirm_large_backfill_and_acknowledge", str(ctx.exception))
        confirmed = report_ingestion_scan(
            self.paths, cycle_id="cyc-3", backfill_limit=LARGE_BACKFILL_THRESHOLD + 1,
            confirm_large_backfill=True, acknowledge=True,
        )
        self.assertEqual(confirmed["status"], "ok")


if __name__ == "__main__":
    unittest.main()
