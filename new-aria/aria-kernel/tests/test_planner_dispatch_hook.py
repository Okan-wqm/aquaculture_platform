"""Plan 025 §D — Claude invocation hook tests.

Six cases covering: no-pending early-return, mock-mode happy path,
challenger_plan role pickup, executor non-zero exit + governance
event, lease-token redaction discipline (env-only, never argv,
never stderr), and subagent-type sourced from request row's
``target_agent`` field (SSoT preserved).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aria_kernel.planner_dispatch_hook import (
    LEASE_TOKEN_ENV_VAR,
    dispatch_one_pending_planner_request,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class _CapturedSubprocess:
    def __init__(self, returncode: int = 0, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


class PlannerDispatchHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pd-hook-"))
        self.tools_root = ensure_tools_dir(self.tmp / "aria-tools")
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self._env = patch.dict(os.environ, {
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
        })
        self._env.start()
        self.captured_argvs: list[list[str]] = []
        self.captured_envs: list[dict[str, str]] = []

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_request(
        self, *, request_id: str, role: str,
        target_agent: str, expected_output_path: Path | None = None,
    ) -> None:
        # Direct ledger write — bypass create_agent_invocation_request
        # contract checks (which require ROLE_TARGET_PAIRING table
        # lookup). The hook only reads request_id + role + target_agent
        # + the request state derivation; minimal seed is sufficient.
        requests_path = self.tools_root / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        eop = expected_output_path or self.tmp / f"out-{request_id}.json"
        row = {
            "$schema": "aria/agent-invocation-request/v1",
            "schema_version": 1,
            "request_id": request_id,
            "role": role,
            "target_agent": target_agent,
            "suggested_prompt": "test prompt",
            "must_satisfy": [{"id": "S1"}],
            "evidence_refs": [],
            "allowed_scope": ["aria-kernel/**"],
            "expected_output_path": str(eop),
            "state": "pending",
            "created_at": "2026-05-10T00:00:00Z",
        }
        append_declared_fixture(
            requests_path,
            row,
            expected_surface="agent_invocation_requests",
        )

    def _read_governance(self) -> list[dict[str, Any]]:
        gov = self.tools_root / "governance.jsonl"
        if not gov.exists():
            return []
        return [
            json.loads(line)
            for line in gov.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _capturing_subprocess_run(self, returncode: int = 0, stderr: str = ""):
        outer = self

        def fake_run(argv, *args, **kwargs):
            outer.captured_argvs.append(list(argv))
            outer.captured_envs.append(dict(kwargs.get("env", {})))
            return _CapturedSubprocess(returncode=returncode, stderr=stderr)

        return fake_run

    def test_no_pending_returns_no_pending(self) -> None:
        # No requests seeded → status=no_pending, no governance events.
        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:0",
            )
        self.assertEqual(result["status"], "no_pending")
        self.assertEqual(result["request_id"], None)
        self.assertEqual(result["governance_event_count"], 0)
        self.assertEqual(self.captured_argvs, [])

    def test_pending_primary_plan_dispatched_subprocess_invoked(self) -> None:
        self._seed_request(
            request_id="REQ-PRI-1",
            role="primary_plan",
            target_agent="aria-primary-planner",
        )
        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:1",
            )
        self.assertEqual(result["status"], "dispatched")
        self.assertEqual(result["request_id"], "REQ-PRI-1")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(len(self.captured_argvs), 1)
        argv = self.captured_argvs[0]
        # argv shape: python3 ci_executor.py <request_id> <target_agent>
        self.assertEqual(argv[0], "python3")
        self.assertTrue(argv[1].endswith("ci_executor.py"))
        self.assertEqual(argv[2], "REQ-PRI-1")
        self.assertEqual(argv[3], "aria-primary-planner")
        # Lease token must be in env, NOT argv.
        env = self.captured_envs[0]
        self.assertIn(LEASE_TOKEN_ENV_VAR, env)
        for arg in argv:
            self.assertNotIn(env[LEASE_TOKEN_ENV_VAR], arg)
        # Governance trail.
        kinds = [r["kind"] for r in self._read_governance()]
        self.assertIn("agent_claim_created", kinds)  # from claim_request
        self.assertIn("planner_dispatch_executor_exit_0", kinds)
        self.assertIn("planner_dispatch_dispatched", kinds)

    def test_pending_challenger_plan_role_iteration(self) -> None:
        # Only a challenger_plan row → primary_plan iteration misses;
        # daemon falls through to challenger_plan and dispatches.
        self._seed_request(
            request_id="REQ-CHL-1",
            role="challenger_plan",
            target_agent="aria-challenger-planner",
        )
        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:2",
            )
        self.assertEqual(result["status"], "dispatched")
        self.assertEqual(result["request_id"], "REQ-CHL-1")
        self.assertEqual(self.captured_argvs[0][3], "aria-challenger-planner")

    def test_executor_nonzero_exit_status_executor_failed(self) -> None:
        self._seed_request(
            request_id="REQ-FAIL-1",
            role="primary_plan",
            target_agent="aria-primary-planner",
        )
        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(
                returncode=2, stderr="invalid choice: 'list-requests'"
            ),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:3",
            )
        self.assertEqual(result["status"], "executor_failed")
        self.assertEqual(result["exit_code"], 2)
        kinds = [r["kind"] for r in self._read_governance()]
        self.assertIn("planner_dispatch_executor_exit_2", kinds)

    def test_lease_token_never_in_argv_redacted_in_stderr(self) -> None:
        # Force the subprocess to emit the lease token in stderr;
        # verify the daemon redacts it before returning.
        self._seed_request(
            request_id="REQ-RED-1",
            role="primary_plan",
            target_agent="aria-primary-planner",
        )

        captured_lease = {"token": ""}

        def fake_run_capturing_lease(argv, *args, **kwargs):
            self.captured_argvs.append(list(argv))
            self.captured_envs.append(dict(kwargs.get("env", {})))
            captured_lease["token"] = kwargs.get("env", {}).get(
                LEASE_TOKEN_ENV_VAR, ""
            )
            return _CapturedSubprocess(
                returncode=1,
                stderr=f"oops lease={captured_lease['token']} mismatch",
            )

        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            fake_run_capturing_lease,
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:4",
            )
        self.assertTrue(captured_lease["token"])
        # Raw token must NEVER appear in argv.
        for arg in self.captured_argvs[0]:
            self.assertNotIn(captured_lease["token"], arg)
        # Raw token must be redacted in stderr_redacted output.
        self.assertNotIn(captured_lease["token"], result["stderr_redacted"])
        self.assertIn("<lease-token-redacted>", result["stderr_redacted"])

    def test_subagent_type_sourced_from_target_agent_field(self) -> None:
        # The hook reads target_agent from the request row. No
        # internal role→agent map exists in the daemon (SSoT lives at
        # agent_contract.ROLE_TARGET_PAIRING; daemon trusts the row).
        self._seed_request(
            request_id="REQ-CUSTOM",
            role="primary_plan",
            target_agent="aria-some-custom-planner",
        )
        with patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ):
            dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="daemon:test:5",
            )
        # argv[3] is the subagent_type — must equal the SSoT field.
        self.assertEqual(
            self.captured_argvs[0][3], "aria-some-custom-planner"
        )


if __name__ == "__main__":
    unittest.main()
