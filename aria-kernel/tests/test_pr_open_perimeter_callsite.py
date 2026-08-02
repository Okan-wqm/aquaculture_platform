"""ORPHAN-CRITICAL-428 — the pre-PR-open perimeter has a caller. Two, now.

Scope history (ORPHAN-CRITICAL-498, then RC-1)
==============================================
This file's original title claimed a "PRODUCTION caller" without qualifying
which lane. That read as "the nightly runs the perimeter", and it did not.
`run_hard_fail_checks` has exactly one caller, `pr_manager.open_pr_for_action`,
and that had exactly two: the operator CLI (`cli.py`, `pr open`) and
`cycle._run_pr_lifecycle_phase`. The second was unreachable — entered only via
`_run_extended_phases`, which fired only when a caller passed `run_phases` or
`pre_tool_phases`, and no production caller passed either.

RC-1 collapsed the two pipelines into `cycle.CYCLE_PHASES`, and `pr_lifecycle`
is a row in it, gated on `ACTION_PERMISSIONS["pr_open"]`. So the second caller
is now live on the scheduled lane for a profile that holds PR-open authority,
and the correction above is history rather than a standing limitation. What
remains true, and is worth stating because it bounds the claim: under the
default `standard` profile the phase records a `precondition_unmet` skip, so
the operator CLI is still the only route that reaches the perimeter on a
default deployment.


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

        # RC-2 — a dry run OBSERVES; only a real open AUTHORISES. Both must name
        # GATE_PRE_PR_OPEN: selecting GATE_PRE_MERGE would refuse every PR
        # forever, since its seven checks are all unimplemented. Asserted per
        # mode rather than once, because "some perimeter ran" is the assertion
        # that would survive the modes being swapped.
        with patch("aria_kernel.pr_manager.observe_perimeter") as observe:
            observe.return_value.refused = ()
            observe.return_value.summary = {"checks": 0}
            open_pr_for_action(
                proposal_id=pid,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        observe.assert_called_once()
        self.assertEqual(observe.call_args.kwargs.get("gate"), GATE_PRE_PR_OPEN)

    def test_a_dry_run_does_not_reach_the_authorising_gate(self) -> None:
        """The two modes are not interchangeable, and this pins the direction.

        An authorisation on a preview is what counted stage artifacts as
        rejected implementations; an observation on a real open would be a gate
        that reports instead of blocking. Either swap is a safety regression, so
        each mode asserts the ABSENCE of the other.
        """
        pid = self._seed(changed_files=[CHANGED_FILE], proposal_id="PROP-CALLSITE-3")
        with patch("aria_kernel.pr_manager.run_hard_fail_checks") as authorise, patch(
            "aria_kernel.pr_manager.observe_perimeter"
        ) as observe:
            observe.return_value.refused = ()
            observe.return_value.summary = {"checks": 0}
            open_pr_for_action(
                proposal_id=pid,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        observe.assert_called_once()
        authorise.assert_not_called()

    def test_dry_run_is_refused_when_the_perimeter_fails(self) -> None:
        """A dry run is gated too, and the refusal names what blocked it.

        ORPHAN-CRITICAL-498 corrected this docstring, and RC-1 then made the
        correction historical. It used to assert that "the only production
        route into open_pr_for_action is the cycle's pr_lifecycle phase with
        dry_run=True", and BOTH halves were false at the time: that phase was
        unreachable (entered only from ``_run_extended_phases``, behind a
        kwarg no production caller passed), and the actual live route was
        ``cli.py`` ``pr open`` — an operator typing a command.

        Since RC-1, ``pr_lifecycle`` is a row in ``cycle.CYCLE_PHASES`` and
        does run on the scheduled lane under a profile that permits
        ``pr_open``. The gating asserted below covers both routes: it is a
        property of ``open_pr_for_action``, which is where the perimeter is
        called, so it holds regardless of which caller arrives.
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
    """RC-2 — an OBSERVATION cannot trip a safety breaker.

    This class previously asserted the opposite, and the reversal is the fix
    rather than a walk-back of ORPHAN-CRITICAL-420 S5.

    S5 was right that ``record_failure`` had no production producer and right
    that the cycle's aggregation point is where a failure should be *observed*.
    It was wrong about WHAT it observed. This phase calls
    ``open_pr_for_action(dry_run=True)``, and the perimeter runs before the
    dry_run branch so a preview cannot skip the gate — but a dry run has no
    changed_files, no base_sha and no diff, so checks needing those refuse on
    data that cannot exist at that stage. Every one of those was being counted
    as a rejected implementation. Three ``approved_for_apply`` proposals in one
    cycle would trip a breaker that now gates ``standard``: the nightly halting
    itself on its own observations. It never fired only because
    ``_run_extended_phases`` was unreachable (ORPHAN-CRITICAL-498), and RC-1 has
    since put this phase on the live lane as a ``CYCLE_PHASES`` row — which is
    why the edge had to go BEFORE that landed, not after.

    The breaker is not left without a producer. ``planner_dispatch_hook``
    records ``subprocess_timeout`` from a single ``except`` arm, discriminated
    structurally rather than by message prefix, so ORPHAN-CRITICAL-485 stays
    closed. That is pinned below precisely so nobody restores this edge
    believing the breaker went decorative again.
    """

    def test_a_dry_run_perimeter_refusal_does_not_reach_the_breaker(self) -> None:
        """The inverse of what this test used to assert, on purpose.

        The refusal is still fully REPORTED — ``passed: False`` plus the verbatim
        error — it is simply not COUNTED. Reported-but-not-counted is the whole
        distinction between observing and authorising.
        """
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
                cycle_mod.build_phase_context(
                    cycle_id="cyc-perimeter-observe",
                    workspace_root=Path("/tmp"),
                    base_dir=Path("/tmp"),
                ),
            )

        self.assertEqual(
            calls, [], "an observation must not reach the failure breaker",
        )
        self.assertEqual(out["proposals"][0]["passed"], False)
        self.assertIn(PERIMETER_REFUSED_PREFIX, out["proposals"][0]["error"])

    def test_the_breaker_still_has_a_live_producer_elsewhere(self) -> None:
        """Removing this edge must not return the breaker to zero producers.

        Asserted by invocation against the live path rather than by grepping for
        the symbol: ORPHAN-CRITICAL-420 existed because `record_failure` was
        importable and never called, so importability proves nothing here.
        """
        import inspect

        from aria_kernel import planner_dispatch_hook

        source = inspect.getsource(planner_dispatch_hook)
        self.assertIn(
            "record_failure(",
            source,
            msg="the breaker's live producer left planner_dispatch_hook",
        )
        self.assertIn(
            'kind="subprocess_timeout"',
            source,
            msg="the live producer no longer records a declared FAILURE_KIND",
        )

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
                cycle_mod.build_phase_context(
                    cycle_id="cyc-perimeter-observe",
                    workspace_root=Path("/tmp"),
                    base_dir=Path("/tmp"),
                ),
            )

        self.assertEqual(calls, [], "a malformed request must not count as a rejection")
        self.assertEqual(out["proposals"][0]["passed"], False)

    def test_a_broken_breaker_cannot_swallow_the_refusal(self) -> None:
        """Degrade to 'not counted', never to 'refusal disappeared'.

        The property is unchanged; RC-2 made it unconditional. It used to hold
        because the breaker-write error was caught and pinned onto the proposal
        row. Now there is no breaker write on this path at all, so a breaker
        that cannot be written to cannot affect this phase's report — the
        strongest form of the same guarantee, and the reason the assertion moved
        from "the error was recorded" to "the refusal survives an unwritable
        ledger untouched".
        """
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
                cycle_mod.build_phase_context(
                    cycle_id="cyc-perimeter-observe",
                    workspace_root=Path("/tmp"),
                    base_dir=Path("/tmp"),
                ),
            )

        row = out["proposals"][0]
        self.assertEqual(row["passed"], False, "the refusal must still be reported")
        self.assertIn(PERIMETER_REFUSED_PREFIX, row["error"])
        self.assertNotIn(
            "breaker_record_error",
            row,
            msg="no breaker write is attempted here, so there is no write error to carry",
        )

if __name__ == "__main__":
    unittest.main()
