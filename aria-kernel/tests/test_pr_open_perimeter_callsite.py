"""ORPHAN-CRITICAL-428 — the pre-PR-open perimeter has a PRODUCTION caller.

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

        The only production route into open_pr_for_action is the cycle's
        pr_lifecycle phase with dry_run=True, so a gate that spared the dry-run
        path would be unreachable in production — the original defect wearing a
        different hat. A preview that reports `ok` while the perimeter would
        block is a false green, which is the failure mode this whole wave keeps
        finding.
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


if __name__ == "__main__":
    unittest.main()
