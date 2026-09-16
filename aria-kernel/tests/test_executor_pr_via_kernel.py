"""Wave 0 §0.7 → ARIA-HIGH-124 — no PR is opened from inside the agent's sandbox, by any path.

The real PRs in the executor lane were once opened by the agent subprocess
running raw ``gh pr create`` (an ALLOWED_BASH_COMMANDS row) — bypassing
pr_manager entirely: GATE_PRE_PR_OPEN, the failure-breaker producer and the
change-id anchor sat on a path no production PR travelled. Wave 0 §0.7 cut
that over to the kernel CLI (``python3 -m aria_kernel pr create``) run by
the agent, behind a lane flag. ARIA-HIGH-124 found that path never worked
either: the kernel CLI run inside the sandbox reads a phantom store (the
durable store is not mounted there, ARIA-HIGH-123) and resolves the kernel
package from the agent's own cwd. Kernel authority is now the EXECUTOR's,
exercised after the spawn (``implementation_delivery``), and these tests pin
the policy half of that:

  1. raw ``gh pr create`` is an allowlist MISS with no flag to open it
     (the transition row and ``ARIA_EXECUTOR_PR_VIA_KERNEL`` are gone);
  2. ``python3 -m aria_kernel pr create`` and ``apply gate`` — and every
     other kernel CLI command — are refused BY NAME (``kernel_authority``),
     as is every ``git push``;
  3. ``gh pr merge`` stays denied — the merge-authority boundary is untouched;
  4. the implementation envelope carries {proposal_id, change_id, branch,
     base_sha} as structured fields, refuses to mint without them, and its
     prompt tells the agent to run NONE of the executor's commands.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.cross_review_bridge import issue_implementation_envelope
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.production_shaped import production_converged_plan

from aria_kernel.implementation_safety import (
    ALLOWED_BASH_COMMANDS,
    BashAllowlistMiss,
    BashDenylistHit,
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


class NoPrOpensFromInsideTheSandboxTests(unittest.TestCase):
    def test_raw_gh_pr_create_is_an_allowlist_miss_with_no_flag_to_open_it(self) -> None:
        import os

        joined = " ".join(LEGACY_GH_PR_CREATE)
        for pattern in ALLOWED_BASH_COMMANDS:
            self.assertIsNone(pattern.match(joined), f"ALLOWED_BASH_COMMANDS admits raw gh pr create via {pattern.pattern!r}")
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                from unittest import mock

                with mock.patch.dict("os.environ", flag, clear=False):
                    os.environ.pop("ARIA_EXECUTOR_PR_VIA_KERNEL", None) if not flag else None
                    with self.assertRaises(BashAllowlistMiss):
                        verify_bash_command_allowed(LEGACY_GH_PR_CREATE)
        from aria_kernel import implementation_safety

        self.assertFalse(hasattr(implementation_safety, "LEGACY_GH_PR_CREATE_PATTERN"))
        self.assertFalse(hasattr(implementation_safety, "executor_pr_via_kernel"))

    def test_the_kernel_cli_is_refused_by_name_inside(self) -> None:
        """ARIA-HIGH-124 — `pr create`, `apply gate` and the rest of the kernel
        CLI are the executor's; inside the sandbox each is a DENY that names
        the rule, so the agent (and the decision ledger) read WHY."""
        for argv in (
            KERNEL_PR_CREATE, KERNEL_APPLY_GATE,
            ["python3", "-m", "aria_kernel", "autonomy", "run"],
            ["python3", "-m", "aria_kernel", "integrity", "verify"],
            ["python3", "-m", "aria_kernel", "apply", "scan-diff", "--diff-file", "/etc/shadow"],
            ["python3", "-m", "aria_kernel"],
            ["/usr/bin/python3.12", "-m", "aria_kernel", "mcp", "serve"],
            ["python", "-m", "aria_kernel", "pr", "create"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(BashDenylistHit) as ctx:
                    verify_bash_command_allowed(argv)
                self.assertIn("kernel_authority:kernel_cli", str(ctx.exception))

    def test_every_push_is_refused_by_name_inside(self) -> None:
        """ARIA-HIGH-124 — the executor pushes the published branch after the
        run with a credential the sandbox never holds; a push from inside has
        neither a reader for the token nor a place in the contract."""
        for argv in (
            ["git", "push", "origin", "aria-impl-0123abcd"],
            ["git", "push", "-u", "origin", "aria-impl-0123abcd"],
            ["git", "push"],
            ["git", "push", "origin", "main"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(BashDenylistHit) as ctx:
                    verify_bash_command_allowed(argv)
                self.assertIn("kernel_authority:git_push_any", str(ctx.exception))
        # A force-push still journals under its own hazard family.
        with self.assertRaises(BashDenylistHit) as ctx:
            verify_bash_command_allowed(["git", "push", "origin", "aria-impl-0123abcd", "-f"])
        self.assertIn("git_push_force", str(ctx.exception))

    def test_the_agents_own_git_stays_allowed(self) -> None:
        for argv in (["git", "status"], ["git", "add", "apps/x.ts"], ["git", "commit", "-m", "x"],
                     ["git", "diff", "--staged"], ["git", "rev-parse", "HEAD"], ["python3", "-m", "unittest", "tests.test_x"]):
            with self.subTest(argv=argv):
                verify_bash_command_allowed(argv)

    def test_gh_pr_merge_stays_denied(self) -> None:
        with self.assertRaises(BashDenylistHit):
            verify_bash_command_allowed(["gh", "pr", "merge", "42"])


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
            "cycle_id": "cycle-727",
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
        # ARIA-HIGH-124 — the prompt's STEPS tell the agent to run none of
        # the executor's commands: no switch (the kernel stood it on the
        # branch), no push, no gate, no PR opener; the one place those
        # spellings appear is the sentence that says they are refused.
        steps = prompt.split("</implementation_ids>", 1)[1].split("`git push`, `python3", 1)[0]
        for forbidden in ("aria_kernel apply gate", "aria_kernel pr create", "git switch", "git push", "gh pr create"):
            self.assertNotIn(forbidden, steps, forbidden)
        self.assertIn("are refused\ninside your sandbox by name", prompt)
        self.assertIn("already standing on <branch> at <base_sha>", prompt)
        self.assertIn("the executor then runs the apply", prompt)

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
        """The prompt used to say "Open PR via gh pr create --base main", then
        "python3 -m aria_kernel pr create"; the command policy refuses both
        inside the sandbox, so either instruction was a contradiction the agent
        could only resolve by failing (ARIA-HIGH-124)."""
        prompt = self._mint()["suggested_prompt"]
        self.assertNotIn("gh pr create --base main", prompt)
        self.assertNotIn("pr create --proposal-id", prompt)
        self.assertNotIn("apply gate --proposal-id", prompt)


if __name__ == "__main__":
    unittest.main()
