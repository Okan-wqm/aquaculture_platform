"""End-to-end CLI tests for `aria-kernel pr` (Plan 019 Phase 3).

Covers the argparser binding + dispatch path; pr_manager core behaviour
is already pinned by test_pr_manager_e2e.py. Each case shells out the
kernel main entry point with argv and asserts exit code + stdout JSON.

Why CLI tests separate from pr_manager tests: the binding adds argv
parsing + flag plumbing (e.g. --no-dry-run flips dry_run=False,
--base default snowball flows through to the explicit base guard).
A pr_manager unit test cannot exercise that surface.
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cli import main as cli_main
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.proposal import approve_proposal, record_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._gh_mock import gh_create_success, recorded_calls, reset_recorded


# ORPHAN-CRITICAL-428 — the product file this synthetic PR touches.
# open_pr_for_action now runs the pre-PR-open hard-fail perimeter, which
# refuses any action whose declared surfaces fall inside
# implementation_safety.READONLY_PATHS — `aria-kernel/aria_kernel/` among
# them. A PR over kernel sources is not a PR ARIA may open, so the CLI
# fixture declares a real product path; the branch commit below writes that
# same path so the declaration and the diff describe one change.
_CHANGED_FILE = "apps/farm-service/src/farm/services/water-quality.service.ts"


def _seed_tools() -> Path:
    import subprocess as _sp
    tmp = Path(tempfile.mkdtemp(prefix="aria-pr-cli-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    # Plan 020 Phase 1.B — pr_open is strict-only under the runtime
    # profile gate. The pr CLI tests intentionally drive the open_pr
    # path; opt into strict here so the gate does not short-circuit
    # before the test can exercise its argv-binding assertions.
    set_profile(
        "strict",
        operator_approval_ref="test:plan-020-phase-1.B:pr-cli",
        base_dir=tools,
        set_by="operator",
    )
    # Plan 023 v3 §P-3 — open_pr_for_action now fails hard when
    # `git rev-parse <branch>` fails. The seeded action carries
    # branch='aria/cli-test'; init a real git repo + create that
    # branch so rev-parse resolves to a real SHA and the CLI test is
    # exercising the CLI surface, not the git plumbing.
    _sp.run(["git", "init", "-q"], cwd=tmp, check=True)
    _sp.run(["git", "config", "user.email", "t@t.invalid"], cwd=tmp, check=True)
    _sp.run(["git", "config", "user.name", "t"], cwd=tmp, check=True)
    (tmp / "init.txt").write_text("init\n", encoding="utf-8")
    _sp.run(["git", "add", "init.txt"], cwd=tmp, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "init"],
        cwd=tmp, check=True, capture_output=True,
    )
    _sp.run(
        ["git", "checkout", "-q", "-b", "aria/cli-test"],
        cwd=tmp, check=True,
    )
    feature_file = tmp / _CHANGED_FILE
    feature_file.parent.mkdir(parents=True, exist_ok=True)
    feature_file.write_text(
        "export const WATER_QUALITY_SAMPLE_INTERVAL_MS = 60_000;\n",
        encoding="utf-8",
    )
    _sp.run(["git", "add", _CHANGED_FILE], cwd=tmp, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "feature"],
        cwd=tmp, check=True, capture_output=True,
    )
    return tmp


def _seed_proposal_and_action(*, repo: Path, proposal_id: str = "PROP-CLI-01") -> dict:
    import subprocess as _sp
    tools = repo / "aria-tools"
    # ORPHAN-CRITICAL-428 — the perimeter secret-scans `git diff
    # <base_sha>..<head_sha>`, and a diff it cannot produce counts as
    # UNVERIFIED, not clean. The placeholder "abcd1234" this fixture used to
    # declare resolves to no object in the seeded repo, so resolve the real
    # branch point instead: aria/cli-test is one commit ahead of it.
    base_sha = _sp.run(
        ["git", "rev-parse", "aria/cli-test~1"],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()
    proposal = record_proposal(
        kind="test_gap",
        title="Plan 019 Phase 3 PR CLI smoke",
        problem="Synthetic — exercises the pr CLI binding.",
        evidence=["docs/aria/SPEC.md:53", "docs/aria/CONTRACTS.md:8"],
        validation_command="nx test aria-kernel",
        proposed_change="Add the pr CLI sub-command surface.",
        base_dir=tools,
    )
    pid = proposal["proposal_id"]
    approve_proposal(
        proposal_id=pid,
        operator_approval_ref="operator-test:plan-019-phase-3",
        base_dir=tools,
    )
    action_row = {
        "schema_version": 1,
        "recorded_at": "2026-05-07T00:00:00Z",
        "proposal_id": pid,
        "workspace_root": str(repo),
        "base_sha": base_sha,
        "branch": "aria/cli-test",
        "worktree_path": str(repo / "aria-worktrees" / f"A-{pid}"),
        "changed_files": [_CHANGED_FILE],
        # ORPHAN-CRITICAL-461 — the canonical suite must appear as whole
        # entries, so this is a list of command strings (which is also the
        # shape apply_engine records: proposal.validation_scope.commands).
        # Sourced from the perimeter's own constant so the fixture cannot
        # drift out of sync with what the gate requires.
        "validation_commands": list(CANONICAL_VALIDATION_COMMANDS),
        "validation_gate_ref": "sha256:gate-ref-fake",
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


def _run_cli(argv: list[str]) -> tuple[int, str]:
    """Invoke kernel CLI main; return (exit_code, captured_stdout)."""
    captured = io.StringIO()
    saved = sys.argv
    sys.argv = ["aria-kernel"] + argv
    try:
        with redirect_stdout(captured):
            try:
                exit_code = cli_main()
            except SystemExit as exc:
                exit_code = int(exc.code or 0)
    finally:
        sys.argv = saved
    return exit_code, captured.getvalue()


class PrCliHelpTests(unittest.TestCase):
    """`aria-kernel pr --help` exits 0 with the six sub-commands listed."""

    def test_pr_help_lists_sub_commands(self) -> None:
        captured_err = io.StringIO()
        saved_argv = sys.argv
        saved_stderr = sys.stderr
        sys.argv = ["aria-kernel", "pr", "--help"]
        sys.stderr = captured_err
        try:
            with redirect_stdout(captured_err):
                try:
                    cli_main()
                except SystemExit as exc:
                    self.assertEqual(int(exc.code or 0), 0)
        finally:
            sys.argv = saved_argv
            sys.stderr = saved_stderr
        text = captured_err.getvalue()
        for sub in ("prepare", "commit", "push", "create", "list-actions",
                    "lifecycle-plan", "split-plan"):
            self.assertIn(sub, text)


class PrCliCreateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_tools()
        self.tools = self.repo / "aria-tools"
        self.proposal = _seed_proposal_and_action(repo=self.repo)
        self.pid = self.proposal["proposal_id"]
        reset_recorded()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_create_dry_run_default_records_pr_dry_run(self) -> None:
        exit_code, stdout = _run_cli([
            "pr", "create",
            "--tools-dir", str(self.tools),
            "--proposal-id", self.pid,
            "--workspace-root", str(self.repo),
        ])
        self.assertEqual(exit_code, 0)
        row = json.loads(stdout)
        self.assertEqual(row["base_branch"], "main")
        self.assertIn("## Problem", row["body"])
        self.assertIn("## Provenance", row["body"])

    def test_create_explicit_base_develop_rejected(self) -> None:
        # Plan 018 Phase 6.2 explicit base guard fires inside
        # open_pr_for_action and propagates up through cli main as a
        # GovernanceError. The CLI does not swallow it (the kernel's
        # contract is fail-loud on governance violations); the test
        # asserts the exception surfaces with the expected message so
        # operator scripts/CI workflows can pattern-match the failure.
        from aria_kernel.tool_registry import GovernanceError
        with self.assertRaisesRegex(GovernanceError, "ARIA PRs MUST target 'main'; got base='develop'"):
            _run_cli([
                "pr", "create",
                "--tools-dir", str(self.tools),
                "--proposal-id", self.pid,
                "--workspace-root", str(self.repo),
                "--base", "develop",
            ])

    def test_create_no_dry_run_invokes_gh(self) -> None:
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
            exit_code, stdout = _run_cli([
                "pr", "create",
                "--tools-dir", str(self.tools),
                "--proposal-id", self.pid,
                "--workspace-root", str(self.repo),
                "--change-id", "ch-test",  # Plan 026R §D.3
                "--no-dry-run",
            ])
        self.assertEqual(exit_code, 0)
        row = json.loads(stdout)
        self.assertEqual(row["base_branch"], "main")
        # Plan 022 §C-4 — recorded_calls() now contains BOTH the
        # `git rev-parse <branch>` head_sha resolution + the gh pr
        # create invocation. Filter to gh_calls for the binding assertion.
        calls = recorded_calls()
        gh_calls = [c for c in calls if c.argv[:3] == ["gh", "pr", "create"]]
        self.assertEqual(len(gh_calls), 1)
        argv = gh_calls[0].argv
        self.assertIn("--base", argv)
        self.assertEqual(argv[argv.index("--base") + 1], "main")


class PrCliListActionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_tools()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_list_actions_empty_returns_empty_array(self) -> None:
        exit_code, stdout = _run_cli([
            "pr", "list-actions",
            "--tools-dir", str(self.tools),
        ])
        self.assertEqual(exit_code, 0)
        rows = json.loads(stdout)
        self.assertEqual(rows, [])

    def test_list_actions_after_seed_returns_rows(self) -> None:
        # Seed a synthetic action row directly in the ledger.
        append_declared_fixture(
            self.tools / "pr-actions.jsonl",
            {
                "schema_version": 1,
                "proposal_id": "PROP-X",
                "branch": "aria/seed",
                "action": "prepare_branch",
                "status": "planned",
                "dry_run": True,
            },
            expected_surface="pr_actions",
        )
        exit_code, stdout = _run_cli([
            "pr", "list-actions",
            "--tools-dir", str(self.tools),
        ])
        self.assertEqual(exit_code, 0)
        rows = json.loads(stdout)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["proposal_id"], "PROP-X")


class PrCliLifecyclePlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_tools()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_lifecycle_plan_emits_recommendation_for_stale_pr(self) -> None:
        prs_file = self.repo / "open_prs.json"
        prs_file.write_text(json.dumps([
            {"number": 42, "updated_at": "2026-04-01T00:00:00Z",
             "title": "old PR", "proposal_id": "PROP-old"},
        ]), encoding="utf-8")
        exit_code, stdout = _run_cli([
            "pr", "lifecycle-plan",
            "--tools-dir", str(self.tools),
            "--open-prs-file", str(prs_file),
            "--cycle-id", "plan-019-phase-3-test",
        ])
        self.assertEqual(exit_code, 0)
        row = json.loads(stdout)
        self.assertEqual(row["status"], "recommendation_only")
        self.assertEqual(len(row["actions"]), 1)
        self.assertEqual(row["actions"][0]["action"], "recommend_close")


class PrCliSplitPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_tools()
        self.tools = self.repo / "aria-tools"
        self.proposal = _seed_proposal_and_action(repo=self.repo)
        self.pid = self.proposal["proposal_id"]

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_split_plan_groups_files(self) -> None:
        exit_code, stdout = _run_cli([
            "pr", "split-plan",
            "--tools-dir", str(self.tools),
            "--proposal-id", self.pid,
            "--changed-file", "apps/farm-service/src/foo.ts",
            "--changed-file", "apps/farm-service/src/bar.ts",
            "--changed-file", "apps/sensor-service/src/baz.ts",
            "--max-files-per-pr", "10",
        ])
        self.assertEqual(exit_code, 0)
        row = json.loads(stdout)
        self.assertEqual(row["status"], "planned")
        # 3 files across 2 service groups -> 2 PR groups, no split needed
        self.assertGreaterEqual(len(row["prs"]), 2)


if __name__ == "__main__":
    unittest.main()
