"""ARIA-HIGH-176 — the planner dispatch hook serves the child from a tree at
the request's own anchor.

Under ``managed_subscription`` the native admission binds
``request.target_sha`` to the checkout's HEAD; the cycle's shared checkout is
main, which moves hourly on this repository, so a challenger-plan request
minted at yesterday's main was refused forty times in a day as
``target_revision_mismatch`` and never ran. The drain already serves each
request from ``aria-worktrees/req-<id>`` (ARIA-HIGH-124); this suite pins
that the hook does the same, through the one kernel spelling
(`aria_kernel.request_worktree`), and what happens when git refuses or does
not answer.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import request_worktree
from aria_kernel.planner_dispatch_hook import (
    ADMISSION_BACKOFF_STATUSES,
    PROVIDER_CONTROL_UNAVAILABLE_STATUS,
    dispatch_one_pending_planner_request,
)
from aria_kernel.release_reason import NATIVE_RUNTIME_CONTROL_UNAVAILABLE
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

_REAL_RUN = subprocess.run


class _ChildExit:
    def __init__(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self.stderr = ""
        self.stdout = ""


class PlannerDispatchWorktreeTests(unittest.TestCase):
    """The tools dir sits INSIDE a real repository so the selection's anchor
    probe and the hook's worktree both run against the same git."""

    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-pd-worktree-")
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)
        self.repo = make_repo_with_initial_commit(
            self.scratch, {"README.md": "one\n", ".gitignore": "aria-worktrees/\naria-tools/\n"},
        )
        self.anchor = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        (self.repo / "README.md").write_text("two\n", encoding="utf-8")
        _git(["commit", "-qam", "main moved on"], cwd=self.repo)
        self.head = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.assertNotEqual(self.head, self.anchor)
        self.tools_root = ensure_tools_dir(self.repo / "aria-tools")
        # The hook resolves the repository from the executor's location.
        self.ci_executor_path = self.repo / "tools" / "aria-poc" / "ci_executor.py"
        self.ci_executor_path.parent.mkdir(parents=True)
        self.ci_executor_path.write_text("# fixture executor\n", encoding="utf-8")
        self._old_cwd = os.getcwd()
        os.chdir(self.scratch)
        self.addCleanup(os.chdir, self._old_cwd)
        env = patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(self.scratch / "workspaces")})
        env.start()
        self.addCleanup(env.stop)
        self.children: list[dict[str, Any]] = []

    def _seed_request(self, *, request_id: str, target_sha: str) -> None:
        requests_path = self.tools_root / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/agent-invocation-request/v1",
            "schema_version": 1,
            "request_id": request_id,
            "role": "challenger_plan",
            "target_agent": "aria-challenger-planner",
            "suggested_prompt": "test prompt",
            "must_satisfy": [{"id": "S1"}],
            "evidence_refs": [],
            "allowed_scope": ["aria-kernel/**"],
            "expected_output_path": str(self.scratch / f"out-{request_id}.json"),
            "state": "pending",
            "target_sha": target_sha,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        append_declared_fixture(requests_path, row, expected_surface="agent_invocation_requests")

    def _child_capturing_run(self, returncode: int = 0):
        """Git keeps answering for real; only the executor child is captured,
        with the worktree's HEAD read WHILE the child would be running."""
        children = self.children

        def fake_run(argv, *args, **kwargs):
            if argv and argv[0] == "git":
                return _REAL_RUN(argv, *args, **kwargs)
            cwd = Path(kwargs["cwd"])
            head_at_child_time = _REAL_RUN(
                ["git", "rev-parse", "HEAD"], cwd=str(cwd), capture_output=True, text=True, check=True,
            ).stdout.strip()
            children.append({
                "argv": list(argv), "cwd": cwd, "env": dict(kwargs.get("env", {})),
                "head": head_at_child_time,
            })
            return _ChildExit(returncode=returncode)

        return fake_run

    def _governance(self) -> list[dict[str, Any]]:
        path = self.tools_root / "governance.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _claims(self) -> list[dict[str, Any]]:
        path = self.tools_root / "agent-invocations" / "claims.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _dispatch(self) -> dict[str, Any]:
        return dispatch_one_pending_planner_request(
            base_dir=self.tools_root, agent_id="daemon:test:176", ci_executor_path=self.ci_executor_path,
        )

    def test_child_runs_in_a_worktree_at_the_request_anchor_not_the_moved_checkout(self) -> None:
        self._seed_request(request_id="REQ-176-ANCHOR", target_sha=self.anchor)
        with patch("aria_kernel.planner_dispatch_hook.subprocess.run", self._child_capturing_run()):
            result = self._dispatch()
        self.assertEqual(result["status"], "dispatched", result)
        self.assertEqual(len(self.children), 1)
        child = self.children[0]
        expected = request_worktree.request_worktree_path(self.repo, "REQ-176-ANCHOR")
        self.assertEqual(child["cwd"], expected)
        self.assertEqual(child["env"]["ARIA_WORKSPACE_ROOT"], str(expected))
        # The tree the child saw is the request's anchor — the shared
        # checkout's HEAD had moved past it.
        self.assertEqual(child["head"], self.anchor)
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip(), self.head)
        # Removed after the child, as the drain removes its own.
        self.assertFalse(expected.exists())
        listed = _git(["worktree", "list", "--porcelain"], cwd=self.repo).stdout
        self.assertNotIn(str(expected), listed)
        # The whole worktree bracket is on the governance ledger by the
        # hook's own stage prefix, and the count the daemon logs matches.
        kinds = [row.get("kind") for row in self._governance()]
        self.assertIn("planner_dispatch_dispatched", kinds)
        self.assertNotIn("planner_dispatch_worktree_unavailable", kinds)

    def test_git_refusing_the_anchor_falls_back_to_the_shared_checkout(self) -> None:
        self._seed_request(request_id="REQ-176-REFUSED", target_sha=self.anchor)
        real_run_git = request_worktree.run_worktree_git

        def refusing_git(argv, **kwargs):
            if argv[:3] == ["git", "worktree", "add"]:
                return subprocess.CompletedProcess(argv, 128, stdout="", stderr="fatal: invalid reference"), None
            return real_run_git(argv, **kwargs)

        with patch.object(request_worktree, "run_worktree_git", refusing_git), \
             patch("aria_kernel.planner_dispatch_hook.subprocess.run", self._child_capturing_run()):
            result = self._dispatch()
        self.assertEqual(result["status"], "dispatched", result)
        self.assertEqual(len(self.children), 1)
        child = self.children[0]
        self.assertEqual(child["cwd"], self.repo)
        self.assertEqual(child["env"]["ARIA_WORKSPACE_ROOT"], str(self.repo))
        self.assertEqual(child["head"], self.head)
        lines = [row["details"].get("line", "") for row in self._governance()
                 if row.get("kind") == "planner_dispatch_worktree"]
        self.assertTrue(any(line.startswith("planner_dispatch_worktree_add_failed") for line in lines), lines)

    def test_git_not_answering_starts_no_child_releases_the_lease_and_backs_off(self) -> None:
        self._seed_request(request_id="REQ-176-UNANSWERED", target_sha=self.anchor)
        real_run_git = request_worktree.run_worktree_git

        def stalled_git(argv, **kwargs):
            if argv[:3] == ["git", "worktree", "add"]:
                return None, "timeout"
            return real_run_git(argv, **kwargs)

        with patch.object(request_worktree, "run_worktree_git", stalled_git), \
             patch("aria_kernel.planner_dispatch_hook.subprocess.run", self._child_capturing_run()):
            result = self._dispatch()
        self.assertEqual(result["status"], PROVIDER_CONTROL_UNAVAILABLE_STATUS, result)
        self.assertIn(result["status"], ADMISSION_BACKOFF_STATUSES)
        self.assertEqual(result["exit_code"], None)
        self.assertEqual(result["stderr_redacted"], "worktree_unavailable:timeout")
        self.assertEqual(self.children, [], "no child may be started without a tree at the anchor")
        released = [row for row in self._claims() if row.get("event") == "released"]
        self.assertEqual(len(released), 1, self._claims())
        self.assertEqual(released[0]["claim_id"], result["claim_id"])
        self.assertEqual(released[0]["reason"], NATIVE_RUNTIME_CONTROL_UNAVAILABLE)
        rows = [row for row in self._governance() if row.get("kind") == "planner_dispatch_worktree_unavailable"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["request_id"], "REQ-176-UNANSWERED")
        self.assertEqual(rows[0]["details"]["anchor"], self.anchor)
        self.assertEqual(rows[0]["details"]["reason"], "timeout")
        # The governance count the daemon logs is the ledger's: claim,
        # the unanswered line, the release, the unavailable row.
        tick_rows = [row.get("kind") for row in self._governance() if row.get("kind") != "tools_root_bootstrapped"]
        self.assertEqual(tick_rows, [
            "agent_claim_created", "planner_dispatch_worktree", "agent_requeued",
            "planner_dispatch_worktree_unavailable",
        ])
        self.assertEqual(result["governance_event_count"], len(tick_rows))
        # The request is PENDING again — the next tick may ask git again.
        from aria_kernel.agent_invocations import derive_request_states
        self.assertIn(derive_request_states(base_dir=self.tools_root)["REQ-176-UNANSWERED"], {"PENDING", "REQUEUED"})

    def test_a_request_without_an_anchor_runs_in_the_shared_checkout_as_before(self) -> None:
        self._seed_request(request_id="REQ-176-NOANCHOR", target_sha="")
        with patch("aria_kernel.planner_dispatch_hook.subprocess.run", self._child_capturing_run()):
            result = self._dispatch()
        self.assertEqual(result["status"], "dispatched", result)
        self.assertEqual(len(self.children), 1)
        self.assertEqual(self.children[0]["cwd"], self.repo)
        self.assertEqual(self.children[0]["env"]["ARIA_WORKSPACE_ROOT"], str(self.repo))
        self.assertFalse((self.repo / request_worktree.REQUEST_WORKTREES_DIR).exists())


if __name__ == "__main__":
    unittest.main()
