"""Tests for the Plan 016 Faz C2 lease / heartbeat / requeue lifecycle."""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import (
    DEFAULT_MAX_REQUEUES,
    DERIVED_STATES,
    claim_request,
    create_agent_invocation_request,
    derive_request_state,
    heartbeat_claim,
    next_pending_request,
    reap_stale_claims,
    release_claim,
)
from aria_kernel.agent_surface import TERMINAL_REQUEST_STATES
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_request(
    tools: Path,
    *,
    target_agent: str = "aria-primary-planner",
    role: str = "primary_plan",
    suggested_prompt: str = "draft architecture-first plan",
    convergence_id: str = "conv-001",
) -> dict:
    # Plan 024 §B-2 — lease lifecycle tests go through the strict claim
    # path; request needs real strict fields so _strict_request_view
    # accepts the conversion.
    return create_agent_invocation_request(
        target_agent=target_agent,
        role=role,
        suggested_prompt=suggested_prompt,
        must_satisfy=[
            {"id": "lease-lifecycle-test", "criterion": "lease moves through states"},
        ],
        allowed_scope=["aria-kernel/**"],
        convergence_id=convergence_id,
        base_dir=tools,
    )


class LeaseLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_pending_request_state_is_PENDING(self) -> None:
        req = _seed_request(self.tools)
        state = derive_request_state(request_id=req["request_id"], base_dir=self.tools)
        self.assertEqual(state, "PENDING")

    def test_next_pending_returns_first_unclaimed_request(self) -> None:
        first = _seed_request(self.tools, suggested_prompt="prompt-1")
        _ = _seed_request(self.tools, suggested_prompt="prompt-2")
        nxt = next_pending_request(role="primary_plan", base_dir=self.tools)
        self.assertEqual(nxt["request_id"], first["request_id"])

    def test_next_pending_skips_claimed_requests(self) -> None:
        first = _seed_request(self.tools, suggested_prompt="prompt-1")
        second = _seed_request(self.tools, suggested_prompt="prompt-2")
        claim_request(
            request_id=first["request_id"], agent_id="worker-1", base_dir=self.tools
        )
        nxt = next_pending_request(role="primary_plan", base_dir=self.tools)
        self.assertEqual(nxt["request_id"], second["request_id"])

    def test_claim_creates_lease_and_returns_raw_token_once(self) -> None:
        req = _seed_request(self.tools)
        claim = claim_request(
            request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools
        )
        self.assertTrue(claim["claim_id"].startswith("claim_"))
        self.assertTrue(claim["lease_token"])
        self.assertTrue(claim["lease_token_hash"].startswith("sha256:"))
        # Second claim attempt fails because the request is now CLAIMED.
        with self.assertRaisesRegex(GovernanceError, "must be PENDING or REQUEUED"):
            claim_request(
                request_id=req["request_id"], agent_id="worker-2", base_dir=self.tools
            )
        # Raw token never appears in the persisted claims.jsonl.
        contents = (self.tools / "agent-invocations" / "claims.jsonl").read_text()
        self.assertNotIn(claim["lease_token"], contents)

    def test_state_transitions_PENDING_to_CLAIMED_to_RUNNING(self) -> None:
        req = _seed_request(self.tools)
        rid = req["request_id"]
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.tools), "PENDING")
        claim = claim_request(request_id=rid, agent_id="worker-1", base_dir=self.tools)
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.tools), "CLAIMED")
        heartbeat_claim(
            claim_id=claim["claim_id"],
            agent_id="worker-1",
            lease_token=claim["lease_token"],
            base_dir=self.tools,
        )
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.tools), "RUNNING")

    def test_heartbeat_with_wrong_agent_rejected(self) -> None:
        req = _seed_request(self.tools)
        claim = claim_request(
            request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools
        )
        with self.assertRaisesRegex(GovernanceError, "owned by"):
            heartbeat_claim(
                claim_id=claim["claim_id"],
                agent_id="worker-2",
                lease_token=claim["lease_token"],
                base_dir=self.tools,
            )

    def test_heartbeat_with_wrong_token_rejected(self) -> None:
        req = _seed_request(self.tools)
        claim = claim_request(
            request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools
        )
        with self.assertRaisesRegex(GovernanceError, "lease_token mismatch"):
            heartbeat_claim(
                claim_id=claim["claim_id"],
                agent_id="worker-1",
                lease_token="00" * 24,
                base_dir=self.tools,
            )

    def test_release_marks_REQUEUED_and_pending_again(self) -> None:
        req = _seed_request(self.tools)
        rid = req["request_id"]
        claim = claim_request(request_id=rid, agent_id="worker-1", base_dir=self.tools)
        # Plan 026R §B.1 — release_claim now requires lease_token; mirrors
        # heartbeat / submit contract. The token is the claim response.
        release_claim(
            claim_id=claim["claim_id"],
            agent_id="worker-1",
            lease_token=claim["lease_token"],
            reason="worker shutting down",
            base_dir=self.tools,
        )
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.tools), "REQUEUED")
        # next_pending_request picks it back up.
        nxt = next_pending_request(role="primary_plan", base_dir=self.tools)
        self.assertEqual(nxt["request_id"], rid)

    def test_three_releases_escalate_to_HUMAN_REQUIRED(self) -> None:
        req = _seed_request(self.tools)
        rid = req["request_id"]
        for i in range(DEFAULT_MAX_REQUEUES + 1):
            claim = claim_request(
                request_id=rid, agent_id=f"worker-{i}", base_dir=self.tools
            )
            release_claim(
                claim_id=claim["claim_id"],
                agent_id=f"worker-{i}",
                lease_token=claim["lease_token"],
                reason=f"attempt {i} aborted",
                base_dir=self.tools,
            )
        self.assertEqual(
            derive_request_state(request_id=rid, base_dir=self.tools),
            "HUMAN_REQUIRED",
        )

    def test_reap_stale_marks_expired_lease_and_requeues(self) -> None:
        req = _seed_request(self.tools)
        rid = req["request_id"]
        claim = claim_request(
            request_id=rid, agent_id="worker-1", base_dir=self.tools, lease_seconds=60
        )
        # Reap with `now` two hours later -> lease expired.
        future = datetime.now(timezone.utc) + timedelta(hours=2)
        result = reap_stale_claims(base_dir=self.tools, now=future)
        self.assertEqual(len(result["stale"]), 1)
        self.assertEqual(len(result["requeued"]), 1)
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.tools, now=future), "REQUEUED")
        # Idempotent — second reap call is a no-op for the same claim.
        again = reap_stale_claims(base_dir=self.tools, now=future)
        self.assertEqual(len(again["stale"]), 0)

    def test_reap_stale_after_max_requeues_emits_HUMAN_REQUIRED(self) -> None:
        req = _seed_request(self.tools)
        rid = req["request_id"]
        future = datetime.now(timezone.utc)
        for i in range(DEFAULT_MAX_REQUEUES + 1):
            future = future + timedelta(hours=1)
            claim_request(
                request_id=rid, agent_id=f"worker-{i}", base_dir=self.tools, lease_seconds=60
            )
            future = future + timedelta(hours=2)
            reap_stale_claims(base_dir=self.tools, now=future)
        self.assertEqual(
            derive_request_state(request_id=rid, base_dir=self.tools, now=future),
            "HUMAN_REQUIRED",
        )

    def test_derived_states_enumeration_includes_ten_states(self) -> None:
        # Plan 026R §C.5 — DERIVED_STATES expanded with two bridge-
        # aware acceptance states (ACCEPTED_PENDING_BRIDGE +
        # ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL).
        # V10.5 Phase 3 (per ADR-0001) — EXTERNAL_OUTAGE added for
        # Anthropic API 529 transient outage handling.
        # ORPHAN-MEDIUM-492 — ANCHOR_STALE added, and deliberately NOT
        # folded into STALE: a lease-expired request is retryable, whereas
        # one anchored at an obsolete tree cannot be made current by
        # retrying it. Count is now 14.
        self.assertEqual(len(DERIVED_STATES), 14)
        self.assertIn("EXTERNAL_OUTAGE", DERIVED_STATES)
        self.assertIn("ANCHOR_STALE", DERIVED_STATES)
        self.assertIn("ANCHOR_STALE", TERMINAL_REQUEST_STATES)
        # The two must stay separate names, not aliases: collapsing them
        # would make an obsolete-anchor request look retryable.
        self.assertNotEqual("STALE", "ANCHOR_STALE")
        self.assertEqual(
            len([s for s in DERIVED_STATES if s.endswith("STALE")]), 2
        )


if __name__ == "__main__":
    unittest.main()
