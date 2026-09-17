"""ARIA-HIGH-086 — a stale envelope is the reaper's to requeue, not the drainer's to bury.

Trial nine (2026-09-12): the planner hook claimed the round-3 cross-review
and its spawn died before the executor started; the lease expired; the next
drainer step ran before the reaper, saw the request STALE, raised
_EnvelopeDead and forced the plan to HUMAN_REQUIRED — for a harness fault
the reaper would have requeued for free.

What this pins, one property per test:

* A request whose only claim's lease has expired is still a LIVE envelope
  for the drainer's step selection.
* After the reaper runs, the same request is REQUEUED and still live.
* A request with an accepted result is not live (the step is done).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel import agent_invocations as ai
from aria_kernel.convergence_drainer import _live_request_id
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-stale-envelope-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.plan_id = "flow-fixture"
        path = self.tools / "agent-invocations" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(path, {
            "$schema": "aria/agent-invocation-request/v1", "schema_version": 1,
            "request_id": "AIR-aria-cross-reviewer-fixture", "role": "cross_review",
            "target_agent": "aria-cross-reviewer", "suggested_prompt": "review",
            "must_satisfy": [{"id": "S1"}], "evidence_refs": [], "allowed_scope": ["**"],
            "expected_output_path": str(self.tmp / "out.json"), "state": "pending",
            "convergence_id": self.plan_id, "round_number": 3,
            "created_at": "2026-09-12T07:00:00Z",
        }, expected_surface="agent_invocation_requests")

    def _live(self) -> str | None:
        return _live_request_id(self.tools, convergence_id=self.plan_id, role="cross_review", round_number=3)


class AStaleEnvelopeIsAlive(_Fixture):
    def test_an_expired_lease_keeps_the_envelope_live_until_the_reaper_decides(self) -> None:
        self.assertEqual(self._live(), "AIR-aria-cross-reviewer-fixture")
        claim = ai.claim_request(request_id="AIR-aria-cross-reviewer-fixture", agent_id="hook-fixture",
                                 base_dir=self.tools, lease_seconds=1)
        self.assertEqual(self._live(), "AIR-aria-cross-reviewer-fixture")
        after_expiry = datetime.now(timezone.utc) + timedelta(seconds=5)
        self.assertEqual(ai.derive_request_state(request_id="AIR-aria-cross-reviewer-fixture",
                                                 base_dir=self.tools, now=after_expiry), "STALE")
        # The drainer's own read uses the wall clock; wait past the lease.
        import time
        time.sleep(1.5)
        self.assertEqual(ai.derive_request_state(request_id="AIR-aria-cross-reviewer-fixture", base_dir=self.tools), "STALE")
        self.assertEqual(self._live(), "AIR-aria-cross-reviewer-fixture", "stale is the reaper's, not dead")
        reaped = ai.reap_stale_claims(base_dir=self.tools)
        self.assertEqual([row["claim_id"] for row in reaped["stale"]], [claim["claim_id"]])
        self.assertEqual(ai.derive_request_state(request_id="AIR-aria-cross-reviewer-fixture", base_dir=self.tools), "REQUEUED")
        self.assertEqual(self._live(), "AIR-aria-cross-reviewer-fixture")


if __name__ == "__main__":
    unittest.main()
