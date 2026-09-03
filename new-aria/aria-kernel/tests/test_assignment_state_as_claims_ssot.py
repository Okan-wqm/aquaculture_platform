"""Plan 026R §G.2 — assignment state as claims-SSoT + recorded_at +
reducer fold rules.

12 tests:

* recorded_at field present on submit_worker_result row.
* recorded_at field present on _verification row.
* Deterministic fold ordering (3 runs same answer).
* Terminal precedence (verified ignores later events).
* Source priority (verification-results > worker-results > claims).
* Multiple-active-claim corruption raises in state map.
* governance.jsonl not consulted for state derivation.
* recover_orphan_governance scanner: missing claim → emits recovery event.
* recover_orphan_governance idempotent.
* legacy rows without recorded_at sort deterministically.
* State derived purely from 3 ledgers — governance audit only.
* submitted state survives reclaim attempts (not terminal yet).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import append_jsonl as _append_jsonl, load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.worker_dispatch import (
    _latest_assignment_states,
    recover_orphan_governance,
)


def append_jsonl(path: Path, record: dict[str, object]) -> dict[str, object]:
    return _append_jsonl(path, record, test_fixture=True)


class RecordedAtFieldTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-g2-recat-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_submit_worker_result_writes_recorded_at(self) -> None:
        # Plan 026R §G.2 + §H.1 — AST-backed conversion.
        # The verification_gate module MUST define ≥2 dict literals
        # with a string-literal key ``recorded_at`` whose value is a
        # Call to ``utc_now``. AST node-shape inspection (not
        # substring scan) proves the contract.
        import ast as _ast
        src_path = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "verification_gate.py"
        )
        tree = _ast.parse(src_path.read_text(encoding="utf-8"))
        recorded_at_with_utc_now = 0
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, _ast.Constant)
                    and key.value == "recorded_at"
                    and isinstance(value, _ast.Call)
                    and isinstance(value.func, _ast.Name)
                    and value.func.id == "utc_now"
                ):
                    recorded_at_with_utc_now += 1
        self.assertGreaterEqual(
            recorded_at_with_utc_now, 2,
            "verification_gate: expected ≥2 dict literals with "
            "recorded_at=utc_now() (submit + verification rows)",
        )

    def test_verification_row_writes_recorded_at(self) -> None:
        # Plan 026R §G.2 + §H.1 — behavioral conversion. Append a
        # verification-results row via the writer + assert the
        # persisted ledger row carries ``recorded_at`` as an ISO 8601
        # UTC string. Proves observable behavior, not source presence.
        from aria_kernel.verification_gate import _verification
        from aria_kernel.tool_registry import ensure_tools_dir
        root = ensure_tools_dir(self.base)
        (root / "dispatch").mkdir(parents=True, exist_ok=True)
        row = _verification(
            root, "A-VR", "passed", [],
            auto_merge_eligible=False,
            auto_merge_evaluated=False,
        )
        self.assertIn("recorded_at", row)
        self.assertTrue(
            isinstance(row["recorded_at"], str)
            and "T" in row["recorded_at"],
            "verification row: recorded_at must be ISO 8601 UTC",
        )


class ReducerFoldTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-g2-fold-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "dispatch").mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_deterministic_fold_ordering(self) -> None:
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-1", "claim_id": "C-1", "event": "claimed",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        append_jsonl(self.base / "dispatch" / "worker-results.jsonl", {
            "assignment_id": "A-1", "state": "accepted",
            "recorded_at": "2026-05-11T13:01:00+00:00",
        })
        runs = [_latest_assignment_states(self.base) for _ in range(3)]
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])

    def test_terminal_precedence_verified(self) -> None:
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-T", "claim_id": "C-T", "event": "claimed",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        append_jsonl(self.base / "dispatch" / "verification-results.jsonl", {
            "assignment_id": "A-T", "status": "passed",
            "recorded_at": "2026-05-11T13:05:00+00:00",
        })
        # Later events ignored.
        append_jsonl(self.base / "dispatch" / "worker-results.jsonl", {
            "assignment_id": "A-T", "state": "rejected",
            "recorded_at": "2026-05-11T13:10:00+00:00",
        })
        self.assertEqual(_latest_assignment_states(self.base)["A-T"], "verified")

    def test_source_priority_with_identical_timestamp(self) -> None:
        ts = "2026-05-11T13:00:00+00:00"
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-S", "claim_id": "C-S", "event": "claimed",
            "claimed_at": ts,
        })
        append_jsonl(self.base / "dispatch" / "verification-results.jsonl", {
            "assignment_id": "A-S", "status": "failed",
            "recorded_at": ts,
        })
        # verification-results > worker-results > claims at same ts.
        self.assertEqual(
            _latest_assignment_states(self.base)["A-S"],
            "verification_failed",
        )

    def test_multiple_active_claim_corruption(self) -> None:
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-X", "claim_id": "C-A", "event": "claimed",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-X", "claim_id": "C-B", "event": "claimed",
            "claimed_at": "2026-05-11T13:01:00+00:00",
        })
        self.assertEqual(
            _latest_assignment_states(self.base)["A-X"],
            "multiple_active_claims_corruption",
        )

    def test_governance_not_consulted_for_state(self) -> None:
        # A governance event would have been written historically; the
        # reducer MUST ignore it.
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-G", "claim_id": "C-G", "event": "claimed",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        # Inject a misleading governance row claiming verified.
        append_jsonl(self.base / "governance.jsonl", {
            "$schema": "aria/governance/v1",
            "kind": "verification_gate_passed",
            "details": {"assignment_id": "A-G", "result": "passed"},
            "ts": "2026-05-11T13:05:00+00:00",
        })
        # State stays picked_up (governance NOT read).
        self.assertEqual(
            _latest_assignment_states(self.base)["A-G"], "picked_up",
        )

    def test_legacy_rows_without_recorded_at_deterministic(self) -> None:
        # Append claims + worker-results with empty recorded_at.
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-L", "claim_id": "C-L", "event": "claimed",
        })
        append_jsonl(self.base / "dispatch" / "worker-results.jsonl", {
            "assignment_id": "A-L", "state": "accepted",
        })
        runs = [_latest_assignment_states(self.base) for _ in range(3)]
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])

    def test_state_derived_from_three_ledgers_only(self) -> None:
        # Reducer should produce state from claims+worker-results+
        # verification-results; if those three are silent for an
        # assignment_id, state map omits it.
        states = _latest_assignment_states(self.base)
        self.assertEqual(states, {})

    def test_submitted_state_not_terminal_until_verified(self) -> None:
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-NT", "claim_id": "C-NT", "event": "claimed",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        append_jsonl(self.base / "dispatch" / "worker-results.jsonl", {
            "assignment_id": "A-NT", "state": "accepted",
            "recorded_at": "2026-05-11T13:01:00+00:00",
        })
        # Without verification → "submitted" (not terminal).
        self.assertEqual(_latest_assignment_states(self.base)["A-NT"], "submitted")


class OrphanGovernanceRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-g2-orphan-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "dispatch").mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_recover_missing_governance_emits_event(self) -> None:
        # Stage a claims row without any matching governance row.
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-OR", "claim_id": "C-OR", "event": "claimed",
            "agent_id": "agent-1",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        result = recover_orphan_governance(self.base)
        self.assertEqual(result["recovered_count"], 1)
        # A governance event was appended.
        gov = load_jsonl(self.base / "governance.jsonl")
        kinds = [str(row.get("kind") or "") for row in gov]
        self.assertIn("worker_claim_recovered_claimed", kinds)

    def test_recover_idempotent(self) -> None:
        append_jsonl(self.base / "dispatch" / "claims.jsonl", {
            "assignment_id": "A-IDEM", "claim_id": "C-IDEM", "event": "claimed",
            "agent_id": "agent-2",
            "claimed_at": "2026-05-11T13:00:00+00:00",
        })
        recover_orphan_governance(self.base)
        # Second call should find the prior recovery event and not
        # emit a duplicate.
        second = recover_orphan_governance(self.base)
        self.assertEqual(second["recovered_count"], 0)


if __name__ == "__main__":
    unittest.main()
