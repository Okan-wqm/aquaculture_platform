"""ORPHAN-CRITICAL-428 — the pre-PR-open perimeter has a caller. An OPERATOR one.

Scope correction (ORPHAN-CRITICAL-498)
======================================
This file's original title claimed a "PRODUCTION caller" without qualifying
which lane. That reads as "the nightly runs the perimeter", and it does not.
`run_hard_fail_checks` has exactly one caller, `pr_manager.open_pr_for_action`,
and that has exactly two: the operator CLI (`cli.py`, `pr open`) and
`cycle._run_pr_lifecycle_phase`. The second is unreachable — it is entered only
via `_run_extended_phases`, which fires only when a caller passes `run_phases`
or `pre_tool_phases`, and no production caller passes either.

So what this file pins is real but narrower than it read: the perimeter is
wired into the PR-open path, and that path is currently operator-driven.
Putting it on the scheduled lane is RC-1 of the follow-up plan (collapse the
two cycle pipelines into one declarative registry). The tests below are
unchanged and still valid — only the claim about reach is corrected.


Why this file exists separately from the perimeter's own unit tests
====================================================================
`implementation_safety` already has thorough tests for every hard-fail check
and for `run_hard_fail_checks` itself. Every one of them passed for months
while the function had **zero production callers** — `grep -rn
'run_hard_fail_checks(' aria-kernel` returned exactly one line, the definition.
Ten correct checks, an invariant pinning their count, and nothing on a live
path that ran them.

ORPHAN-HIGH-455 found that same shape four separate times in one branch:
extract a helper so it is testable, test the helper, leave the production
callsite unpinned. A suite full of green helper tests then says nothing about
whether the behaviour happens in production.

So these tests deliberately do NOT test the checks. They test that
`open_pr_for_action` *calls* them, that it *refuses* when they fail, and that
the refusal covers the dry-run path too. Delete the gate call from
`pr_manager.open_pr_for_action` and every test here must fail — that is the
only property this file is for.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.implementation_safety import (
    CANONICAL_VALIDATION_COMMANDS,
    GATE_PRE_PR_OPEN,
)
from aria_kernel.pr_manager import open_pr_for_action
from aria_kernel.proposal import approve_proposal, record_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

CHANGED_FILE = "apps/farm-service/src/pond/pond-density.service.ts"
# Inside implementation_safety.READONLY_PATHS — ARIA rewriting its own kernel.
KERNEL_FILE = "aria-kernel/aria_kernel/cycle.py"


class PrOpenPerimeterCallsiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-perimeter-callsite-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.tmp)], check=False))
        self.workspace = self.tmp / "repo"
        self.workspace.mkdir()
        self._git("init")
        self._git("config", "user.email", "aria@example.invalid")
        self._git("config", "user.name", "ARIA")
        (self.workspace / "README.md").write_text("seed\n", encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-q", "-m", "init")
        self.base_sha = self._git_out("rev-parse", "HEAD")
        # A real branch carrying a real change, so `git diff base..head`
        # produces a diff the secret scan can actually read.
        self._git("checkout", "-q", "-b", "aria/perimeter-callsite")
        target = self.workspace / CHANGED_FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export const POND_DENSITY_MAX = 30;\n", encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-q", "-m", "pond density")

        self.base_dir = self.tmp / "aria-tools"
        self.base_dir.mkdir()
        ensure_tools_dir(self.base_dir)
        # open_pr_for_action enforces runtime profile = 'strict' (Plan 020 §1.B).
        set_profile(
            "strict",
            operator_approval_ref="test-fixture",
            base_dir=self.base_dir,
        )

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.workspace, check=True, capture_output=True)

    def _git_out(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.workspace, check=True, capture_output=True, text=True
        ).stdout.strip()

    def _seed(self, *, changed_files: list[str], proposal_id: str) -> str:
        proposal = record_proposal(
            kind="test_gap",
            title="Perimeter callsite fixture",
            problem="pin the production caller",
            evidence=changed_files,
            validation_command=CANONICAL_VALIDATION_COMMANDS[0],
            validation_commands=list(CANONICAL_VALIDATION_COMMANDS),
            base_dir=self.base_dir,
        )
        pid = proposal["proposal_id"]
        approve_proposal(
            proposal_id=pid,
            operator_approval_ref="test-fixture",
            base_dir=self.base_dir,
        )
        append_declared_fixture(
            self.base_dir / "apply" / "actions.jsonl",
            {
                "schema_version": 1,
                "recorded_at": "2026-07-27T00:00:00Z",
                "proposal_id": pid,
                "workspace_root": str(self.workspace),
                "base_sha": self.base_sha,
                "branch": "aria/perimeter-callsite",
                "worktree_path": str(self.workspace),
                "status": "ready_for_pr",
                "changed_files": changed_files,
                "validation_commands": list(CANONICAL_VALIDATION_COMMANDS),
                "validation_gate_ref": "sha256:gate-ref",
                "validation_gate_status": "ready_for_pr",
                "validation_gate_blocked_by": [],
            },
            expected_surface="apply_actions",
        )
        return pid

    def test_open_pr_invokes_the_pre_pr_open_gate(self) -> None:
        """The callsite exists and asks for the PRE_PR_OPEN gate specifically.

        Patching where pr_manager LOOKED THE NAME UP (not where it is defined)
        is the point: this fails if the call is deleted, and it also fails if
        someone runs the wrong gate. GATE_PRE_MERGE's seven checks are all
        unimplemented, so selecting it here would refuse every PR forever.
        """
        pid = self._seed(changed_files=[CHANGED_FILE], proposal_id="PROP-CALLSITE-1")
        with patch("aria_kernel.pr_manager.run_hard_fail_checks") as gate:
            gate.return_value.passed = True
            gate.return_value.failures = ()
            open_pr_for_action(
                proposal_id=pid,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        gate.assert_called_once()
        self.assertEqual(gate.call_args.kwargs.get("gate"), GATE_PRE_PR_OPEN)

    def test_dry_run_is_refused_when_the_perimeter_fails(self) -> None:
        """A dry run is gated too, and the refusal names what blocked it.

        ORPHAN-CRITICAL-498 corrected this docstring. It used to assert that
        "the only production route into open_pr_for_action is the cycle's
        pr_lifecycle phase with dry_run=True", and BOTH halves were false:

        * that phase is unreachable — it is entered only from
          ``_run_extended_phases``, which requires a caller to pass
          ``run_phases`` / ``pre_tool_phases``, and no production caller does;
        * the actual live route is ``cli.py`` ``pr open``, i.e. an operator
          typing a command.

        So ``run_hard_fail_checks`` does not execute on the scheduled lane at
        all. The gating asserted below is real, but it is operator-path gating
        until the cycle pipeline is collapsed (RC-1). A comment stating a dead
        route as production fact is precisely what let that survive review,
        which is why the correction lives here rather than only in the finding.
        """
        pid = self._seed(changed_files=[KERNEL_FILE], proposal_id="PROP-CALLSITE-2")
        with self.assertRaises(GovernanceError) as caught:
            open_pr_for_action(
                proposal_id=pid,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        message = str(caught.exception)
        self.assertIn("open_pr_hard_fail_perimeter_refused", message)
        # The refusal must name the failing check, not just say "no".
        self.assertIn("kernel_self_modification_blocked_at_envelope_mint", message)

    def test_a_legal_action_still_opens(self) -> None:
        """The gate must not block the happy path.

        Without this, `test_dry_run_is_refused_when_the_perimeter_fails` would
        also pass if the gate refused unconditionally — a perimeter that
        refuses everything is not a working perimeter, and this pins the
        difference.
        """
        pid = self._seed(changed_files=[CHANGED_FILE], proposal_id="PROP-CALLSITE-3")
        row = open_pr_for_action(
            proposal_id=pid,
            workspace_root=self.workspace,
            base_dir=self.base_dir,
            dry_run=True,
        )
        self.assertEqual(len(row["head_sha"]), 40)



class BreakerProducerCallsiteTests(unittest.TestCase):
    """ORPHAN-CRITICAL-420 — the failure breaker has a PRODUCTION producer.

    Same reasoning as the perimeter tests above, one layer out.
    ``circuit_breaker.record_failure`` had complete unit tests and, until this
    change, exactly one occurrence repo-wide: its own ``def``. A breaker with
    no producer cannot trip, so the autonomous-halt control was decorative
    while every test covering it was green.

    These tests therefore assert the WIRING, not the breaker's arithmetic:
    that a perimeter refusal observed in the cycle's pr_lifecycle phase records
    a ``validator_rejection``, that a malformed-request GovernanceError does
    NOT (it is not a rejected implementation), and that a breaker-write failure
    cannot swallow the refusal it was trying to count.
    """

    def test_perimeter_refusal_records_a_validator_rejection(self) -> None:
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.pr_manager import PERIMETER_REFUSED_PREFIX

        calls: list[dict] = []
        refusal = GovernanceError(f"{PERIMETER_REFUSED_PREFIX}: secret_scan_diff_clean:x")
        # cycle.py imports these INSIDE the function, so they are not module
        # attributes of cycle_mod; patch them where they are looked up.
        with patch("aria_kernel.proposal.list_proposals", return_value=[
            {"proposal_id": "PROP-1", "status": "approved_for_apply"},
        ]), patch(
            "aria_kernel.pr_manager.open_pr_for_action", side_effect=refusal
        ), patch(
            "aria_kernel.circuit_breaker.record_failure",
            side_effect=lambda **kw: calls.append(kw),
        ):
            out = cycle_mod._run_pr_lifecycle_phase(
                workspace_root=Path("/tmp"), base_dir=Path("/tmp"),
            )

        self.assertEqual(len(calls), 1, "a perimeter refusal must reach the breaker")
        self.assertEqual(calls[0]["kind"], "validator_rejection")
        self.assertEqual(calls[0]["materialize_event_id"], "PROP-1")
        self.assertEqual(out["proposals"][0]["passed"], False)

    def test_malformed_request_error_does_not_count_toward_the_breaker(self) -> None:
        """A missing change_id is a bad REQUEST, not a rejected implementation.

        Counting it would let operator mistakes trip the autonomous halt, so
        the discrimination is part of the contract rather than an accident of
        which errors happen to reach this handler.
        """
        from aria_kernel import cycle as cycle_mod

        calls: list[dict] = []
        with patch("aria_kernel.proposal.list_proposals", return_value=[
            {"proposal_id": "PROP-2", "status": "approved_for_apply"},
        ]), patch(
            "aria_kernel.pr_manager.open_pr_for_action",
            side_effect=GovernanceError("open_pr_change_id_required: nope"),
        ), patch(
            "aria_kernel.circuit_breaker.record_failure",
            side_effect=lambda **kw: calls.append(kw),
        ):
            out = cycle_mod._run_pr_lifecycle_phase(
                workspace_root=Path("/tmp"), base_dir=Path("/tmp"),
            )

        self.assertEqual(calls, [], "a malformed request must not count as a rejection")
        self.assertEqual(out["proposals"][0]["passed"], False)

    def test_a_broken_breaker_cannot_swallow_the_refusal(self) -> None:
        """Degrade to 'not counted', never to 'refusal disappeared'."""
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.pr_manager import PERIMETER_REFUSED_PREFIX

        with patch("aria_kernel.proposal.list_proposals", return_value=[
            {"proposal_id": "PROP-3", "status": "approved_for_apply"},
        ]), patch(
            "aria_kernel.pr_manager.open_pr_for_action",
            side_effect=GovernanceError(f"{PERIMETER_REFUSED_PREFIX}: x:y"),
        ), patch(
            "aria_kernel.circuit_breaker.record_failure",
            side_effect=OSError("ledger unwritable"),
        ):
            out = cycle_mod._run_pr_lifecycle_phase(
                workspace_root=Path("/tmp"), base_dir=Path("/tmp"),
            )

        row = out["proposals"][0]
        self.assertEqual(row["passed"], False, "the refusal must still be reported")
        self.assertIn("breaker_record_error", row)
        self.assertIn("OSError", row["breaker_record_error"])

if __name__ == "__main__":
    unittest.main()
