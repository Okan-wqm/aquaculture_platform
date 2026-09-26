"""ARIA-HIGH-217 — a lane evaluates the pre-merge perimeter on the PR it judges.

The perimeter reads a committed snapshot at the PR head, and its branch-tip
lock reads HEAD, the PR branch and the base branch. The merge lane and the
claim lane check out ``main``, so the capture stopped at
``committed_snapshot_unavailable`` and the lock at
``native_branch_tip_changed``, every time. The perimeter could never pass,
and the expert-review requests it gated were never made.

* ``merge_lane_workspace.pr_head_workspace`` shapes that workspace: a
  worktree of the lane's (detached) checkout on the PR head, the base branch
  at the implementation base, every ref put back afterwards.
* ``merge_authority`` evaluates the perimeter in it, and only evaluates.
* The expert panel is requested at claim time
  (``readiness request-expert-review``), on the PR head.
* Both lanes detach their checkout from main first.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml  # type: ignore[import-untyped]

from aria_kernel.merge_lane_workspace import MergeLaneWorkspaceRefusal, pr_head_workspace

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRANCH = "aria-impl-0123456789abcdef"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _ref(cwd: Path, ref: str) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", ref], cwd=cwd, capture_output=True, text=True,
    )
    return completed.stdout.strip() if completed.returncode == 0 else None


class _Origin(unittest.TestCase):
    """An origin with main and one PR (``refs/pull/7/head``), and a lane clone
    that checked out main only — the shape actions/checkout leaves."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.scratch = self.base / "scratch"
        self.origin = self.base / "origin.git"
        self.origin.mkdir()
        _git(self.origin, "init", "--bare", "--initial-branch=main", ".")
        author = self.base / "author"
        author.mkdir()
        for argv in (
            ("init", "--initial-branch=main", "."),
            ("config", "user.email", "aria@example.invalid"),
            ("config", "user.name", "ARIA Test"),
            ("config", "commit.gpgsign", "false"),
            ("remote", "add", "origin", str(self.origin)),
        ):
            _git(author, *argv)
        (author / "README.md").write_text("seed\n", encoding="utf-8")
        _git(author, "add", "README.md")
        _git(author, "commit", "-m", "seed")
        self.implementation_base = _git(author, "rev-parse", "HEAD")
        _git(author, "push", "origin", "main")
        _git(author, "checkout", "-b", _BRANCH)
        (author / "change.txt").write_text("the change\n", encoding="utf-8")
        _git(author, "add", "change.txt")
        _git(author, "commit", "-m", "the change")
        self.head = _git(author, "rev-parse", "HEAD")
        _git(author, "push", "origin", f"{_BRANCH}:refs/pull/7/head")
        self.author = author
        self.lane = self.base / "lane"
        subprocess.run(
            # --no-local: a path clone would copy every object, the PR head
            # included; a lane's checkout holds main's history only.
            ["git", "clone", "--quiet", "--no-local", "--single-branch", "--branch", "main",
             str(self.origin), str(self.lane)],
            check=True, capture_output=True,
        )
        _git(self.lane, "checkout", "--quiet", "--detach")

    def _move_main_ahead(self) -> str:
        _git(self.author, "checkout", "--quiet", "main")
        (self.author / "moved-on.txt").write_text("main moved on\n", encoding="utf-8")
        _git(self.author, "add", "moved-on.txt")
        _git(self.author, "commit", "-m", "main moves on")
        _git(self.author, "push", "origin", "main")
        return _git(self.author, "rev-parse", "HEAD")

    def _pr(self, **overrides) -> dict:
        pr = {
            "number": 7, "state": "OPEN", "base_branch": "main", "base_sha": self.implementation_base,
            "head_ref": _BRANCH, "head_sha": self.head,
        }
        pr.update(overrides)
        return pr


class PrHeadWorkspaceTests(_Origin):
    def test_the_workspace_stands_where_the_perimeter_reads(self) -> None:
        self.assertIsNone(_ref(self.lane, f"{self.head}^{{commit}}"))
        main_before = _ref(self.lane, "refs/heads/main")
        with pr_head_workspace(source_root=self.lane, pr=self._pr(), scratch_root=self.scratch) as workspace:
            self.assertNotEqual(workspace.resolve(), self.lane.resolve())
            # What implementation_safety._check_branch_tip_lock_and_recheck reads.
            self.assertEqual(_ref(workspace, "HEAD"), self.head)
            self.assertEqual(_ref(workspace, f"refs/heads/{_BRANCH}"), self.head)
            self.assertEqual(_ref(workspace, "refs/heads/main"), self.implementation_base)
            self.assertEqual(_git(workspace, "status", "--porcelain"), "")
            self.assertTrue((workspace / "change.txt").is_file())
        # Every ref is put back; the worktree is gone.
        self.assertEqual(_ref(self.lane, "refs/heads/main"), main_before)
        self.assertIsNone(_ref(self.lane, f"refs/heads/{_BRANCH}"))
        self.assertIsNone(_ref(self.lane, "refs/aria/merge-lane/pr-7"))
        self.assertFalse(workspace.exists())
        self.assertEqual(len(_git(self.lane, "worktree", "list", "--porcelain").split("\n\n")), 1)

    def test_main_moved_ahead_stands_the_base_at_the_fork_point(self) -> None:
        live_base = self._move_main_ahead()
        _git(self.lane, "fetch", "--quiet", "origin", "main:refs/heads/main")
        with pr_head_workspace(
            source_root=self.lane, pr=self._pr(base_sha=live_base), scratch_root=self.scratch,
        ) as workspace:
            self.assertEqual(_ref(workspace, "refs/heads/main"), self.implementation_base)
            self.assertEqual(_ref(workspace, "HEAD"), self.head)
            self.assertFalse((workspace / "moved-on.txt").exists())
        self.assertEqual(_ref(self.lane, "refs/heads/main"), live_base)

    def test_a_live_base_the_checkout_lacks_is_fetched(self) -> None:
        live_base = self._move_main_ahead()
        with pr_head_workspace(
            source_root=self.lane, pr=self._pr(base_sha=live_base), scratch_root=self.scratch,
        ) as workspace:
            self.assertEqual(_ref(workspace, "refs/heads/main"), self.implementation_base)

    def test_a_workspace_already_in_shape_is_used_as_it_is(self) -> None:
        with pr_head_workspace(source_root=self.author, pr=self._pr(), scratch_root=self.scratch) as workspace:
            self.assertEqual(workspace, self.author)
        self.assertEqual(_ref(self.author, f"refs/heads/{_BRANCH}"), self.head)
        self.assertEqual(_ref(self.author, "refs/heads/main"), self.implementation_base)

    def test_refs_are_put_back_when_the_evaluation_raises(self) -> None:
        main_before = _ref(self.lane, "refs/heads/main")
        with self.assertRaises(RuntimeError):
            with pr_head_workspace(source_root=self.lane, pr=self._pr(), scratch_root=self.scratch):
                raise RuntimeError("the evaluation failed")
        self.assertEqual(_ref(self.lane, "refs/heads/main"), main_before)
        self.assertIsNone(_ref(self.lane, f"refs/heads/{_BRANCH}"))

    def test_it_refuses_to_move_a_base_branch_a_checkout_stands_on(self) -> None:
        live_base = self._move_main_ahead()
        _git(self.lane, "fetch", "--quiet", "origin", "main:refs/heads/main")
        _git(self.lane, "checkout", "--quiet", "main")
        with self.assertRaisesRegex(MergeLaneWorkspaceRefusal, "merge_lane_workspace_branch_checked_out:refs/heads/main"):
            with pr_head_workspace(
                source_root=self.lane, pr=self._pr(base_sha=live_base), scratch_root=self.scratch,
            ):
                self.fail("shaped a workspace under a checked-out main")
        self.assertEqual(_ref(self.lane, "refs/heads/main"), live_base)

    def test_a_local_branch_at_another_commit_is_left_for_the_lock_to_name(self) -> None:
        # The module never moves a branch it did not create: the workspace
        # stands on the head, the branch stays where it was, and the
        # branch-tip lock (which reads refs/heads/<branch>) sees the gap.
        _git(self.lane, "branch", _BRANCH, self.implementation_base)
        with pr_head_workspace(source_root=self.lane, pr=self._pr(), scratch_root=self.scratch) as workspace:
            self.assertEqual(_ref(workspace, "HEAD"), self.head)
            self.assertEqual(_ref(workspace, f"refs/heads/{_BRANCH}"), self.implementation_base)
        self.assertEqual(_ref(self.lane, f"refs/heads/{_BRANCH}"), self.implementation_base)

    def test_a_base_branch_already_at_the_fork_point_is_not_moved_even_when_checked_out(self) -> None:
        _git(self.lane, "checkout", "--quiet", "main")
        live_base = _ref(self.lane, "refs/heads/main")
        self.assertEqual(live_base, self.implementation_base)
        with pr_head_workspace(source_root=self.lane, pr=self._pr(), scratch_root=self.scratch) as workspace:
            self.assertEqual(_ref(workspace, "HEAD"), self.head)
            self.assertEqual(_ref(workspace, "refs/heads/main"), self.implementation_base)

    def test_it_refuses_an_incomplete_or_unreachable_pr_by_name(self) -> None:
        cases = (
            (dict(base_sha=""), "merge_lane_workspace_pr_fields_required:live_base_sha"),
            (dict(head_sha="abc"), "merge_lane_workspace_head_sha_not_a_full_sha"),
            (dict(head_ref="main"), "merge_lane_workspace_head_is_the_base_branch"),
            (dict(number=8), "merge_lane_workspace_git_failed:fetch"),
        )
        for overrides, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(MergeLaneWorkspaceRefusal, reason):
                    with pr_head_workspace(
                        source_root=self.lane, pr=self._pr(**overrides), scratch_root=self.scratch,
                    ):
                        self.fail("shaped a workspace for an unusable PR")


class TheAuthorityEvaluatesOnThePrHeadTests(_Origin):
    def _evaluate(self, pr: dict, **kwargs):
        from aria_kernel import merge_authority

        seen: list[dict] = []

        def capture(*, workspace_root, base_dir, pr, diff_text):
            root = None if workspace_root is None else Path(workspace_root)
            seen.append({
                "root": root,
                "head": None if root is None else _ref(root, "HEAD"),
                "main": None if root is None else _ref(root, "refs/heads/main"),
            })
            return merge_authority_capture(workspace_root=workspace_root, base_dir=base_dir, pr=pr, diff_text=diff_text)

        merge_authority_capture = merge_authority._capture_pre_merge_context
        with patch.object(merge_authority, "_capture_pre_merge_context", side_effect=capture), \
                patch.dict("os.environ", {"RUNNER_TEMP": str(self.scratch)}):
            context, report = merge_authority._evaluate_pre_merge_perimeter(
                workspace_root=self.lane, base_dir=self.base / "tools", pr=pr, diff_text=None, **kwargs,
            )
        return seen, context, report

    def test_the_capture_reads_the_shaped_workspace(self) -> None:
        seen, _context, _report = self._evaluate(self._pr())
        self.assertEqual(len(seen), 1)
        self.assertNotEqual(seen[0]["root"].resolve(), self.lane.resolve())
        self.assertEqual((seen[0]["head"], seen[0]["main"]), (self.head, self.implementation_base))
        self.assertIsNone(_ref(self.lane, f"refs/heads/{_BRANCH}"))

    def test_a_workspace_that_cannot_be_shaped_is_a_named_gap(self) -> None:
        live_base = self._move_main_ahead()
        _git(self.lane, "fetch", "--quiet", "origin", "main:refs/heads/main")
        _git(self.lane, "checkout", "--quiet", "main")
        seen, context, report = self._evaluate(self._pr(base_sha=live_base))
        self.assertEqual(seen, [])
        (reason,) = context.pre_merge_evidence.unavailable_reasons
        self.assertTrue(reason.startswith("merge_lane_workspace_unavailable:"), reason)
        self.assertIn("merge_lane_workspace_branch_checked_out", reason)
        self.assertFalse(report.passed)

    def test_an_incomplete_pr_observation_is_named_by_the_capture(self) -> None:
        pr = self._pr()
        pr.pop("base_sha")
        seen, _context, _report = self._evaluate(pr)
        self.assertEqual([entry["root"] for entry in seen], [self.lane])

    def test_while_shaped_runs_inside_the_shaped_workspace(self) -> None:
        inside: list[str | None] = []
        seen, _context, _report = self._evaluate(
            self._pr(),
            while_shaped=lambda context, report: inside.append(_ref(Path(context.workspace_root), "HEAD")),
        )
        self.assertEqual(inside, [self.head])


class TheExpertPanelIsRequestedAtClaimTimeTests(_Origin):
    class _Adapter:
        def __init__(self, pr: dict) -> None:
            self.pr = pr

        def get_pr(self, number: int) -> dict:
            return dict(self.pr)

        def get_pr_diff(self, number: int) -> str:
            return "diff"

    def test_the_request_is_made_on_the_pr_head(self) -> None:
        from aria_kernel.merge_authority import request_implementation_expert_review

        heads: list[str | None] = []

        def producer(context, report, *, base_dir, cycle_id):
            heads.append(_ref(Path(context.workspace_root), "HEAD"))
            return ("AIR-farm-expert-0123456789ab",)

        with patch("aria_kernel.expert_review_gate.request_implementation_expert_reviews", side_effect=producer), \
                patch.dict("os.environ", {"RUNNER_TEMP": str(self.scratch)}):
            result = request_implementation_expert_review(
                adapter=self._Adapter(self._pr()), pr_number=7,
                base_dir=self.base / "tools", workspace_root=self.lane,
            )
        self.assertEqual(heads, [self.head])
        self.assertEqual(result["requested"], ["AIR-farm-expert-0123456789ab"])
        self.assertEqual(result["head_sha"], self.head)
        self.assertIn("branch_tip_lock_and_recheck", result["perimeter"])

    def test_a_pr_that_is_not_open_is_not_reviewed(self) -> None:
        from aria_kernel.merge_authority import request_implementation_expert_review

        with patch("aria_kernel.expert_review_gate.request_implementation_expert_reviews",
                   side_effect=AssertionError("no review for a closed PR")):
            result = request_implementation_expert_review(
                adapter=self._Adapter(self._pr(state="MERGED")), pr_number=7,
                base_dir=self.base / "tools", workspace_root=self.lane,
            )
        self.assertEqual((result["requested"], result["reasons"]), ([], ["pr_not_open:MERGED"]))

    def test_the_merge_authority_only_evaluates(self) -> None:
        import inspect

        from aria_kernel import merge_authority

        source = inspect.getsource(merge_authority.merge_pr_if_ready)
        self.assertNotIn("request_implementation_expert_reviews", source)
        self.assertNotIn("create_agent_invocation_request", source)
        self.assertIn("_evaluate_pre_merge_perimeter", source)

    def test_the_cli_verb_reviews_through_the_live_adapter(self) -> None:
        from aria_kernel.cli import main as cli_main

        calls: dict = {}

        def review(**kwargs):
            calls.update(kwargs)
            return {"pr_number": 7, "requested": []}

        with patch("aria_kernel.auto_merge.GhCliGitHubAdapter", side_effect=lambda **kw: ("adapter", kw)), \
                patch("aria_kernel.merge_authority.request_implementation_expert_review", side_effect=review), \
                patch("sys.stdout"):
            code = cli_main([
                "readiness", "request-expert-review", "--pr", "7",
                "--workspace-root", str(self.lane), "--tools-dir", str(self.base / "tools"),
            ])
        self.assertEqual(code, 0)
        self.assertEqual(calls["pr_number"], 7)
        self.assertEqual(calls["workspace_root"], str(self.lane))
        self.assertEqual(calls["adapter"], ("adapter", {"cwd": str(self.lane)}))


class TheLanesStandWhereThePerimeterReadsTests(unittest.TestCase):
    def _steps(self, workflow: str, job: str) -> list[dict]:
        path = _REPO_ROOT / ".github" / "workflows" / workflow
        return yaml.safe_load(path.read_text(encoding="utf-8"))["jobs"][job]["steps"]

    def test_both_lanes_detach_their_checkout_before_the_kernel_evaluates(self) -> None:
        for workflow, job, kernel_step in (
            ("aria-merge-runner.yml", "merge", "Run the merge lane"),
            ("aria-readiness-claim.yml", "claim", "Request expert review of the implementation"),
        ):
            with self.subTest(workflow=workflow):
                steps = self._steps(workflow, job)
                names = [step.get("name") for step in steps]
                detach = steps[names.index("Detach the checkout from main")]
                self.assertEqual(detach["run"].split(), ["git", "checkout", "--quiet", "--detach"])
                self.assertLess(names.index("Detach the checkout from main"), names.index(kernel_step))

    def test_the_claim_lane_requests_the_panel_on_the_pr_head(self) -> None:
        steps = self._steps("aria-readiness-claim.yml", "claim")
        names = [step.get("name") for step in steps]
        step = steps[names.index("Request expert review of the implementation")]
        self.assertIn("python3 -m aria_kernel readiness request-expert-review", step["run"])
        self.assertIn('--workspace-root "$GITHUB_WORKSPACE"', step["run"])
        # The PR head is fetched with the job token.
        self.assertIn("GIT_CONFIG_VALUE_0", step["run"])
        self.assertLess(names.index("Restore ARIA state from the aria/state branch"), names.index(step["name"]))
        self.assertLess(names.index(step["name"]), names.index("Publish ARIA state to the aria/state branch"))

    def test_the_contracts_require_it(self) -> None:
        from aria_kernel.workflow_contract_registry import workflow_job_contract

        claim = workflow_job_contract("aria-readiness-claim", "claim")
        self.assertIn("Detach the checkout from main", claim.required_steps)
        self.assertIn("Request expert review of the implementation", claim.required_steps)
        merge = workflow_job_contract("aria-merge-runner", "merge")
        self.assertIn(("Detach the checkout from main", "Run the merge lane"), merge.step_order)


if __name__ == "__main__":
    unittest.main()
