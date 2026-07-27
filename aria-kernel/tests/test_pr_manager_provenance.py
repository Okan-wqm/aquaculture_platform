"""Plan 022 C-4 — PR provenance head_sha + PR number parse tests.

Pre-Plan-022 open_pr_for_action wrote payload['head_sha'] = base_sha
(wrong: head and base conflated) and never parsed the PR number from
gh stdout. Auto-merge / provenance ledger consumed misidentified
commit data.

This suite pins the C-4 fix:
1. head_sha resolved via `git rev-parse <action.branch>` (real proposal
   commit) and is distinct from base_sha.
2. PR number parsed via robust regex r'https?://.../pull/(\\d+)(?:\\s|$)':
   - canonical URL.
   - trailing newline.
   - extra stdout diagnostic lines + URL.
3. URL parse failure raises GovernanceError('pr_create_url_unparseable').
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
from aria_kernel.proposal import approve_proposal, record_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


# The product file the synthetic proposal touches. One constant so the seeded
# commit and the action's declared changed_files cannot drift: the pre-PR-open
# hard-fail perimeter compares the declaration against READONLY_PATHS, so a
# fixture naming an aria-kernel/ path (or nothing at all) is refused before it
# ever reaches the provenance behaviour these tests pin.
CHANGED_FILE = "apps/farm-service/src/water-quality/water-quality.service.ts"


class _GhResult:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _seed_workspace() -> tuple[Path, Path, str]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-c4-prov-"))
    repo = tmp / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "README.md").write_text("# r\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True, capture_output=True)
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True,
    ).stdout.strip()
    # Create + commit a fake proposal branch with a different SHA.
    subprocess.run(["git", "checkout", "-q", "-b", "aria/test-proposal"], cwd=repo, check=True)
    patch_target = repo / CHANGED_FILE
    patch_target.parent.mkdir(parents=True, exist_ok=True)
    patch_target.write_text("export const WATER_QUALITY_SAMPLE_MS = 60000;\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "proposal commit"], cwd=repo, check=True, capture_output=True)
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    set_profile(
        "strict",
        operator_approval_ref="test:plan-022-c4",
        base_dir=tools, set_by="test-fixture",
    )
    return tools, repo, base_sha


def _seed_action_and_proposal(*, tools: Path, repo: Path, base_sha: str, proposal_id: str = "PROP-C4") -> dict:
    proposal = record_proposal(
        kind="test_gap",
        title="Plan 022 C-4 PR provenance test",
        problem="Synthetic provenance test.",
        evidence=["docs/aria/SPEC.md:53"],
        validation_command="nx test",
        proposed_change="C-4 fix verification.",
        base_dir=tools,
    )
    approve_proposal(proposal_id=proposal["proposal_id"],
                     operator_approval_ref="ops:c4-test",
                     base_dir=tools)
    action_row = {
        "schema_version": 1,
        "recorded_at": "2026-05-08T00:00:00Z",
        "proposal_id": proposal["proposal_id"],
        "workspace_root": str(repo),
        "base_sha": base_sha,
        "branch": "aria/test-proposal",
        "worktree_path": str(repo),
        "changed_files": [CHANGED_FILE],
        # The canonical suite, sourced from the perimeter's own constant so the
        # fixture cannot drift from what test_gate_canonical_suite requires.
        # Each command is its own entry — one string mentioning all three does
        # not count (ORPHAN-CRITICAL-461).
        "validation_commands": list(CANONICAL_VALIDATION_COMMANDS),
        "validation_gate_ref": "sha256:gate-fake",
        "validation_gate_status": "ready_for_pr",
        "validation_gate_blocked_by": [],
        "status": "ready_for_pr",
        "blocked_by": [],
    }
    append_declared_fixture(
        tools / "apply" / "actions.jsonl",
        action_row,
        expected_surface="apply_actions",
    )
    return proposal


class HeadShaResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo, self.base_sha = _seed_workspace()
        self.proposal = _seed_action_and_proposal(tools=self.tools, repo=self.repo, base_sha=self.base_sha)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_head_sha_distinct_from_base_sha(self) -> None:
        # dry_run path skips gh subprocess; we can verify head_sha resolution.
        row = open_pr_for_action(
            proposal_id=self.proposal["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
        )
        self.assertIsNotNone(row["head_sha"])
        self.assertNotEqual(row["head_sha"], self.base_sha,
            "head_sha must point at proposal branch HEAD, not base_sha")
        self.assertEqual(row["base_sha"], self.base_sha)


class PrNumberParseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo, self.base_sha = _seed_workspace()
        self.proposal = _seed_action_and_proposal(tools=self.tools, repo=self.repo, base_sha=self.base_sha)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def _run_with_stdout(self, stdout: str) -> dict:
        # Save the unpatched subprocess.run reference BEFORE patching so the
        # git rev-parse fallback inside the mock doesn't recurse into the
        # mock itself.
        real_run = subprocess.run
        with patch("aria_kernel.pr_manager.subprocess.run") as mock_run:
            def fake_run(argv, **kw):
                # Defer ALL git, not just rev-parse. This mock exists to stand
                # in for `gh pr create`; every git call open_pr_for_action
                # makes must reach the real repo. When only rev-parse was
                # passed through, the perimeter's `git diff base..head` fell
                # through to the gh stdout fixture, so
                # secret_scan_diff_clean scanned a PR URL — or, for the
                # empty-stdout case, "" — instead of a diff. An empty string
                # is a VALID CLEAN diff, so the check passed vacuously: green
                # for the wrong reason, which is the defect class
                # ORPHAN-CRITICAL-428 exists to remove, reproduced inside the
                # very tests that cover it.
                if argv[:1] == ["git"]:
                    return real_run(argv, **kw)
                return _GhResult(stdout=stdout, returncode=0)
            mock_run.side_effect = fake_run
            return open_pr_for_action(
                proposal_id=self.proposal["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                change_id="ch-test", dry_run=False,
            )

    def test_canonical_url_parses(self) -> None:
        row = self._run_with_stdout("https://github.com/o/r/pull/42")
        # record_pr_lifecycle persists pr_number; the raw URL stays in
        # the input payload but does not survive into the lifecycle row.
        self.assertEqual(row["pr_number"], 42)

    def test_trailing_newline_url_parses(self) -> None:
        row = self._run_with_stdout("https://github.com/o/r/pull/123\n")
        self.assertEqual(row["pr_number"], 123)

    def test_extra_diagnostic_then_url_parses(self) -> None:
        # gh sometimes prints diagnostic lines before the URL.
        stdout = (
            "Creating pull request for aria/test-proposal into main...\n"
            "https://github.com/o/r/pull/777\n"
        )
        row = self._run_with_stdout(stdout)
        self.assertEqual(row["pr_number"], 777)

    def test_empty_stdout_raises_governance_error(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            self._run_with_stdout("")
        self.assertIn("pr_create_url_unparseable", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
