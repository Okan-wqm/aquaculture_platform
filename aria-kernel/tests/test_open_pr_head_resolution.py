"""Plan 023 v3 §P-3 — open_pr_for_action --head + rev-parse fail-hard.

Pre-Plan-023 open_pr_for_action's `gh pr create` argv did not include
`--head <branch>`. gh inferred the branch from the current checkout,
which could be wrong (the worktree might not be on action.branch when
gate ran). Plus the rev-parse path was fail-soft: a missing branch or
git failure left resolved_head_sha=None silently on the proposal
payload. Auto-merge later compared head_sha to latest_head_sha — if
both were None, the comparison passed spuriously.

Plan 023 v3 §P-3 fix:
* `gh pr create` argv always includes `--head {branch}`.
* Missing branch on action → GovernanceError('open_pr_branch_missing')
  (rather than reaching gh with an unclear failure).
* `git rev-parse <branch>` failure → GovernanceError(
  'open_pr_head_sha_unresolvable: <stderr>') (rather than silent None).

Tests:
1. Missing branch on action → GovernanceError.
2. rev-parse fails (gh subprocess returns non-zero) → GovernanceError.
3. (Implicit baseline regression: when valid, --head is in argv. Hard
   to test without mocking gh; covered indirectly via the existing
   pr_manager tests.)
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.pr_manager import open_pr_for_action
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


# The product file the synthetic proposal touches. One constant so the branch
# commit and the action's declared changed_files cannot drift: the pre-PR-open
# hard-fail perimeter compares the declaration against READONLY_PATHS, so a
# fixture naming an aria-kernel/ path (or nothing at all) is refused before it
# ever reaches the head-resolution behaviour these tests pin.
CHANGED_FILE = "apps/farm-service/src/pond/pond.service.ts"


class OpenPrHeadResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-p3-"))
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        # Initialize a real git repo so rev-parse can succeed for the
        # happy path. Branch creation handled per-test.
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        subprocess.run(
            ["git", "config", "user.email", "t@t.invalid"],
            cwd=self.workspace, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "t"], cwd=self.workspace, check=True,
        )
        (self.workspace / "x.ts").write_text("export const x = 1;\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"],
            cwd=self.workspace, check=True, capture_output=True,
        )
        # A real base SHA, not a placeholder: the perimeter's secret scan
        # reads `git diff <base_sha>..<head>`, so a base that does not
        # resolve describes a PR nothing could have diffed.
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.workspace, check=True, capture_output=True, text=True,
        ).stdout.strip()
        self.base_dir = self.tmp / "aria-tools"
        self.base_dir.mkdir()
        # open_pr_for_action enforces runtime profile = 'strict' (Plan
        # 020 §1.B). Test fixture sets the profile to 'strict' via the
        # control-plane API.
        from aria_kernel.runtime_profile import set_profile
        set_profile(
            "strict",
            operator_approval_ref="test-fixture",
            base_dir=self.base_dir,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_proposal_and_action(self, *, branch: str | None) -> str:
        """Seed minimum proposal + apply-action ledger rows for the
        open_pr_for_action call to find. Returns proposal_id."""
        proposal_id = "p-test"
        proposal = {
            "schema_version": 1,
            "proposal_id": proposal_id,
            "task_id": "task-test",
            "title": "Test PR",
            "status": "approved_for_apply",
            # ORPHAN-CRITICAL-728 — an approval names WHO granted it.
            # `open_pr_for_action` refuses a row in `approved_for_apply` that
            # records neither an operator nor a machine grant, because a
            # proposal nobody is recorded as having approved is not approved;
            # this fixture is an operator's, so it says so.
            "approval_source": "operator",
            "operator_approval_ref": "operator:test-fixture:plan-023-p3",
            "kind": "external",
            "evidence": [],
            "validation_scope": {"commands": ["nx test x"]},
        }
        append_declared_fixture(
            self.base_dir / "proposals" / "proposals.jsonl",
            proposal,
            expected_surface="proposals",
        )
        action = {
            "schema_version": 1,
            "proposal_id": proposal_id,
            "workspace_root": str(self.workspace),
            "base_sha": self.base_sha,
            "worktree_path": str(self.workspace),
            "branch": branch,
            "status": "ready_for_pr",
            "validation_gate_ref": "sha256:gate-ref",
            "changed_files": [CHANGED_FILE],
            # The canonical suite, sourced from the perimeter's own constant
            # so the fixture cannot drift from what test_gate_canonical_suite
            # requires. Each command is its own entry — one string mentioning
            # all three does not count (ORPHAN-CRITICAL-461).
            "validation_commands": list(CANONICAL_VALIDATION_COMMANDS),
        }
        append_declared_fixture(
            self.base_dir / "apply" / "actions.jsonl",
            action,
            expected_surface="apply_actions",
        )
        return proposal_id

    def test_missing_branch_raises_specific_error(self) -> None:
        """Plan 023 §P-3: action without branch → explicit
        open_pr_branch_missing error (was silent None pre-fix)."""
        proposal_id = self._seed_proposal_and_action(branch=None)
        with self.assertRaises(GovernanceError) as ctx:
            open_pr_for_action(
                proposal_id=proposal_id,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        self.assertIn("open_pr_branch_missing", str(ctx.exception))

    def test_rev_parse_failure_raises_specific_error(self) -> None:
        """Plan 023 §P-3: branch not resolvable via git rev-parse →
        open_pr_head_sha_unresolvable. Was silently None pre-fix."""
        proposal_id = self._seed_proposal_and_action(branch="aria/nonexistent-branch")
        with self.assertRaises(GovernanceError) as ctx:
            open_pr_for_action(
                proposal_id=proposal_id,
                workspace_root=self.workspace,
                base_dir=self.base_dir,
                dry_run=True,
            )
        self.assertIn("open_pr_head_sha_unresolvable", str(ctx.exception))

    def test_dry_run_with_valid_branch_succeeds_and_resolves_head_sha(self) -> None:
        """Happy path: valid branch + dry_run produces a row with
        resolved_head_sha populated and base_sha distinct."""
        # Create a real branch with a commit.
        subprocess.run(
            ["git", "checkout", "-q", "-b", "aria/feature-test"],
            cwd=self.workspace, check=True,
        )
        feature = self.workspace / CHANGED_FILE
        feature.parent.mkdir(parents=True, exist_ok=True)
        feature.write_text("export const POND_SAMPLE_MS = 60000;\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "feature"],
            cwd=self.workspace, check=True, capture_output=True,
        )
        proposal_id = self._seed_proposal_and_action(branch="aria/feature-test")
        result = open_pr_for_action(
            proposal_id=proposal_id,
            workspace_root=self.workspace,
            base_dir=self.base_dir,
            dry_run=True,
        )
        self.assertIsNotNone(result.get("head_sha"))
        self.assertEqual(len(result["head_sha"]), 40)  # full git SHA
        # base_sha and head_sha are distinct concepts.
        self.assertEqual(result.get("base_sha"), self.base_sha)
        self.assertNotEqual(result["head_sha"], result["base_sha"])


if __name__ == "__main__":
    unittest.main()
