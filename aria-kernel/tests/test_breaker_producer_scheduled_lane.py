"""ORPHAN-CRITICAL-485 — the failure breaker's producer must fire on the lane a
SCHEDULE actually walks, under the profile that schedule uses.

Why this file replaces the previous reachability test
====================================================
The earlier test called the private ``cycle._run_pr_lifecycle_phase`` directly
and injected a synthetic perimeter GovernanceError. It passed while the
production path was dead four ways over:

  1. ``_run_extended_phases`` only ran when ``run_phases is not None``, and the
     autonomy orchestrator never passed it.
  2. The callsite is gated on ``pr_create``, which the nightly's ``standard``
     profile does not permit — ``enforce_profile_for_action`` raises
     ``profile_violation`` 92 lines before the perimeter check, so the message
     never carries PERIMETER_REFUSED_PREFIX.
  3. The proposal set it iterates has no autonomous producer.
  4. It therefore recorded nothing on any schedule.

Reason 1 is now history: RC-1 deleted ``_run_extended_phases`` and made
``pr_lifecycle`` a row in ``cycle.CYCLE_PHASES``. Reasons 2 and 3 stand, and
they are why this file still exists — the phase's precondition reads
``ACTION_PERMISSIONS["pr_open"]``, so under the nightly's ``standard`` profile
it records a skip rather than running. A breaker producer that depends on a
phase the nightly skips is still not a producer on the scheduled lane.

Calling a private function with a synthetic error proves the function works. It
proves nothing about what reaches it. This test drives the PUBLIC entry point the
drainer actually invokes — ``dispatch_one_pending_planner_request`` — mocks only
the subprocess boundary, and asserts a row lands in the real breaker ledger.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock
from unittest.mock import patch

from aria_kernel.circuit_breaker import FAILURE_KINDS, _read_failures_evidence
from tests._helpers.declared_fixtures import append_declared_fixture
from aria_kernel.planner_dispatch_hook import dispatch_one_pending_planner_request
from aria_kernel.tool_registry import ensure_tools_dir


class BreakerProducerOnTheScheduledLane(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-breaker-lane-"))
        self.tools_root = ensure_tools_dir(self.tmp / "aria-tools")
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

    def _seed_request(self, *, request_id: str) -> None:
        requests_path = self.tools_root / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            requests_path,
            {
                "$schema": "aria/agent-invocation-request/v1",
                "schema_version": 1,
                "request_id": request_id,
                "role": "primary_plan",
                "target_agent": "aria-primary-planner",
                "suggested_prompt": "test prompt",
                "must_satisfy": [{"id": "S1"}],
                "evidence_refs": [],
                "allowed_scope": ["aria-kernel/**"],
                "expected_output_path": str(self.tmp / f"out-{request_id}.json"),
                "state": "pending",
                "created_at": "2026-05-10T00:00:00Z",
            },
            expected_surface="agent_invocation_requests",
        )

    def test_subprocess_timeout_is_a_declared_failure_kind(self) -> None:
        """Guards the vocabulary: record_failure RAISES on an unknown kind, so a
        rename upstream would turn the producer into a silent no-op."""
        self.assertIn("subprocess_timeout", FAILURE_KINDS)

    def test_a_dispatch_timeout_records_a_breaker_failure(self) -> None:
        self._seed_request(request_id="req-timeout-1")
        before = len(_read_failures_evidence(self.tools_root).rows)

        # The ONLY stub is the subprocess boundary — the timeout itself.
        # Everything from the except arm onward is production code.
        with mock.patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=1),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="gha-runner:test",
            )

        self.assertEqual(
            result["status"], "executor_failed",
            f"expected the timeout arm, got {result!r}",
        )
        after = _read_failures_evidence(self.tools_root)
        self.assertEqual(
            len(after.rows), before + 1,
            "a dispatch timeout must append exactly one breaker failure row",
        )
        self.assertEqual(after.rows[-1].get("kind"), "subprocess_timeout")

    def test_a_ledger_failure_does_not_crash_the_dispatch(self) -> None:
        """The governance event for the timeout is written BEFORE the breaker
        row, so losing the row must not lose the event or the dispatch result."""
        self._seed_request(request_id="req-timeout-2")
        with mock.patch(
            "aria_kernel.planner_dispatch_hook.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=1),
        ), mock.patch(
            "aria_kernel.circuit_breaker.record_failure",
            side_effect=OSError("ledger unwritable"),
        ):
            result = dispatch_one_pending_planner_request(
                base_dir=self.tools_root,
                agent_id="gha-runner:test",
            )
        self.assertEqual(result["status"], "executor_failed")

    def test_removing_the_producer_would_be_caught(self) -> None:
        """Negative control on the source. Without it this suite could pass
        against a build with the record_failure call deleted — which is exactly
        how the previous reachability test stayed green through four broken
        levels."""
        from aria_kernel import planner_dispatch_hook as hook

        source = Path(hook.__file__).read_text(encoding="utf-8")
        arm = source[source.index("except subprocess.TimeoutExpired:"):]
        arm = arm[: arm.index('"stderr_redacted": "executor_timeout",')]
        self.assertIn("record_failure(", arm)
        self.assertIn('kind="subprocess_timeout"', arm)


if __name__ == "__main__":
    unittest.main()
