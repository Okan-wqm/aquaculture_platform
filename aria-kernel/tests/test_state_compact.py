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

from aria_kernel.ledger import load_declared_jsonl, load_jsonl, verify_jsonl
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
        if name == "artifact-index.jsonl":
            return "runtime_artifact_index"
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

    def _seed_recurring_raw_findings(self) -> None:
        """Three cycles re-record the same two fingerprints (ARIA-HIGH-185);
        one of them carries an unparseable recording time."""
        rows = []
        for cycle_index, recorded in enumerate((_old_ts(3), _old_ts(2), _old_ts(1))):
            for fp in ("fp-shared-a", "fp-shared-b"):
                rows.append({
                    "recorded_at": recorded,
                    "tool_id": "tool-b",
                    "run_id": f"run-{cycle_index}",
                    "cycle_id": f"cyc-{cycle_index}",
                    "finding_id": f"{fp}:{cycle_index}",
                    "finding_fingerprint": fp,
                    "status": "raw",
                    "finding_summary": {"rule": "shared-rule", "id": fp},
                })
        rows.append({
            "recorded_at": "not-a-time",
            "tool_id": "tool-b",
            "run_id": "run-undated",
            "cycle_id": "cyc-undated",
            "finding_id": "fp-shared-a:undated",
            "finding_fingerprint": "fp-shared-a",
            "status": "raw",
            "finding_summary": {"rule": "shared-rule", "id": "fp-shared-a"},
        })
        self._write_ledger(self.tools / "raw-findings.jsonl", rows)

    def test_raw_findings_keep_only_the_newest_row_per_fingerprint(self) -> None:
        self._seed_recurring_raw_findings()
        compact_state(base_dir=self.tools, retain_days=7)
        rows = load_declared_jsonl(self.tools / "raw-findings.jsonl", expected_surface="raw_findings")
        shared = [r for r in rows if r["tool_id"] == "tool-b"]
        self.assertEqual(
            sorted((r["finding_fingerprint"], r["run_id"]) for r in shared),
            [("fp-shared-a", "run-2"), ("fp-shared-b", "run-2")],
            "one row per fingerprint survives, the newest dated one",
        )
        # Rows with distinct fingerprints are not collapsed — the seed's 13
        # unique tool-a rows all remain.
        self.assertEqual(len([r for r in rows if r["tool_id"] == "tool-a"]), 13)

    def test_raw_findings_collapse_archives_the_older_copies_pristine(self) -> None:
        self._seed_recurring_raw_findings()
        compact_state(base_dir=self.tools, retain_days=7)
        archive = next((self.tools / "archives").glob("raw_findings-compact-*.jsonl.gz"))
        with gzip.open(archive, "rt", encoding="utf-8") as fh:
            archived = [json.loads(line) for line in fh]
        collapsed = sorted(r["run_id"] for r in archived if r["tool_id"] == "tool-b")
        self.assertEqual(collapsed, ["run-0", "run-0", "run-1", "run-1", "run-undated"])
        self.assertTrue(all("finding_summary" in r for r in archived if r["tool_id"] == "tool-b"))

    def test_raw_findings_collapse_is_reported_and_dry_run_keeps_every_row(self) -> None:
        self._seed_recurring_raw_findings()
        before = len(load_declared_jsonl(self.tools / "raw-findings.jsonl", expected_surface="raw_findings"))
        dry = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        self.assertEqual(dry["surfaces"]["raw_findings"]["stripped_rows"], 10 + 5)
        self.assertEqual(
            len(load_declared_jsonl(self.tools / "raw-findings.jsonl", expected_surface="raw_findings")),
            before,
        )
        wet = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(wet["surfaces"]["raw_findings"]["after_rows"], before - 5)

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

    def test_compaction_keeps_the_funnel_organ_input(self) -> None:
        """B4 (2026-09-12) — the 2026-09-11 compaction (origin/aria/state
        84032eda1) was suspected of stripping
        knowledge-graph/pressure-source-effectiveness.jsonl. It touched
        runs, learning-events and the artifact index only; the ledger had
        never been written to the store (see the writer's root-binding
        tests). Pinned here so a compaction surface added later cannot
        strip a ledger a doctor organ reads: bytes and the organ's verdict
        are identical before and after."""
        from aria_kernel import doctor
        from aria_kernel.knowledge_graph import record_pressure_source_outcome
        from aria_kernel.ledger import append_declared_jsonl

        append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl",
            {"request_id": "AIR-1", "role": "challenger_plan"},
            expected_surface="agent_invocation_requests",
        )
        record_pressure_source_outcome(
            base_dir=self.tools, source_type="finding", minted=40, converged=12, merged=5,
        )
        ledger = self.tools / "knowledge-graph" / "pressure-source-effectiveness.jsonl"
        before_bytes = ledger.read_bytes()
        before_check = doctor._check_funnel(self.tools)
        self.assertEqual(before_check.status, "ok")
        compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(ledger.read_bytes(), before_bytes)
        self.assertEqual(doctor._check_funnel(self.tools), before_check)

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

    # ------------------------------------------------------------------
    # The prune is attested: what compaction removes, it names — and the
    # publish gate reads those names back. Before this, the only way past
    # `surfaces_lost` after a compaction was the operator bootstrap ack.
    # ------------------------------------------------------------------

    def test_compaction_names_every_pruned_path_on_its_governance_row(self) -> None:
        from aria_kernel.state_compact import COMPACTED_EVENT, PRUNED_PATHS_KEY

        self._seed_hot_artifacts()
        fates = self.tools / "discovery" / "cyc-x" / "FATES.json"
        fates.parent.mkdir(parents=True, exist_ok=True)
        fates.write_text("{}", encoding="utf-8")
        old_ts = (datetime.now(timezone.utc) - timedelta(days=31)).timestamp()
        os.utime(fates, (old_ts, old_ts))
        hot = self.tools / "run-artifacts" / "hot"
        before = {p.name for p in hot.iterdir()}

        result = compact_state(base_dir=self.tools, retain_days=7)

        after = {p.name for p in hot.iterdir()}
        old_cycles = sorted(f"run-artifacts/hot/{name}/" for name in before - after)
        self.assertEqual(len(old_cycles), 2)
        expected = sorted([*old_cycles, "discovery/cyc-x/FATES.json"])
        self.assertEqual(result[PRUNED_PATHS_KEY], expected)
        rows = load_jsonl(self.tools / "governance.jsonl")
        row = [r for r in rows if r.get("kind") == COMPACTED_EVENT][-1]
        self.assertEqual(row["details"][PRUNED_PATHS_KEY], expected)
        # Directory prunes end with "/" so a reader can match by prefix;
        # single files are exact.
        self.assertTrue(all(p.endswith("/") for p in old_cycles))

    def test_attested_pruned_paths_reads_only_rows_since_the_published_tip(self) -> None:
        from aria_kernel.state_compact import attested_pruned_paths, prune_attested

        rows_before = len(load_jsonl(self.tools / "governance.jsonl"))
        self._seed_hot_artifacts()
        compact_state(base_dir=self.tools, retain_days=7)
        rows_after = len(load_jsonl(self.tools / "governance.jsonl"))

        attested = attested_pruned_paths(self.tools, governance_rows_since=rows_before)
        self.assertTrue(any(p.startswith("run-artifacts/hot/cyc-") for p in attested))
        self.assertIn("run-artifacts/hot/not-a-cycle-dir/", attested)
        # Rows the published tip already claims are not this run's evidence.
        self.assertEqual(attested_pruned_paths(self.tools, governance_rows_since=rows_after), ())
        self.assertEqual(attested_pruned_paths(self._tmp / "nowhere", governance_rows_since=0), ())

        cycle = next(p for p in attested if p.startswith("run-artifacts/hot/cyc-"))
        self.assertTrue(prune_attested(f"{cycle}abc/tool_run.json", attested))
        self.assertTrue(prune_attested(f"{cycle}progress.jsonl", attested))
        self.assertFalse(prune_attested("run-artifacts/hot/cyc-other/tool_run.json", attested))
        self.assertFalse(prune_attested("runs.jsonl", attested))

    def test_a_compaction_that_prunes_nothing_attests_nothing(self) -> None:
        from aria_kernel.state_compact import COMPACTED_EVENT, PRUNED_PATHS_KEY

        result = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(result[PRUNED_PATHS_KEY], [])
        row = [r for r in load_jsonl(self.tools / "governance.jsonl") if r.get("kind") == COMPACTED_EVENT][-1]
        self.assertEqual(row["details"][PRUNED_PATHS_KEY], [])

    # ------------------------------------------------------------------
    # ORPHAN-CRITICAL-805 — the index must follow the files it describes.
    #
    # These three tests were defined BELOW the module's `if __name__ ==
    # "__main__": unittest.main()` block at the block's indentation, so they
    # were never class methods and no runner ever collected them: the gate
    # for 805 was green because it did not exist. The block now sits where
    # a main guard belongs, at the end of the module.
    # ------------------------------------------------------------------

    def _index_row(self, cycle: str, run: str, body: bytes | None) -> dict:
        """One artifact-index row in the shape the writer records — the
        hash carries the ``sha256:`` scheme prefix ``verify_artifacts``
        compares byte-for-byte."""
        from aria_kernel.runtime_artifacts import _sha256_bytes

        return {
            "schema_version": 1,
            "artifact_id": f"{cycle}.{run}.tool_run",
            "cycle_uid": cycle,
            "current_uri": f"run-artifacts/hot/{cycle}/{run}/tool_run.json",
            "sha256": _sha256_bytes(body) if body is not None else "sha256:" + "0" * 64,
            "storage_tier": "hot",
            "run_status": "ok",
        }

    def _seed_artifact_index(self) -> str:
        """One artifact that exists on disk, one whose cycle was swept.

        The live cycle's stamp is relative to now: a fixed date here is a
        time bomb — the retention sweep would remove the "live" directory
        itself once the date aged past --retain-days, and the test would
        then assert against a sweep it never meant to exercise. Returns
        the live cycle's name.
        """
        live_cycle = f"cyc-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-auto"
        live = self.tools / "run-artifacts" / "hot" / live_cycle / "run-live" / "tool_run.json"
        live.parent.mkdir(parents=True, exist_ok=True)
        body = b'{"tool_id": "event-contracts-adapter"}'
        live.write_bytes(body)
        rows = [
            self._index_row(live_cycle, "run-live", body),
            self._index_row("cyc-20260810T063724Z-auto", "run-swept", None),
        ]
        self._write_ledger(self.tools / "run-artifacts" / "artifact-index.jsonl", rows)
        return live_cycle

    def test_index_rows_for_swept_artifacts_are_dropped_and_archived(self) -> None:
        """A row whose file `_strip_hot_artifacts` removed used to survive
        forever, and `verify_artifacts` walks the INDEX — so one swept cycle
        made every later cycle report integrity_failed regardless of its
        work. Measured on the production runner 2026-09-04: 158 stale rows
        against 18 live files."""
        from aria_kernel.runtime_artifacts import verify_artifacts

        self._seed_artifact_index()
        self.assertFalse(verify_artifacts(base_dir=self.tools)["valid"])

        result = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(result["artifact_index_rows_dropped"], 1)

        verdict = verify_artifacts(base_dir=self.tools)
        self.assertTrue(verdict["valid"], msg=str(verdict.get("issues")))
        self.assertEqual(verdict["issues"], [])

        kept = load_declared_jsonl(
            self.tools / "run-artifacts" / "artifact-index.jsonl",
            expected_surface="runtime_artifact_index",
        )
        self.assertEqual(len(kept), 1)
        self.assertTrue(kept[0]["artifact_id"].endswith(".run-live.tool_run"))

        archives = sorted((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))
        self.assertEqual(len(archives), 1, "compaction must not lose the rows it drops")
        with gzip.open(archives[0], "rt", encoding="utf-8") as fh:
            archived = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual([r["artifact_id"] for r in archived], ["cyc-20260810T063724Z-auto.run-swept.tool_run"])

    def test_index_compaction_is_a_no_op_when_every_file_is_present(self) -> None:
        from aria_kernel.runtime_artifacts import verify_artifacts

        live_cycle = f"cyc-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-auto"
        mismatched = self.tools / "run-artifacts" / "hot" / live_cycle / "run-mismatch" / "tool_run.json"
        mismatched.parent.mkdir(parents=True, exist_ok=True)
        # A file whose bytes do not match the recorded hash is a REAL integrity
        # failure and must stay in the index for verify_artifacts to catch —
        # in a cycle the retention sweep keeps, or the sweep (not the index
        # compaction) would be what removed it.
        mismatched.write_bytes(b"{}")
        self._write_ledger(
            self.tools / "run-artifacts" / "artifact-index.jsonl",
            [self._index_row(live_cycle, "run-mismatch", None)],
        )

        result = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(result["artifact_index_rows_dropped"], 0)
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertEqual([i["code"] for i in verdict["issues"]], ["run_artifact_hash_mismatch"])

    def test_dry_run_leaves_the_index_alone(self) -> None:
        self._seed_artifact_index()
        result = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        self.assertEqual(result["artifact_index_rows_dropped"], 1)
        rows = load_declared_jsonl(
            self.tools / "run-artifacts" / "artifact-index.jsonl",
            expected_surface="runtime_artifact_index",
        )
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
