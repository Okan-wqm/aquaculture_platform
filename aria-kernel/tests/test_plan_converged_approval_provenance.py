"""Every ``aria:plan-converged:`` approval traces to a real CONVERGED plan.

ORPHAN-CRITICAL-727 — staging a CONVERGED plan for PR approves its own
proposal. That is a MACHINE approval: what it asserts is not "a human agreed"
but "the convergence gate reached CONVERGED on this exact plan body".
ORPHAN-CRITICAL-728 splits the WRITER: ``record_machine_approval`` is the
only producer of that column, ``approve_proposal`` refuses the reserved
prefix, and the row carries ``approval_source``. What the split cannot prove
is that the convergence a ref NAMES actually happened — the ref's text is
authored, and a row can be written to the ledger without going through either
writer at all.

These tests pin the join that makes the claim falsifiable, and pin it where it
is SPENT: ``pr_manager.open_pr_for_action`` calls
``apply_engine.verify_plan_converged_approval`` and refuses a PR whose machine
approval does not resolve. An audit that only ran afterwards would find the
untraceable approval attached to a PR that already exists.

  * a real staged chain leaves an approval every machine-approved row in the
    ledger can be traced from — and the sweep here must actually inspect one,
    because a checker that silently checks nothing is the failure mode this
    file exists to prevent;
  * a ref naming a plan that never converged is a violation, and the PR
    opener refuses it;
  * a ref naming a converged plan with a body that plan never carried is a
    violation;
  * an operator's own approval ref is a different population and is not
    judged — ``approval_source`` separates the two as a column, and
    ``approve_proposal`` refuses to write a machine-prefixed ref at all.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.apply_engine import (
    PLAN_CONVERGED_APPROVAL_PREFIX,
    plan_converged_approval_ref,
    stage_converged_plan_for_pr,
    verify_plan_converged_approval,
)
from aria_kernel.pr_manager import open_pr_for_action
from aria_kernel.proposal import (
    approval_source_of,
    approve_proposal,
    get_proposal,
    list_proposals,
    record_proposal,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.production_shaped import production_converged_plan


FIXTURE_FILE = "apps/farm-service/src/farm/services/water-quality.service.ts"


def _fake_child_process():
    """Answer validation children with exit 0; every git call stays real.

    Same seam as tests/test_pr_manager_e2e.py, for the same reason: the
    production ``run_validation_commands`` writes the rows the gate joins on,
    so it must execute — only the `npx nx` child is simulated.
    """
    import subprocess as _sp

    from aria_kernel import validation as validation_module

    real_run = _sp.run

    def _run(argv, *args, **kwargs):
        if argv and str(argv[0]) in ("npx", "npm", "cargo"):
            return _sp.CompletedProcess(argv, 0, "ok\n", "")
        return real_run(argv, *args, **kwargs)

    return patch.object(validation_module.subprocess, "run", _run)


def _sweep(base_dir: Path) -> tuple[int, list[tuple[str, str]]]:
    """Every machine approval in the ledger, judged by the production reader."""
    checked = 0
    violations: list[tuple[str, str]] = []
    for proposal in list_proposals(base_dir=base_dir):
        # ORPHAN-CRITICAL-728 — select on the COLUMN, through the production
        # classifier, so a forged row that hid its ref in the operator column
        # is still swept.
        if approval_source_of(proposal) != "machine":
            continue
        checked += 1
        reason = verify_plan_converged_approval(proposal=proposal, base_dir=base_dir)
        if reason is not None:
            violations.append((str(proposal.get("proposal_id")), reason))
    return checked, violations


class PlanConvergedApprovalProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        import subprocess as _sp

        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "workspace"
        self.repo.mkdir()
        self.tools = self.repo / "aria-tools"
        # ORPHAN-HIGH-728 — the same authority order a deployment obeys:
        # a strict profile needs an operator-recorded ceiling that admits
        # it, and only an operator gesture may widen that ceiling. The
        # fixture declares the grant instead of arranging a world the
        # kernel refuses.
        set_profile(
            "strict",
            operator_approval_ref="test:orphan-critical-727:approval-provenance",
            base_dir=self.tools,
            set_by="operator",
            scheduler_ceiling="strict",
        )
        _sp.run(["git", "init", "-q"], cwd=self.repo, check=True)
        _sp.run(["git", "config", "user.email", "t@t.invalid"], cwd=self.repo, check=True)
        _sp.run(["git", "config", "user.name", "t"], cwd=self.repo, check=True)
        # `aria-tools/*` is ignored in the real repository (.gitignore:34);
        # mirrored here because the baseline validation refuses a dirty tree.
        (self.repo / ".gitignore").write_text("aria-tools/*\n", encoding="utf-8")
        target = self.repo / FIXTURE_FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export const INTERVAL_MS = 60000;\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _commit(self, message: str) -> None:
        import subprocess as _sp
        _sp.run(["git", "add", "-A"], cwd=self.repo, check=True)
        _sp.run(
            ["git", "commit", "-q", "-m", message],
            cwd=self.repo, check=True, capture_output=True,
        )

    def _converge_and_stage(self):
        plan = production_converged_plan(
            tools_dir=self.tools,
            workspace_root=self.repo,
            affected_paths=[FIXTURE_FILE],
        )
        self._commit("fixture: converged plan")
        with _fake_child_process():
            staged = stage_converged_plan_for_pr(
                plan_id=plan.plan_id,
                workspace_root=self.repo,
                base_dir=self.tools,
            )
        return plan, staged

    def _forge(self, ref: str) -> str:
        """Put a row carrying `ref` on the ledger WITHOUT either approval writer.

        ORPHAN-CRITICAL-728 — it used to forge through ``approve_proposal``,
        which now refuses the reserved prefix outright (pinned below). That
        refusal closes one route and not the threat: the ledger is an append
        surface, and the question these tests exist to answer is whether a row
        ALREADY carrying an untraceable machine ref can be spent. So the forge
        writes the row directly, which is the strongest attacker this file can
        model.
        """
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        proposal = record_proposal(
            kind="architecture",
            title="Forged approval",
            problem="A proposal whose approval ref claims a convergence.",
            evidence=["docs/aria/SPEC.md"],
            validation_command="npm run type-check",
            source_authority="plan_convergence",
            base_dir=self.tools,
        )
        row = dict(proposal)
        row.update({
            "recorded_at": utc_now(),
            "status": "approved_for_apply",
            "approval_source": "machine",
            "operator_approval_ref": None,
            "machine_approval_ref": ref,
            "blocked_by": [],
        })
        append_declared_jsonl(
            ensure_tools_dir(self.tools) / "proposals" / "proposals.jsonl",
            row,
            expected_surface="proposals",
        )
        return str(proposal["proposal_id"])

    def test_approve_proposal_refuses_the_reserved_machine_prefix(self) -> None:
        """The operator writer may not mint a machine approval.

        Without this the split would be advisory: any caller could keep
        writing an `aria:plan-converged:` ref through `approve_proposal` and
        every `approval_source == "operator"` reader would believe it.
        """
        proposal = record_proposal(
            kind="architecture",
            title="Operator approval",
            problem="An operator ref that impersonates a machine one.",
            evidence=["docs/aria/SPEC.md"],
            validation_command="npm run type-check",
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(
            GovernanceError, "operator_approval_ref_uses_reserved_machine_prefix",
        ):
            approve_proposal(
                proposal_id=proposal["proposal_id"],
                operator_approval_ref=(
                    f"{PLAN_CONVERGED_APPROVAL_PREFIX}plan-x:sha256:{'d' * 64}"
                ),
                base_dir=self.tools,
            )

    def test_staged_approval_is_traceable(self) -> None:
        plan, staged = self._converge_and_stage()
        checked, violations = _sweep(self.tools)
        self.assertEqual(violations, [])
        # The sweep must actually have inspected the staged approval — a
        # checked count of 0 would make an empty violation list meaningless.
        self.assertEqual(checked, 1)
        proposal = get_proposal(proposal_id=staged["proposal_id"], base_dir=self.tools)
        # ORPHAN-CRITICAL-728 — the machine ref lands in its OWN column and
        # the operator column stays empty, because no operator did anything.
        self.assertEqual(proposal["approval_source"], "machine")
        self.assertIsNone(proposal["operator_approval_ref"])
        self.assertEqual(
            proposal["machine_approval_ref"],
            plan_converged_approval_ref(
                plan_id=plan.plan_id, converged_content_hash=plan.content_hash,
            ),
        )

    def test_ref_naming_a_plan_that_never_converged_is_a_violation(self) -> None:
        forged_id = self._forge(
            f"{PLAN_CONVERGED_APPROVAL_PREFIX}plan-never-existed:sha256:{'a' * 64}",
        )
        checked, violations = _sweep(self.tools)
        self.assertEqual(checked, 1)
        self.assertEqual(
            violations, [(forged_id, "no_converged_plan_evaluated_event")],
        )

    def test_ref_naming_a_body_the_plan_never_carried_is_a_violation(self) -> None:
        plan, _staged = self._converge_and_stage()
        self._forge(
            plan_converged_approval_ref(
                plan_id=plan.plan_id, converged_content_hash="sha256:" + "b" * 64,
            ),
        )
        checked, violations = _sweep(self.tools)
        self.assertEqual(checked, 2)
        self.assertEqual(
            [reason for _proposal_id, reason in violations],
            ["content_hash_not_a_recorded_revision"],
        )

    def test_operator_approvals_are_a_separate_population(self) -> None:
        # Through the OPERATOR writer, which is what makes it that population.
        proposal = record_proposal(
            kind="architecture",
            title="Operator approval",
            problem="A proposal a human approved.",
            evidence=["docs/aria/SPEC.md"],
            validation_command="npm run type-check",
            base_dir=self.tools,
        )
        approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="operator:okan:2026-08-18:reviewed-by-hand",
            base_dir=self.tools,
        )
        checked, violations = _sweep(self.tools)
        self.assertEqual(checked, 0)
        self.assertEqual(violations, [])
        # And the PR opener does not judge them either — an operator approval
        # is authority in its own right.
        self.assertIsNone(
            verify_plan_converged_approval(
                proposal={
                    "approval_source": "operator",
                    "operator_approval_ref": "operator:okan:by-hand",
                },
                base_dir=self.tools,
            ),
        )
        # And a row that CLAIMS to be machine-granted while naming no machine
        # ref fails closed rather than passing as an operator's.
        self.assertEqual(
            verify_plan_converged_approval(
                proposal={"approval_source": "machine"}, base_dir=self.tools,
            ),
            "machine_approval_ref_absent",
        )

    def test_pr_open_refuses_an_untraceable_machine_approval(self) -> None:
        """The production refusal, not just the audit.

        A forged approval must not be spendable. The proposal below has no
        apply action either, so this also pins the ORDER: the approval is
        judged before the action lookup, because an approval that authorises
        nothing real should not be reported as a missing-action problem.
        """
        forged_id = self._forge(
            f"{PLAN_CONVERGED_APPROVAL_PREFIX}plan-never-existed:sha256:{'c' * 64}",
        )
        with self.assertRaisesRegex(
            GovernanceError, "open_pr_machine_approval_untraceable",
        ):
            open_pr_for_action(
                proposal_id=forged_id,
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
            )


if __name__ == "__main__":
    unittest.main()
