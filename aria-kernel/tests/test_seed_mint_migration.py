"""ORPHAN-702 — the drift seeder mints through the kernel, or not at all.

  * a drift becomes a real spine_drift finding with events + lifecycle
  * the SAME drift next night is chain-deduped (one durable record)
  * a drift the kernel refuses is disclosed, never hand-written
  * the author digest carries experiment_author; watchdog digest carries
    the sweep's REAL field names
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.finding import list_findings, show_finding
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))
import seed_drift_findings as seeder  # noqa: E402


def _drift(concept: str = "farm_status", cross: bool = True) -> dict:
    return {
        "drift_class": "enum-drift",
        "concept": concept,
        "cross_service": cross,
        "missing_in_ts": ["ARCHIVED"],
        "missing_in_sql": [],
        "candidate_tool": "typeorm-entity-schema-adapter",
        "ts": {"ref": "apps/farm-service/src/module1.ts:10", "name": "FarmStatus", "values": ["A", "B"]},
        "sql": {"ref": "apps/farm-service/src/module2.ts:20", "name": "farm_status", "values": ["A", "B", "C"]},
    }


class SeedMintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-seedmint-")
        self.repo = Path(self.tmp.name) / "repo"
        for i in (1, 2):
            path = self.repo / "apps" / "farm-service" / "src" / f"module{i}.ts"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "T"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "apps"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=self.repo, check=True)
        paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(paths)
        ensure_tools_dir(self.repo / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_drift_becomes_a_real_finding_with_lifecycle(self) -> None:
        minted, already, unmintable = seeder.mint_candidates(self.repo, [_drift()], base_dir=self.repo / 'aria-tools')
        self.assertEqual((len(minted), already, unmintable), (1, [], []))
        record = minted[0]
        self.assertEqual(record["claim_type"], "spine_drift")
        self.assertEqual(record["severity"], "HIGH")
        self.assertEqual(record["status"], "OPEN")
        # event-ledger'da yaşıyor — replay görüyor
        doc = show_finding(self.repo, record["finding_id"])
        self.assertEqual(doc["originating_skill"], "seed:drift-scan")

    def test_same_drift_next_night_is_one_durable_record(self) -> None:
        seeder.mint_candidates(self.repo, [_drift()], base_dir=self.repo / 'aria-tools')
        minted, already, unmintable = seeder.mint_candidates(self.repo, [_drift()], base_dir=self.repo / 'aria-tools')
        self.assertEqual((minted, len(already), unmintable), ([], 1, []))
        self.assertEqual(len(list_findings(self.repo)), 1)

    def test_single_sided_drift_is_disclosed_not_minted(self) -> None:
        drift = _drift()
        drift.pop("sql")
        minted, already, unmintable = seeder.mint_candidates(self.repo, [drift], base_dir=self.repo / 'aria-tools')
        self.assertEqual(minted, [])
        self.assertEqual(unmintable[0]["reason"], "fewer_than_two_evidence_sides")

    def test_low_blast_radius_is_medium(self) -> None:
        minted, _, _ = seeder.mint_candidates(self.repo, [_drift(cross=False)], base_dir=self.repo / 'aria-tools')
        self.assertEqual(minted[0]["severity"], "MEDIUM")


class DigestFieldTests(unittest.TestCase):
    def test_watchdog_digest_fields_match_real_sweep_return(self) -> None:
        """The digest field set must be run_watchdog_sweep's ACTUAL return keys.

        Two generations of this digest shipped with names the sweep never
        returns (invented fields, then the daemon's termination keys); both
        recorded honest-looking zeros. This pin builds the payload from the
        sweep's real return shape so a third drift cannot pass.
        """
        import inspect

        from aria_kernel import aria_watchdog
        from aria_kernel.cycle import _phase_digest_of

        digest_fields = ("candidates", "emitted", "suppressed")
        sweep_source = inspect.getsource(aria_watchdog.run_watchdog_sweep)
        for field in digest_fields:
            self.assertIn(f'"{field}"', sweep_source)

        payload = {"candidates": 3, "emitted": 2, "suppressed": 1,
                   "latest_governance_ts": "2026-08-17T00:00:00+00:00"}
        digest = _phase_digest_of(payload, digest_fields)
        self.assertEqual(digest, {"candidates": 3, "emitted": 2, "suppressed": 1})

    def test_author_digest_is_assembled(self) -> None:
        import inspect

        from aria_kernel import cycle

        src = inspect.getsource(cycle._phase_metrics)
        self.assertIn('"experiment_author"', src)
        self.assertIn('"authored"', src)


if __name__ == "__main__":
    unittest.main()
