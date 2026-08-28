"""Y1+Y3 (ORPHAN-703) — claim lifecycle + dead-request re-mint.

Second sealed night's measurement: 106 ``lease_expired`` requeues and every
planner HUMAN_REQUIRED escalation carried the same signature — the dispatch
hook abandoned its claim on failure (timeout budget LONGER than the lease,
no release on any failure path), and both planner-request idempotency
filters counted terminally-dead envelopes as live, wedging the round.

Deliberate-breakage pins:
- the hook releases on EVERY failure exit (timeout + non-zero exit);
- the child's wall-clock budget sits strictly inside the lease;
- both new release reasons are harness-class (never burn request budget);
- a dead planner request is succeeded with ``remint_of`` lineage, a live
  one short-circuits, and the third successor is refused with an honest
  exhausted disclosure.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.agent_invocations import (
    HARNESS_FAULT_RELEASE_REASONS,
    _is_harness_fault_reason,
    claim_request,
    derive_request_state,
)
from aria_kernel.planner_dispatch_hook import (
    _executor_timeout_seconds,
    _release_abandoned_claim,
    dispatch_one_pending_planner_request,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class _FakeProc:
    def __init__(self, returncode: int = 0, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


class _StoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-y1y3-"))
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

    def _seed_request(self, *, request_id: str, role: str, target_agent: str) -> None:
        requests_path = self.tools_root / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            requests_path,
            {
                "$schema": "aria/agent-invocation-request/v1",
                "schema_version": 1,
                "request_id": request_id,
                "role": role,
                "target_agent": target_agent,
                "suggested_prompt": "test prompt",
                "must_satisfy": [{"id": "S1"}],
                "evidence_refs": [],
                "allowed_scope": ["aria-kernel/**"],
                "expected_output_path": str(self.tmp / f"out-{request_id}.json"),
                "state": "pending",
                "created_at": "2026-08-17T00:00:00Z",
            },
            expected_surface="agent_invocation_requests",
        )

    def _claim_rows(self) -> list[dict[str, Any]]:
        path = self.tools_root / "agent-invocations" / "claims.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def _governance_kinds(self) -> list[str]:
        gov = self.tools_root / "governance.jsonl"
        if not gov.exists():
            return []
        return [json.loads(l)["kind"] for l in gov.read_text(encoding="utf-8").splitlines() if l.strip()]


class ExecutorTimeoutBudgetTests(unittest.TestCase):
    def test_timeout_sits_strictly_inside_the_lease(self) -> None:
        # The shipped value was lease+60: the lease died before the timeout
        # could ever fire. The budget must leave the release a live lease.
        self.assertEqual(_executor_timeout_seconds(1800), 1680)
        self.assertLess(_executor_timeout_seconds(1800), 1800)

    def test_floor_keeps_test_scale_leases_usable(self) -> None:
        self.assertEqual(_executor_timeout_seconds(60), 300)

    def test_new_release_reasons_are_harness_class(self) -> None:
        # Harness-class = the requeue does NOT burn the request's budget.
        for reason in (
            "planner_dispatch_executor_timeout",
            "planner_dispatch_executor_exit_nonzero",
        ):
            self.assertIn(reason, HARNESS_FAULT_RELEASE_REASONS)
            self.assertTrue(_is_harness_fault_reason(reason))


class HookReleasesOnFailureTests(_StoreCase):
    def _dispatch(self, fake_run) -> dict[str, Any]:
        with patch("aria_kernel.planner_dispatch_hook.subprocess.run", fake_run):
            return dispatch_one_pending_planner_request(
                base_dir=self.tools_root, agent_id="daemon:test:y1",
            )

    def test_timeout_releases_claim_and_requeues_without_burning_budget(self) -> None:
        self._seed_request(
            request_id="REQ-TMO-1", role="primary_plan",
            target_agent="aria-primary-planner",
        )

        def raising_run(argv, *args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=argv, timeout=1)

        result = self._dispatch(raising_run)
        self.assertEqual(result["status"], "executor_failed")
        events = {(r.get("event"), r.get("reason")) for r in self._claim_rows()}
        self.assertIn(("released", "planner_dispatch_executor_timeout"), events)
        self.assertIn(("requeued", "planner_dispatch_executor_timeout"), events)
        # Harness-class: the request derives back to a drainable state, not
        # toward HUMAN_REQUIRED.
        self.assertEqual(
            derive_request_state(request_id="REQ-TMO-1", base_dir=self.tools_root),
            "REQUEUED",
        )

    def test_nonzero_exit_releases_claim(self) -> None:
        self._seed_request(
            request_id="REQ-EXIT-1", role="challenger_plan",
            target_agent="aria-challenger-planner",
        )

        def failing_run(argv, *args, **kwargs):
            return _FakeProc(returncode=1, stderr="boom")

        result = self._dispatch(failing_run)
        self.assertEqual(result["status"], "executor_failed")
        events = {(r.get("event"), r.get("reason")) for r in self._claim_rows()}
        self.assertIn(("released", "planner_dispatch_executor_exit_nonzero"), events)
        self.assertEqual(
            derive_request_state(request_id="REQ-EXIT-1", base_dir=self.tools_root),
            "REQUEUED",
        )

    def test_double_release_is_tolerated_and_disclosed(self) -> None:
        # The child may have released through its own CLI-failure classes;
        # the hook's second attempt must be a recorded refusal, not a crash.
        self._seed_request(
            request_id="REQ-DBL-1", role="primary_plan",
            target_agent="aria-primary-planner",
        )
        claim = claim_request(
            request_id="REQ-DBL-1", agent_id="daemon:test:dbl",
            lease_seconds=1800, base_dir=self.tools_root,
        )
        first = _release_abandoned_claim(
            root=self.tools_root, claim_id=claim["claim_id"],
            agent_id="daemon:test:dbl", lease_token=claim["lease_token"],
            reason="planner_dispatch_executor_timeout",
        )
        second = _release_abandoned_claim(
            root=self.tools_root, claim_id=claim["claim_id"],
            agent_id="daemon:test:dbl", lease_token=claim["lease_token"],
            reason="planner_dispatch_executor_timeout",
        )
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertIn(
            "planner_dispatch_release_skipped_already_released",
            self._governance_kinds(),
        )
        released = [
            r for r in self._claim_rows()
            if r.get("event") == "released" and r.get("claim_id") == claim["claim_id"]
        ]
        # Exactly one released row — the skip prevented the duplicate
        # released+requeued pair a blind second release would append.
        self.assertEqual(len(released), 1)


class DeadPlannerRequestRemintTests(_StoreCase):
    """Y3 — _ensure_planner_request state-aware idempotency."""

    def _state(self) -> dict[str, Any]:
        return {
            "plan_id": "conv-y3-test",
            "latest_revision": {"revision_id": "rev-1"},
            "current_round": 1,
        }

    def _ensure(self) -> dict[str, Any]:
        from aria_kernel.plan_round_controller import _ensure_planner_request

        return _ensure_planner_request(
            self.tools_root, self._state(), role="challenger_plan",
        )

    def _kill_request(self, request_id: str) -> None:
        # Three request-fault requeues push the derived state over
        # DEFAULT_MAX_REQUEUES into HUMAN_REQUIRED — the measured death.
        claims_path = self.tools_root / "agent-invocations" / "claims.jsonl"
        claims_path.parent.mkdir(parents=True, exist_ok=True)
        for n in (1, 2, 3):
            append_declared_fixture(
                claims_path,
                {
                    "schema_version": 1,
                    "event": "requeued" if n <= 2 else "human_required",
                    "claim_id": f"claim-{request_id}-{n}",
                    "request_id": request_id,
                    "at": f"2026-08-17T0{n}:00:00+00:00",
                    "requeue_count": n,
                    "reason": "lease_expired",
                },
                expected_surface="agent_invocation_claims",
            )

    def test_live_request_short_circuits(self) -> None:
        first = self._ensure()
        self.assertEqual(first["kind"], "planner_request_created")
        second = self._ensure()
        self.assertEqual(second["kind"], "planner_request_exists")
        self.assertEqual(second["request_id"], first["request_id"])

    def test_dead_request_is_succeeded_with_lineage(self) -> None:
        first = self._ensure()
        self.assertEqual(
            derive_request_state(request_id=first["request_id"], base_dir=self.tools_root),
            "PENDING",
        )
        self._kill_request(first["request_id"])
        self.assertEqual(
            derive_request_state(request_id=first["request_id"], base_dir=self.tools_root),
            "HUMAN_REQUIRED",
        )
        successor = self._ensure()
        self.assertEqual(successor["kind"], "planner_request_reminted")
        self.assertEqual(successor["remint_of"], first["request_id"])
        self.assertNotEqual(successor["request_id"], first["request_id"])

    def test_third_successor_is_refused_with_disclosure(self) -> None:
        first = self._ensure()
        self._kill_request(first["request_id"])
        second = self._ensure()
        self.assertEqual(second["kind"], "planner_request_reminted")
        self._kill_request(second["request_id"])
        third = self._ensure()
        self.assertEqual(third["kind"], "planner_request_reminted")
        self._kill_request(third["request_id"])
        exhausted = self._ensure()
        self.assertEqual(exhausted["kind"], "planner_request_remint_exhausted")
        self.assertIn("planner_request_remint_exhausted", self._governance_kinds())


if __name__ == "__main__":
    unittest.main()
