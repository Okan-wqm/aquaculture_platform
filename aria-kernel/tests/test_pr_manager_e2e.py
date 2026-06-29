"""End-to-end PR pipeline tests (Plan 017 Phase 3, closes DEBT-2026-05-07-004).

Walks proposal -> approve -> apply action -> validation gate -> open PR
under a mock gh API factory. Asserts:

- PR body carries the seven required sections (Problem, Evidence, Solution,
  Validation, Baseline Comparison, Rollback, Provenance).
- gh subprocess is invoked with `--base main` (hardcoded in
  pr_manager); a different base never appears.
- Action without `ready_for_pr` status cannot open a PR.
- gh API failure surfaces as `GovernanceError`.
- push_prepared_branch refuses to push protected base branches.


Plus the apply_engine.gate_apply_action `diff_text` extension:
- Diff containing a banned suppression (e.g. `// @ts-ignore`) flips the
  action status to `blocked` with `suppression_pattern` in `blocked_by`.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.apply_engine import gate_apply_action
from aria_kernel.pr_manager import (
    build_pr_body,
    open_pr_for_action,
    push_prepared_branch,
)
from aria_kernel.proposal import approve_proposal, record_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._gh_mock import (
    gh_create_failure,
    gh_create_success,
    recorded_calls,
    reset_recorded,
)


def _seed_tools() -> Path:
    import subprocess as _sp
    tmp = Path(tempfile.mkdtemp(prefix="aria-pr-e2e-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    # Plan 020 Phase 1.B — pr_open is strict-only under the new runtime
    # profile gate. PR-manager tests intentionally exercise the open_pr
    # path, so the seed bumps the profile to strict (with an explicit
    # test-fixture operator_approval_ref). Profile gate is the safety
    # boundary; the test explicitly opts into the boundary it is testing.
    set_profile(
        "strict",
        operator_approval_ref="test:plan-020-phase-1.B:pr-manager-e2e",
        base_dir=tools,
        set_by="test-fixture",
    )
    # Plan 023 v3 §P-3 — open_pr_for_action now fails hard when
    # `git rev-parse <branch>` fails. _seed_apply_action uses a fixed
    # `aria/test-proposal` branch; init a real git repo + create the
    # branch so rev-parse resolves to a real SHA and the existing
    # tests stay portable.
    workspace = tools.parent
    _sp.run(["git", "init", "-q"], cwd=workspace, check=True)
    _sp.run(["git", "config", "user.email", "t@t.invalid"], cwd=workspace, check=True)
    _sp.run(["git", "config", "user.name", "t"], cwd=workspace, check=True)
    (workspace / "init.txt").write_text("init\n", encoding="utf-8")
    _sp.run(["git", "add", "init.txt"], cwd=workspace, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "init"],
        cwd=workspace, check=True, capture_output=True,
    )
    _sp.run(
        ["git", "checkout", "-q", "-b", "aria/test-proposal"],
        cwd=workspace, check=True,
    )
    (workspace / "feature.txt").write_text("feature\n", encoding="utf-8")
    _sp.run(["git", "add", "feature.txt"], cwd=workspace, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "feature"],
        cwd=workspace, check=True, capture_output=True,
    )
    return tools


def _seed_apply_action(
    *,
    tools: Path,
    proposal_id: str,
    status: str,
    base_sha: str = "abcd1234",
    branch: str = "aria/test-proposal",
) -> dict:
    """Bypass plan_apply_worktree (which needs git) and write the action row directly.

    Plan 017 Phase 3 verifies the gate logic, not the worktree planner. The
    seeded action row mirrors what plan_apply_worktree -> gate_apply_action
    would have produced for a passing validation gate.
    """
    row = {
        "schema_version": 1,
        "recorded_at": "2026-05-07T00:00:00Z",
        "proposal_id": proposal_id,
        "workspace_root": str(tools.parent),
        "base_sha": base_sha,
        "branch": branch,
        "worktree_path": str(tools.parent / "aria-worktrees" / f"A-{proposal_id}"),
        "changed_files": ["aria-kernel/aria_kernel/test_module.py"],
        "validation_commands": [{"cmd": "nx test aria-kernel", "expected_exit": 0, "timeout_ms": 60000}],
        "validation_gate_ref": "sha256:gate-ref-fake",
        "validation_gate_status": "ready_for_pr",
        "validation_gate_blocked_by": [],
        "status": status,
        "blocked_by": [],
    }
    append_declared_fixture(
        tools / "apply" / "actions.jsonl",
        row,
        expected_surface="apply_actions",
    )
    return row


def _seed_proposal(*, tools: Path, proposal_id: str = "PROP-0001") -> dict:
    proposal = record_proposal(
        kind="test_gap",
        title="Plan 017 Phase 3 sample proposal",
        problem="Synthetic test proposal — exercises the PR pipeline end to end.",
        evidence=["docs/aria/SPEC.md:53", "docs/aria/CONTRACTS.md:8"],
        validation_command="nx test aria-kernel",
        proposed_change="Land the integration test that closes DEBT-2026-05-07-004.",
        base_dir=tools,
    )
    pid = proposal["proposal_id"]
    approve_proposal(
        proposal_id=pid,
        operator_approval_ref="operator-test:plan-017-phase-3",
        base_dir=tools,
    )
    return proposal


class PRBodySectionsTests(unittest.TestCase):
    """Verify build_pr_body produces all seven required sections."""

    def test_body_has_seven_required_sections(self) -> None:
        proposal = {
            "proposal_id": "PROP-X",
            "task_id": "TASK-Y",
            "title": "Sample title",
            "problem": "Sample problem statement",
            "evidence": ["docs/aria/SPEC.md:53"],
            "proposed_change": "Sample change",
        }
        action = {
            "base_sha": "abcd1234",
            "validation_commands": [{"cmd": "nx test", "expected_exit": 0, "timeout_ms": 60000}],
            "validation_run_refs": ["sha256:run-ref"],
            "worktree_path": "/tmp/wt",
        }
        body = build_pr_body(proposal=proposal, action=action)
        for section in (
            "## Problem",
            "## Evidence",
            "## Solution",
            "## Validation",
            "## Baseline Comparison",
            "## Rollback",
            "## Provenance",
        ):
            self.assertIn(section, body, f"missing section {section}")


class OpenPRForActionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent
        reset_recorded()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_dry_run_records_pr_dry_run_event_with_seven_section_body(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        result = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
        )
        self.assertEqual(result["base_branch"], "main")
        self.assertIn("## Problem", result["body"])
        self.assertIn("## Provenance", result["body"])

    def test_claim_id_change_requires_expert_consensus(self) -> None:
        # Plan 031-R R2 (B1) — a real PR for an ARIA-authored change (claim_id)
        # cannot open without an evidence-verified expert consensus on record.
        from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        planned = emit_change_planned(
            plan_id="p", finding_id="F-1", intended_affected_files=["x.ts"],
            intended_validation_refs=["nx test"], architectural_tier=1, base_dir=self.tools,
        )
        emit_change_committed(
            change_id=planned["change_id"], commit_sha="c1",
            actual_affected_files=["x.ts"], base_dir=self.tools, claim_id="claim-1",
        )
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
            with self.assertRaises(GovernanceError) as cm:
                open_pr_for_action(
                    proposal_id=proposal["proposal_id"], workspace_root=self.repo,
                    base_dir=self.tools, change_id=planned["change_id"], dry_run=False,
                )
        self.assertIn("expert_consensus_verdict_missing", str(cm.exception))

    def test_action_not_ready_for_pr_raises(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="blocked")
        with self.assertRaisesRegex(GovernanceError, "validation gate"):
            open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
            )

    def test_open_pr_invokes_gh_with_base_main(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
            result = open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                change_id="ch-test", dry_run=False,
            )
        self.assertEqual(result["base_branch"], "main")
        # Plan 022 §C-4 — open_pr_for_action now also calls
        # `git rev-parse <branch>` to resolve the real head_sha; the
        # call log captures BOTH that git call AND the gh pr create call.
        calls = recorded_calls()
        gh_calls = [c for c in calls if c.argv[:3] == ["gh", "pr", "create"]]
        git_calls = [c for c in calls if c.argv[:2] == ["git", "rev-parse"]]
        self.assertEqual(len(gh_calls), 1)
        self.assertEqual(len(git_calls), 1)
        argv = gh_calls[0].argv
        self.assertIn("--title", argv)
        self.assertEqual(argv[argv.index("--title") + 1], proposal["title"])

    def test_gh_failure_raises_governance_error(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_failure):
            with self.assertRaisesRegex(GovernanceError, "insufficient permissions"):
                open_pr_for_action(
                    proposal_id=proposal["proposal_id"],
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    change_id="ch-test", dry_run=False,
                )

    def test_explicit_base_develop_is_rejected_at_function_entry(self) -> None:
        # Plan 018 Phase 6.2 (G7) — open_pr_for_action MUST surface the
        # main-only invariant at the function boundary, not just at
        # the gh argv hardcoded value. The explicit base parameter
        # rejection runs BEFORE proposal lookup so a misconfigured
        # caller cannot leak any state through the call.
        with self.assertRaisesRegex(GovernanceError, "ARIA PRs MUST target 'main'; got base='develop'"):
            open_pr_for_action(
                proposal_id="PROP-NONEXISTENT",  # unreachable — base check fires first
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
                base="develop",
            )

    def test_explicit_base_main_passes_through(self) -> None:
        # The default value is main; explicit base="main" must
        # behave identically to no-arg.
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        result = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
            base="main",
        )
        self.assertEqual(result["base_branch"], "main")


class PushBaseBranchProtectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_push_rejects_snowball_branch(self) -> None:
        # Historical ARIA work branch remains protected from direct push.
        commit_row = {
            "schema_version": 1,
            "proposal_id": "PROP-Z",
            "branch": "snowball",
            "action": "commit",
            "status": "committed",
        }
        append_declared_fixture(
            self.tools / "pr-actions.jsonl",
            commit_row,
            expected_surface="pr_actions",
        )
        with self.assertRaisesRegex(GovernanceError, "base branch push is forbidden|aria/\\.\\.\\. branches"):
            push_prepared_branch(
                proposal_id="PROP-Z",
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=False,
            )

    def test_push_rejects_main_branch(self) -> None:
        commit_row = {
            "schema_version": 1,
            "proposal_id": "PROP-Z",
            "branch": "main",
            "action": "commit",
            "status": "committed",
        }
        append_declared_fixture(
            self.tools / "pr-actions.jsonl",
            commit_row,
            expected_surface="pr_actions",
        )
        with self.assertRaisesRegex(GovernanceError, "base branch push is forbidden|aria/\\.\\.\\. branches"):
            push_prepared_branch(
                proposal_id="PROP-Z",
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=False,
            )


class ApplyGateSuppressionScanTests(unittest.TestCase):
    """Plan 017 Phase 3.3 — gate_apply_action diff_text optional kwarg."""

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _seed_validation_gate_row(self, comparison_ref: str = "sha256:cmp-ref") -> str:
        # Validation rows live under tools/validation/. Seed a passing one.
        gate_row = {
            "schema_version": 1,
            "comparison_ref": comparison_ref,
            "status": "ready_for_pr",
            "blocked_by": [],
            "ledger_hash": "sha256:gate-ledger-hash",
            "previous_ledger_hash": None,
        }
        append_declared_fixture(
            self.tools / "validation" / "validation-gates.jsonl",
            gate_row,
            expected_surface="validation_gates",
        )
        return comparison_ref

    def _seed_proposal_and_action(self) -> str:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="planned")
        return proposal["proposal_id"]

    def test_clean_diff_lets_gate_pass(self) -> None:
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        clean_diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+const y = 2;\n"
        )
        # Patch evaluate_validation_gate to return our seeded shape directly.
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            row = gate_apply_action(
                proposal_id=pid,
                validation_comparison_ref=cmp_ref,
                base_dir=self.tools,
                diff_text=clean_diff,
            )
        self.assertEqual(row["status"], "ready_for_pr")
        self.assertEqual(row["suppression_matches"], [])
        self.assertNotIn("suppression_pattern", row["blocked_by"])

    def test_diff_with_ts_ignore_blocks_action(self) -> None:
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        bad_diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+// @ts-ignore\n"
        )
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            row = gate_apply_action(
                proposal_id=pid,
                validation_comparison_ref=cmp_ref,
                base_dir=self.tools,
                diff_text=bad_diff,
            )
        self.assertEqual(row["status"], "blocked")
        self.assertIn("suppression_pattern", row["blocked_by"])
        self.assertEqual(len(row["suppression_matches"]), 1)
        self.assertEqual(row["suppression_matches"][0]["category"], "ts_masking")

    def test_no_diff_text_now_fails_closed(self) -> None:
        # Plan 022 §H-1 — pre-fix gate_apply_action(diff_text=None)
        # silently skipped suppression scan and returned ready_for_pr.
        # That was the bug. Post-fix: caller MUST either pass a diff
        # explicitly OR seed the action with branch+base_sha so the
        # fallback can run `git diff base..branch`. The test now
        # asserts the new fail-closed contract.
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            with self.assertRaises(GovernanceError) as cm:
                gate_apply_action(
                    proposal_id=pid,
                    validation_comparison_ref=cmp_ref,
                    base_dir=self.tools,
                    # diff_text=None implicit
                )
        self.assertIn("suppression_scan_requires_diff_content", str(cm.exception))

    def test_empty_diff_text_explicit_rejected_post_d6(self) -> None:
        # Plan 026R §D.6 INVERSION — the pre-§D.6 contract said "an
        # explicit empty diff is a valid no-content claim; suppression
        # scan over empty input returns zero matches". §D.6 invalidates
        # that: an empty diff is NOT a clean diff. The gate now
        # raises on empty diff_text explicitly, structurally
        # impossible to pass.
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            with self.assertRaises(GovernanceError) as ctx:
                gate_apply_action(
                    proposal_id=pid,
                    validation_comparison_ref=cmp_ref,
                    base_dir=self.tools,
                    diff_text="",
                )
        self.assertIn("empty", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
