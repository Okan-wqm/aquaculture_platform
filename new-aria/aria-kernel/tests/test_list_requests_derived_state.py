"""Plan 026R §B.4 — list_agent_invocation_requests uses derive_request_state.

4 tests:

* Raw-state pending + derived CLAIMED → filtered out of state="claimed"
  result set with the pre-§B.4 logic (zero hits); now included.
* Raw-state pending + derived PENDING → still included in state="pending".
* Case normalisation: ``--state claimed`` matches derived ``CLAIMED``.
* Per-call derive cache regression: calling list_..._requests with
  state filter invokes derive_request_state at most once per request_id
  (mock-counter check).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.runtime_profile import set_profile


class ListRequestsDerivedStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-b4-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        # Two requests in different derived states.
        self.r1 = create_agent_invocation_request(
            target_agent="agent-a", role="primary_plan",
            suggested_prompt="r1",
            expected_output_path="docs/r1.md",
            must_satisfy=[{"id": "p", "description": "p"}],
            allowed_scope=["docs/"], evidence_refs=["docs/a.md"],
            base_dir=self.base,
        )
        self.r2 = create_agent_invocation_request(
            target_agent="agent-b", role="primary_plan",
            suggested_prompt="r2",
            expected_output_path="docs/r2.md",
            must_satisfy=[{"id": "p", "description": "p"}],
            allowed_scope=["docs/"], evidence_refs=["docs/b.md"],
            base_dir=self.base,
        )
        # Claim r1 → derived state CLAIMED. r2 stays PENDING.
        claim_request(
            request_id=self.r1["request_id"], agent_id="agent-a",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_state_claimed_filter_returns_claimed_request_only(self) -> None:
        result = list_agent_invocation_requests(
            base_dir=self.base, state="CLAIMED",
        )
        ids = sorted(row["request_id"] for row in result)
        self.assertEqual(ids, [self.r1["request_id"]])

    def test_state_pending_filter_returns_pending_request_only(self) -> None:
        result = list_agent_invocation_requests(
            base_dir=self.base, state="PENDING",
        )
        ids = sorted(row["request_id"] for row in result)
        self.assertEqual(ids, [self.r2["request_id"]])

    def test_state_filter_case_normalised_lowercase(self) -> None:
        # CLI users may pass ``--state claimed`` (lowercase). The filter
        # must normalise to the derive_request_state uppercase return.
        result = list_agent_invocation_requests(
            base_dir=self.base, state="claimed",
        )
        ids = sorted(row["request_id"] for row in result)
        self.assertEqual(ids, [self.r1["request_id"]])

    def test_per_call_derive_cache_invokes_once_per_request_id(self) -> None:
        # Plan 026R §B.4 — the per-call cache hits derive_request_state
        # at most once per request_id across the filter pass.
        call_counts: dict[str, int] = {}
        original = list_agent_invocation_requests.__globals__["derive_request_state"]

        def counting(*args, **kwargs):
            rid = kwargs.get("request_id") or (args[0] if args else None)
            call_counts[rid] = call_counts.get(rid, 0) + 1
            return original(*args, **kwargs)

        with patch(
            "aria_kernel.agent_invocations.derive_request_state",
            side_effect=counting,
        ):
            list_agent_invocation_requests(
                base_dir=self.base, state="PENDING",
            )
        for rid, count in call_counts.items():
            self.assertLessEqual(
                count, 1,
                f"derive_request_state called {count}x for {rid} — cache miss",
            )


if __name__ == "__main__":
    unittest.main()
