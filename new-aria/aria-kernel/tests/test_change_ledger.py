"""Tests for Plan 019 Phase 7 Change Ledger primitive."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
    find_changes_by_file,
    get_change_chain,
    list_change_chains,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-change-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class EmitChangePlannedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_planned_carries_change_id_and_files_hash(self) -> None:
        row = emit_change_planned(
            plan_id="plan-019-phase-7",
            finding_id="F-003",
            intended_affected_files=["aria-kernel/aria_kernel/change_ledger.py"],
            intended_validation_refs=["nx test aria-kernel"],
            architectural_tier=1,
            base_dir=self.tools,
        )
        self.assertTrue(row["change_id"].startswith("chg_"))
        self.assertIn("intended_files_hash", row)
        self.assertEqual(row["event"], "change_planned")

    def test_idempotent_on_same_inputs(self) -> None:
        first = emit_change_planned(
            plan_id="plan-X",
            finding_id="F-001",
            intended_affected_files=["a.ts", "b.ts"],
            intended_validation_refs=["nx test x"],
            architectural_tier=2,
            base_dir=self.tools,
        )
        second = emit_change_planned(
            plan_id="plan-X",
            finding_id="F-001",
            intended_affected_files=["b.ts", "a.ts"],  # order shuffled — same hash
            intended_validation_refs=["nx test x"],
            architectural_tier=2,
            base_dir=self.tools,
        )
        self.assertEqual(first["change_id"], second["change_id"])
        # Only one event row on disk.
        rows = (self.tools / "change-ledger" / "planned.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(rows), 1)

    def test_invalid_tier_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "architectural_tier"):
            emit_change_planned(
                plan_id="x", finding_id="y",
                intended_affected_files=["a.ts"],
                intended_validation_refs=["x"],
                architectural_tier=99,
                base_dir=self.tools,
            )

    def test_empty_intended_files_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "intended_affected_files"):
            emit_change_planned(
                plan_id="x", finding_id="y",
                intended_affected_files=[],
                intended_validation_refs=["x"],
                architectural_tier=1,
                base_dir=self.tools,
            )

    def test_governance_event_emitted(self) -> None:
        emit_change_planned(
            plan_id="x", finding_id="y",
            intended_affected_files=["a.ts"],
            intended_validation_refs=["x"],
            architectural_tier=1,
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = {json.loads(line).get("kind") for line in gov if line.strip()}
        self.assertIn("change_planned", kinds)


class EmitChangeCommittedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.planned = emit_change_planned(
            plan_id="plan-A", finding_id="F-100",
            intended_affected_files=["src/x.ts"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_committed_requires_planned(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "no change_planned for"):
            emit_change_committed(
                change_id="chg_nonexistent",
                commit_sha="abc123",
                actual_affected_files=["src/x.ts"],
                base_dir=self.tools,
            )

    def test_committed_happy_path(self) -> None:
        row = emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="deadbeef",
            actual_affected_files=["src/x.ts"],
            base_dir=self.tools,
        )
        self.assertEqual(row["event"], "change_committed")
        self.assertEqual(row["commit_sha"], "deadbeef")

    def test_idempotent_on_same_commit_sha(self) -> None:
        first = emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="abc123",
            actual_affected_files=["src/x.ts"],
            base_dir=self.tools,
        )
        second = emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="abc123",
            actual_affected_files=["src/x.ts"],
            base_dir=self.tools,
        )
        self.assertEqual(first["commit_sha"], second["commit_sha"])
        rows = (self.tools / "change-ledger" / "committed.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(rows), 1)

    def test_different_commit_sha_for_same_change_rejected(self) -> None:
        emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="abc123",
            actual_affected_files=["src/x.ts"],
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "chain is immutable"):
            emit_change_committed(
                change_id=self.planned["change_id"],
                commit_sha="zzz999",
                actual_affected_files=["src/x.ts"],
                base_dir=self.tools,
            )


class EmitChangeValidatedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.planned = emit_change_planned(
            plan_id="plan-V", finding_id="F-V",
            intended_affected_files=["src/v.ts"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_validated_requires_committed(self) -> None:
        # Plan 020 Phase 8.B — historical_attestation mode bypasses the
        # validation matrix gate so this test still exercises the
        # sequence-violation guard (its actual subject) without needing
        # structured run refs.
        with self.assertRaisesRegex(GovernanceError, "no change_committed for"):
            emit_change_validated(
                change_id=self.planned["change_id"],
                validation_run_refs=["nx test:run-1"],
                base_dir=self.tools,
                validation_mode="historical_attestation",
            )

    def test_validated_happy_path(self) -> None:
        emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="abc",
            actual_affected_files=["src/v.ts"],
            base_dir=self.tools,
        )
        # historical_attestation: legacy string refs accepted (Plan 019
        # backfill compat). The Plan 020 enforced-mode contract is
        # exercised in test_validation_matrix_gate.py.
        row = emit_change_validated(
            change_id=self.planned["change_id"],
            validation_run_refs=["nx test:run-1", "spine_postcheck:event-id-1"],
            baseline_comparison_ref="sha256:baseline-fingerprint",
            post_remediation_invariants={"tenant_scoping": 5, "schema_entity": 80},
            base_dir=self.tools,
            validation_mode="historical_attestation",
        )
        self.assertEqual(row["event"], "change_validated")
        self.assertEqual(len(row["validation_run_refs"]), 2)
        self.assertEqual(row["post_remediation_invariants"]["schema_entity"], 80)


class QueryAPITests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        # Two planned changes, only one committed.
        self.p1 = emit_change_planned(
            plan_id="plan-A", finding_id="F-1",
            intended_affected_files=["x.ts", "y.ts"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools,
        )
        self.p2 = emit_change_planned(
            plan_id="plan-B", finding_id="F-2",
            intended_affected_files=["z.ts"],
            intended_validation_refs=["nx test"],
            architectural_tier=2,
            base_dir=self.tools,
        )
        emit_change_committed(
            change_id=self.p1["change_id"],
            commit_sha="aaa",
            actual_affected_files=["x.ts", "y.ts"],
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_get_change_chain_returns_blocks(self) -> None:
        chain = get_change_chain(change_id=self.p1["change_id"], base_dir=self.tools)
        self.assertIsNotNone(chain["planned"])
        self.assertIsNotNone(chain["committed"])
        self.assertIsNone(chain["validated"])

    def test_get_change_chain_unknown_returns_all_none(self) -> None:
        chain = get_change_chain(change_id="chg_does_not_exist", base_dir=self.tools)
        self.assertIsNone(chain["planned"])
        self.assertIsNone(chain["committed"])
        self.assertIsNone(chain["validated"])

    def test_list_change_chains_no_filter_returns_all(self) -> None:
        chains = list_change_chains(base_dir=self.tools)
        self.assertEqual(len(chains), 2)

    def test_list_change_chains_plan_filter(self) -> None:
        chains = list_change_chains(plan_id="plan-A", base_dir=self.tools)
        self.assertEqual(len(chains), 1)
        self.assertEqual(chains[0]["planned"]["plan_id"], "plan-A")

    def test_list_change_chains_finding_filter(self) -> None:
        chains = list_change_chains(finding_id="F-2", base_dir=self.tools)
        self.assertEqual(len(chains), 1)
        self.assertEqual(chains[0]["planned"]["finding_id"], "F-2")

    def test_find_changes_by_file_intended(self) -> None:
        chains = find_changes_by_file(file_path="x.ts", base_dir=self.tools)
        self.assertEqual(len(chains), 1)
        self.assertEqual(chains[0]["planned"]["plan_id"], "plan-A")

    def test_find_changes_by_file_committed(self) -> None:
        # actual_affected_files match — even if intended would have missed.
        chains = find_changes_by_file(file_path="y.ts", base_dir=self.tools)
        self.assertEqual(len(chains), 1)


if __name__ == "__main__":
    unittest.main()
