"""Plan 024 v3 §H-3 + §H-4 — lease expiry fail-closed + role match.

§H-3: _latest_lease_expiry now raises GovernanceError on parse
failure / missing field / no-claim-row instead of silently returning
None. Both submit_claim_result and heartbeat_claim consumed the
None-pass-through fail-OPEN before the fix.

§H-4: validate_response now compares envelope.role to request.role
inside the `if request is not None` cross-check branch. Pre-fix
only the REQUEST_ROLES membership was asserted; a domain_review
request could accept an architectural_judgment response.

Tests:
1. _latest_lease_expiry raises lease_not_found when no claim row.
2. _latest_lease_expiry raises lease_expires_at_unparseable_or_missing
   when every row's lease_expires_at is unparseable.
3. validate_response with envelope.role == request.role passes
   (regression — happy path).
4. validate_response with envelope.role != request.role raises
   response_role_mismatch_with_request.
"""
from __future__ import annotations

import unittest

from aria_kernel.agent_contract import validate_response
from aria_kernel.agent_invocations import _latest_lease_expiry
from aria_kernel.tool_registry import GovernanceError


class LatestLeaseExpiryFailClosedTests(unittest.TestCase):
    def test_no_claim_row_raises_lease_not_found(self) -> None:
        """Plan 024 §H-3 acceptance (1)."""
        with self.assertRaises(GovernanceError) as ctx:
            _latest_lease_expiry([], "claim_xyz")
        self.assertIn("lease_not_found", str(ctx.exception))

    def test_unparseable_expiry_raises(self) -> None:
        """Plan 024 §H-3 acceptance (2)."""
        claims = [
            {
                "claim_id": "claim_xyz",
                "event": "claimed",
                "lease_expires_at": "definitely-not-an-iso-timestamp",
            },
            {
                "claim_id": "claim_xyz",
                "event": "heartbeat",
                "lease_expires_at": "",  # empty / missing too
            },
        ]
        with self.assertRaises(GovernanceError) as ctx:
            _latest_lease_expiry(claims, "claim_xyz")
        msg = str(ctx.exception)
        self.assertIn("lease_expires_at_unparseable_or_missing", msg)


def _envelope(role: str, request_id: str = "REQ-1") -> dict:
    return {
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": "claim_aaaaaaaaaaaaaaaa",
        "agent_id": "test-agent",
        "role": role,
        "status": "submitted",
        "satisfaction_matrix": [
            {
                "id": "c-1",
                "verdict": "satisfied",
                "evidence_refs": ["src/x.ts:1"],
            },
        ],
        "evidence_refs": ["src/x.ts:1"],
    }


def _request(role: str, request_id: str = "REQ-1") -> dict:
    return {
        "request_id": request_id,
        "role": role,
        "must_satisfy": [{"id": "c-1", "criterion": "ok"}],
        "allowed_scope": ["**"],
    }


class ValidateResponseRoleMatchTests(unittest.TestCase):
    def test_envelope_role_matches_request_role_passes(self) -> None:
        """Plan 024 §H-4 acceptance (3): regression happy path."""
        env = _envelope(role="evidence_judgment")
        req = _request(role="evidence_judgment")
        # Should not raise.
        validate_response(env, request=req)

    def test_envelope_role_mismatch_raises(self) -> None:
        """Plan 024 §H-4 acceptance (4)."""
        env = _envelope(role="adversarial_judgment")
        req = _request(role="evidence_judgment")
        with self.assertRaises(GovernanceError) as ctx:
            validate_response(env, request=req)
        msg = str(ctx.exception)
        self.assertIn("response_role_mismatch_with_request", msg)
        self.assertIn("adversarial_judgment", msg)
        self.assertIn("evidence_judgment", msg)


if __name__ == "__main__":
    unittest.main()
