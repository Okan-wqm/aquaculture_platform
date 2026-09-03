"""ORPHAN-HIGH-798 (compact half) — the compact command shrinks ledgers.

Tests: runs evidence envelopes stripped, raw-findings inline findings
stripped, beliefs collapsed to latest, learning-events pruned by age,
archives written, hash chain re-established, dry-run writes nothing.
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.ledger import load_declared_jsonl, verify_jsonl
from aria_kernel.state_compact import compact_state
from aria_kernel.tool_registry import ensure_tools_dir


def _old_ts(days: int = 30) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _new_ts() -> str:
    return datetime.now(timezone.utc).isoformat()


class StateCompactTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-compact-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self._seed_runs()
        self._seed_raw_findings()
        self._seed_beliefs()
        self._seed_learning_events()

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_ledger(self, path: Path, rows: list[dict]) -> None:
        from aria_kernel.ledger import append_declared_jsonl
        path.parent.mkdir(parents=True, exist_ok=True)
        for row in rows:
            append_declared_jsonl(path, row, expected_surface=self._surface_for(path))

    def _surface_for(self, path: Path) -> str:
        name = path.name
        if name == "runs.jsonl":
            return "runs"
        if name == "raw-findings.jsonl":
            return "raw_findings"
        if name == "beliefs.jsonl":
            return "memory_beliefs"
        if name == "learning-events.jsonl":
            return "memory_learning_events"
        raise ValueError(f"unknown ledger: {path}")

    def _seed_runs(self) -> None:
        old_run = {
            "recorded_at": _old_ts(30),
            "run_id": "run-old",
            "tool_id": "tool-a",
            "cycle_id": "cyc-old",
            "status": "ok",
            "evidence_validation": {
                "valid": True,
                "evidence_envelopes": [
                    {"canonical_ref": f"src/file{i}.ts", "trust_grade": "repo_verified"}
                    for i in range(100)
                ],
            },
            "read_paths": [f"src/file{i}.ts" for i in range(100)],
        }
        new_run = {
            "recorded_at": _new_ts(),
            "run_id": "run-new",
            "tool_id": "tool-a",
            "cycle_id": "cyc-new",
            "status": "ok",
            "evidence_validation": {
                "valid": True,
                "evidence_envelopes": [
                    {"canonical_ref": f"src/new{i}.ts", "trust_grade": "repo_verified"}
                    for i in range(5)
                ],
            },
            "read_paths": ["src/new0.ts"],
        }
        self._write_ledger(self.tools / "runs.jsonl", [old_run, new_run])

    def _seed_raw_findings(self) -> None:
        rows = []
        for i in range(10):
            rows.append({
                "recorded_at": _old_ts(30),
                "tool_id": "tool-a",
                "run_id": "run-old",
                "cycle_id": "cyc-old",
                "finding_id": f"F-old-{i}",
                "finding_fingerprint": f"fp-old-{i}",
                "status": "raw",
                "finding": {"id": f"F-old-{i}", "rule": "old-rule", "message": "x" * 100},
            })
        for i in range(3):
            rows.append({
                "recorded_at": _new_ts(),
                "tool_id": "tool-a",
                "run_id": "run-new",
                "cycle_id": "cyc-new",
                "finding_id": f"F-new-{i}",
                "finding_fingerprint": f"fp-new-{i}",
                "status": "raw",
                "finding": {"id": f"F-new-{i}", "rule": "new-rule", "message": "y" * 100},
            })
        self._write_ledger(self.tools / "raw-findings.jsonl", rows)

    def _seed_beliefs(self) -> None:
        rows = []
        for i in range(20):
            rows.append({"belief_id": f"b-{i}", "status": "supported", "evidence_refs": [f"ref-{i}"]})
        for i in range(10):
            rows.append({"belief_id": f"b-{i}", "status": "stale", "evidence_refs": [f"ref-{i}-v2"]})
        self._write_ledger(self.tools / "memory" / "beliefs.jsonl", rows)

    def _seed_learning_events(self) -> None:
        rows = [
            {"recorded_at": _old_ts(30), "event": "learned", "belief_id": "b-0"},
            {"recorded_at": _new_ts(), "event": "learned", "belief_id": "b-1"},
        ]
        self._write_ledger(self.tools / "memory" / "learning-events.jsonl", rows)

    def test_dry_run_writes_nothing(self) -> None:
        before = (self.tools / "runs.jsonl").read_text()
        result = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        self.assertTrue(result["dry_run"])
        after = (self.tools / "runs.jsonl").read_text()
        self.assertEqual(before, after)

    def test_old_runs_lose_envelopes_and_read_paths(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        rows = load_declared_jsonl(self.tools / "runs.jsonl", expected_surface="runs")
        old = next(r for r in rows if r["run_id"] == "run-old")
        new = next(r for r in rows if r["run_id"] == "run-new")
        self.assertNotIn("evidence_envelopes", old["evidence_validation"])
        self.assertEqual(old["evidence_validation"]["evidence_envelope_count"], 100)
        self.assertEqual(len(old["read_paths"]), 5)
        self.assertEqual(old["read_paths_count"], 100)
        # New run untouched
        self.assertEqual(len(new["evidence_validation"]["evidence_envelopes"]), 5)

    def test_old_raw_findings_lose_inline_finding(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        rows = load_declared_jsonl(self.tools / "raw-findings.jsonl", expected_surface="raw_findings")
        old = [r for r in rows if r.get("finding_id", "").startswith("F-old")]
        new = [r for r in rows if r.get("finding_id", "").startswith("F-new")]
        self.assertTrue(all("finding" not in r for r in old))
        self.assertTrue(all(r.get("finding_summary", {}).get("rule") == "old-rule" for r in old))
        self.assertTrue(all("finding" in r for r in new))

    def test_beliefs_collapse_to_latest(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        rows = load_declared_jsonl(self.tools / "memory" / "beliefs.jsonl", expected_surface="memory_beliefs")
        self.assertEqual(len(rows), 20)  # 20 unique belief_ids
        b0 = next(r for r in rows if r["belief_id"] == "b-0")
        self.assertEqual(b0["status"], "stale")  # latest wins

    def test_learning_events_pruned(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        rows = load_declared_jsonl(self.tools / "memory" / "learning-events.jsonl", expected_surface="memory_learning_events")
        self.assertEqual(len(rows), 1)  # only the new one

    def test_archives_written(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        archive_dir = self.tools / "archives"
        self.assertTrue(archive_dir.exists())
        gz_files = list(archive_dir.glob("*.jsonl.gz"))
        self.assertGreater(len(gz_files), 0)

    def test_runs_archive_carries_stripped_rows_pristine(self) -> None:
        """2026-09-01 controlled reproduction: 100 stripped evidence
        envelopes were unrecoverable from the 'lossless' archive because
        the archive wrote the SAME mutated row objects the live ledger
        kept (shallow alias). The archive must carry each slimmed row as
        it was BEFORE slimming."""
        compact_state(base_dir=self.tools, retain_days=7)
        archive = next((self.tools / "archives").glob("runs-compact-*.jsonl.gz"))
        with gzip.open(archive, "rt", encoding="utf-8") as fh:
            archived = [json.loads(line) for line in fh]
        self.assertGreater(len(archived), 0)
        old = next(r for r in archived if r["run_id"] == "run-old")
        self.assertEqual(len(old["evidence_validation"]["evidence_envelopes"]), 100)
        self.assertEqual(len(old["read_paths"]), 100)
        self.assertNotIn("evidence_envelope_count", old["evidence_validation"])
        for row in archived:
            self.assertNotEqual(row.get("run_id"), "run-new",
                                "unstripped rows do not belong in the runs archive")

    def test_raw_findings_archive_carries_inline_findings_pristine(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        archive = next((self.tools / "archives").glob("raw_findings-compact-*.jsonl.gz"))
        with gzip.open(archive, "rt", encoding="utf-8") as fh:
            archived = [json.loads(line) for line in fh]
        self.assertGreater(len(archived), 0)
        self.assertTrue(all("finding" in r for r in archived),
                        "every archived raw-finding row must still carry its inline finding")
        self.assertTrue(all("finding_summary" not in r for r in archived))

    def test_beliefs_and_learning_archives_carry_dropped_rows_only(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        beliefs_archive = next((self.tools / "archives").glob("beliefs-compact-*.jsonl.gz"))
        with gzip.open(beliefs_archive, "rt", encoding="utf-8") as fh:
            archived_beliefs = [json.loads(line) for line in fh]
        # Collapse-to-latest drops the SUPERSEDED rows; their belief_ids
        # legitimately still live in the ledger via their newer rows. What
        # the archive must carry is exactly the superseded versions: the
        # ten b-0..b-9 "supported" rows, and nothing for b-10..b-19.
        self.assertEqual(len(archived_beliefs), 10)
        archived_by_id = {r["belief_id"]: r for r in archived_beliefs}
        for i in range(10):
            self.assertEqual(archived_by_id[f"b-{i}"]["status"], "supported")
        for i in range(10, 20):
            self.assertNotIn(f"b-{i}", archived_by_id)

        learning_archive = next((self.tools / "archives").glob("learning_events-compact-*.jsonl.gz"))
        with gzip.open(learning_archive, "rt", encoding="utf-8") as fh:
            archived_learning = [json.loads(line) for line in fh]
        kept_learning = load_declared_jsonl(
            self.tools / "memory" / "learning-events.jsonl", expected_surface="memory_learning_events"
        )
        # Fixture: one old row dropped, one new row kept — the archive
        # carries the dropped one, the ledger the kept one.
        self.assertEqual(len(archived_learning), 1)
        self.assertEqual(len(kept_learning), 1)
        self.assertEqual(archived_learning[0]["belief_id"], "b-0")
        self.assertEqual(kept_learning[0]["belief_id"], "b-1")

    def test_hash_chain_rechained(self) -> None:
        compact_state(base_dir=self.tools, retain_days=7)
        for ledger_name in ["runs.jsonl", "raw-findings.jsonl", "memory/beliefs.jsonl", "memory/learning-events.jsonl"]:
            path = self.tools / ledger_name
            if path.exists():
                result = verify_jsonl(path)
                self.assertTrue(result["valid"], f"{ledger_name}: {result.get('reason', 'invalid chain')}")

    def test_governance_event_written(self) -> None:
        from aria_kernel.ledger import load_jsonl
        compact_state(base_dir=self.tools, retain_days=7)
        events = load_jsonl(self.tools / "governance.jsonl")
        compact_events = [e for e in events if e.get("kind") == "state_compacted"]
        self.assertEqual(len(compact_events), 1)

    def _seed_hot_artifacts(self) -> None:
        hot = self.tools / "run-artifacts" / "hot"
        old_stamp = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y%m%dT%H%M%SZ")
        new_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        for name in (f"cyc-{old_stamp}-auto", f"cyc-{new_stamp}-auto", "not-a-cycle-dir"):
            cycle = hot / name
            cycle.mkdir(parents=True, exist_ok=True)
            (cycle / "tool_run.json").write_text("{}", encoding="utf-8")
        # The non-cycle directory has no name stamp: its mtime decides.
        stale = hot / "not-a-cycle-dir"
        old_ts = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
        os.utime(stale, (old_ts, old_ts))

    def test_hot_artifacts_older_than_retain_removed_newer_kept(self) -> None:
        self._seed_hot_artifacts()
        result = compact_state(base_dir=self.tools, retain_days=7)
        hot = self.tools / "run-artifacts" / "hot"
        self.assertEqual(result["hot_artifacts_removed"], 2)
        remaining = sorted(p.name for p in hot.iterdir())
        self.assertTrue(any(n.startswith("cyc-") and n != "not-a-cycle-dir" for n in remaining))
        self.assertNotIn("not-a-cycle-dir", remaining)

    def test_discovery_fates_older_than_thirty_days_removed(self) -> None:
        fates = self.tools / "discovery" / "cyc-x"
        fates.mkdir(parents=True, exist_ok=True)
        target = fates / "FATES.json"
        target.write_text("{}", encoding="utf-8")
        old_ts = (datetime.now(timezone.utc) - timedelta(days=31)).timestamp()
        os.utime(target, (old_ts, old_ts))
        fresh = self.tools / "discovery" / "cyc-y" / "FATES.json"
        fresh.parent.mkdir(parents=True, exist_ok=True)
        fresh.write_text("{}", encoding="utf-8")

        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result["fates_removed"], 1)
        self.assertFalse(target.exists())
        self.assertTrue(fresh.exists())

    def test_dry_run_removes_no_hot_artifacts_or_fates(self) -> None:
        self._seed_hot_artifacts()
        result = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        self.assertEqual(result["hot_artifacts_removed"], 2)
        hot = self.tools / "run-artifacts" / "hot"
        self.assertEqual(len(list(hot.iterdir())), 3)


if __name__ == "__main__":
    unittest.main()
