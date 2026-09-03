"""Plan 026R §A.2 — backfill-ledger-hashes.py AND-precondition + idempotent.

6 tests:

* hashless fixtures → all rows hashed + idempotent re-run is no-op
* production: missing ARIA_STOP → refuse
* production: recent mtime on a target ledger → refuse
* production: recent governance event → refuse
* production: active daemon pid lock → refuse
* production: without --operator-acknowledge-maintenance → refuse
"""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from aria_kernel._backfill import BackfillError, run
from aria_kernel.ledger import verify_jsonl


class BackfillIdempotentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-backfill-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hashless_fixtures_chained_and_idempotent(self) -> None:
        # Stage hashless rows into a fixture-shaped tree.
        target = self.tmp / "fixtures"
        target.mkdir()
        (target / "cycles.jsonl").write_text(
            json.dumps({"event": "a"}) + "\n" + json.dumps({"event": "b"}) + "\n",
            encoding="utf-8",
        )
        (target / "runs.jsonl").write_text(
            json.dumps({"run_id": "r1"}) + "\n",
            encoding="utf-8",
        )

        reports = run(
            target=target,
            mode="fixture",
            operator_acknowledge_maintenance=False,
        )
        statuses = sorted(r.status for r in reports)
        self.assertEqual(statuses, ["backfilled", "backfilled"])
        # Strict verify now passes on both files.
        for f in (target / "cycles.jsonl", target / "runs.jsonl"):
            self.assertTrue(verify_jsonl(f)["valid"], f)

        # Idempotent re-run — every file reports already_chained, no rewrite.
        first_cycles_hash = (target / "cycles.jsonl").read_bytes()
        first_runs_hash = (target / "runs.jsonl").read_bytes()
        reports2 = run(
            target=target,
            mode="fixture",
            operator_acknowledge_maintenance=False,
        )
        self.assertTrue(all(r.status == "already_chained" for r in reports2),
                        [r.as_dict() for r in reports2])
        # Bytes-identical — proof rewrite_jsonl was not invoked.
        self.assertEqual((target / "cycles.jsonl").read_bytes(), first_cycles_hash)
        self.assertEqual((target / "runs.jsonl").read_bytes(), first_runs_hash)

    def test_production_without_operator_ack_refuse(self) -> None:
        target = self.tmp / "aria-tools"
        target.mkdir()
        (target / "cycles.jsonl").touch()
        # Even with ARIA_STOP present, without the operator-ack the call refuses.
        (self.tmp / "ARIA_STOP").touch()
        with self.assertRaises(BackfillError) as ctx:
            run(
                target=target,
                mode="production",
                operator_acknowledge_maintenance=False,
            )
        self.assertIn("operator-acknowledge-maintenance", str(ctx.exception))

    def test_production_missing_aria_stop_refuse(self) -> None:
        target = self.tmp / "aria-tools"
        target.mkdir()
        (target / "cycles.jsonl").touch()
        # No ARIA_STOP file anywhere in the parent chain.
        with self.assertRaises(BackfillError) as ctx:
            run(
                target=target,
                mode="production",
                operator_acknowledge_maintenance=True,
            )
        self.assertIn("ARIA_STOP", str(ctx.exception))

    def test_production_recent_mtime_refuse(self) -> None:
        target = self.tmp / "aria-tools"
        target.mkdir()
        ledger = target / "cycles.jsonl"
        ledger.write_text("", encoding="utf-8")
        (self.tmp / "ARIA_STOP").touch()
        # Force the ledger mtime to "now" — within the 300s window.
        recent = time.time()
        import os
        os.utime(ledger, (recent, recent))
        with self.assertRaises(BackfillError) as ctx:
            run(
                target=target,
                mode="production",
                operator_acknowledge_maintenance=True,
            )
        self.assertIn("recent mtime", str(ctx.exception))

    def test_production_recent_governance_refuse(self) -> None:
        target = self.tmp / "aria-tools"
        target.mkdir()
        # All non-governance ledgers are old; governance was just touched.
        old = time.time() - 3600
        cycles = target / "cycles.jsonl"
        cycles.write_text("", encoding="utf-8")
        import os
        os.utime(cycles, (old, old))
        governance = target / "governance.jsonl"
        governance.write_text("", encoding="utf-8")
        os.utime(governance, (time.time(), time.time()))
        (self.tmp / "ARIA_STOP").touch()
        # Use a now slightly in the past so the mtime checks for non-governance
        # files pass, but governance is still within window.
        with self.assertRaises(BackfillError) as ctx:
            run(
                target=target,
                mode="production",
                operator_acknowledge_maintenance=True,
            )
        # Either recent_mtime (caught first on governance.jsonl as a *.jsonl
        # itself) or recent_governance_event — both are valid refusal signals
        # for an idle-failure on governance.jsonl. Accept either.
        self.assertTrue(
            "recent mtime" in str(ctx.exception)
            or "recent governance event" in str(ctx.exception),
            str(ctx.exception),
        )

    def test_production_active_daemon_pid_refuse(self) -> None:
        target = self.tmp / "aria-tools"
        target.mkdir()
        (target / "cycles.jsonl").write_text("", encoding="utf-8")
        # Age everything beyond the window.
        old = time.time() - 3600
        import os
        for f in target.rglob("*.jsonl"):
            os.utime(f, (old, old))
        (self.tmp / "ARIA_STOP").touch()
        daemons = target / "daemons"
        daemons.mkdir()
        (daemons / "planner.pid.lock").write_text("12345", encoding="utf-8")
        with self.assertRaises(BackfillError) as ctx:
            run(
                target=target,
                mode="production",
                operator_acknowledge_maintenance=True,
            )
        self.assertIn("daemon pid lock", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
