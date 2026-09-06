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
            from aria_kernel.runtime_artifacts import write_run_artifact
            write_run_artifact(base_dir=self.tools, run_id="fixture", cycle_uid=name,
                               tool_id="fixture", kind="tool_run", payload={}, run_status="ok")
        # The non-cycle directory has no name stamp: its mtime decides.
        stale = hot / "not-a-cycle-dir"
        old_ts = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
        os.utime(stale, (old_ts, old_ts))

    def test_compaction_preserves_all_hot_artifacts_for_retention_owner(self) -> None:
        self._seed_hot_artifacts()
        result = compact_state(base_dir=self.tools, retain_days=7)
        hot = self.tools / "run-artifacts" / "hot"
        self.assertEqual(result["hot_artifacts_removed"], 0)
        remaining = sorted(p.name for p in hot.iterdir())
        self.assertTrue(any(n.startswith("cyc-") and n != "not-a-cycle-dir" for n in remaining))
        self.assertIn("not-a-cycle-dir", remaining)
        self.assertEqual(len(remaining), 3)

    def test_compaction_preserves_discovery_evidence_for_retention_owner(self) -> None:
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

        self.assertEqual(result["fates_removed"], 0)
        self.assertTrue(target.exists())
        self.assertTrue(fresh.exists())

    def test_dry_run_removes_no_hot_artifacts_or_fates(self) -> None:
        self._seed_hot_artifacts()
        result = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        self.assertEqual(result["hot_artifacts_removed"], 0)
        hot = self.tools / "run-artifacts" / "hot"
        self.assertEqual(len(list(hot.iterdir())), 3)



class ArtifactIntegrityCompactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tools = Path(self.temp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def seed_artifact(self, number: int = 0) -> dict:
        from aria_kernel.runtime_artifacts import write_run_artifact
        return write_run_artifact(
            base_dir=self.tools, run_id=f"run-{number}",
            cycle_uid="cyc-20260810T063724Z-auto", tool_id="fixture",
            kind="tool_run", payload={"evidence": "redacted"}, run_status="ok",
        )["artifact_ref"]

    def bytes_before(self) -> dict:
        return {p.relative_to(self.tools).as_posix(): p.read_bytes()
                for p in self.tools.rglob("*") if p.is_file()}

    def test_live_reference_survives_compaction_and_repeat(self) -> None:
        from aria_kernel.runtime_artifacts import resolve_artifact_payload, verify_artifacts
        ref = self.seed_artifact()
        before = (self.tools / ref["uri"]).read_bytes()
        for _ in range(2):
            result = compact_state(base_dir=self.tools, retain_days=7)
            self.assertEqual(result["artifact_index_rows_dropped"], 0)
            self.assertEqual((self.tools / ref["uri"]).read_bytes(), before)
            self.assertIsNotNone(resolve_artifact_payload(ref, base_dir=self.tools))
            self.assertTrue(verify_artifacts(base_dir=self.tools)["valid"])

    def test_158_missing_historical_files_remain_invalid_and_unmodified(self) -> None:
        from aria_kernel.ledger import rewrite_declared_jsonl
        from aria_kernel.runtime_artifacts import verify_artifacts
        from aria_kernel.tool_registry import GovernanceError
        ref = self.seed_artifact()
        (self.tools / ref["uri"]).unlink()
        for surface, relative in (
            ("runtime_artifact_manifest", "run-artifacts/manifest.jsonl"),
            ("runtime_artifact_inventory", "observability/artifact-inventory.jsonl"),
        ):
            template = load_declared_jsonl(self.tools / relative, expected_surface=surface)[0]
            rows = []
            for number in range(158):
                row = dict(template)
                row["artifact_id"] = f"redacted-history-{number}"
                uri = f"run-artifacts/hot/cyc-202608{10 + number % 13:02d}T063724Z-auto/run-{number}/tool_run.json"
                row["path" if surface == "runtime_artifact_inventory" else "current_uri"] = uri
                rows.append(row)
            rewrite_declared_jsonl(self.tools / relative, rows, expected_surface=surface, migration_id="fixture")
        # Mirror the observed incident: index shrunk, historical projections
        # retain 158 references, with no currently active run rows.
        rewrite_declared_jsonl(self.tools / "run-artifacts/artifact-index.jsonl", [],
                               expected_surface="runtime_artifact_index", migration_id="fixture")
        before = self.bytes_before()
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertEqual(len({issue["artifact_id"] for issue in verdict["issues"]
                             if issue["code"] == "run_artifact_missing"}), 158)
        with self.assertRaises(GovernanceError):
            compact_state(base_dir=self.tools)
        self.assertEqual(self.bytes_before(), before)

    def test_existing_hash_mismatch_cannot_be_hidden_by_compaction(self) -> None:
        from aria_kernel.tool_registry import GovernanceError
        ref = self.seed_artifact()
        (self.tools / ref["uri"]).write_bytes(b"corrupt")
        before = self.bytes_before()
        with self.assertRaisesRegex(GovernanceError, "artifact"):
            compact_state(base_dir=self.tools)
        self.assertEqual(self.bytes_before(), before)

    def test_dry_run_has_no_byte_changes(self) -> None:
        self.seed_artifact()
        before = self.bytes_before()
        compact_state(base_dir=self.tools, dry_run=True)
        self.assertEqual(self.bytes_before(), before)

    def test_partial_projection_write_is_invalid(self) -> None:
        from aria_kernel.ledger import rewrite_declared_jsonl
        from aria_kernel.runtime_artifacts import verify_artifacts
        self.seed_artifact()
        rewrite_declared_jsonl(self.tools / "observability/artifact-inventory.jsonl", [],
                               expected_surface="runtime_artifact_inventory", migration_id="fixture")
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertIn("artifact_projection_missing", {i["code"] for i in verdict["issues"]})

    def test_archive_copy_failure_preserves_source_and_retry_succeeds(self) -> None:
        from unittest import mock
        from aria_kernel.runtime_artifacts import retention_apply, verify_artifacts
        self.seed_artifact()
        original = self.bytes_before()
        kwargs = dict(base_dir=self.tools, acknowledge=True, retain_hot_cycles=0,
                      reason="fixture", operator_approval_ref="gov:fixture")
        with mock.patch("aria_kernel.runtime_artifacts._atomic_write_bytes", side_effect=OSError("disk interrupted")):
            with self.assertRaises(OSError):
                retention_apply(**kwargs)
        for relative, data in original.items():
            self.assertEqual((self.tools / relative).read_bytes(), data)
        result = retention_apply(**kwargs)
        self.assertEqual(result["archived_count"], 1)
        self.assertTrue(verify_artifacts(base_dir=self.tools)["valid"])
        archive = self.tools / result["archived"][0]["new_path"]
        archive.write_bytes(b"corrupt")
        self.assertFalse(verify_artifacts(base_dir=self.tools)["valid"])

    def test_inventory_byte_count_drift_is_invalid(self) -> None:
        from aria_kernel.ledger import rewrite_declared_jsonl
        from aria_kernel.runtime_artifacts import verify_artifacts
        self.seed_artifact()
        path = self.tools / "observability/artifact-inventory.jsonl"
        rows = load_declared_jsonl(path, expected_surface="runtime_artifact_inventory")
        rows[0]["bytes"] = 0
        rewrite_declared_jsonl(path, rows, expected_surface="runtime_artifact_inventory", migration_id="fixture")
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertIn("artifact_projection_size_mismatch", {i["code"] for i in verdict["issues"]})

    def test_artifact_identity_collision_preserves_existing_evidence(self) -> None:
        from aria_kernel.runtime_artifacts import write_run_artifact
        from aria_kernel.tool_registry import GovernanceError
        self.seed_artifact()
        before = self.bytes_before()
        with self.assertRaisesRegex(GovernanceError, "identity_collision"):
            write_run_artifact(base_dir=self.tools, run_id="run-0",
                               cycle_uid="cyc-20260810T063724Z-auto", tool_id="fixture",
                               kind="tool_run", payload={"evidence": "different"}, run_status="ok")
        self.assertEqual(self.bytes_before(), before)

    def test_identical_artifact_retry_reuses_original_bytes_and_projections(self) -> None:
        first = self.seed_artifact()
        before = self.bytes_before()
        second = self.seed_artifact()
        self.assertEqual(second, first)
        self.assertEqual(self.bytes_before(), before)

    def test_read_paths_only_compaction_archives_and_rewrites_the_row(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl
        source_paths = [f"source-{i}.ts" for i in range(30)]
        append_declared_jsonl(self.tools / "runs.jsonl", {
            "run_id": "read-paths-only", "recorded_at": _old_ts(), "read_paths": source_paths,
        }, expected_surface="runs")
        result = compact_state(base_dir=self.tools)
        self.assertEqual(result["surfaces"]["runs"]["stripped_rows"], 1)
        kept = load_declared_jsonl(self.tools / "runs.jsonl", expected_surface="runs")
        self.assertEqual(kept[0]["read_paths_count"], 30)
        self.assertEqual(len(kept[0]["read_paths"]), 5)
        archive = next((self.tools / "archives").glob("runs-compact-*.jsonl.gz"))
        with gzip.open(archive, "rt", encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle]
        self.assertEqual(rows[0]["read_paths"], source_paths)

    def test_interrupted_first_projection_write_is_invalid_until_same_input_retry(self) -> None:
        from unittest import mock
        from aria_kernel.ledger import StateTransaction
        from aria_kernel.runtime_artifacts import verify_artifacts
        with mock.patch.object(StateTransaction, "append_declared_jsonl", side_effect=OSError("writer interrupted")):
            with self.assertRaises(OSError):
                self.seed_artifact()
        blob = next((self.tools / "run-artifacts/hot").rglob("*.json"))
        original = blob.read_bytes()
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertIn("artifact_unindexed", {i["code"] for i in verdict["issues"]})
        self.seed_artifact()
        self.assertEqual(blob.read_bytes(), original)
        self.assertTrue(verify_artifacts(base_dir=self.tools)["valid"])

    def test_concurrent_append_survives_each_compaction_surface(self) -> None:
        import threading
        from unittest import mock
        from aria_kernel import state_compact
        from aria_kernel.ledger import append_declared_jsonl
        cases = [
            ("runs", "runs.jsonl", "runs", [{"evidence_validation": {"evidence_envelopes": [{}]}}]),
            ("raw_findings", "raw-findings.jsonl", "raw_findings", [{"finding": {"id": "old"}}]),
            ("beliefs", "memory/beliefs.jsonl", "memory_beliefs", [{"belief_id": "old"}, {"belief_id": "old"}]),
            ("learning_events", "memory/learning-events.jsonl", "memory_learning_events", [{}]),
        ]
        for surface, relative, expected, initial_rows in cases:
            with self.subTest(surface=surface):
                path = self.tools / relative
                for row in initial_rows:
                    append_declared_jsonl(path, {"recorded_at": _old_ts(), **row}, expected_surface=expected)
                completed = threading.Event()
                failures = []
                marker = f"concurrent-{surface}"
                def append_concurrently() -> None:
                    try:
                        append_declared_jsonl(path, {"marker": marker, "belief_id": marker,
                                                    "recorded_at": _new_ts()}, expected_surface=expected)
                    except BaseException as exc:
                        failures.append(exc)
                    finally:
                        completed.set()
                worker = threading.Thread(target=append_concurrently)
                original = state_compact._archive_stripped
                def interleave(root, name, rows, **kwargs):
                    if name == surface:
                        worker.start()
                        # A proper transaction blocks the append until after
                        # archive/rewrite; without it the append finishes here.
                        completed.wait(2)
                    return original(root, name, rows, **kwargs)
                with mock.patch.object(state_compact, "_archive_stripped", side_effect=interleave):
                    compact_state(base_dir=self.tools)
                worker.join(10)
                self.assertFalse(worker.is_alive())
                self.assertFalse(failures, failures)
                retained = load_declared_jsonl(path, expected_surface=expected)
                archived = []
                for archive in (self.tools / "archives").glob(f"{surface}-compact-*.jsonl.gz"):
                    with gzip.open(archive, "rt", encoding="utf-8") as handle:
                        archived.extend(json.loads(line) for line in handle)
                self.assertIn(marker, {row.get("marker") for row in retained + archived})

    def test_archive_receipt_must_name_the_bytes_of_its_artifact(self) -> None:
        from aria_kernel.ledger import rewrite_declared_jsonl
        from aria_kernel.runtime_artifacts import retention_apply, verify_artifacts
        first = self.seed_artifact(1)
        second = self.seed_artifact(2)
        retention_apply(base_dir=self.tools, acknowledge=True, retain_hot_cycles=0,
                        reason="fixture", operator_approval_ref="gov:fixture")
        events_path = self.tools / "retention/events.jsonl"
        rows = load_declared_jsonl(events_path, expected_surface="retention_events")
        source = next(row for row in rows if row.get("artifact_id") == first["artifact_id"])
        # Keep the archive URI/digest internally consistent but bind A's
        # archived bytes to B's identity and original hot URI.
        source["artifact_id"] = second["artifact_id"]
        source["original_path"] = second["uri"]
        rewrite_declared_jsonl(events_path, rows, expected_surface="retention_events", migration_id="fixture")
        verdict = verify_artifacts(base_dir=self.tools)
        self.assertFalse(verdict["valid"])
        self.assertIn("retention_artifact_binding_mismatch", {i["code"] for i in verdict["issues"]})
