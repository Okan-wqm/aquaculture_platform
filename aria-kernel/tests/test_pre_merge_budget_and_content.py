"""ARIA-HIGH-008 — merge authority binds the converged plan content and the budget.

The autonomy-closure policy (``docs/aria/policy/autonomy-closure-findings.json``,
task-11, predicate ``budget_and_content_checks_code_proven``) names this file as
the regression ref of ARIA-HIGH-008: "merge authority does not bind reconciled
budget and plan content". Both halves were fixed by commits that cited other
findings, and this file is the one place that pins them under 008's name.

Plan content (4f4918c88, the native implementation join). The merge gate's
evidence binds only when ``merge_authority._join_pre_merge_implementation``
accepts the implementation request: the request was planned against the
converged plan body (``request.plan_revision_hash`` == the body's content hash),
the recorded implementation names that revision and content
(``implementation.converged_plan_revision_id`` / ``converged_plan_content_hash``),
and the change, proposal, base, branch, intended request and claim are the
ones the PR merges. Any mismatch leaves the evidence unbound, and every
pre-merge check then fails with ``native_implementation_binding_unavailable``.
``PlanContentBindingTests`` drives the real join with constructed ledger rows;
only the three request-integrity collaborators are replaced
(``_strict_request_view``, ``_assert_envelope_reproduces_binding``,
``_verify_invocation_context_binding_rows``), whose own contracts are pinned in
``test_request_contract_minter.py`` and ``test_claim_envelope_binding.py``. The
converged body itself is recomputed and tamper-checked by
``resolve_converged_plan_observation``, pinned in ``test_plan_convergence.py``;
it is not re-proved here.

Budget (bd74c801c, ``cycle_and_turn_budget_cap``). The seventh pre-merge
predicate reads the turn-budget evidence the PreToolUse hook captured for this
request and judges it against the policy cap the caller resolved for the
merged store. Two halves bind that: the capture
(``merge_authority._capture_pre_merge_turn_budget``) resolves the cap from the
merged store's workspace policy, never from the hook rows' own record, and
``CaptureJudgesAgainstTheMergedStoresPolicy`` drives it against a real store
whose policy changed after the spawn; ``PredicateReadsCapturedEvidence`` is
the predicate's one owner (moved here from ``test_turn_budget.py``, which keeps
the hook, policy and CLI tests). Task-11's per-cycle dollar-reservation cases are superseded by
ARIA-HIGH-088 (closed by bd74c801c): ``monetary_admission`` is
``managed_subscription`` (``aria-config/genesis_policy.json``), so dollars are
telemetry and the cap that binds is turns plus the job deadline.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import agent_invocations, merge_authority
from aria_kernel.implementation_safety import (
    GATE_PRE_MERGE,
    HardFailContext,
    _PreMergeEvidence,
    run_hard_fail_checks,
)
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.turn_budget_policy import IMPLEMENTER_TURN_BUDGET_DEFAULTS
from tests.test_turn_budget_policy import write_override
from tests._helpers.pre_merge_evidence import fixture_pre_merge_evidence

# The kernel default; the predicate judges against whatever the policy says.
_CAP = IMPLEMENTER_TURN_BUDGET_DEFAULTS["budgeted_turns"]

_BASE = "a" * 40
_HEAD = "b" * 40
_BODY = {"revision_id": "rev-2", "content_hash": "sha256:" + "c" * 64}

# The stage the join reached: the request stage passed and the next one (the
# result rows, absent in this fixture) refused.
_REQUEST_STAGE_PASSED = ({}, ("implementation_result_join_unavailable",))
_REQUEST_STAGE_REFUSED = ({}, ("implementation_request_join_unavailable",))


def _fixture() -> dict[str, Any]:
    """Ledger rows and observations whose every binding agrees with ``_BODY``."""
    request = {
        "request_id": "AIR-1", "role": "implementation", "convergence_id": "PLAN-1",
        "implementation_ids": {"change_id": "CHG-1", "proposal_id": "PROP-1",
                               "base_sha": _BASE, "branch": "aria/chg-1"},
        "plan_revision_hash": _BODY["content_hash"], "context_hash": "sha256:ctx",
        "prompt_hash": "sha256:prm", "ledger_hash": "sha256:req",
    }
    return {
        "rows": {
            "agent_invocation_claims": [{"claim_id": "CL-1", "event": "claimed", "request_id": "AIR-1",
                                         "agent_id": "aria-implementer", "ledger_hash": "sha256:cl"}],
            "agent_invocation_requests": [request],
            "agent_invocation_contexts": [{"request_id": "AIR-1", "ledger_hash": "sha256:ctx-row"}],
            "agent_invocation_prompts": [{"ledger_hash": "sha256:prm-row"}],
            "agent_invocation_results": [],
            "agent_result_bridge_status": [],
        },
        "state": {
            "implementation": {"converged_plan_revision_id": _BODY["revision_id"],
                               "converged_plan_content_hash": _BODY["content_hash"],
                               "claim_id": "CL-1"},
            "events": [], "state": "IMPLEMENTATION_RECORDED",
        },
        "body": dict(_BODY),
        "planned": {"plan_id": "PLAN-1", "change_id": "CHG-1", "intended_request_id": "AIR-1"},
        "committed": {"claim_id": "CL-1"},
        "pr_binding": {"proposal_id": "PROP-1"},
        # Production-shaped: the gh adapter's get_pr carries no proposal_id,
        # so the opener's binding row (ARIA-HIGH-521: `pr_change_binding`)
        # is the proposal the join has to hold.
        "pr": {"head_ref": "aria/chg-1", "url": "https://github.com/o/r/pull/1"},
    }


def _request(fx: dict[str, Any]) -> dict[str, Any]:
    return fx["rows"]["agent_invocation_requests"][0]


def _ids(fx: dict[str, Any]) -> dict[str, Any]:
    return _request(fx)["implementation_ids"]


def _request_and_pr_name_another_proposal(fx: dict[str, Any]) -> None:
    _ids(fx).update(proposal_id="PROP-2")
    fx["pr"].update(proposal_id="PROP-2")


def _join(fx: dict[str, Any]) -> tuple[dict[str, Any], tuple[str, ...]]:
    binding = {"context": {"ledger_hash": "sha256:ctx-row"}, "prompt": {"ledger_hash": "sha256:prm-row"}}
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(agent_invocations, "_strict_request_view", lambda request: request), \
            mock.patch.object(agent_invocations, "_assert_envelope_reproduces_binding", lambda request: None), \
            mock.patch.object(agent_invocations, "_verify_invocation_context_binding_rows",
                              lambda **_: binding):
        return merge_authority._join_pre_merge_implementation(
            tools=Path(tmp), workspace=Path(tmp), rows=fx["rows"], state=fx["state"], body=fx["body"],
            planned=fx["planned"], committed=fx["committed"], pr_binding=fx["pr_binding"], pr=fx["pr"],
            base_sha=_BASE, head_sha=_HEAD, diff_text="", merge_base_sha=_BASE, merge_head_sha=_HEAD,
        )


class PlanContentBindingTests(unittest.TestCase):
    """The join refuses an implementation bound to anything but the merged plan."""

    def test_the_fixture_passes_the_request_stage(self) -> None:
        # Control: every binding agrees, so each case below isolates one.
        self.assertEqual(_join(_fixture()), _REQUEST_STAGE_PASSED)
        # A PR row that does carry a proposal passes when it names the same one.
        fx = _fixture()
        fx["pr"]["proposal_id"] = "PROP-1"
        self.assertEqual(_join(fx), _REQUEST_STAGE_PASSED)

    def test_plan_content_mismatches_leave_the_evidence_unbound(self) -> None:
        other = "sha256:" + "d" * 64
        cases: dict[str, Callable[[dict[str, Any]], None]] = {
            # The implementer was asked to implement another plan text.
            "request.plan_revision_hash": lambda fx: _request(fx).update(plan_revision_hash=other),
            # The recorded implementation names another revision or content.
            "implementation.converged_plan_revision_id":
                lambda fx: fx["state"]["implementation"].update(converged_plan_revision_id="rev-1"),
            "implementation.converged_plan_content_hash":
                lambda fx: fx["state"]["implementation"].update(converged_plan_content_hash=other),
            # The plan re-converged after the request: request and record
            # agree with each other, not with the body being merged.
            "converged body moved on": lambda fx: fx.update(body={"revision_id": "rev-3", "content_hash": other}),
        }
        for label, mutate in cases.items():
            with self.subTest(binding=label):
                fx = _fixture()
                mutate(fx)
                self.assertEqual(_join(fx), _REQUEST_STAGE_REFUSED)

    def test_change_proposal_commit_and_claim_mismatches_leave_the_evidence_unbound(self) -> None:
        cases: dict[str, Callable[[dict[str, Any]], None]] = {
            "request.role": lambda fx: _request(fx).update(role="review"),
            "request.convergence_id": lambda fx: _request(fx).update(convergence_id="PLAN-2"),
            "implementation_ids.change_id": lambda fx: _ids(fx).update(change_id="CHG-2"),
            # The PR row carries no proposal, so only the binding row's
            # proposal can refuse a request planned for another proposal.
            "implementation_ids.proposal_id": lambda fx: _ids(fx).update(proposal_id="PROP-2"),
            # Request and PR agree with each other, not with the binding row.
            "binding proposal only": _request_and_pr_name_another_proposal,
            "binding proposal absent": lambda fx: fx.update(pr_binding={}),
            # Request and binding row agree; the PR names another proposal.
            "pr.proposal_id": lambda fx: fx["pr"].update(proposal_id="PROP-2"),
            "implementation_ids.base_sha": lambda fx: _ids(fx).update(base_sha="e" * 40),
            "implementation_ids.branch": lambda fx: _ids(fx).update(branch="aria/other"),
            "planned.intended_request_id": lambda fx: fx["planned"].update(intended_request_id="AIR-2"),
            "implementation.claim_id": lambda fx: fx["state"]["implementation"].update(claim_id="CL-2"),
        }
        for label, mutate in cases.items():
            with self.subTest(binding=label):
                fx = _fixture()
                mutate(fx)
                self.assertEqual(_join(fx), _REQUEST_STAGE_REFUSED)


def _bound_evidence(**budget) -> _PreMergeEvidence:
    """Every native binding field the predicates require, plus the budget view."""
    sha = "b" * 40
    return fixture_pre_merge_evidence(
        (), repo_identity="repo", snapshot_hash="sha256:snap",
        pr_row_hash="sha256:pr", planned_row_hash="sha256:planned", committed_row_hash="sha256:committed",
        request_id="AIR-1", claim_id="claim-1", request_row_hash="sha256:req", claim_row_hash="sha256:claim",
        result_row_hash="sha256:res", implementation_event_hash="sha256:evt",
        implementation_base_sha="a" * 40, implementation_head_sha=sha, base_sha="a" * 40, head_sha=sha,
        **budget,
    )


def _budget_verdict(evidence: _PreMergeEvidence | None):
    report = run_hard_fail_checks(HardFailContext(pre_merge_evidence=evidence), gate=GATE_PRE_MERGE)
    return next(result for result in report.results if result.name == "cycle_and_turn_budget_cap")


def _hook_row(cap: int, used_before: int) -> dict[str, Any]:
    """One budgeted PreToolUse verdict as ``hooks.admit_budgeted_turn`` records it."""
    return {"request_id": "AIR-1", "tool_name": "Bash", "decision": "allow", "reason": "command_policy_allow",
            "ledger_hash": f"sha256:hook-{used_before}", "turn_budget": {"cap": cap, "used_before": used_before}}


class CaptureJudgesAgainstTheMergedStoresPolicy(unittest.TestCase):
    """The merge gate resolves the cap from the merged store's policy, not from the rows."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("ARIA_TOOLS_DIR", None)
        self.workspace = Path(tmp.name).resolve() / "ws"
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def _capture(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return merge_authority._capture_pre_merge_turn_budget(
            tools=self.tools, rows={"hook_decisions": rows}, implementation={"request_id": "AIR-1"},
        )

    def test_rows_recorded_under_a_cap_the_policy_no_longer_says_are_refused(self) -> None:
        # Spawned under the default cap, 50 turns used: bound, and the gate passes.
        rows = [_hook_row(_CAP, used) for used in range(50)]
        captured = self._capture(rows)
        self.assertEqual((captured["turn_budget_cap"], captured["turn_budget_policy_cap"]), (_CAP, _CAP))
        self.assertTrue(_budget_verdict(_bound_evidence(**captured)).passed)
        # The operator lowers the store's policy to 10 after the spawn. The
        # rows still say the default; judged against them, 50 < cap would pass.
        write_override(self.workspace, {"budgeted_turns": 10})
        captured = self._capture(rows)
        self.assertEqual(captured, {"turn_budget_unavailable_reason": "native_turn_budget_cap_mismatch"})
        verdict = _budget_verdict(_bound_evidence(**captured))
        self.assertEqual((verdict.passed, verdict.reason), (False, "native_turn_budget_cap_mismatch"))

    def test_a_policy_the_store_refuses_is_a_named_reason(self) -> None:
        write_override(self.workspace, {"budgeted_turns": 0})
        self.assertEqual(self._capture([_hook_row(_CAP, 0)]),
                         {"turn_budget_unavailable_reason": "native_turn_budget_policy_invalid"})


class PredicateReadsCapturedEvidence(unittest.TestCase):
    def _verdict(self, evidence: _PreMergeEvidence | None):
        return _budget_verdict(evidence)

    def test_passes_when_both_caps_were_respected_under_the_policys_cap(self) -> None:
        # Whatever the policy says is the cap the evidence is judged against:
        # the default, and an override the merged store's workspace carries.
        for cap in (_CAP, 25):
            verdict = self._verdict(_bound_evidence(
                turn_budget_cap=cap, turn_budget_policy_cap=cap, turn_budget_used=cap,
                turn_budget_refusal_reason=None, turn_budget_ledger_tip="sha256:tip",
            ))
            self.assertTrue(verdict.passed, verdict.reason)
            self.assertEqual(verdict.reason, "native_cycle_and_turn_budget_respected")

    def test_fails_by_name_on_either_refusal(self) -> None:
        for reason in (f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}",
                       "cycle_budget_exhausted:remaining=90s:margin=120s"):
            verdict = self._verdict(_bound_evidence(
                turn_budget_cap=_CAP, turn_budget_policy_cap=_CAP, turn_budget_used=3,
                turn_budget_refusal_reason=reason, turn_budget_ledger_tip="sha256:tip",
            ))
            self.assertFalse(verdict.passed)
            self.assertEqual(verdict.reason, reason.split(":", 1)[0])

    def test_fails_when_more_turns_were_admitted_than_the_cap(self) -> None:
        verdict = self._verdict(_bound_evidence(
            turn_budget_cap=_CAP, turn_budget_policy_cap=_CAP, turn_budget_used=_CAP + 1,
            turn_budget_ledger_tip="sha256:tip",
        ))
        self.assertEqual((verdict.passed, verdict.reason), (False, "implementer_turn_budget_exceeded_unrefused"))

    def test_fails_by_name_when_the_recorded_cap_is_not_the_policys(self) -> None:
        # The spawn ran under 10 (the former literal, or another workspace's
        # policy) and the merged store's policy says the default: refused by name,
        # even though 3 admitted turns respect both numbers.
        verdict = self._verdict(_bound_evidence(
            turn_budget_cap=10, turn_budget_policy_cap=_CAP, turn_budget_used=3,
            turn_budget_ledger_tip="sha256:tip",
        ))
        self.assertEqual((verdict.passed, verdict.reason), (False, "native_turn_budget_cap_mismatch"))

    def test_fails_on_absent_malformed_or_unbound_evidence(self) -> None:
        for budget, expected in (
            ({"turn_budget_unavailable_reason": "native_turn_budget_evidence_unavailable"},
             "native_turn_budget_evidence_unavailable"),
            ({"turn_budget_unavailable_reason": "native_turn_budget_cap_mismatch"}, "native_turn_budget_cap_mismatch"),
            ({"turn_budget_unavailable_reason": "native_turn_budget_policy_invalid"}, "native_turn_budget_policy_invalid"),
            ({}, "native_turn_budget_binding_unavailable"),
            # A recorded cap with no policy cap is unbound: nobody resolved
            # the merged store's policy, so there is nothing to compare.
            ({"turn_budget_cap": _CAP, "turn_budget_used": 1, "turn_budget_ledger_tip": "sha256:tip"},
             "native_turn_budget_binding_unavailable"),
            ({"turn_budget_policy_cap": _CAP, "turn_budget_used": 1, "turn_budget_ledger_tip": "sha256:tip"},
             "native_turn_budget_binding_unavailable"),
            ({"turn_budget_cap": _CAP, "turn_budget_policy_cap": _CAP, "turn_budget_used": 1},
             "native_turn_budget_binding_unavailable"),
        ):
            verdict = self._verdict(_bound_evidence(**budget))
            self.assertEqual((verdict.passed, verdict.reason), (False, expected), budget)
        unbound = replace(_bound_evidence(turn_budget_cap=_CAP, turn_budget_policy_cap=_CAP, turn_budget_used=0,
                                          turn_budget_ledger_tip="sha256:tip"), result_row_hash=None)
        self.assertEqual(self._verdict(unbound).reason, "native_implementation_binding_unavailable")
        self.assertEqual(self._verdict(None).reason, "native_implementation_binding_unavailable")


if __name__ == "__main__":
    unittest.main()
