"""Plan 025 §E — autonomous worker scheduler daemon tests.

Seven cases covering the daemon-level state machine + lock +
ARIA_STOP + profile gate + max-iterations + counter rollups +
single-instance discipline. The per-tick hook is injected as a
stub so the daemon's loop semantics are tested independently of
the subprocess wiring (covered by test_worker_dispatch_hook.py).
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aria_kernel.autonomous_worker_scheduler import (
    run_worker_scheduler_daemon,
)


class _FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _make_invoke_worker(*responses: dict[str, Any]):
    iterator = iter(responses)
    captured_calls: list[dict[str, Any]] = []

    def stub(**kwargs: Any) -> dict[str, Any]:
        captured_calls.append(kwargs)
        try:
            return next(iterator)
        except StopIteration:
            return {
                "status": "no_pending",
                "assignment_id": None, "claim_id": None,
                "exit_code": None, "decision": None,
                "governance_event_count": 0,
                "stderr_redacted": "",
                "retry_count": 0,
                "merge_result": None,
            }

    stub.captured_calls = captured_calls
    return stub


class WorkerSchedulerDaemonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ws-daemon-"))
        self.tools_root = self.tmp / "aria-tools"
        self.tools_root.mkdir()
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
        sleeper = _FakeSleep()
        stub = _make_invoke_worker()
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=2,
            poll_interval_seconds=5.0,
            invoke_worker=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["iterations"], 2)
        self.assertEqual(result["assignments_dispatched"], 0)
        self.assertEqual(result["exit_reason"], "max_iterations")
        self.assertTrue(result["exits_clean"])
        # Only one sleep — second iteration hits the max-iterations
        # check before the sleep call (mirrors §D semantics).
        self.assertEqual(sleeper.calls, [5.0])

    def test_happy_path_single_dispatch_counter_rollup(self) -> None:
        sleeper = _FakeSleep()
        stub = _make_invoke_worker({
            "status": "merged",
            "assignment_id": "A-1", "claim_id": "DC-1",
            "exit_code": 0, "decision": {"status": "passed"},
            "governance_event_count": 5, "stderr_redacted": "",
            "retry_count": 0,
            "merge_result": {"decision": "merged"},
        })
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=1,
            invoke_worker=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["assignments_dispatched"], 1)
        self.assertEqual(result["merges_completed"], 1)
        self.assertEqual(result["exit_reason"], "max_iterations")

    def test_retry_scheduled_increments_retries_attempted(self) -> None:
        sleeper = _FakeSleep()
        stub = _make_invoke_worker(
            {
                "status": "retry_scheduled",
                "assignment_id": "A-X", "claim_id": "DC-X",
                "exit_code": 0, "decision": {"status": "failed"},
                "governance_event_count": 4, "stderr_redacted": "",
                "retry_count": 1,
                "merge_result": None,
            },
            {
                "status": "merged",
                "assignment_id": "A-X", "claim_id": "DC-X2",
                "exit_code": 0, "decision": {"status": "passed"},
                "governance_event_count": 5, "stderr_redacted": "",
                "retry_count": 1,
                "merge_result": {"decision": "merged"},
            },
        )
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=2,
            invoke_worker=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["assignments_dispatched"], 2)
        self.assertEqual(result["retries_attempted"], 1)
        self.assertEqual(result["merges_completed"], 1)

    def test_aria_stop_clean_exit(self) -> None:
        (self.tools_root / "ARIA_STOP").touch()
        sleeper = _FakeSleep()
        stub = _make_invoke_worker()
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=10,
            invoke_worker=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["exit_reason"], "aria_stop")
        self.assertEqual(result["iterations"], 0)
        self.assertEqual(stub.captured_calls, [])

    def test_frozen_profile_clean_exit(self) -> None:
        from aria_kernel.tool_registry import GovernanceError
        sleeper = _FakeSleep()
        stub = _make_invoke_worker()
        with patch(
            "aria_kernel.runtime_profile.enforce_profile_for_action"
        ) as mock_gate:
            mock_gate.side_effect = GovernanceError("profile_violation: frozen")
            result = run_worker_scheduler_daemon(
                base_dir=self.tools_root,
                github_adapter=MagicMock(name="github_adapter"),
                workspace_root=self.tmp,
                max_iterations=5,
                invoke_worker=stub,
                sleep=sleeper,
            )
        self.assertEqual(result["exit_reason"], "profile_frozen")
        self.assertEqual(stub.captured_calls, [])

    def test_second_daemon_lock_contended_clean_exit(self) -> None:
        slow_event = threading.Event()
        release_event = threading.Event()

        def slow_stub(**kwargs: Any) -> dict[str, Any]:
            slow_event.set()
            release_event.wait(timeout=10)
            return {
                "status": "merged",
                "assignment_id": "A-1", "claim_id": "DC-1",
                "exit_code": 0, "decision": None,
                "governance_event_count": 0, "stderr_redacted": "",
                "retry_count": 0,
                "merge_result": {"decision": "merged"},
            }

        first_holder: dict[str, Any] = {}

        def first_daemon() -> None:
            res = run_worker_scheduler_daemon(
                base_dir=self.tools_root,
                github_adapter=MagicMock(name="github_adapter"),
                workspace_root=self.tmp,
                max_iterations=1,
                invoke_worker=slow_stub,
                sleep=lambda s: None,
            )
            first_holder["result"] = res

        thread = threading.Thread(target=first_daemon, daemon=True)
        thread.start()
        self.assertTrue(
            slow_event.wait(timeout=5),
            "first daemon failed to start within 5s",
        )
        second = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=1,
            invoke_worker=_make_invoke_worker(),
            sleep=lambda s: None,
        )
        release_event.set()
        thread.join(timeout=5)
        self.assertEqual(second["exit_reason"], "daemon_already_running")
        self.assertFalse(second["exits_clean"])
        self.assertEqual(first_holder["result"]["merges_completed"], 1)
        kinds = [r["kind"] for r in self._read_governance()]
        self.assertIn("worker_scheduler_daemon_lock_contended", kinds)

    def test_max_iterations_cap_enforced(self) -> None:
        sleeper = _FakeSleep()
        stub = _make_invoke_worker(*[
            {
                "status": "merged",
                "assignment_id": f"A-{i}", "claim_id": f"DC-{i}",
                "exit_code": 0, "decision": None,
                "governance_event_count": 0, "stderr_redacted": "",
                "retry_count": 0,
                "merge_result": {"decision": "merged"},
            }
            for i in range(5)
        ])
        result = run_worker_scheduler_daemon(
            base_dir=self.tools_root,
            github_adapter=MagicMock(name="github_adapter"),
            workspace_root=self.tmp,
            max_iterations=3,
            invoke_worker=stub,
            sleep=sleeper,
        )
        self.assertEqual(result["iterations"], 3)
        self.assertEqual(result["assignments_dispatched"], 3)
        self.assertEqual(result["merges_completed"], 3)
        self.assertEqual(len(stub.captured_calls), 3)


if __name__ == "__main__":
    unittest.main()
