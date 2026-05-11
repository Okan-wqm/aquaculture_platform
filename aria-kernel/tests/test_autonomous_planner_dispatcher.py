"""Plan 025 §D — autonomous planner dispatcher daemon tests.

Eight cases covering the daemon state machine + lock + ARIA_STOP +
profile gate + max-iterations + role priority. The Claude
invocation hook (planner_dispatch_hook.dispatch_one_pending_planner
_request) is injected as a stub so the daemon's loop semantics are
tested independently of the subprocess wiring (covered by
test_planner_dispatch_hook.py).
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.autonomous_planner_dispatcher import (
    DEFAULT_PLANNER_ROLES,
    run_planner_dispatch_daemon,
)


class _FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _make_invoke_planner(*responses: dict[str, Any]):
    """Return a stub matching the dispatch_one_pending_planner_request
    signature; cycles through the responses then returns no_pending.
    """
    iterator = iter(responses)
    captured_calls: list[dict[str, Any]] = []

    def stub(**kwargs: Any) -> dict[str, Any]:
        captured_calls.append(kwargs)
        try:
            return next(iterator)
        except StopIteration:
            return {
                "status": "no_pending",
                "request_id": None, "claim_id": None,
                "exit_code": None, "governance_event_count": 0,
                "stderr_redacted": "",
            }

    stub.captured_calls = captured_calls
    return stub


class PlannerDispatchDaemonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pd-daemon-"))
        self.tools_root = self.tmp / "aria-tools"
        self.tools_root.mkdir()
        # Bootstrap repo_identity.json so ensure_tools_dir does not
        # raise ambiguous_tools_root on the first daemon iteration.
        identity = {
            "aria_tools_contract_version": 2,
            "bound_repo_hash": None,
            "bound_repo_root": None,
            "schema_version": 2,
        }
        (self.tools_root / "repo_identity.json").write_text(
            json.dumps(identity, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self._env = patch.dict(os.environ, {
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
        })
        self._env.start()

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _read_governance(self) -> list[dict[str, Any]]:
        gov = self.tools_root / "governance.jsonl"
        if not gov.exists():
            return []
        return [
            json.loads(line)
            for line in gov.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_empty_queue_idle_loop_max_iterations(self) -> None:
        # No pending requests; daemon idles + sleeps + exits at cap.
        sleeper = _FakeSleep()
        stub = _make_invoke_planner()  # always returns no_pending
        result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=2,
            poll_interval_seconds=5.0,
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["iterations"], 2)
        self.assertEqual(result["claims_dispatched"], 0)
        self.assertEqual(result["exit_reason"], "max_iterations")
        self.assertTrue(result["exits_clean"])
        # Iteration 1: idle → sleep → continue. Iteration 2: idle →
        # max_iterations check fires BEFORE sleep → break. So exactly
        # one sleep call is recorded.
        self.assertEqual(sleeper.calls, [5.0])
        kinds = [r["kind"] for r in self._read_governance()]
        self.assertEqual(
            kinds.count("planner_dispatch_iteration_completed"), 2
        )
        self.assertIn("planner_dispatch_daemon_exit", kinds)

    def test_happy_path_single_dispatch(self) -> None:
        sleeper = _FakeSleep()
        stub = _make_invoke_planner({
            "status": "dispatched",
            "request_id": "REQ-1", "claim_id": "claim_a",
            "exit_code": 0, "governance_event_count": 3,
            "stderr_redacted": "",
        })
        result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=1,
            poll_interval_seconds=5.0,
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["claims_dispatched"], 1)
        self.assertEqual(result["iterations"], 1)
        self.assertEqual(result["exit_reason"], "max_iterations")
        # No sleep on a dispatched tick.
        self.assertEqual(sleeper.calls, [])
        self.assertEqual(stub.captured_calls[0]["agent_id"].split(":")[0], "daemon")
        self.assertEqual(
            stub.captured_calls[0]["planner_roles"], DEFAULT_PLANNER_ROLES
        )

    def test_aria_stop_file_clean_exit(self) -> None:
        # Touch ARIA_STOP before daemon starts → exits on first tick
        # check, before any sleep or dispatch.
        (self.tools_root / "ARIA_STOP").touch()
        sleeper = _FakeSleep()
        stub = _make_invoke_planner()
        result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=10,
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["exit_reason"], "aria_stop")
        self.assertEqual(result["iterations"], 0)
        self.assertEqual(stub.captured_calls, [])  # never invoked
        self.assertTrue(result["exits_clean"])

    def test_frozen_profile_clean_exit(self) -> None:
        # Force enforce_profile_for_action to raise → exit profile_frozen.
        from aria_kernel.tool_registry import GovernanceError
        sleeper = _FakeSleep()
        stub = _make_invoke_planner()
        with patch(
            "aria_kernel.runtime_profile.enforce_profile_for_action"
        ) as mock_gate:
            mock_gate.side_effect = GovernanceError(
                "profile_violation: frozen blocks agent_claim"
            )
            result = run_planner_dispatch_daemon(
                base_dir=self.tools_root,
                workspace_root=self.tmp,
                max_iterations=5,
                invoke_planner=stub,
                sleep=sleeper,
            )
        self.assertEqual(result["exit_reason"], "profile_frozen")
        self.assertEqual(result["iterations"], 0)
        self.assertEqual(stub.captured_calls, [])
        self.assertTrue(result["exits_clean"])

    def test_second_daemon_lock_contended_clean_exit(self) -> None:
        # Spawn first daemon in background thread holding the lock for
        # ~3s; second call returns daemon_already_running within 2s.
        slow_invoke_event = threading.Event()
        release_first_event = threading.Event()

        def slow_stub(**kwargs: Any) -> dict[str, Any]:
            slow_invoke_event.set()
            release_first_event.wait(timeout=10)
            return {
                "status": "dispatched",
                "request_id": "R", "claim_id": "C", "exit_code": 0,
                "governance_event_count": 0, "stderr_redacted": "",
            }

        first_result_holder: dict[str, Any] = {}

        def first_daemon() -> None:
            res = run_planner_dispatch_daemon(
                base_dir=self.tools_root,
                workspace_root=self.tmp,
                max_iterations=1,
                invoke_planner=slow_stub,
                sleep=lambda s: None,
            )
            first_result_holder["result"] = res

        thread = threading.Thread(target=first_daemon, daemon=True)
        thread.start()
        # Wait for the first daemon to acquire lock + enter slow_stub.
        self.assertTrue(slow_invoke_event.wait(timeout=5),
                        "first daemon failed to start within 5s")
        # Now try a second daemon — it must see lock contention.
        second_result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=1,
            invoke_planner=_make_invoke_planner(),
            sleep=lambda s: None,
        )
        # Release the first daemon so the test cleans up.
        release_first_event.set()
        thread.join(timeout=5)
        self.assertEqual(second_result["exit_reason"], "daemon_already_running")
        self.assertFalse(second_result["exits_clean"])
        self.assertEqual(second_result["iterations"], 0)
        self.assertEqual(first_result_holder["result"]["claims_dispatched"], 1)
        kinds = [r["kind"] for r in self._read_governance()]
        self.assertIn("planner_dispatch_daemon_lock_contended", kinds)

    def test_max_iterations_cap_enforced(self) -> None:
        sleeper = _FakeSleep()
        # 5 dispatched responses, but cap=3 → exactly 3 dispatched.
        stub = _make_invoke_planner(*[
            {"status": "dispatched", "request_id": f"R{i}",
             "claim_id": f"C{i}", "exit_code": 0,
             "governance_event_count": 0, "stderr_redacted": ""}
            for i in range(5)
        ])
        result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=3,
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["iterations"], 3)
        self.assertEqual(result["claims_dispatched"], 3)
        self.assertEqual(len(stub.captured_calls), 3)

    def test_role_priority_passed_to_hook(self) -> None:
        # Custom role priority forwarded verbatim to the hook.
        sleeper = _FakeSleep()
        stub = _make_invoke_planner({
            "status": "dispatched", "request_id": "R", "claim_id": "C",
            "exit_code": 0, "governance_event_count": 0,
            "stderr_redacted": "",
        })
        run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=1,
            roles=("challenger_plan", "primary_plan"),
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(
            stub.captured_calls[0]["planner_roles"],
            ("challenger_plan", "primary_plan"),
        )

    def test_executor_failed_status_does_not_abort_loop(self) -> None:
        # status='executor_failed' is a per-tick failure that emits
        # iteration_completed{status=executor_failed} and continues
        # to the next iteration (NOT a daemon-level exit). Verifies
        # the per-tick error capture envelope.
        sleeper = _FakeSleep()
        stub = _make_invoke_planner(
            {"status": "executor_failed", "request_id": "R-X",
             "claim_id": "C-X", "exit_code": 1,
             "governance_event_count": 3,
             "stderr_redacted": "ci_executor_error"},
            {"status": "dispatched", "request_id": "R-Y",
             "claim_id": "C-Y", "exit_code": 0,
             "governance_event_count": 3, "stderr_redacted": ""},
        )
        result = run_planner_dispatch_daemon(
            base_dir=self.tools_root,
            workspace_root=self.tmp,
            max_iterations=2,
            invoke_planner=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["iterations"], 2)
        self.assertEqual(result["claims_dispatched"], 1)
        completed = [
            r for r in self._read_governance()
            if r["kind"] == "planner_dispatch_iteration_completed"
        ]
        self.assertEqual(len(completed), 2)
        statuses = sorted(c["details"]["status"] for c in completed)
        self.assertEqual(statuses, ["dispatched", "executor_failed"])


if __name__ == "__main__":
    unittest.main()
