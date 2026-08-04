"""Wave 0 PR 0.1 — ``replay_pending_bridges``, the §C.5 retry primitive.

Pre-W0 the orchestrator's ``_default_bridge_drainer`` looked up
``bridge_status_ledger.replay_pending_bridges`` by name and found
nothing: ``status="skipped"`` every cycle, so every strict/autonomous
run exited ``bridge_replay_required`` unconditionally — a consumer
wired to a function that was never written (the ORPHAN-CRITICAL-498
defect class on the bridge lane).

Coverage:

* crash-recovery ``pending`` row (attempt 0) replays → ``ok`` at attempt 1;
* invoker failure with budget left → ``pending_retry`` attempt+1,
  counted in ``retry_scheduled`` AND still in ``pending_after``;
* budget exhaustion → ``permanent_fail``, leaves ``pending_after``;
* ``max_iterations`` bounds the loop; leftovers stay in ``pending_after``;
* rows that are not accepted / not bridge-required / already ``ok`` are
  untouched;
* the return shape is exactly the orchestrator's consumer contract;
* a structural ledger failure returns ``status="failed"`` instead of
  raising (the orchestrator loop must stay in control);
* ``_default_bridge_drainer`` resolves the primitive (wiring, not mock);
* the default invoker reports a missing request as a bridge error.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.bridge_status_ledger import (
    append_bridge_status,
    derive_bridge_state,
    replay_pending_bridges,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


CONTRACT_KEYS = {
    "status",
    "iterations",
    "replayed_ok",
    "retry_scheduled",
    "permanent_fail",
    "pending_after",
}


class ReplayPendingBridgesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-w0-replay-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self._counter = 0

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_result(
        self,
        *,
        role: str = "evidence_judgment",
        status: str = "accepted",
        bridge_status: str = "pending",
    ) -> dict:
        self._counter += 1
        row = {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "row_type": "result",
            "claim_id": f"claim-{self._counter}",
            "request_id": f"req-{self._counter}",
            "agent_id": "agent-x",
            "role": role,
            "status": status,
            "output_path": str(self.tmp / f"out-{self._counter}.json"),
            "envelope_evidence_hash": "sha256:" + f"{self._counter:064d}",
            "bridge_status": bridge_status,
        }
        return append_declared_fixture(
            self.base / "agent-invocations" / "results.jsonl",
            row,
            expected_surface="agent_invocation_results",
        )

    def test_crash_recovery_row_replays_to_ok_at_attempt_one(self) -> None:
        row = self._seed_result()
        calls: list[str] = []

        def invoker(result_row: dict, root: Path) -> list[str]:
            calls.append(result_row["claim_id"])
            return []

        summary = replay_pending_bridges(base_dir=self.base, bridge_invoker=invoker)
        self.assertEqual(calls, [row["claim_id"]])
        self.assertEqual(summary["status"], "ok")
        self.assertEqual(summary["replayed_ok"], 1)
        self.assertEqual(summary["pending_after"], 0)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "ok")
        self.assertEqual(state["attempt_number"], 1)

    def test_invoker_failure_with_budget_schedules_retry(self) -> None:
        row = self._seed_result()
        summary = replay_pending_bridges(
            base_dir=self.base,
            bridge_invoker=lambda r, root: ["judge_bridge: boom"],
        )
        self.assertEqual(summary["retry_scheduled"], 1)
        self.assertEqual(summary["replayed_ok"], 0)
        # A retry-scheduled row is unresolved work: it MUST stay visible
        # in pending_after so strict/autonomous profiles do not advance
        # past unfinished bridges.
        self.assertEqual(summary["pending_after"], 1)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "pending_retry")
        self.assertEqual(state["attempt_number"], 1)

    def test_budget_exhaustion_marks_permanent_fail(self) -> None:
        row = self._seed_result()
        # Attempts 1 and 2 already spent (ARIA_BRIDGE_MAX_RETRIES default 3).
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
            role=row["role"],
            transition="pending_retry",
            attempt_number=2,
        )
        summary = replay_pending_bridges(
            base_dir=self.base,
            bridge_invoker=lambda r, root: ["supporting_bridge: still broken"],
        )
        self.assertEqual(summary["permanent_fail"], 1)
        self.assertEqual(summary["retry_scheduled"], 0)
        # permanent_fail is terminal — it must LEAVE pending_after.
        self.assertEqual(summary["pending_after"], 0)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "permanent_fail")
        self.assertEqual(state["attempt_number"], 3)

    def test_max_iterations_bounds_the_loop(self) -> None:
        for _ in range(3):
            self._seed_result()
        summary = replay_pending_bridges(
            base_dir=self.base,
            max_iterations=1,
            bridge_invoker=lambda r, root: [],
        )
        self.assertEqual(summary["iterations"], 1)
        self.assertEqual(summary["replayed_ok"], 1)
        self.assertEqual(summary["pending_after"], 2)

    def test_non_replayable_rows_are_untouched(self) -> None:
        self._seed_result(status="rejected")
        self._seed_result(role="maintenance_utility", bridge_status="not_required")
        done = self._seed_result()
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=done["ledger_hash"],
            envelope_evidence_hash=done["envelope_evidence_hash"],
            role=done["role"],
            transition="ok",
            attempt_number=1,
        )
        calls: list[str] = []
        summary = replay_pending_bridges(
            base_dir=self.base,
            bridge_invoker=lambda r, root: calls.append(r["claim_id"]) or [],
        )
        self.assertEqual(calls, [])
        self.assertEqual(summary["iterations"], 0)
        self.assertEqual(summary["pending_after"], 0)

    def test_return_shape_is_the_orchestrator_contract(self) -> None:
        summary = replay_pending_bridges(base_dir=self.base, bridge_invoker=lambda r, root: [])
        self.assertEqual(set(summary), CONTRACT_KEYS)
        self.assertEqual(summary["status"], "ok")

    def test_structural_ledger_failure_returns_failed_not_raise(self) -> None:
        with mock.patch(
            "aria_kernel.bridge_status_ledger.load_declared_jsonl",
            side_effect=GovernanceError("results_chain_broken"),
        ):
            summary = replay_pending_bridges(base_dir=self.base)
        self.assertEqual(summary["status"], "failed")
        self.assertIn("results_ledger_unreadable", summary["reason"])
        self.assertEqual(summary["pending_after"], 0)

    def test_default_invoker_reports_missing_request(self) -> None:
        row = self._seed_result()
        summary = replay_pending_bridges(base_dir=self.base)
        self.assertEqual(summary["retry_scheduled"], 1)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "pending_retry")
        from aria_kernel.ledger import load_jsonl

        ledger_rows = load_jsonl(
            self.base / "agent-invocations" / "agent-result-bridge-status.jsonl",
        )
        self.assertIn("replay_request_missing", str(ledger_rows[-1].get("error_detail")))


class BridgeDrainerWiringTests(unittest.TestCase):
    """The orchestrator's drainer must resolve the real primitive —
    ``status="skipped"`` was the pre-W0 unconditional-halt defect."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-w0-drainer-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_bridge_drainer_resolves_replay_primitive(self) -> None:
        from aria_kernel.autonomy_orchestrator import _default_bridge_drainer

        result = _default_bridge_drainer(base_dir=self.base, max_iterations=5)
        self.assertNotEqual(result.get("status"), "skipped")
        self.assertEqual(result.get("status"), "ok")
        self.assertEqual(set(result), CONTRACT_KEYS)


if __name__ == "__main__":
    unittest.main()
