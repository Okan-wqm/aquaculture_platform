"""The per-request worktree bracket is bounded, priced, and never a request fault.

Plan 032 Faz 032h lets the drain give each request its own worktree:
`git worktree add` before the child, `git worktree remove` after it. Both
ran with no timeout at all and outside the child the drain loop prices, so a
git that stopped answering on the runner held the loop past every window it
checks — the class `test_state_lock_liveness_bound` closed for the child's
own waits.

Pinned here:

* both calls run at the store's git cap (`state_store.GIT_TIMEOUT_SECONDS`,
  read through the engine's kernel mirror), named once in the drain;
* an add that does not answer starts NO child — the request stays PENDING,
  nothing claims it — and stops the drain by name
  (`worktree_unavailable`) with a breaker row under the taxonomy's
  `subprocess_timeout`; an add git ANSWERED with a refusal still falls
  back to the shared checkout as before;
* a remove that does not answer is a breaker row, not a request failure;
* the bracket is charged to the child's worst case when the policy turns
  it on, and the workflow window is checked with it on
  (`test_state_lock_liveness_bound`).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402
from aria_kernel.state_store import GIT_TIMEOUT_SECONDS  # noqa: E402


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _Fixture:
    """One drain over one request, with git's worktree answers scripted."""

    def __init__(self, tmp: Path, *, add: str, remove: str = "ok") -> None:
        self.tmp = tmp
        self.add = add
        self.remove = remove
        self.git_calls: list[tuple[list[str], float | None]] = []
        self.dispatch: list[dict] = []
        self.breaker_rows: list[dict] = []
        self.queue: list[dict | None] = [{"request_id": "AIR-1", "target_agent": "aria-evidence-judge", "target_sha": "a" * 40}, None]

    def run(self) -> tuple[int, str]:
        parent_output = self.tmp / "github-output.txt"
        parent_output.write_text("", encoding="utf-8")

        def fake_run(argv, **kwargs):
            if argv[:2] == ["git", "worktree"]:
                self.git_calls.append((list(argv), kwargs.get("timeout")))
                # `prune` is the bracket's reconcile step and answers unless a
                # test scripts it; `add` and `remove` are the scripted calls.
                answer = {"add": self.add, "remove": self.remove}.get(argv[2], "ok")
                if answer == "stall":
                    raise subprocess.TimeoutExpired(argv, kwargs.get("timeout") or 0)
                if answer == "refuse":
                    return _FakeProc(returncode=128, stderr="fatal: already exists")
                return _FakeProc()
            if "next-pending" in argv:
                row = next((r for r in self.queue if r is not None), None)
                if row is not None:
                    self.queue.remove(row)
                return _FakeProc(stdout=json.dumps(row) if row else "null")
            self.dispatch.append({"argv": list(argv), "cwd": kwargs.get("cwd"), "env": kwargs.get("env")})
            # The summary is the drain's only evidence of success (ARIA-HIGH-095):
            # a child that writes none is a named failure whatever its exit
            # code, so the scripted child writes the v1 summary a real one does
            # and names it on its own GITHUB_OUTPUT.
            child_env = kwargs.get("env") or {}
            summary_path = self.tmp / "dispatch-summary-AIR-1.json"
            summary_path.write_text(json.dumps({
                "schema_version": 1, "request_id": "AIR-1", "role": "evidence_judgment",
                "provider": "anthropic", "model": "opus", "outcome": "succeeded",
                "failure_class": None, "retryable": False,
            }), encoding="utf-8")
            Path(child_env["GITHUB_OUTPUT"]).write_text(
                f"dispatch_summary_path={summary_path}\n", encoding="utf-8",
            )
            return _FakeProc()

        def fake_record_failure(**kwargs):
            self.breaker_rows.append(kwargs)

        env_vars = {"GITHUB_OUTPUT": str(parent_output), "RUNNER_TEMP": str(self.tmp)}
        with mock.patch.dict(os.environ, env_vars), \
                mock.patch.object(ci_executor_drain.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(ci_executor_drain, "record_failure", new=fake_record_failure), \
                mock.patch.object(
                    ci_executor_drain, "_executor_policy",
                    return_value={"max_concurrent": 1, "worktree_per_request": True},
                ):
            rc = ci_executor_drain.drain_pending(tools_dir=self.tmp / "aria-tools", repo_root=_REPO_ROOT)
        return rc, parent_output.read_text(encoding="utf-8")


class TheBracketIsBounded(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_the_bound_is_the_stores_git_cap(self) -> None:
        self.assertEqual(ci_executor_drain.REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS, GIT_TIMEOUT_SECONDS)
        self.assertEqual(ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS, 2 * GIT_TIMEOUT_SECONDS)

    def test_both_calls_carry_the_bound_and_the_child_runs_in_the_tree(self) -> None:
        fixture = _Fixture(self.tmp, add="ok", remove="ok")
        rc, output = fixture.run()
        self.assertEqual(rc, 0)
        # The bracket reconciles a leftover registration first (`prune`, the
        # per-request worktree doctrine of ARIA-HIGH-095), then adds, then
        # removes — every one of them bounded.
        self.assertEqual([call[0][2] for call in fixture.git_calls], ["prune", "add", "remove"])
        for argv, timeout in fixture.git_calls:
            with self.subTest(argv=argv):
                self.assertEqual(timeout, ci_executor_drain.REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS)
        self.assertEqual(len(fixture.dispatch), 1)
        worktree = Path(fixture.git_calls[1][0][4])
        self.assertEqual(Path(fixture.dispatch[0]["cwd"]), worktree)
        self.assertEqual(fixture.dispatch[0]["env"]["ARIA_WORKSPACE_ROOT"], str(worktree))
        self.assertEqual(fixture.breaker_rows, [])
        self.assertIn("drained=1\n", output)

    def test_an_add_git_refused_falls_back_to_the_shared_checkout(self) -> None:
        # Git ANSWERED: the pre-existing fallback, unchanged.
        fixture = _Fixture(self.tmp, add="refuse")
        rc, _ = fixture.run()
        self.assertEqual(rc, 0)
        self.assertEqual(len(fixture.dispatch), 1)
        self.assertEqual(Path(fixture.dispatch[0]["cwd"]), _REPO_ROOT)
        self.assertNotIn("ARIA_WORKSPACE_ROOT", fixture.dispatch[0]["env"])
        self.assertEqual([call[0][2] for call in fixture.git_calls], ["prune", "add"])

    def test_an_add_that_does_not_answer_starts_no_child_and_stops_the_drain_by_name(self) -> None:
        fixture = _Fixture(self.tmp, add="stall")
        rc, output = fixture.run()
        self.assertEqual(rc, 1)
        # No child: nothing claimed the request, so it stays PENDING for the
        # next drain instead of being dispatched on a runner whose git is
        # not answering.
        self.assertEqual(fixture.dispatch, [])
        self.assertIn("drained=0\n", output)
        self.assertEqual(len(fixture.breaker_rows), 1)
        row = fixture.breaker_rows[0]
        self.assertEqual(row["kind"], ci_executor_drain.WORKTREE_UNANSWERED_BREAKER_KIND)
        self.assertEqual(row["kind"], "subprocess_timeout")
        self.assertEqual(row["extra"]["stage"], "worktree_add")
        self.assertEqual(row["extra"]["reason"], "timeout")
        self.assertEqual(row["extra"]["request_id"], "AIR-1")
        # The drain stopped: the queue still holds nothing else here, but the
        # stop reason is the named one, not `queue_empty`.
        self.assertEqual(ci_executor_drain.WORKTREE_UNAVAILABLE_STOP_REASON, "worktree_unavailable")

    def test_a_remove_that_does_not_answer_is_a_breaker_row_not_a_request_failure(self) -> None:
        fixture = _Fixture(self.tmp, add="ok", remove="stall")
        rc, output = fixture.run()
        self.assertEqual(rc, 0, "the child succeeded; a lingering tree is the runner's condition")
        self.assertIn("drained=1\n", output)
        self.assertEqual(len(fixture.breaker_rows), 1)
        self.assertEqual(fixture.breaker_rows[0]["extra"]["stage"], "worktree_remove")
        self.assertEqual(fixture.breaker_rows[0]["kind"], "subprocess_timeout")

    def test_the_stop_reason_reaches_the_governance_payload(self) -> None:
        payloads: list[dict] = []
        fixture = _Fixture(self.tmp, add="stall")
        with mock.patch.object(
            ci_executor_drain._engine, "_append_tools_governance",
            new=lambda tools_dir, kind, payload: payloads.append(payload),
        ):
            fixture.run()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["stop_reason"], "worktree_unavailable")
        self.assertEqual(payloads[0]["attempted"], 0)


if __name__ == "__main__":
    unittest.main()
