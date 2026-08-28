"""Plan 025 §E — worker dispatch hook tests.

Seven cases covering: no-pending early-return, executor non-zero
exit fail-fast + claim release, max_retries pre-claim guard, retry
scheduling on verification failure, verified_pending_merge when
PR bridge missing, lease-token discipline (env-only, never argv,
redacted in stderr), merged path via merge_if_green when PR
exists + GitHubAdapter injected.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aria_kernel.ledger import append_jsonl as _append_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.worker_dispatch_hook import (
    LEASE_TOKEN_ENV_VAR,
    dispatch_one_pending_worker_assignment,
)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    return _append_jsonl(path, record, test_fixture=True)


class _CapturedSubprocess:
    def __init__(self, returncode: int = 0, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


class WorkerDispatchHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-wdh-"))
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
        self.captured_argvs: list[list[str]] = []
        self.captured_envs: list[dict[str, str]] = []
        # Plan ARIA-V3 §A2 — github_adapter is REQUIRED on the hook
        # signature. A plain MagicMock satisfies the Protocol via
        # duck-typing for the branches that do not exercise the
        # merge path. Tests that need real adapter behaviour
        # override this explicitly.
        self.fake_github_adapter = MagicMock(name="github_adapter")

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_dispatch_row(
        self, *,
        assignment_id: str = "A-W-1",
        triage_tier: str = "auto_fix_safe",
    ) -> None:
        path = self.tools_root / "dispatch" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/dispatch-request/v1",
            "schema_version": 1,
            "assignment_id": assignment_id,
            "pressure_event_id": f"P-{assignment_id}",
            "target_agent": "aria-worker",
            "triage_tier": triage_tier,
            "worktree_path": str(self.tmp / "worktrees" / assignment_id),
            "base_sha": "deadbeef",
            "required_tests": [],
            "expected_trailer": f"Closes-Pressure: P-{assignment_id}",
            "state": "pending",
            "created_at": "2026-05-10T00:00:00Z",
        }
        append_jsonl(path, row)

    def _seed_governance_failures(
        self, *, assignment_id: str, count: int,
    ) -> None:
        path = self.tools_root / "governance.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(count):
            append_jsonl(
                path,
                {
                    "kind": "verification_gate_failed",
                    "details": {"assignment_id": assignment_id},
                },
            )

    def _capturing_subprocess_run(self, returncode: int = 0, stderr: str = ""):
        outer = self

        def fake_run(argv, *args, **kwargs):
            outer.captured_argvs.append(list(argv))
            outer.captured_envs.append(dict(kwargs.get("env", {})))
            return _CapturedSubprocess(returncode=returncode, stderr=stderr)

        return fake_run

    def test_no_pending_returns_no_pending(self) -> None:
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(),
        ):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:1",
                github_adapter=self.fake_github_adapter,
            )
        self.assertEqual(result["status"], "no_pending")
        self.assertEqual(result["governance_event_count"], 0)
        self.assertEqual(self.captured_argvs, [])

    def test_max_retries_exceeded_pre_claim_guard(self) -> None:
        # Seed 3 prior failures + max_retries=3 → guard fires before
        # claim_assignment, no lease token minted.
        self._seed_dispatch_row(assignment_id="A-MAX")
        self._seed_governance_failures(assignment_id="A-MAX", count=3)
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(),
        ):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:2",
                github_adapter=self.fake_github_adapter,
                max_retries=3,
            )
        self.assertEqual(result["status"], "max_retries_exceeded")
        self.assertEqual(result["retry_count"], 3)
        self.assertIsNone(result["claim_id"])
        # No subprocess invocation — guard is pre-claim.
        self.assertEqual(self.captured_argvs, [])

    def test_executor_nonzero_exit_releases_claim(self) -> None:
        self._seed_dispatch_row(assignment_id="A-EX")
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(
                returncode=1, stderr="executor failed",
            ),
        ):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:3",
                github_adapter=self.fake_github_adapter,
            )
        self.assertEqual(result["status"], "executor_failed")
        self.assertEqual(result["exit_code"], 1)
        # Claim was created then released back to pending.
        gov = (self.tools_root / "governance.jsonl").read_text(
            encoding="utf-8"
        )
        self.assertIn("dispatch_claim_created", gov)
        self.assertIn("dispatch_claim_released", gov)
        self.assertIn("worker_dispatch_executor_exit_nonzero", gov)

    def test_verified_passed_no_pr_returns_pending_merge(self) -> None:
        self._seed_dispatch_row(assignment_id="A-VPM")
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ), patch(
            "aria_kernel.verification_gate.verify_worker_result"
        ) as mock_verify:
            mock_verify.return_value = {"status": "passed", "failures": []}
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:4",
                github_adapter=self.fake_github_adapter,
            )
        self.assertEqual(result["status"], "verified_pending_merge")
        self.assertIsNone(result["merge_result"])
        gov = (self.tools_root / "governance.jsonl").read_text(
            encoding="utf-8"
        )
        self.assertIn("worker_dispatch_verified_pending_merge", gov)

    def test_verified_passed_with_pr_requires_enterprise_readiness_claim(self) -> None:
        # Seed pr-lifecycle.jsonl with assignment_id bridge.
        self._seed_dispatch_row(assignment_id="A-MERGE")
        pr_path = self.tools_root / "pr-lifecycle.jsonl"
        append_jsonl(
            pr_path,
            {
                "schema_version": 1, "event": "opened",
                "pr_number": 555, "assignment_id": "A-MERGE",
            },
        )
        adapter = MagicMock()
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ), patch(
            "aria_kernel.verification_gate.verify_worker_result"
        ) as mock_verify, patch(
            "aria_kernel.merge_authority.merge_pr_if_ready"
        ) as mock_merge:
            set_profile(
                "autonomous",
                operator_approval_ref="test:worker-merge",
                base_dir=self.tools_root,
                set_by="operator",
            )
            mock_verify.return_value = {"status": "passed", "failures": []}
            mock_merge.return_value = {"decision": "merged", "eligible": True}
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:5",
                github_adapter=adapter,
            )
        self.assertEqual(result["status"], "verified_pending_merge")
        self.assertEqual(result["merge_result"]["decision"], "blocked")
        self.assertIn(
            "enterprise_readiness_claim_id_required",
            result["merge_result"]["reasons"],
        )
        mock_merge.assert_not_called()

    def test_verification_failed_retry_scheduled_releases_claim(self) -> None:
        self._seed_dispatch_row(assignment_id="A-FAIL")
        # 0 prior failures → next_retry=1 < max_retries=3 → retry.
        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            self._capturing_subprocess_run(returncode=0),
        ), patch(
            "aria_kernel.verification_gate.verify_worker_result"
        ) as mock_verify:
            mock_verify.return_value = {"status": "failed", "failures": ["test_x"]}
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:6",
                github_adapter=self.fake_github_adapter,
                max_retries=3,
            )
        self.assertEqual(result["status"], "retry_scheduled")
        self.assertEqual(result["retry_count"], 1)
        gov = (self.tools_root / "governance.jsonl").read_text(
            encoding="utf-8"
        )
        self.assertIn("worker_dispatch_retry_scheduled", gov)
        self.assertIn("dispatch_claim_released", gov)

    def test_lease_token_never_in_argv_redacted_in_stderr(self) -> None:
        self._seed_dispatch_row(assignment_id="A-RED")
        captured_lease = {"token": ""}

        def fake_run(argv, *args, **kwargs):
            self.captured_argvs.append(list(argv))
            self.captured_envs.append(dict(kwargs.get("env", {})))
            captured_lease["token"] = (
                kwargs.get("env", {}).get(LEASE_TOKEN_ENV_VAR, "")
            )
            return _CapturedSubprocess(
                returncode=1,
                stderr=f"oops lease={captured_lease['token']} bad",
            )

        with patch(
            "aria_kernel.worker_dispatch_hook.subprocess.run",
            fake_run,
        ):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root,
                agent_id="daemon:test:7",
                github_adapter=self.fake_github_adapter,
            )
        self.assertTrue(captured_lease["token"])
        for arg in self.captured_argvs[0]:
            self.assertNotIn(captured_lease["token"], arg)
        self.assertNotIn(captured_lease["token"], result["stderr_redacted"])
        self.assertIn("<lease-token-redacted>", result["stderr_redacted"])


if __name__ == "__main__":
    unittest.main()
