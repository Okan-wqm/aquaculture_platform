"""Plan 023 v3 §A-5 — envelope claim_id/agent_id bound to lease.

Pre-Plan-023 validate_response checked envelope.request_id against
request.request_id but did NOT compare envelope.claim_id or
envelope.agent_id to the leased claim/agent identity. submit_claim_
result validated the function-arg agent_id against claim_event
(line 636-638) but never bound the envelope's claim_id/agent_id.

A stitched envelope from a different lease — same request_id but
different claim_id and/or agent_id — passed validation. An attacker
or buggy caller could submit work under one lease while the envelope
claimed a different lease's identity.

Plan 023 v3 §A-5 fix: validate_response gains an optional `lease`
parameter. When supplied (which submit_claim_result now does), the
envelope's claim_id and agent_id MUST match the leased identity.
Mismatch → GovernanceError('envelope_claim_id_mismatch') or
'envelope_agent_id_mismatch'.

Tests:
1. envelope.claim_id matches leased.claim_id + envelope.agent_id
   matches leased.agent_id → pass.
2. envelope.claim_id swapped → reject.
3. envelope.agent_id swapped → reject.
4. lease=None (legacy callers) → no binding check (regression).
"""
from __future__ import annotations

import unittest

from aria_kernel.agent_contract import validate_response
from aria_kernel.tool_registry import GovernanceError


def _make_envelope(
    *,
    claim_id: str = "claim_test-001",
    agent_id: str = "agent-test-001",
    request_id: str = "req-test-001",
) -> dict:
    return {
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": claim_id,
        "agent_id": agent_id,
        "role": "implementation",
        "status": "submitted",
        "satisfaction_matrix": [],
        "rationale": "all clear",
        "evidence_refs": [],
    }


class EnvelopeLeaseBindingTests(unittest.TestCase):
    def test_matching_envelope_passes(self) -> None:
        envelope = _make_envelope(
            claim_id="claim_test-001",
            agent_id="agent-test-001",
        )
        # Should NOT raise.
        validate_response(
            envelope,
            lease={"claim_id": "claim_test-001", "agent_id": "agent-test-001"},
        )

    def test_envelope_claim_id_mismatch_rejects(self) -> None:
        envelope = _make_envelope(claim_id="claim_attacker-002")
        with self.assertRaises(GovernanceError) as ctx:
            validate_response(
                envelope,
                lease={"claim_id": "claim_test-001", "agent_id": "agent-test-001"},
            )
        self.assertIn("envelope_claim_id_mismatch", str(ctx.exception))

    def test_envelope_agent_id_mismatch_rejects(self) -> None:
        envelope = _make_envelope(agent_id="agent-attacker-002")
        with self.assertRaises(GovernanceError) as ctx:
            validate_response(
                envelope,
                lease={"claim_id": "claim_test-001", "agent_id": "agent-test-001"},
            )
        self.assertIn("envelope_agent_id_mismatch", str(ctx.exception))

    def test_no_lease_no_binding_check(self) -> None:
        """Regression: legacy callers that don't pass lease still see the
        original validate_response behavior (request-only check)."""
        envelope = _make_envelope(claim_id="claim_any-001", agent_id="any-agent")
        # Should NOT raise — no lease provided means no binding check.
        validate_response(envelope, lease=None)


if __name__ == "__main__":
    unittest.main()
