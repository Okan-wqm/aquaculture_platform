"""Wave 0 §0.7 — executor-lane PR opening goes through the kernel CLI.

The real PRs in the executor lane were opened by the agent subprocess
running raw ``gh pr create`` (an ALLOWED_BASH_COMMANDS row), which
bypassed pr_manager entirely: GATE_PRE_PR_OPEN, the failure-breaker
producer, and the change-id anchor all sat on a path no production PR
travelled. These tests pin the cutover mechanics:

  1. the kernel CLI row admits exactly `python3 -m aria_kernel pr create`
     — not the rest of the kernel CLI (operator surface, not implementer
     surface);
  2. with ARIA_EXECUTOR_PR_VIA_KERNEL=1 (the executor lane's setting)
     raw ``gh pr create`` is an allowlist MISS — the kernel path is the
     only reachable one;
  3. without the flag the legacy row still matches — the staged
     transition the program plan tracks (flag + legacy row are deleted
     together after one green scheduled run);
  4. ``gh pr merge`` stays denied in BOTH states — the cutover must not
     loosen the merge-authority boundary.

ORPHAN-CRITICAL-727 adds the other half of the same cutover. `pr create`
refuses an action that is not ``ready_for_pr`` with a ``validation_gate_ref``,
and the only producer of both is the apply gate — which had no command
surface at all. The implementer was told to open a PR it had no reachable way
to earn, with ids nobody minted. So this file also pins:

  5. ``python3 -m aria_kernel apply gate`` is admitted, and the rest of the
     ``apply`` group is not (``scan-diff`` is operator surface);
  6. the implementation envelope carries {proposal_id, change_id, branch} as
     structured fields, and refuses to mint without them.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.cross_review_bridge import issue_implementation_envelope
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.production_shaped import production_converged_plan

from aria_kernel.implementation_safety import (
    ALLOWED_BASH_COMMANDS,
    BashAllowlistMiss,
    BashDenylistHit,
    LEGACY_GH_PR_CREATE_PATTERN,
    executor_pr_via_kernel,
    verify_bash_command_allowed,
)

KERNEL_PR_CREATE = [
    "python3", "-m", "aria_kernel", "pr", "create",
    "--proposal-id", "prop-1", "--change-id", "chg-1", "--no-dry-run",
]
KERNEL_APPLY_GATE = [
    "python3", "-m", "aria_kernel", "apply", "gate",
    "--proposal-id", "prop-1", "--change-id", "chg-1",
]
LEGACY_GH_PR_CREATE = [
    "gh", "pr", "create", "--base", "main",
    "--head", "aria-impl-abc123", "--title", "[ARIA-AUTO]x",
]


class ExecutorPrViaKernelTests(unittest.TestCase):
    def test_the_legacy_row_left_the_allowlist(self) -> None:
        """The transition pattern must not ALSO live in the closed set.

        If it did, the flag would gate a copy while the original kept
        matching — the cutover would be a no-op that reads as done.
        """
        joined = " ".join(LEGACY_GH_PR_CREATE)
        for pattern in ALLOWED_BASH_COMMANDS:
            self.assertIsNone(
                pattern.match(joined),
                f"ALLOWED_BASH_COMMANDS still admits raw gh pr create via "
                f"{pattern.pattern!r}",
            )
        self.assertIsNotNone(LEGACY_GH_PR_CREATE_PATTERN.match(joined))

    def test_kernel_pr_create_is_allowed_in_both_states(self) -> None:
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                with mock.patch.dict("os.environ", flag, clear=False):
                    verify_bash_command_allowed(KERNEL_PR_CREATE)

    def test_only_the_pr_create_subcommand_is_admitted(self) -> None:
        for argv in (
            ["python3", "-m", "aria_kernel", "autonomy", "run"],
            ["python3", "-m", "aria_kernel", "integrity", "verify"],
            ["python3", "-m", "aria_kernel"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(BashAllowlistMiss):
                    verify_bash_command_allowed(argv)

    def test_flag_on_refuses_raw_gh_pr_create(self) -> None:
        with mock.patch.dict("os.environ", {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}, clear=False):
            self.assertTrue(executor_pr_via_kernel())
            with self.assertRaises(BashAllowlistMiss):
                verify_bash_command_allowed(LEGACY_GH_PR_CREATE)

    def test_flag_off_keeps_the_transition_path_open(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("ARIA_EXECUTOR_PR_VIA_KERNEL", None)
            self.assertFalse(executor_pr_via_kernel())
            verify_bash_command_allowed(LEGACY_GH_PR_CREATE)

    def test_gh_pr_merge_stays_denied_in_both_states(self) -> None:
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                with mock.patch.dict("os.environ", flag, clear=False):
                    with self.assertRaises(BashDenylistHit):
                        verify_bash_command_allowed(["gh", "pr", "merge", "42"])


class ExecutorApplyGateSurfaceTests(unittest.TestCase):
    """ORPHAN-CRITICAL-727 — the gate is reachable, and only the gate."""

    def test_apply_gate_is_allowed_in_both_states(self) -> None:
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                with mock.patch.dict("os.environ", flag, clear=False):
                    verify_bash_command_allowed(KERNEL_APPLY_GATE)

    def test_the_rest_of_the_apply_group_stays_operator_surface(self) -> None:
        """`apply scan-diff` reads an arbitrary file path off the argv.

        The implementer's admitted commands are the two that MOVE its own
        change forward; a diff-scanning utility is a thing an operator runs,
        and widening the row to `apply` would have admitted every subcommand
        the group ever grows.
        """
        with self.assertRaises(BashAllowlistMiss):
            verify_bash_command_allowed(
                ["python3", "-m", "aria_kernel", "apply", "scan-diff",
                 "--diff-file", "/etc/shadow"],
            )


class ImplementationEnvelopeIdsTests(unittest.TestCase):
    """The envelope hands the agent ids that resolve to real staged rows."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        self.repo = root / "workspace"
        self.repo.mkdir()
        # ORPHAN-HIGH-728 — the fixture follows the DEPLOYMENT's order,
        # it does not bypass it: a strict profile now requires an
        # operator-recorded ceiling that admits it, and only an operator
        # gesture may widen that ceiling. A fixture that set the profile
        # with a machine identity was arranging a world the kernel no
        # longer permits — so it declares the grant first, exactly as the
        # workflow's profile_gate does.
        set_profile(
            "strict",
            operator_approval_ref="test:orphan-critical-727:envelope-ids",
            base_dir=self.tools,
            set_by="operator",
            scheduler_ceiling="strict",
        )
        self.plan = production_converged_plan(
            tools_dir=self.tools, workspace_root=self.repo,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mint(self, **overrides):
        """ORPHAN-CRITICAL-728 — the mint takes ids, not plan content.

        This helper used to hand-supply ``must_satisfy``, ``allowed_scope``,
        ``evidence_refs``, the plan text and its revision id — which is
        exactly why every pin in this class passed while the production
        caller could not mint a single envelope: no producer existed for the
        first two, and the fixture stood in for one. The mint now derives all
        of them from the plan ledger, so a fixture CANNOT stand in.
        """
        kwargs = {
            "plan_id": self.plan.plan_id,
            "cross_review_revision_id": "cr-1",
            "cross_review_summary_text": "{}",
            "proposal_id": "proposal-727",
            "change_id": "chg-727",
            "branch": "aria-impl-0123456789abcdef",
            "base_sha": "0" * 40,
            "base_dir": self.tools,
        }
        kwargs.update(overrides)
        return issue_implementation_envelope(**kwargs)

    def test_envelope_row_and_prompt_carry_the_staged_ids(self) -> None:
        row = self._mint()
        self.assertEqual(
            row["implementation_ids"],
            {
                "proposal_id": "proposal-727",
                "change_id": "chg-727",
                "branch": "aria-impl-0123456789abcdef",
                # ORPHAN-CRITICAL-728 — the commit the staging measured its
                # baseline at, so the agent branches from it instead of from
                # wherever origin/main has moved to.
                "base_sha": "0" * 40,
            },
        )
        prompt = row["suggested_prompt"]
        # Structured, and OUTSIDE the untrusted delimiters: these are the
        # kernel's instructions to the agent, not plan content it must
        # distrust.
        self.assertIn("<implementation_ids>", prompt)
        self.assertIn("proposal-727", prompt.split("<untrusted_converged_plan")[0])
        self.assertIn("python3 -m aria_kernel apply gate", prompt)
        self.assertIn("python3 -m aria_kernel pr create", prompt)
        # The branch instruction names the staged base, not origin/main.
        self.assertIn("git switch -c <branch> <base_sha>", prompt)
        self.assertNotIn("git switch -c <branch> origin/", prompt)

    def test_envelope_derives_scope_and_obligations_from_the_plan(self) -> None:
        """The two arguments that had no producer are now derived.

        ORPHAN-CRITICAL-728 — `must_satisfy` and `allowed_scope` are not
        plan-content fields, so the production caller's
        `converged_plan.get(...)` handed the mint two empty lists and it
        refused its own envelope. Nothing in the pins could see it, because
        every test supplied both by hand.
        """
        row = self._mint()
        self.assertEqual(
            row["allowed_scope"],
            ["apps/farm-service/src/farm/services/water-quality.service.ts"],
        )
        authenticity = row["must_satisfy"][0]
        self.assertEqual(authenticity["content_hash"], self.plan.content_hash)
        self.assertEqual(authenticity["revision_id"], self.plan.revision_id)
        self.assertIn(
            "validation:canonical_suite",
            [item["id"] for item in row["must_satisfy"]],
        )
        # The embedded body is the CONVERGED body, not the caller's text.
        # (base64, per the delimiter-smuggling anchor — decode to read it.)
        import base64

        payload = (row["suggested_prompt"] or "").split(
            '<untrusted_converged_plan revision_id="', 1,
        )[1].split(">\n", 1)[1].split("\n</untrusted_converged_plan>", 1)[0]
        decoded = base64.b64decode(payload).decode("utf-8")
        self.assertIn("Converged fixture plan", decoded)
        self.assertIn("water-quality.service.ts", decoded)

    def test_envelope_refuses_a_plan_whose_every_surface_is_readonly(self) -> None:
        """`affected_surfaces − READONLY_PATHS` is the scope, and it may be empty.

        The bridge docstring said the orchestrator "MUST" compute this
        subtraction and cited an invariant id (I-V9-IMPL-04) that exists
        nowhere in the repository. Nobody computed it; nothing checked.
        """
        from aria_kernel.bridge_exceptions import BridgeContractViolation

        kernel_plan = production_converged_plan(
            tools_dir=self.tools,
            workspace_root=self.repo,
            plan_id="plan-kernel-selfmod",
            affected_paths=["aria-kernel/aria_kernel/cli.py"],
        )
        with self.assertRaisesRegex(
            BridgeContractViolation, "implementation_envelope_no_writable_scope",
        ):
            self._mint(plan_id=kernel_plan.plan_id)

    def test_envelope_refuses_to_mint_without_the_ids(self) -> None:
        """Tier-1: an envelope without ids describes work that dies at the
        last command, which is precisely what every CONVERGED plan did."""
        with self.assertRaises(GovernanceError) as ctx:
            self._mint(change_id="  ")
        self.assertIn(
            "implementation_envelope_missing_staged_ids", str(ctx.exception),
        )

    def test_prompt_no_longer_tells_the_agent_to_run_raw_gh(self) -> None:
        """The prompt used to say "Open PR via gh pr create --base main".

        The executor lane refuses that command (ARIA_EXECUTOR_PR_VIA_KERNEL=1),
        so the envelope was instructing the agent to do the one thing the
        allowlist would stop — a contradiction the agent could only resolve by
        failing.
        """
        prompt = self._mint()["suggested_prompt"]
        self.assertNotIn("gh pr create --base main", prompt)


if __name__ == "__main__":
    unittest.main()
