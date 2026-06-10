"""Plan 023 v3 §A-4 — lease expiry time-check on heartbeat + submit.

Pre-Plan-023 heartbeat_claim and submit_claim_result checked terminal
events ONLY (released / stale / human_required). They did NOT check
`lease_expires_at > utc_now()`. An expired lease (whose reaper sweep
hadn't yet appended the `stale` row) still accepted heartbeat AND
submit. The reaper provides eventual consistency; without a real-time
gate, agents could continue working past their allocated lease.

Plan 023 v3 §A-4 fix: new _latest_lease_expiry() helper returns the
max lease_expires_at across the original `claimed` row + all
`heartbeat` rows. heartbeat_claim and submit_claim_result both check
`if latest_expires < now: raise GovernanceError("lease_expired: ...")`.

Tests:
1. Fresh lease → heartbeat accepts.
2. Lease past expiry → heartbeat reject.
3. Lease past expiry → submit reject.
4. Heartbeat extends lease past now → submit accepts.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import (
    _hash_lease_token,
    heartbeat_claim,
    submit_claim_result,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).astimezone(timezone.utc).isoformat()


class LeaseExpiryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a4-"))
        self.base = self.tmp / "aria-tools"
        ensure_tools_dir(self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_request_and_claim(self, *, lease_expires_at: datetime) -> tuple[str, str, str]:
        """Seed a request + claim row directly via append_jsonl with a
        controlled lease_expires_at. Returns (request_id, claim_id,
        lease_token)."""
        request_id = "req-test-001"
        claim_id = "claim-test-001"
        agent_id = "agent-test-001"
        lease_token = "secret-token-test-001"
        # Request row.
        append_declared_fixture(
            self.base / "agent-invocations" / "requests.jsonl",
            {
                "schema_version": 1,
                "event": "created",
                "request_id": request_id,
                "role": "executor",
                "must_satisfy": [],
                "evidence_caps": {"max_response_tokens": 1000},
                "expected_output_path": str(self.tmp / "out.json"),
            },
            expected_surface="agent_invocation_requests",
        )
        # Claim row.
        append_declared_fixture(
            self.base / "agent-invocations" / "claims.jsonl",
            {
                "schema_version": 1,
                "event": "claimed",
                "claim_id": claim_id,
                "request_id": request_id,
                "agent_id": agent_id,
                "lease_token_hash": _hash_lease_token(lease_token),
                "claimed_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
                "lease_expires_at": _iso(lease_expires_at),
            },
            expected_surface="agent_invocation_claims",
        )
        return request_id, claim_id, lease_token

    def test_fresh_lease_heartbeat_accepts(self) -> None:
        """Baseline: lease in the future → heartbeat extends it."""
        future = datetime.now(timezone.utc) + timedelta(minutes=10)
        _, claim_id, token = self._seed_request_and_claim(lease_expires_at=future)
        result = heartbeat_claim(
            claim_id=claim_id,
            agent_id="agent-test-001",
            lease_token=token,
            base_dir=self.base,
        )
        self.assertEqual(result["event"], "heartbeat")

    def test_expired_lease_heartbeat_rejects(self) -> None:
        """Plan 023 v3 §A-4 — past-expiry lease → reject heartbeat."""
        past = datetime.now(timezone.utc) - timedelta(seconds=10)
        _, claim_id, token = self._seed_request_and_claim(lease_expires_at=past)
        with self.assertRaises(GovernanceError) as ctx:
            heartbeat_claim(
                claim_id=claim_id,
                agent_id="agent-test-001",
                lease_token=token,
                base_dir=self.base,
            )
        self.assertIn("lease_expired", str(ctx.exception))

    def test_expired_lease_submit_rejects(self) -> None:
        """Plan 023 v3 §A-4 — past-expiry lease → reject submit."""
        past = datetime.now(timezone.utc) - timedelta(seconds=10)
        _, claim_id, token = self._seed_request_and_claim(lease_expires_at=past)
        # Write a fake envelope file at the expected output path.
        out_path = self.tmp / "out.json"
        out_path.write_text(json.dumps({}), encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            submit_claim_result(
                claim_id=claim_id,
                agent_id="agent-test-001",
                lease_token=token,
                output_path=out_path,
                workspace_root=self.tmp,
                base_dir=self.base,
            )
        self.assertIn("lease_expired", str(ctx.exception))

    def test_heartbeat_extends_lease_then_submit_accepts(self) -> None:
        """Plan 023 v3 §A-4 — heartbeat extends lease past current
        time; subsequent submit sees the extended lease and proceeds
        past the time-check (will then fail on a different gate, e.g.
        envelope-validation, which is fine — the lease check is what
        we're pinning)."""
        future = datetime.now(timezone.utc) + timedelta(minutes=10)
        _, claim_id, token = self._seed_request_and_claim(lease_expires_at=future)
        # Heartbeat extends the lease by another extend window.
        heartbeat_claim(
            claim_id=claim_id,
            agent_id="agent-test-001",
            lease_token=token,
            base_dir=self.base,
            extend_seconds=600,
        )
        # Submit with bad envelope — we expect rejection but NOT for
        # lease_expired; some other reason fires. The point is the
        # lease-expiry check passed.
        out_path = self.tmp / "out.json"
        out_path.write_text(json.dumps({}), encoding="utf-8")
        try:
            submit_claim_result(
                claim_id=claim_id,
                agent_id="agent-test-001",
                lease_token=token,
                output_path=out_path,
                workspace_root=self.tmp,
                base_dir=self.base,
            )
            # Submit may succeed or fail on schema; either way no
            # lease_expired surfaces.
        except GovernanceError as exc:
            self.assertNotIn("lease_expired", str(exc))


if __name__ == "__main__":
    unittest.main()
