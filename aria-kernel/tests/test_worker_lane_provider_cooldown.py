"""The worker lane honours the provider cooldown (operator decision 2026-09-12).

The worker is a write-scope role that REQUEUES under the provider cooldown:
only the managed Claude route can run it, so an exhausted opus means wait,
never a weaker tier. Before this module the lane had the terminal raise but
no cooldown: `worker_executor.main` exited 1 on `ClaudeCreditExhausted`, the
hook released the claim as a generic `worker_executor_failed`, and the
scheduler — which sleeps only on `no_pending` — re-claimed the same
assignment and re-spawned the exhausted provider on its very next iteration,
with no back-off. What this module pins, one seam per class:

* `worker_executor.main` — the `except ClaudeCreditExhausted` arm records the
  `provider_quota_cooldown` row under the `--claim-id` the hook minted, with
  the policy's duration, and exits 1 (its release protocol is unchanged).
* `worker_dispatch_hook` — pre-claim, an active cooldown on the assignment's
  provider is skipped by name (`provider_cooldown`, no claim, no spawn);
  post-executor, the row the child wrote under this claim is how the hook
  tells a quota exhaustion from a crash, and the claim is released under
  `provider_quota_unavailable:<provider>`. A malformed cooldown row propagates
  as a named `GovernanceError` — it stops the daemon rather than re-admitting
  an exhausted provider.
* `autonomous_worker_scheduler` — `provider_cooldown` is a back-off tick: the
  daemon sleeps the poll interval and records the cooldown on the iteration
  row instead of looping straight into the next claim attempt.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aria_kernel.autonomous_worker_scheduler import run_worker_scheduler_daemon
from aria_kernel.ledger import append_jsonl as _append_jsonl, load_jsonl
from aria_kernel.provider_cooldown import (
    PROVIDER_COOLDOWN_GOVERNANCE_KIND,
    active_provider_cooldowns,
    record_provider_cooldown,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance
from aria_kernel.worker_dispatch_hook import LEASE_TOKEN_ENV_VAR, dispatch_one_pending_worker_assignment

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

class _CapturedSubprocess:
    def __init__(self, returncode: int = 0, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


class _LaneFixture(unittest.TestCase):
    """A tools root bound to nothing, cwd moved beside it (the hook fixture shape)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-worker-cooldown-"))
        self.tools_root = self.tmp / "aria-tools"
        self.tools_root.mkdir()
        (self.tools_root / "repo_identity.json").write_text(json.dumps({
            "aria_tools_contract_version": 2, "bound_repo_hash": None,
            "bound_repo_root": None, "schema_version": 2,
        }, indent=2, sort_keys=True), encoding="utf-8")
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self._env = patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces")})
        self._env.start()
        for volatile in ("RUNNER_TEMP", "GITHUB_OUTPUT"):
            os.environ.pop(volatile, None)

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _governance(self) -> list[dict[str, Any]]:
        return load_jsonl(self.tools_root / "governance.jsonl")

    def _kinds(self) -> list[str]:
        return [row["kind"] for row in self._governance()]

    def _seed_dispatch_row(self, assignment_id: str = "A-W-1") -> None:
        path = self.tools_root / "dispatch" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        _append_jsonl(path, {
            "$schema": "aria/dispatch-request/v1", "schema_version": 1,
            "assignment_id": assignment_id, "pressure_event_id": f"P-{assignment_id}",
            "target_agent": "aria-worker", "triage_tier": "auto_fix_safe",
            "worktree_path": str(self.tmp / "worktrees" / assignment_id),
            "base_sha": "deadbeef", "required_tests": [],
            "expected_trailer": f"Closes-Pressure: P-{assignment_id}",
            "state": "pending", "created_at": "2026-05-10T00:00:00Z",
        }, test_fixture=True)


class TheExecutorCoolsTheProviderUnderItsClaim(_LaneFixture):
    def _run_executor(self, *, argv: list[str]) -> tuple[int, str]:
        import worker_executor
        from claude_runtime import ClaudeRunResult

        worktree = self.tmp / "worktrees" / "A-W-1"
        worktree.mkdir(parents=True)
        assignment = {"assignment_id": "A-W-1", "target_agent": "aria-worker", "worktree_path": str(worktree),
                      "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1", "timeout_seconds": 60}
        detection = {"matched_marker": "usage-credits", "source": "cli_usage_limit_message", "returncode": 0}

        def exhausted_claude(**kwargs: Any) -> ClaudeRunResult:
            self.spawned.append(kwargs["model"])
            return ClaudeRunResult(returncode=0, stdout="", stderr="", final_message="You've reached your limit.",
                                   usage=None, events=(), credit_exhaustion=detection)

        self.spawned: list[str] = []
        stderr = io.StringIO()
        with patch.object(worker_executor, "_resolve_assignment", return_value=assignment), \
                patch.object(worker_executor, "run_claude_exec", exhausted_claude), \
                patch.object(sys, "stderr", stderr):
            code = worker_executor.main(argv)
        return code, stderr.getvalue()

    def test_a_quota_exhaustion_writes_the_cooldown_row_and_exits_one(self) -> None:
        code, stderr = self._run_executor(argv=["A-W-1", "aria-worker", "--claim-id", "DC-7"])
        self.assertEqual(code, 1)
        self.assertEqual(self.spawned, ["opus"], "one spawn, no weaker tier")
        self.assertIn("model_credit_exhausted assignment=A-W-1", stderr)
        self.assertIn("claude_credit_exhausted", stderr)
        rows = [row for row in self._governance() if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]
        self.assertEqual(len(rows), 1)
        details = rows[0]["details"]
        self.assertEqual((details["provider"], details["model"]), ("anthropic", "opus"))
        self.assertEqual((details["request_id"], details["claim_id"]), ("A-W-1", "DC-7"))
        self.assertEqual(details["cooldown_seconds"], 900, "the policy's duration, not a literal here")
        self.assertEqual(details["detection"]["matched_marker"], "usage-credits")
        self.assertEqual(set(active_provider_cooldowns(self.tools_root)), {"anthropic"})
        # Nothing was submitted: a usage-limit notice is not an answer.
        self.assertFalse((self.tools_root / "dispatch" / "results.jsonl").exists())

    def test_the_claim_id_is_required_on_argv(self) -> None:
        """A cooldown that names no claim could not be told apart from a crash
        by the hook that owns the claim, so the executor refuses to start
        without one."""
        import worker_executor

        with patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                worker_executor.main(["A-W-1", "aria-worker"])
        self.assertEqual(exit_.exception.code, 2)


class TheHookSkipsACooledProviderBeforeClaiming(_LaneFixture):
    def setUp(self) -> None:
        super().setUp()
        self.captured_argvs: list[list[str]] = []

    def _fake_run(self, returncode: int = 0):
        def run(argv, *args, **kwargs):
            self.captured_argvs.append(list(argv))
            return _CapturedSubprocess(returncode=returncode)
        return run

    def _dispatch(self) -> dict[str, Any]:
        with patch("aria_kernel.worker_dispatch_hook.subprocess.run", self._fake_run()):
            return dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root, agent_id="daemon:test:1",
                github_adapter=MagicMock(name="github_adapter"),
            )

    def test_an_active_cooldown_skips_the_assignment_by_name_without_a_claim(self) -> None:
        self._seed_dispatch_row()
        # Cooled by ANOTHER run — the planner lane's — five minutes ago.
        record_provider_cooldown(self.tools_root, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-planner", claim_id="CL-planner", detection={},
                                 now=datetime.now(timezone.utc) - timedelta(minutes=5))
        result = self._dispatch()
        self.assertEqual(result["status"], "provider_cooldown")
        self.assertEqual((result["assignment_id"], result["claim_id"], result["exit_code"]), ("A-W-1", None, None))
        self.assertEqual(result["provider_cooldown"]["provider"], "anthropic")
        self.assertEqual(result["provider_cooldown"]["cooldown_request_id"], "AIR-planner")
        self.assertEqual(self.captured_argvs, [], "no spawn")
        kinds = self._kinds()
        self.assertNotIn("dispatch_claim_created", kinds, "no claim, no lease")
        skipped = next(row for row in self._governance() if row["kind"] == "worker_dispatch_provider_cooldown")
        self.assertEqual(skipped["details"]["stage"], "pre_claim")
        self.assertEqual(skipped["details"]["assignment_id"], "A-W-1")
        self.assertEqual(skipped["details"]["cooldown_claim_id"], "CL-planner")
        self.assertEqual(skipped["details"]["model"], "opus")

    def test_an_expired_cooldown_does_not_gate(self) -> None:
        self._seed_dispatch_row()
        record_provider_cooldown(self.tools_root, provider="anthropic", model="opus", cooldown_seconds=60,
                                 request_id="AIR-old", claim_id="CL-old", detection={},
                                 now=datetime.now(timezone.utc) - timedelta(hours=1))
        result = self._dispatch()
        self.assertNotEqual(result["status"], "provider_cooldown")
        self.assertIn("dispatch_claim_created", self._kinds())
        self.assertEqual(len(self.captured_argvs), 1)

    def test_another_providers_cooldown_does_not_gate_a_worker(self) -> None:
        self._seed_dispatch_row()
        record_provider_cooldown(self.tools_root, provider="zai", model="glm-5.3", cooldown_seconds=900,
                                 request_id="AIR-zai", claim_id="CL-zai", detection={})
        result = self._dispatch()
        self.assertNotEqual(result["status"], "provider_cooldown")
        self.assertEqual(len(self.captured_argvs), 1)

    def test_a_malformed_cooldown_row_stops_the_hook_by_name_before_any_claim(self) -> None:
        self._seed_dispatch_row()
        append_tools_governance(self.tools_root, PROVIDER_COOLDOWN_GOVERNANCE_KIND, {
            "schema_version": 1, "provider": "anthropic", "until": "2999-01-01T00:00:00Z",
        })
        with self.assertRaises(GovernanceError) as refused:
            self._dispatch()
        self.assertIn("provider_cooldown_row_malformed:", str(refused.exception))
        self.assertNotIn("dispatch_claim_created", self._kinds())
        self.assertEqual(self.captured_argvs, [])


class TheHookReleasesAQuotaExhaustionUnderTheProviderName(_LaneFixture):
    def test_the_row_the_child_wrote_under_this_claim_names_the_release(self) -> None:
        self._seed_dispatch_row()
        captured: dict[str, Any] = {}

        def child_exhausts_opus(argv, *args, **kwargs):
            # The child's `except ClaudeCreditExhausted` arm, as the hook sees
            # it: a cooldown row keyed on the `--claim-id` argv, then exit 1.
            captured["argv"] = list(argv)
            captured["lease"] = kwargs["env"][LEASE_TOKEN_ENV_VAR]
            claim_id = argv[argv.index("--claim-id") + 1]
            record_provider_cooldown(self.tools_root, provider="anthropic", model="opus", cooldown_seconds=900,
                                     request_id=argv[2], claim_id=claim_id,
                                     detection={"matched_marker": "usage-credits"})
            return _CapturedSubprocess(returncode=1, stderr="claude_credit_exhausted: provider='anthropic'")

        with patch("aria_kernel.worker_dispatch_hook.subprocess.run", child_exhausts_opus):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root, agent_id="daemon:test:2",
                github_adapter=MagicMock(name="github_adapter"),
            )
        self.assertEqual(result["status"], "provider_cooldown")
        self.assertEqual(result["exit_code"], 1)
        self.assertIsNotNone(result["claim_id"])
        self.assertEqual(result["provider_cooldown"]["cooldown_claim_id"], result["claim_id"])
        # argv carries the claim id (public) and never the lease token.
        self.assertIn("--claim-id", captured["argv"])
        self.assertEqual(captured["argv"][captured["argv"].index("--claim-id") + 1], result["claim_id"])
        self.assertTrue(captured["lease"])
        self.assertNotIn(captured["lease"], " ".join(captured["argv"]))
        governance = self._governance()
        released = next(row for row in governance if row["kind"] == "dispatch_claim_released")
        self.assertEqual(released["details"]["reason"], "provider_quota_unavailable:anthropic")
        self.assertEqual(released["details"]["claim_id"], result["claim_id"])
        state_changes = [row["details"] for row in governance if row["kind"] == "dispatch_request_state_changed"]
        self.assertEqual([(row["from_state"], row["to_state"]) for row in state_changes],
                         [("pending", "picked_up"), ("picked_up", "pending")], "back to pending, retried later")
        kinds = self._kinds()
        self.assertNotIn("worker_dispatch_executor_exit_nonzero", kinds, "a billing event is not a crash")
        cooled = next(row for row in governance if row["kind"] == "worker_dispatch_provider_cooldown")
        self.assertEqual((cooled["details"]["stage"], cooled["details"]["exit_code"]), ("executor", 1))
        # The retry budget is untouched: no verification failure was recorded.
        self.assertEqual(result["retry_count"], 0)

    def test_a_plain_executor_crash_is_still_an_executor_failure(self) -> None:
        self._seed_dispatch_row()
        with patch("aria_kernel.worker_dispatch_hook.subprocess.run",
                   lambda argv, *a, **k: _CapturedSubprocess(returncode=1, stderr="boom")):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root, agent_id="daemon:test:3",
                github_adapter=MagicMock(name="github_adapter"),
            )
        self.assertEqual(result["status"], "executor_failed")
        released = next(row for row in self._governance() if row["kind"] == "dispatch_claim_released")
        self.assertEqual(released["details"]["reason"], "worker_executor_failed")
        self.assertIn("worker_dispatch_executor_exit_nonzero", self._kinds())


class _FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _idle() -> dict[str, Any]:
    return {"status": "no_pending", "assignment_id": None, "claim_id": None, "exit_code": None,
            "decision": None, "governance_event_count": 0, "stderr_redacted": "", "retry_count": 0,
            "merge_result": None}


def _cooled(*, claim_id: str | None, exit_code: int | None) -> dict[str, Any]:
    return {"status": "provider_cooldown", "assignment_id": "A-W-1", "claim_id": claim_id,
            "exit_code": exit_code, "decision": None, "governance_event_count": 1, "stderr_redacted": "",
            "retry_count": 0, "merge_result": None,
            "provider_cooldown": {"provider": "anthropic", "cooldown_model": "opus",
                                  "cooldown_until": "2026-09-12T03:15:00Z",
                                  "cooldown_recorded_at": "2026-09-12T03:00:00Z",
                                  "cooldown_request_id": "AIR-1", "cooldown_claim_id": "CL-1"}}


class TheSchedulerBacksOffWhileTheCooldownStands(_LaneFixture):
    def _run(self, responses: list[dict[str, Any]], *, max_iterations: int) -> tuple[dict[str, Any], _FakeSleep, list]:
        iterator = iter(responses)
        calls: list[dict[str, Any]] = []

        def stub(**kwargs: Any) -> dict[str, Any]:
            calls.append(kwargs)
            return next(iterator, _idle())

        sleeper = _FakeSleep()
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root, github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp, max_iterations=max_iterations, poll_interval_seconds=7.0,
            invoke_worker=stub, sleep=sleeper,
        )
        return result, sleeper, calls

    def test_a_pre_claim_skip_sleeps_the_poll_interval_and_counts_no_dispatch(self) -> None:
        # Before the fix the loop slept only on no_pending: a pending
        # assignment under a cooled provider was re-attempted immediately,
        # every iteration.
        result, sleeper, calls = self._run([_cooled(claim_id=None, exit_code=None)] * 3, max_iterations=3)
        self.assertEqual(sleeper.calls, [7.0, 7.0], "sleeps between cooled ticks; the last tick hits the cap first")
        self.assertEqual(len(calls), 3)
        self.assertEqual(result["assignments_dispatched"], 0)
        self.assertEqual(result["exit_reason"], "max_iterations")
        completed = [row["details"] for row in self._governance()
                     if row["kind"] == "worker_scheduler_iteration_completed"]
        self.assertEqual({row["status"] for row in completed}, {"provider_cooldown"})
        self.assertEqual(completed[0]["provider"], "anthropic")
        self.assertEqual(completed[0]["cooldown_until"], "2026-09-12T03:15:00Z")

    def test_a_post_executor_cooldown_counts_the_dispatch_and_still_backs_off(self) -> None:
        result, sleeper, _ = self._run([_cooled(claim_id="DC-1", exit_code=1)], max_iterations=2)
        # One sleep: the cooled tick backs off; the idle second tick reaches
        # the iteration cap before its own sleep.
        self.assertEqual(sleeper.calls, [7.0])
        self.assertEqual(result["assignments_dispatched"], 1)
        self.assertEqual(result["retries_attempted"], 0, "a quota wait is not a retry")

    def test_aria_stop_is_still_seen_between_cooled_ticks(self) -> None:
        # The back-off is the poll interval, not the cooldown: the STOP file
        # written during a cooldown ends the daemon on the next tick.
        stop = self.tools_root / "ARIA_STOP"

        def stop_after_first_sleep(seconds: float) -> None:
            stop.touch()

        iterator = iter([_cooled(claim_id=None, exit_code=None)] * 5)
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root, github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp, max_iterations=5, poll_interval_seconds=7.0,
            invoke_worker=lambda **kwargs: next(iterator), sleep=stop_after_first_sleep,
        )
        self.assertEqual(result["exit_reason"], "aria_stop")
        self.assertEqual(result["iterations"], 1)


if __name__ == "__main__":
    unittest.main()
