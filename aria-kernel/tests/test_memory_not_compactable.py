"""ARIA-HIGH-263 — memory surfaces are never compacted and never shrink at publish.

THE DEFECT (docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-HIGH-263):
state compaction collapsed ``memory/beliefs.jsonl`` to the latest row per
belief id and kept ``memory/learning-events.jsonl`` only inside
``--retain-days`` (7), archiving the rest into ``archives/`` where no memory
reader looks. Every publisher ran that compaction as a pre-step over the
WHOLE root as soon as any compactable ledger passed 32 MiB, and the publish
carried the shrunk memory as an ordinary change. Live: 8 beliefs and 33
learning events against 8 MB archived of each — ARIA forgot weekly.

WHAT IS PINNED HERE:

  1. the memory set is the manifest's ``memory`` flag, and it covers at
     least the arbiter's list; no memory surface is compactable;
  2. compaction leaves every memory surface byte-identical, and refuses a
     memory surface named to it;
  3. an oversized ``runs.jsonl`` compacts ``runs`` alone — no other ledger,
     hot artifact or FATES file is touched as a side effect;
  4. a publish whose memory lost rows, or rewrote a prefix while growing, is
     refused by name (``memory_surface_rewrite``), with or without the
     operator's acknowledgment;
  5. append-only memory growth publishes.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import state_compact, state_store
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.state_compact import (
    ARCHIVE_KEY,
    COMPACTABLE_SURFACES,
    COMPACTED_EVENT,
    bound_compactable_surfaces,
    compact_state,
    compact_surfaces,
)
from aria_kernel.state_manifest import memory_surfaces, resolve_surface_path, surface_by_name
from aria_kernel.state_snapshot import (
    MEMORY_REWRITE_STATUS,
    SnapshotError,
    build_snapshot,
    compute_manifest_root,
    snapshot_continuity,
)
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    publish_state,
    read_published_snapshot,
    tools_root,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    rewrite_declared_out_of_band,
)
from tests.test_state_publish_maintenance import MaintenanceLaneTestCase
from tests.test_state_store import REPO_HASH, _EnvPatch, _git

# The arbiter's minimum (program plan step A1a): the memory ledgers plus the
# reflection and knowledge-graph surfaces.
RULED_MEMORY = {
    "memory_beliefs",
    "memory_learning_events",
    "memory_observations",
    "memory_uncertainties",
    "memory_contradictions",
    "memory_calibration",
    "reflections",
    "kg_conventions",
    "kg_anti_patterns",
    "kg_pressure_source_effectiveness",
    "kg_duel_ratings",
    "kg_embeddings",
}


def _old_ts(days: int = 30) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _memory_surface_file(root: Path, surface) -> Path:
    """The one file a test seeds a memory surface through.

    A glob ledger (``plan_convergence_events`` is ``plans/*.jsonl``) is the
    surface, not a single path, so the seed picks one deterministic file of
    the family — the gates protect each file of the family the same way.
    """
    if "*" in surface.path_pattern:
        return root / surface.path_pattern.replace("*", "memory-seed")
    return resolve_surface_path(root, surface)


def _seed_memory(root: Path) -> dict[str, str]:
    """Every memory surface with rows the retired compactors would have cut:
    old timestamps and one id recorded three times."""
    digests: dict[str, str] = {}
    for surface in memory_surfaces():
        path = _memory_surface_file(root, surface)
        path.parent.mkdir(parents=True, exist_ok=True)
        for version in range(3):
            append_declared_fixture(
                path,
                {
                    "schema_version": 1,
                    "belief_id": "b-0",
                    "event": "learned",
                    "recorded_at": _old_ts(30 - version),
                    "version": version,
                },
                expected_surface=surface.name,
            )
        digests[surface.name] = _sha(path)
    return digests


def _assert_memory_unchanged(test: unittest.TestCase, root: Path, digests: dict[str, str]) -> None:
    for surface in memory_surfaces():
        path = _memory_surface_file(root, surface)
        test.assertTrue(path.is_file(), f"{surface.name} must survive")
        test.assertEqual(_sha(path), digests[surface.name], f"{surface.name} must be byte-identical")


class MemoryIsNotCompactable(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-memory-compact-"))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")
        self.memory = _seed_memory(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _seed_runs(self, envelopes: int = 200) -> Path:
        path = self.tools / "runs.jsonl"
        append_declared_fixture(
            path,
            {
                "recorded_at": _old_ts(30),
                "run_id": "run-old",
                "tool_id": "tool-a",
                "cycle_id": "cyc-old",
                "status": "ok",
                "evidence_validation": {
                    "valid": True,
                    "evidence_envelopes": [{"canonical_ref": f"src/f{i}.ts"} for i in range(envelopes)],
                },
                "read_paths": [f"src/f{i}.ts" for i in range(envelopes)],
            },
            expected_surface="runs",
        )
        return path

    def _seed_raw_findings(self) -> Path:
        path = self.tools / "raw-findings.jsonl"
        for run in ("run-a", "run-b"):
            append_declared_fixture(
                path,
                {
                    "recorded_at": _old_ts(30),
                    "tool_id": "tool-a",
                    "run_id": run,
                    "cycle_id": "cyc-old",
                    "finding_id": "F-1",
                    "finding_fingerprint": "fp-1",
                    "status": "raw",
                    "finding": {"id": "F-1", "rule": "r", "message": "m"},
                },
                expected_surface="raw_findings",
            )
        return path

    def test_the_memory_set_is_the_manifests_flag_and_none_is_compactable(self) -> None:
        names = {surface.name for surface in memory_surfaces()}
        self.assertTrue(RULED_MEMORY <= names, sorted(RULED_MEMORY - names))
        self.assertEqual(set(COMPACTABLE_SURFACES) & names, set())
        # The compactable names ARE manifest names — the old private aliases
        # ("beliefs", "learning_events") hid memory from any manifest check.
        for name in COMPACTABLE_SURFACES:
            self.assertFalse(surface_by_name(name).memory, name)
        for surface in memory_surfaces():
            self.assertEqual(surface.state_class, "ledger", surface.name)

    def test_compaction_leaves_every_memory_surface_byte_identical(self) -> None:
        self._seed_runs()
        self._seed_raw_findings()
        result = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(set(result["surfaces"]), {"runs", "raw_findings"})
        _assert_memory_unchanged(self, self.tools, self.memory)
        self.assertEqual(
            sorted(path.name.split("-compact-")[0] for path in (self.tools / "archives").glob("*-compact-*")),
            ["raw_findings", "runs"],
            "no memory archive may be written",
        )

    def test_a_memory_surface_named_to_the_compactor_is_refused(self) -> None:
        for name in ("memory_beliefs", "memory_learning_events", "kg_conventions", "reflections"):
            with self.subTest(surface=name), self.assertRaisesRegex(
                ValueError, f"memory_surface_not_compactable:{name}"
            ):
                compact_surfaces(self.tools, [name])
        _assert_memory_unchanged(self, self.tools, self.memory)

    def test_an_oversized_runs_ledger_compacts_only_runs(self) -> None:
        runs = self._seed_runs()
        raw = self._seed_raw_findings()
        old_cycle = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("cyc-%Y%m%dT%H%M%SZ-auto")
        hot = self.tools / "run-artifacts" / "hot" / old_cycle / "run-old" / "tool_run.json"
        hot.parent.mkdir(parents=True)
        hot.write_text('{"tool_id": "tool-a"}\n', encoding="utf-8")
        fates = self.tools / "discovery" / "cyc-old" / "FATES.json"
        fates.parent.mkdir(parents=True)
        fates.write_text("{}\n", encoding="utf-8")
        stale = (datetime.now(timezone.utc) - timedelta(days=60)).timestamp()
        os.utime(fates, (stale, stale))
        runs_before, raw_before = _sha(runs), _sha(raw)
        governance_rows = len(load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance"))
        self.assertGreater(runs.stat().st_size, raw.stat().st_size)

        with mock.patch.object(state_compact, "COMPACTION_TRIGGER_BYTES", raw.stat().st_size):
            bound = bound_compactable_surfaces(self.tools)

        self.assertEqual(bound["oversized"], ["runs"])
        self.assertEqual(set(bound["result"]["surfaces"]), {"runs"})
        self.assertNotEqual(_sha(runs), runs_before, "the oversized ledger is compacted")
        self.assertEqual(_sha(raw), raw_before, "a ledger under the trigger is not rewritten")
        self.assertTrue(hot.is_file(), "bounding a ledger strips no hot artifact")
        self.assertTrue(fates.is_file(), "bounding a ledger prunes no FATES")
        _assert_memory_unchanged(self, self.tools, self.memory)
        added = load_declared_jsonl(
            self.tools / "governance.jsonl", expected_surface="tools_governance"
        )[governance_rows:]
        self.assertEqual([row["kind"] for row in added], [COMPACTED_EVENT])
        details = added[0]["details"]
        self.assertEqual(set(details["surfaces"]), {"runs"})
        # The cold-eviction change retired pruned-path attestation: nothing is pruned, so no row claims to vouch for it.
        self.assertNotIn("pruned_paths", details)
        self.assertIn(ARCHIVE_KEY, details)
        self.assertIsNone(details[ARCHIVE_KEY])


class ContinuityNamesAMemoryRewrite(unittest.TestCase):
    """The manifest-level half: what a pair of snapshots can show."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-memory-continuity-"))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")
        self.beliefs = self.tools / "memory" / "beliefs.jsonl"
        for index in range(3):
            append_declared_fixture(
                self.beliefs, {"schema_version": 1, "belief_id": f"b-{index}"},
                expected_surface="memory_beliefs",
            )
        append_declared_fixture(
            self.tools / "cycles.jsonl", {"schema_version": 1, "cycle_id": "c"},
            expected_surface="cycles",
        )
        self.first = self._build("snap-1")

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _build(self, snapshot_id: str, previous: dict | None = None) -> dict:
        return build_snapshot(
            snapshot_id=snapshot_id, cycle_id="cyc", lane="test",
            roots={"tools": self.tools}, previous=previous,
        )

    def _chained(self, snapshot: dict) -> dict:
        """A successor that names ``self.first`` without the builder's check."""
        snapshot = dict(snapshot)
        snapshot["prev_snapshot_id"] = self.first["snapshot_id"]
        snapshot["prev_manifest_root"] = self.first["manifest_root"]
        snapshot["manifest_root"] = compute_manifest_root(snapshot)
        return snapshot

    def test_fewer_rows_outranks_a_loss_that_could_be_vouched_for(self) -> None:
        rows = load_declared_jsonl(self.beliefs, expected_surface="memory_beliefs")
        # Out of band: the writer refuses this rewrite (memory_class), and the
        # continuity verdict is what must name it — the loss arrived as bytes.
        rewrite_declared_out_of_band(self.beliefs, rows[-1:], expected_surface="memory_beliefs")
        (self.tools / "cycles.jsonl").unlink()
        verdict = snapshot_continuity(self._chained(self._build("snap-2")), self.first)
        self.assertEqual(verdict["status"], MEMORY_REWRITE_STATUS)
        self.assertEqual(verdict["memory_rewrites"], ["memory_beliefs"])
        self.assertEqual(verdict["lost_surfaces"], ["cycles"])

    def test_a_vanished_memory_surface_is_a_rewrite_not_a_loss(self) -> None:
        self.beliefs.unlink()
        verdict = snapshot_continuity(self._chained(self._build("snap-2")), self.first)
        self.assertEqual(verdict["status"], MEMORY_REWRITE_STATUS)
        self.assertEqual(verdict["memory_rewrites"], ["memory_beliefs"])

    def test_append_only_growth_is_continuous(self) -> None:
        append_declared_fixture(
            self.beliefs, {"schema_version": 1, "belief_id": "b-3"},
            expected_surface="memory_beliefs",
        )
        second = self._build("snap-2", previous=self.first)
        verdict = snapshot_continuity(second, self.first)
        self.assertEqual(verdict["status"], "ok")
        self.assertEqual(verdict["memory_rewrites"], [])
        self.assertEqual(verdict["changed_surfaces"], ["memory_beliefs"])

    def test_a_grown_rewrite_is_refused_by_the_builder_from_the_bytes(self) -> None:
        """More rows than the predecessor, but not its prefix — the case no
        pair of manifests can show, so the builder refuses it while it
        verifies the chain."""
        rows = load_declared_jsonl(self.beliefs, expected_surface="memory_beliefs")
        rows[0] = {**rows[0], "status": "rewritten"}
        rows.append({"schema_version": 1, "belief_id": "b-new"})
        rewrite_declared_out_of_band(self.beliefs, rows, expected_surface="memory_beliefs")
        unchecked = self._chained(self._build("snap-2"))
        self.assertEqual(snapshot_continuity(unchecked, self.first)["memory_rewrites"], [])
        with self.assertRaisesRegex(SnapshotError, f"snapshot_{MEMORY_REWRITE_STATUS}:memory_beliefs"):
            self._build("snap-2", previous=self.first)


class APublishNeverShrinksMemory(MaintenanceLaneTestCase):
    """The publish end to end, against real git, through the one preamble."""

    def _seed_beliefs(self, store, count: int) -> Path:
        path = tools_root(store) / "memory" / "beliefs.jsonl"
        for index in range(count):
            append_declared_fixture(
                path, {"schema_version": 1, "belief_id": f"b-{index}"},
                expected_surface="memory_beliefs",
            )
        return path

    def test_append_only_memory_growth_publishes(self) -> None:
        store = self._bound_store()
        beliefs = self._seed_beliefs(store, 2)
        self.assertTrue(self._publish(store, "snap-1", "cycle-1")["published"])
        append_declared_fixture(
            beliefs, {"schema_version": 1, "belief_id": "b-2"}, expected_surface="memory_beliefs",
        )
        second = self._publish(store, "snap-2", "cycle-2")
        self.assertTrue(second["published"])
        self.assertEqual(second["continuity"]["status"], "ok")
        self.assertEqual(second["continuity"]["memory_rewrites"], [])
        published = json.loads(_git(store.root, "show", "HEAD:snapshot.json"))
        self.assertEqual(published["surfaces"]["memory_beliefs"]["row_count"], 3)

    def test_memory_that_lost_rows_is_refused_by_name_even_with_the_ack(self) -> None:
        store = self._bound_store()
        beliefs = self._seed_beliefs(store, 3)
        self.assertTrue(self._publish(store, "snap-1", "cycle-1")["published"])
        head = _git(store.root, "rev-parse", "HEAD").strip()
        # Exactly what the retired belief compaction did: latest row per id.
        rows = load_declared_jsonl(beliefs, expected_surface="memory_beliefs")
        rewrite_declared_out_of_band(beliefs, rows[-1:], expected_surface="memory_beliefs")

        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}), self.assertRaisesRegex(
            SnapshotError, f"snapshot_{MEMORY_REWRITE_STATUS}:memory_beliefs",
        ):
            self._publish(store, "snap-2", "cycle-2")
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head)

    def test_the_publish_gate_refuses_a_shrunk_snapshot_it_did_not_build(self) -> None:
        """A snapshot that names the tip but was never checked against it
        still meets the publish gate, and no acknowledgment opens it."""
        store = self._bound_store()
        beliefs = self._seed_beliefs(store, 3)
        self.assertTrue(self._publish(store, "snap-1", "cycle-1")["published"])
        tip = read_published_snapshot(store)
        head = _git(store.root, "rev-parse", "HEAD").strip()
        rows = load_declared_jsonl(beliefs, expected_surface="memory_beliefs")
        rewrite_declared_out_of_band(beliefs, rows[:1], expected_surface="memory_beliefs")
        snapshot = build_snapshot(
            snapshot_id="snap-2", cycle_id="cycle-2", lane="test",
            roots=state_store.store_roots(store, REPO_HASH),
        )
        snapshot["prev_snapshot_id"] = tip["snapshot_id"]
        snapshot["prev_manifest_root"] = tip["manifest_root"]
        snapshot["manifest_root"] = compute_manifest_root(snapshot)

        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}), self.assertRaisesRegex(
            StateStoreRefusal, f"state_publish_continuity_{MEMORY_REWRITE_STATUS}",
        ):
            publish_state(
                store, writer_fence=None, snapshot=snapshot, cycle_id="cycle-2", repo_hash=REPO_HASH,
                expected_base_head=head,
            )
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head)


if __name__ == "__main__":
    unittest.main()
