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

ARIA-MEDIUM-172 — a deterministic refusal ends the retries by name:

* a sealed judge envelope the judge bridge refuses (verdict outside the
  vocabulary) drains to ``permanent_fail@1`` with
  ``terminal_reason="refused"`` through the REAL default invoker, and a
  second drain never re-invokes it;
* a transient failure still schedules ``pending_retry``;
* a row whose budget is already spent (the knob was lowered, or an older
  loop's selector stranded it) is terminalized
  ``retry_budget_exhausted`` WITHOUT invoking the bridge;
* ``permanent_fail`` rows carry a terminal reason from a closed
  vocabulary, validated at the write boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.bridge_status_ledger import (
    BridgeOutcome,
    append_bridge_status,
    derive_bridge_state,
    latest_bridge_status_for,
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
        output_path: str | None = None,
        output_hash: str | None = None,
        ordinal: int | None = None,
    ) -> dict:
        self._counter += 1
        n = ordinal if ordinal is not None else self._counter
        row = {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "row_type": "result",
            "claim_id": f"claim-{n}",
            "request_id": f"req-{n}",
            "agent_id": "agent-x",
            "role": role,
            "status": status,
            "output_path": output_path if output_path is not None else str(self.tmp / f"out-{n}.json"),
            "envelope_evidence_hash": "sha256:" + f"{n:064d}",
            "bridge_status": bridge_status,
        }
        if output_hash is not None:
            row["output_hash"] = output_hash
        return append_declared_fixture(
            self.base / "agent-invocations" / "results.jsonl",
            row,
            expected_surface="agent_invocation_results",
        )

    def _seed_refused_judge_row(self, *, ordinal: int = 1) -> dict:
        """An accepted judge row whose sealed envelope the judge bridge
        refuses deterministically (a verdict outside the vocabulary), with a
        real request row so the drain drives the REAL default invoker."""
        envelope = {
            "request_id": f"req-{ordinal}",
            "claim_id": f"claim-{ordinal}",
            "agent_id": "aria-evidence-judge",
            "role": "evidence_judgment",
            "status": "submitted",
            "details": {"verdict": {"verdict": "maybe", "confidence": 0.9,
                                    "judge_id": "aria-evidence-judge"}},
        }
        content = json.dumps(envelope).encode("utf-8")
        digest = "sha256:" + hashlib.sha256(content).hexdigest()
        from aria_kernel.agent_invocations import _submission_artifact_target

        seal = _submission_artifact_target(self.base, artifact_kind="responses", content_hash=digest)
        seal.parent.mkdir(parents=True, exist_ok=True)
        seal.write_bytes(content)
        append_declared_fixture(
            self.base / "agent-invocations" / "requests.jsonl",
            {
                "request_id": f"req-{ordinal}",
                "claim_id": f"claim-{ordinal}",
                "role": "evidence_judgment",
                "tool_id": "tool-a",
                "run_id": "run-1",
                "finding_id": "F-001",
                "judgment_group_id": "judge:tool-a:fp1",
            },
            expected_surface="agent_invocation_requests",
        )
        return self._seed_result(
            output_path=seal.relative_to(self.base).as_posix(),
            output_hash=digest,
            ordinal=ordinal,
        )

    def test_crash_recovery_row_replays_to_ok_at_attempt_one(self) -> None:
        row = self._seed_result()
        calls: list[str] = []

        def invoker(result_row: dict, root: Path) -> BridgeOutcome:
            calls.append(result_row["claim_id"])
            return BridgeOutcome()

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
            bridge_invoker=lambda r, root: BridgeOutcome(errors=("judge_bridge: boom",)),
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
            bridge_invoker=lambda r, root: BridgeOutcome(errors=("supporting_bridge: still broken",)),
        )
        self.assertEqual(summary["permanent_fail"], 1)
        self.assertEqual(summary["retry_scheduled"], 0)
        # permanent_fail is terminal — it must LEAVE pending_after.
        self.assertEqual(summary["pending_after"], 0)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "permanent_fail")
        self.assertEqual(state["attempt_number"], 3)
        latest = latest_bridge_status_for(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
        )
        self.assertEqual(latest.get("terminal_reason"), "retry_budget_exhausted")

    def test_a_contract_refused_row_drains_to_permanent_fail_by_name(self) -> None:
        """ARIA-MEDIUM-172 red — the whole real path: the drain invokes the
        real bridges over the sealed envelope, the judge bridge refuses the
        verdict (outside the vocabulary), and the lane must END by name at
        the first attempt instead of spending the retry budget. Before the
        fix this wrote pending_retry@1 and re-invoked the refused envelope
        on every later drain (the live state's 13 permanent_fail@3 rows each
        cost two useless replays)."""
        from aria_kernel.bridge_status_ledger import BRIDGE_LEDGER_FILENAME
        from aria_kernel.ledger import load_jsonl

        row = self._seed_refused_judge_row()
        first = replay_pending_bridges(base_dir=self.base)
        self.assertEqual(first["permanent_fail"], 1)
        self.assertEqual(first["retry_scheduled"], 0)
        self.assertEqual(first["pending_after"], 0)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual((state["state"], state["attempt_number"]), ("permanent_fail", 1))
        latest = latest_bridge_status_for(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
        )
        self.assertEqual(latest.get("terminal_reason"), "refused")
        self.assertIn("judge bridge", str(latest.get("error_detail")))
        # A refusal is terminal: the second drain must not re-invoke it —
        # exactly one bridge-status row exists for the pair after both.
        second = replay_pending_bridges(base_dir=self.base)
        self.assertEqual((second["iterations"], second["permanent_fail"]), (0, 0))
        pair_rows = [
            r for r in load_jsonl(self.base / "agent-invocations" / BRIDGE_LEDGER_FILENAME)
            if r.get("result_row_ledger_hash") == row["ledger_hash"]
        ]
        self.assertEqual(len(pair_rows), 1)

    def test_a_transient_row_still_schedules_its_retry(self) -> None:
        # The other half of the classification: a transient fault keeps the
        # budget (the request ledger is missing — the row cannot even reach
        # the bridges), so it is pending_retry, never a refusal.
        row = self._seed_result()
        summary = replay_pending_bridges(base_dir=self.base)
        self.assertEqual(summary["retry_scheduled"], 1)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual((state["state"], state["attempt_number"]), ("pending_retry", 1))
        latest = latest_bridge_status_for(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
        )
        self.assertIsNone(latest.get("terminal_reason"))
        self.assertIn("replay_request_missing", str(latest.get("error_detail")))

    def test_a_budget_spent_row_is_terminalized_without_invoking(self) -> None:
        """ARIA-MEDIUM-172 (A1) — the selector no longer owns the budget. A
        pending_retry row whose attempt already meets a LOWERED knob used to
        be silently stranded (skipped by the selector, invisible in
        pending_after, no terminal row); the loop terminalizes it by name
        without spending an invocation."""
        row = self._seed_result()
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
            role=row["role"],
            transition="pending_retry",
            attempt_number=2,
            error_detail="judge_bridge: lock contention",
        )
        calls: list[str] = []
        with mock.patch.dict(os.environ, {"ARIA_BRIDGE_MAX_RETRIES": "2"}):
            summary = replay_pending_bridges(
                base_dir=self.base,
                bridge_invoker=lambda r, root: calls.append(r["claim_id"]) or BridgeOutcome(),
            )
        self.assertEqual(calls, [])
        self.assertEqual(summary["permanent_fail"], 1)
        self.assertEqual(summary["pending_after"], 0)
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual((state["state"], state["attempt_number"]), ("permanent_fail", 2))
        latest = latest_bridge_status_for(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
        )
        self.assertEqual(latest.get("terminal_reason"), "retry_budget_exhausted")
        self.assertIn("judge_bridge: lock contention", str(latest.get("error_detail")))

    def test_a_mixed_refused_and_transient_outcome_keeps_the_retry(self) -> None:
        # Not every error deterministic -> the row is not refused; the budget
        # still owns it, and both strings ride the error_detail.
        row = self._seed_result()
        summary = replay_pending_bridges(
            base_dir=self.base,
            bridge_invoker=lambda r, root: BridgeOutcome(
                errors=("judge_bridge: verdict vocabulary", "plan_convergence_bridge: store busy"),
                refused=("judge_bridge: verdict vocabulary",),
            ),
        )
        self.assertEqual((summary["retry_scheduled"], summary["permanent_fail"]), (1, 0))
        latest = latest_bridge_status_for(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
        )
        self.assertIn("verdict vocabulary", str(latest.get("error_detail")))
        self.assertIn("store busy", str(latest.get("error_detail")))

    def test_permanent_fail_rows_carry_a_terminal_reason_from_a_closed_vocabulary(self) -> None:
        row = self._seed_result()
        for kwargs in (
            {"transition": "permanent_fail", "attempt_number": 1},
            {"transition": "permanent_fail", "attempt_number": 1, "terminal_reason": "mood"},
            {"transition": "pending_retry", "attempt_number": 1, "terminal_reason": "refused"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(GovernanceError, "terminal_reason"):
                append_bridge_status(
                    base_dir=self.base,
                    result_row_ledger_hash=row["ledger_hash"],
                    envelope_evidence_hash=row["envelope_evidence_hash"],
                    role=row["role"],
                    **kwargs,
                )
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
            role=row["role"],
            transition="permanent_fail",
            attempt_number=1,
            error_detail="judge_bridge: refused once",
            terminal_reason="refused",
        )

    def test_max_iterations_bounds_the_loop(self) -> None:
        for _ in range(3):
            self._seed_result()
        summary = replay_pending_bridges(
            base_dir=self.base,
            max_iterations=1,
            bridge_invoker=lambda r, root: BridgeOutcome(),
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
            bridge_invoker=lambda r, root: calls.append(r["claim_id"]) or BridgeOutcome(),
        )
        self.assertEqual(calls, [])
        self.assertEqual(summary["iterations"], 0)
        self.assertEqual(summary["pending_after"], 0)

    def test_return_shape_is_the_orchestrator_contract(self) -> None:
        summary = replay_pending_bridges(base_dir=self.base, bridge_invoker=lambda r, root: BridgeOutcome())
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
