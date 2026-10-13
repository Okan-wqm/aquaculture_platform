"""A machine approval's plan, not its action, says who owns the next step (ARIA-HIGH-412).

Production shape (aria/state 2026-10-10): ten approved proposals, all machine
approvals; eight of their apply actions sat in ``staged_for_implementation``
for days because their plans had already ended — HUMAN_REQUIRED after three
refused deliveries (two plans x three stagings), HUMAN_REQUIRED by the
operator, and REJECTED by the orphan reaper with no PR. The pr_lifecycle phase
reported them as in-flight forever, and any of them leaving
``staged_for_implementation`` without a PR (a ``blocked`` gate, a host-stage
refusal after ``ready_for_pr``) would have been previewed on a runner without
the executor's branch and failed the night.

These tests drive the plan through the real ``plan_convergence`` transitions
(``production_converged_plan``, ``force_plan_human_required``,
``request_implementation``) rather than stamping a state into a fold.
"""
from __future__ import annotations

import inspect
import os
import re
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import plan_convergence
from aria_kernel.cycle import (
    CYCLE_PHASES,
    _payload_failed_phases,
    _run_pr_lifecycle_phase,
    _runtime_status,
    build_phase_context,
)
from aria_kernel.pr_lifecycle_items import (
    EXECUTOR_OWNED_PLAN_STATES,
    SETTLED_PLAN_STATES,
    classify_pr_lifecycle_items,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_repo_with_initial_commit
from tests._helpers.production_shaped import production_converged_plan

# The convergence states a plan passes through before any staging can exist.
_PRE_CONVERGENCE_STATES = frozenset({
    "DRAFT", "CHALLENGER_DRAFTED", "CRITIQUE_REQUESTED", "CROSS_REVIEW_REQUESTED",
    "REVISED", "CRITIQUED", "CROSS_REVIEWED",
})


class PlanStateSetsCoverTheReducer(unittest.TestCase):
    def test_every_state_the_reducer_assigns_is_classified_exactly_once(self) -> None:
        """Read from the reducer itself, not from the constants the sets derive from.

        A state added to the reducer and to neither constant would otherwise
        land silently in ``unowned``; this fails instead and forces a decision.
        """
        source = inspect.getsource(plan_convergence)
        assigned = set(re.findall(r'state\["state"\] = "([A-Z_]+)"', source))
        # plan_evaluated assigns its payload's terminal_state, validated to these two.
        assigned |= {"CONVERGED", "HUMAN_REQUIRED"}
        self.assertEqual(
            assigned,
            _PRE_CONVERGENCE_STATES | SETTLED_PLAN_STATES | EXECUTOR_OWNED_PLAN_STATES,
        )
        self.assertEqual(SETTLED_PLAN_STATES & EXECUTOR_OWNED_PLAN_STATES, frozenset())

    def test_converged_is_the_executors_not_settled(self) -> None:
        # V9 re-opens CONVERGED into the implementation phase; TERMINAL_STATES
        # keeps it only for V8 invariants, so it must not read as finished.
        self.assertIn("CONVERGED", EXECUTOR_OWNED_PLAN_STATES)
        self.assertNotIn("CONVERGED", SETTLED_PLAN_STATES)


class _LedgerFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pr-owner-"))
        self.tools_root = ensure_tools_dir(self.tmp / "aria-tools")
        self.workspace = make_repo_with_initial_commit(
            self.tmp, name="source",
            files={
                "apps/farm-service/src/farm/services/water-quality.service.ts": "export const x = 1;\n",
                "docs/aria/SPEC.md": "one\ntwo\nthree\n",
            },
        )
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self._env = patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces")})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _converged(self, plan_id: str) -> Any:
        return production_converged_plan(
            tools_dir=self.tools_root, workspace_root=self.workspace, plan_id=plan_id,
        )

    def _approve(self, *, proposal_id: str, source: str | None, plan_id: str | None = None) -> None:
        """The approval row as its writer shapes it (``proposal._write_approval``)."""
        row: dict[str, Any] = {
            "$schema": "aria/proposal/v1", "schema_version": 1,
            "proposal_id": proposal_id, "kind": "converged_plan",
            "status": "approved_for_apply", "blocked_by": [],
            "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if source == "machine":
            row.update({
                "approval_source": "machine",
                "machine_approval_ref": f"aria:plan-converged:{plan_id}:{'0' * 64}",
            })
        elif source == "operator":
            row.update({
                "approval_source": "operator",
                "operator_approval_ref": f"gh:Okan-wqm/aquaculture_platform#1/review/{proposal_id}",
            })
        append_declared_fixture(
            self.tools_root / "proposals" / "proposals.jsonl", row, expected_surface="proposals",
        )

    def _action(self, *, proposal_id: str, status: str, plan_id: str | None) -> None:
        """Machine stagings carry plan_id + change_id; ``plan_apply_worktree`` mints neither."""
        append_declared_fixture(
            self.tools_root / "apply" / "actions.jsonl",
            {
                "$schema": "aria/apply-action/v1", "schema_version": 1,
                "proposal_id": proposal_id, "status": status,
                "branch": "aria-impl-0123456789abcdef", "base_sha": "0" * 40,
                "plan_id": plan_id, "change_id": f"chg_{proposal_id[-8:]}" if plan_id else None,
                "workspace_root": str(self.workspace),
                "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            expected_surface="apply_actions",
        )

    def _staging(self, *, proposal_id: str, status: str, plan_id: str) -> None:
        self._approve(proposal_id=proposal_id, source="machine", plan_id=plan_id)
        self._action(proposal_id=proposal_id, status=status, plan_id=plan_id)

    def _phase(self) -> tuple[dict[str, Any], Any]:
        with patch("aria_kernel.pr_manager.open_pr_for_action") as preview:
            preview.return_value = {"event": "pr_dry_run"}
            payload = _run_pr_lifecycle_phase(build_phase_context(
                cycle_id="cyc-pr-owner", workspace_root=self.workspace,
                base_dir=self.tools_root, cycle_started_at=datetime.now(timezone.utc),
            ))
        return payload, preview


class AMachineApprovalIsNeverPreviewed(_LedgerFixture):
    def test_a_converged_plans_staging_is_in_flight(self) -> None:
        """ORPHAN-CRITICAL-728's shape: staged, implementer not run yet."""
        self._converged("plan-owner-converged")
        self._staging(
            proposal_id="prop-converged", status="staged_for_implementation",
            plan_id="plan-owner-converged",
        )
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(
            [(row["proposal_id"], row["plan_state"]) for row in payload["in_flight"]],
            [("prop-converged", "CONVERGED")],
        )

    def test_three_stagings_of_an_exhausted_plan_are_settled(self) -> None:
        """120143Z / 151306Z: three refused deliveries, plan HUMAN_REQUIRED."""
        self._converged("plan-owner-exhausted")
        for attempt in range(3):
            self._staging(
                proposal_id=f"prop-exhausted-{attempt}", status="staged_for_implementation",
                plan_id="plan-owner-exhausted",
            )
        plan_convergence.force_plan_human_required(
            plan_id="plan-owner-exhausted", round_number=1,
            reason_codes=["implementation_delivery_exhausted"],
            from_states=frozenset({"CONVERGED"}), base_dir=self.tools_root,
            forced_by="kernel:converged_delivery",
        )
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(payload["in_flight"], [])
        self.assertEqual(
            sorted((row["proposal_id"], row["plan_state"]) for row in payload["settled"]),
            [(f"prop-exhausted-{n}", "HUMAN_REQUIRED") for n in range(3)],
        )

    def test_a_gated_action_whose_delivery_the_executor_still_owns_is_not_a_candidate(self) -> None:
        """``ready_for_pr`` + plan IMPLEMENTATION_REQUESTED: the host-stage-refusal shape.

        The executor's branch is not on the cycle runner, so previewing it
        here can only fail with ``open_pr_head_sha_unresolvable`` — and fail
        the night. It is the executor's, not a candidate.
        """
        plan = self._converged("plan-owner-requested")
        plan_convergence.request_implementation(
            plan_id="plan-owner-requested", implementer_agent="aria-implementer",
            converged_plan_revision_id=plan.revision_id,
            converged_plan_content_hash=plan.content_hash,
            base_dir=self.tools_root,
        )
        self._staging(proposal_id="prop-requested", status="ready_for_pr", plan_id="plan-owner-requested")
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(
            [(row["proposal_id"], row["plan_state"]) for row in payload["in_flight"]],
            [("prop-requested", "IMPLEMENTATION_REQUESTED")],
        )

    def test_a_staging_whose_plan_has_no_events_is_unowned_and_visible(self) -> None:
        self._staging(proposal_id="prop-orphan-plan", status="ready_for_pr", plan_id="plan-without-events")
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(
            [(row["proposal_id"], row["plan_state"]) for row in payload["unowned"]],
            [("prop-orphan-plan", None)],
        )

    def test_a_machine_approval_whose_action_names_no_plan_is_unowned(self) -> None:
        self._approve(proposal_id="prop-machine-noplan", source="machine", plan_id="plan-x")
        self._action(proposal_id="prop-machine-noplan", status="ready_for_pr", plan_id=None)
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 0)
        self.assertEqual([row["proposal_id"] for row in payload["unowned"]], ["prop-machine-noplan"])


class OnlyAGatedOperatorApprovalIsPreviewed(_LedgerFixture):
    def test_buckets(self) -> None:
        for pid, status in (
            ("prop-op-ready", "ready_for_pr"), ("prop-op-blocked", "blocked"),
            ("prop-op-building", "worktree_created"), ("prop-op-future", "some_future_status"),
        ):
            self._approve(proposal_id=pid, source="operator")
            self._action(proposal_id=pid, status=status, plan_id=None)
        self._approve(proposal_id="prop-op-unapplied", source="operator")
        self._approve(proposal_id="prop-unknown-source", source=None)
        self._action(proposal_id="prop-unknown-source", status="ready_for_pr", plan_id=None)
        items = classify_pr_lifecycle_items(base_dir=self.tools_root)
        self.assertEqual([p["proposal_id"] for p in items.candidates], ["prop-op-ready"])
        self.assertEqual([p["proposal_id"] for p in items.gate_blocked], ["prop-op-blocked"])
        self.assertEqual([p["proposal_id"] for p in items.in_flight], ["prop-op-building"])
        self.assertEqual([p["proposal_id"] for p in items.awaiting_apply], ["prop-op-unapplied"])
        # An unknown status, or an approval nobody can attribute, would only be
        # refused by open_pr_for_action (open_pr_approval_source_unknown) and
        # fail the night: reported, never previewed.
        self.assertEqual(
            [p["proposal_id"] for p in items.unowned], ["prop-op-future", "prop-unknown-source"],
        )
        payload, preview = self._phase()
        self.assertEqual([c.kwargs["proposal_id"] for c in preview.call_args_list], ["prop-op-ready"])
        self.assertEqual(payload["status"], "ok")

    def test_a_re_approved_proposal_is_previewed_once(self) -> None:
        self._approve(proposal_id="prop-op-twice", source="operator")
        self._approve(proposal_id="prop-op-twice", source="operator")
        self._action(proposal_id="prop-op-twice", status="ready_for_pr", plan_id=None)
        payload, preview = self._phase()
        self.assertEqual(preview.call_count, 1)
        self.assertEqual((payload["total"], payload["ok"]), (1, 1))


class APayloadFailureIsTheCyclesVerdict(unittest.TestCase):
    def _context(self) -> Any:
        tmp = Path(tempfile.mkdtemp(prefix="aria-pr-verdict-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        context = build_phase_context(
            cycle_id="cyc-verdict", workspace_root=tmp, base_dir=ensure_tools_dir(tmp / "aria-tools"),
        )
        context.results["artifact_integrity"] = {"valid": True}
        context.outcomes["artifact_integrity"] = {"outcome": "ran"}
        return context

    def test_a_failed_payload_carries_its_error_and_fails_the_runtime_verdict(self) -> None:
        context = self._context()
        context.results["pr_lifecycle"] = {
            "status": "fail", "error": "1 of 1 PR previews refused: open_pr_branch_missing: x",
        }
        context.outcomes["pr_lifecycle"] = {"outcome": "ran"}
        self.assertEqual(_payload_failed_phases(context), [{
            "phase": "pr_lifecycle", "status": "failed",
            "error": "1 of 1 PR previews refused: open_pr_branch_missing: x",
        }])
        # Before: the outcome said `ran`, so the verdict said `ok` beside a
        # FAILED terminal row.
        self.assertEqual(_runtime_status(context), "failed")

    def test_a_payload_failure_outranks_a_degraded_tool(self) -> None:
        """Behaviour change, deliberate (cycle_runtime_status: "failed — a phase
        raised or declared itself failed"). Before, a degraded tool made the
        verdict ``degraded`` and the orchestrator ran the night's lanes on a
        cycle whose terminal row said FAILED; with every tool ok the same
        failure stopped the night. Now both stop it, the same way."""
        context = self._context()
        context.results["tools"] = {"run_summary": [{
            "tool_id": "test-gap-adapter", "status": "budget_exceeded", "artifact_status": "written",
        }]}
        context.results["pr_lifecycle"] = {"status": "fail", "error": "x"}
        context.outcomes["pr_lifecycle"] = {"outcome": "ran"}
        self.assertEqual(_runtime_status(context), "failed")

    def test_the_error_published_on_the_row_is_bounded(self) -> None:
        context = self._context()
        context.results["validation_matrix"] = {"status": "fail", "error": "x" * 5000}
        (row,) = _payload_failed_phases(context)
        self.assertLessEqual(len(row["error"]), 300)

    def test_a_failed_payload_without_its_own_error_says_so(self) -> None:
        context = self._context()
        context.results["validation_matrix"] = {"status": "fail"}
        (row,) = _payload_failed_phases(context)
        self.assertEqual(row["error"], "payload_declared_fail")

    def test_a_returned_gate_refusal_keeps_its_reason(self) -> None:
        from aria_kernel.cycle import _refusal_summary

        rows = [{"change_id": "chg_a", "passed": False,
                 "gate_result": {"passed": False, "reason": "regression_anchor_required"}}]
        self.assertEqual(
            _refusal_summary(rows, total=1, noun="validation gates"),
            "1 of 1 validation gates refused: regression_anchor_required",
        )


class TheVerdictPhasesRunBeforeTheCloseOut(unittest.TestCase):
    def _context(self) -> Any:
        tmp = Path(tempfile.mkdtemp(prefix="aria-pr-metrics-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return build_phase_context(
            cycle_id="cyc-metrics", workspace_root=tmp, base_dir=ensure_tools_dir(tmp / "aria-tools"),
        )

    def test_tail_order(self) -> None:
        names = [phase.name for phase in CYCLE_PHASES]
        for verdict_phase in ("architecture_postcheck", "validation_matrix", "pr_lifecycle"):
            self.assertLess(names.index(verdict_phase), names.index("artifact_integrity"), verdict_phase)
        self.assertLess(names.index("artifact_integrity"), names.index("metrics"))
        self.assertLess(names.index("metrics"), names.index("observability_dashboard"))

    def _digests(self, context: Any) -> dict[str, Any]:
        from aria_kernel import cycle as cycle_mod

        with patch.object(cycle_mod, "record_cycle_metrics", side_effect=lambda **kw: kw) as record:
            cycle_mod._phase_metrics(context)
        return record.call_args.kwargs["phase_digests"] or {}

    def test_metrics_carries_the_pr_lifecycle_digest(self) -> None:
        context = self._context()
        context.results["pr_lifecycle"] = {
            "status": "no_op", "total": 0, "ok": 0, "fail": 0,
            "delivered": [{}], "settled": [{}] * 8, "in_flight": [{}],
            "gate_blocked": [], "awaiting_apply": [], "unowned": [],
        }
        context.outcomes["pr_lifecycle"] = {"outcome": "ran"}
        digest = self._digests(context)["pr_lifecycle"]
        self.assertEqual(
            (digest["settled"], digest["delivered"], digest["in_flight"], digest["status"]),
            (8, 1, 1, "no_op"),
        )

    def test_a_phase_that_did_not_run_has_no_digest(self) -> None:
        """A skipped phase stores ``{}``; a digest of it would read "ran empty"."""
        context = self._context()
        context.results["pr_lifecycle"] = {}
        context.outcomes["pr_lifecycle"] = {"outcome": "skipped", "reason": "precondition_unmet"}
        self.assertNotIn("pr_lifecycle", self._digests(context))


if __name__ == "__main__":
    unittest.main()
