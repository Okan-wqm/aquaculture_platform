"""Plan 024 v3 followup §E (ORPHAN-LOW-057) — end-to-end invariant
test for the cycles.jsonl status field.

This test asserts the COMPOSITE architectural invariant:

  After routing cycles.jsonl rows through upcast_cycle_rows, EVERY
  row carries a status field in the closed set {started, completed,
  failed, stopped, aborted}.

The invariant holds for two distinct row populations:

  1. Rows written by the current cycle.py writer (whatever its
     vintage). The integration test drives run_cycle through a
     temp-dir fixture, then reads the resulting cycles.jsonl.

  2. Legacy rows persisted before the schema bump (schema_version=2,
     no status). The test writes a synthetic legacy row and asserts
     that upcast_cycle_rows derives the status from event.

Crucially, the test also asserts that the upcaster is READ-ONLY: the
on-disk cycles.jsonl byte stream is identical before and after the
upcast call. Mutating the on-disk file would break the
aria-tools/integrity_index.json hash chain (ADR-equivalent — see the
upcaster module docstring).
"""
from __future__ import annotations

import hashlib
import base64
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import register_tool, run_cycle
from aria_kernel.ledger import append_jsonl, load_jsonl
from aria_kernel.upcasters import upcast_cycle_rows

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


# Closed set of valid statuses (mirrors the upcaster's mapping). A
# divergence here means either the upcaster or the writer added a new
# status — at which point the invariant test must be updated in lock
# step with the schema doc.
VALID_CYCLE_STATUSES: frozenset[str] = frozenset(
    {"started", "completed", "failed", "stopped", "aborted"},
)


def _fake_tool_argv(output: dict[str, object]) -> list[str]:
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]


def _fixture_tool() -> dict[str, object]:
    """Minimal SHADOW tool definition used by the integration test.
    Mirrors the shape used in test_enterprise_cycle.py."""
    return {
        "tool_id": "fixture-upcast-tool",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/fixture-upcast-tool",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": ["src/**/*.ts"],
        "forbidden_read_globs": [],
        "claim_types": ["fixture"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": _fake_tool_argv({
                "observations": [{"id": "obs-1", "type": "fixture"}],
                "findings": [],
                "read_paths": ["src/app.ts"],
                "evidence_sources": ["src/app.ts"],
                "cost_units": 1,
                "metadata": {"fixture": True},
            }),
            "cwd": ".",
            "timeout_ms": 5000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


class CycleLifecycleInvariantTests(unittest.TestCase):
    """Drive run_cycle end-to-end and assert every cycles.jsonl row
    carries a status field after the upcaster."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "src").mkdir()
        (self.root / "src/app.ts").write_text(
            "export const app = true;\n", encoding="utf-8",
        )
        (self.root / "package.json").write_text(
            '{"name":"fixture"}\n', encoding="utf-8",
        )
        (self.root / "nx.json").write_text(
            '{"affected":{}}\n', encoding="utf-8",
        )
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_cycle_lifecycle_invariant_every_row_has_status(self) -> None:
        # Drive a real cycle through run_cycle. After the cycle the
        # cycles.jsonl ledger has at minimum a 'started' and a
        # 'completed' row for cycle-upcast-invariant.
        register_tool(_fixture_tool(), base_dir=self.tools_dir)
        result = run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-upcast-invariant",
            base_dir=self.tools_dir,
            shadow_only=True,
        )
        self.assertEqual(result["status"], "completed")

        # Read the ledger; route every row through the upcaster.
        cycles_path = self.tools_dir / "cycles.jsonl"
        self.assertTrue(cycles_path.exists())
        raw_rows = load_jsonl(cycles_path)

        # Filter to just the rows for this cycle. The integration test
        # is robust to whatever else the workspace has accumulated.
        cycle_rows = [r for r in raw_rows if r.get("cycle_id") == "cycle-upcast-invariant"]
        # Must have at least started + completed.
        self.assertGreaterEqual(len(cycle_rows), 2)

        upcast_rows = upcast_cycle_rows(cycle_rows)
        for row in upcast_rows:
            with self.subTest(cycle_id=row.get("cycle_id"), event=row.get("event")):
                self.assertIn("status", row)
                self.assertIn(row["status"], VALID_CYCLE_STATUSES)

        # And the lifecycle pair must include both the start and a
        # terminal state — the invariant is end-to-end.
        statuses_seen = {r["status"] for r in upcast_rows}
        self.assertIn("started", statuses_seen)
        # 'completed' / 'failed' / 'stopped' / 'aborted' are all valid
        # terminal states for a single cycle; assert at least one
        # appears.
        terminals = statuses_seen & {"completed", "failed", "stopped", "aborted"}
        self.assertTrue(terminals, f"no terminal status in {statuses_seen}")


class LegacyRowsViaUpcasterTests(unittest.TestCase):
    """Synthetic legacy v2 rows must upcast to the v3 shape via the
    helper, without any disk mutation."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        self.tools_dir.mkdir()
        self.cycles_path = self.tools_dir / "cycles.jsonl"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_legacy_v2_rows_upcast_to_v3_shape_via_helper(self) -> None:
        # Write 4 synthetic v2 rows mirroring real-world legacy
        # cycles.jsonl entries (started + completed pairs for two
        # cycles). The rows omit status — that is exactly the legacy
        # shape that motivated the upcaster.
        legacy_rows: list[dict[str, object]] = [
            {
                "schema_version": 2,
                "at": "2026-05-06T05:22:59+00:00",
                "cycle_id": "legacy-cycle-1",
                "event": "started",
            },
            {
                "schema_version": 2,
                "at": "2026-05-06T05:24:47+00:00",
                "cycle_id": "legacy-cycle-1",
                "event": "completed",
                "tool_decision_count": 5,
                "tool_governance_decision_count": 5,
            },
            {
                "schema_version": 2,
                "at": "2026-05-06T05:25:09+00:00",
                "cycle_id": "legacy-cycle-2",
                "event": "started",
            },
            {
                "schema_version": 2,
                "at": "2026-05-06T05:26:53+00:00",
                "cycle_id": "legacy-cycle-2",
                "event": "completed",
                "tool_decision_count": 5,
                "tool_governance_decision_count": 5,
            },
        ]
        for row in legacy_rows:
            append_jsonl(self.cycles_path, row, test_fixture=True)

        rows_on_disk = load_jsonl(self.cycles_path)
        self.assertEqual(len(rows_on_disk), 4)
        # Pre-upcast: NO row has status.
        for row in rows_on_disk:
            self.assertNotIn("status", row)

        upcast = upcast_cycle_rows(rows_on_disk)
        # Post-upcast: EVERY row has a valid status.
        self.assertEqual(len(upcast), 4)
        for row in upcast:
            self.assertIn("status", row)
            self.assertIn(row["status"], VALID_CYCLE_STATUSES)

        # And the derived statuses match the events.
        cycle1_started = next(
            r for r in upcast
            if r["cycle_id"] == "legacy-cycle-1" and r["event"] == "started"
        )
        cycle1_completed = next(
            r for r in upcast
            if r["cycle_id"] == "legacy-cycle-1" and r["event"] == "completed"
        )
        self.assertEqual(cycle1_started["status"], "started")
        self.assertEqual(cycle1_completed["status"], "completed")

    def test_legacy_rows_not_modified_on_disk(self) -> None:
        # Write 3 synthetic v2 rows; capture the byte-level disk hash
        # before AND after the upcaster runs. The two hashes must be
        # identical — mutating the on-disk file would break the
        # aria-tools/integrity_index.json ledger-hash chain.
        for row in [
            {
                "schema_version": 2,
                "at": "2026-05-06T05:22:59+00:00",
                "cycle_id": "legacy-immutable-1",
                "event": "started",
            },
            {
                "schema_version": 2,
                "at": "2026-05-06T05:24:47+00:00",
                "cycle_id": "legacy-immutable-1",
                "event": "completed",
                "tool_decision_count": 1,
            },
            {
                "schema_version": 2,
                "at": "2026-05-06T05:25:09+00:00",
                "cycle_id": "legacy-immutable-2",
                "event": "stopped",
            },
        ]:
            append_jsonl(self.cycles_path, row, test_fixture=True)

        sha_before = hashlib.sha256(self.cycles_path.read_bytes()).hexdigest()

        # Read + upcast. We deliberately do this twice to also catch
        # any caching layer that might write back on a second read.
        for _ in range(2):
            rows = load_jsonl(self.cycles_path)
            upcast = upcast_cycle_rows(rows)
            self.assertEqual(len(upcast), 3)

        sha_after = hashlib.sha256(self.cycles_path.read_bytes()).hexdigest()
        self.assertEqual(
            sha_before, sha_after,
            "upcast_cycle_rows mutated cycles.jsonl on disk; ledger-hash "
            "chain in aria-tools/integrity_index.json would break.",
        )

    def test_legacy_row_input_dict_immutable_after_bulk_call(self) -> None:
        # Tighter version of the same invariant at the in-memory level:
        # the row dict the caller passes in must NOT gain a status key
        # as a side effect of the bulk call.
        original = {
            "schema_version": 2,
            "cycle_id": "legacy-input-immutable",
            "event": "completed",
        }
        snapshot = dict(original)
        upcast_cycle_rows([original])
        self.assertEqual(original, snapshot)
        self.assertNotIn("status", original)


class RealLegacyLedgerSpotCheckTests(unittest.TestCase):
    """Sanity-check the actual legacy aria-tools/cycles.jsonl ledger.

    This is a live spot check — the test only runs if the legacy
    ledger is present at the canonical location (worktree root).
    Skipping silently is fine when running outside a worktree."""

    def test_legacy_ledger_upcast_yields_status_for_every_row(self) -> None:
        legacy_path = (
            Path(__file__).resolve().parent.parent.parent
            / "aria-tools" / "cycles.jsonl"
        )
        if not legacy_path.exists():
            self.skipTest(f"legacy ledger not present at {legacy_path}")

        # Capture byte-stream hash before; assert no mutation after.
        sha_before = hashlib.sha256(legacy_path.read_bytes()).hexdigest()

        rows = load_jsonl(legacy_path)
        # Plan ARIA-V2 Phase 1 gitignored aria-tools/cycles.jsonl so
        # fresh CI checkouts no longer carry the historical legacy
        # rows. Tests that import modules calling ensure_tools_dir()
        # at default base_dir touch the file empty during discovery,
        # so the file exists but has zero rows. Empty-but-present is
        # semantically the same as absent for this live spot-check —
        # no rows means no upcast to validate. Tier-3: extend the
        # skip semantic that already governs the absent case.
        if not rows:
            self.skipTest(
                f"legacy ledger at {legacy_path} is empty; nothing to "
                "spot-check (Plan ARIA-V2 Phase 1 gitignored the "
                "historical ledger; CI fresh checkouts touch the file "
                "empty during test discovery)."
            )
        upcast = upcast_cycle_rows(rows)
        self.assertEqual(len(upcast), len(rows))

        for row in upcast:
            with self.subTest(
                cycle_id=row.get("cycle_id"),
                event=row.get("event"),
                schema_version=row.get("schema_version"),
            ):
                self.assertIn("status", row)
                self.assertIn(row["status"], VALID_CYCLE_STATUSES)

        sha_after = hashlib.sha256(legacy_path.read_bytes()).hexdigest()
        self.assertEqual(
            sha_before, sha_after,
            "upcaster mutated the live legacy ledger on disk.",
        )


if __name__ == "__main__":
    unittest.main()
