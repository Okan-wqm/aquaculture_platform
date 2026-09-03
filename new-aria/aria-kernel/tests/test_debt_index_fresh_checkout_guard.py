"""ORPHAN-MEDIUM-307 — the committed debt index must survive kernel
commands on a fresh checkout where the (uncommitted) debt-events ledger
is absent. An empty derivation clobbering committed audit truth is the
defect; this suite pins the guard.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.debt import _refresh_index


COMMITTED_INDEX = {
    "schema_version": 1,
    "debts": [
        {
            "debt_id": "DEBT-2026-05-07-001",
            "current_status": "OPEN",
            "severity": "LOW",
            "path": "DEBT-2026-05-07-001.json",
        }
    ],
}


class FreshCheckoutGuardTests(unittest.TestCase):
    def test_absent_ledger_keeps_committed_index_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            debts = repo / "aria-debts"
            debts.mkdir()
            index_path = debts / "_index.json"
            payload = json.dumps(COMMITTED_INDEX, indent=2, sort_keys=True) + "\n"
            index_path.write_text(payload, encoding="utf-8")
            result = _refresh_index(repo)
            self.assertEqual(index_path.read_text(encoding="utf-8"), payload)
            self.assertEqual(result["debts"][0]["debt_id"], "DEBT-2026-05-07-001")

    def test_absent_ledger_and_absent_index_still_derives_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "aria-debts").mkdir()
            result = _refresh_index(repo)
            self.assertEqual(result["debts"], [])
            self.assertTrue((repo / "aria-debts" / "_index.json").exists())

    def test_present_ledger_still_rebuilds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            debts = repo / "aria-debts"
            debts.mkdir()
            (debts / "_index.json").write_text(
                json.dumps(COMMITTED_INDEX), encoding="utf-8",
            )
            (debts / "debt-events.jsonl").write_text("", encoding="utf-8")
            result = _refresh_index(repo)
            self.assertEqual(result["schema_version"], 2)
            self.assertEqual(result["debts"], [])


if __name__ == "__main__":
    unittest.main()
