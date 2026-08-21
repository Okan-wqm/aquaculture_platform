"""ORPHAN-HIGH-786 — expired anchors are swept proactively, not lazily.

Expiry was only ever discovered when a claim was attempted against a dead
envelope; the backlog read pending while being dead, the mint gate counted
corpses, and minting continued into the hole the drain could never fill
within the TTL. The sweep retires age-expired requests BEFORE minting, so
the backlog cap counts only envelopes still alive to claim.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import (
    DEFAULT_ANCHOR_MAX_AGE_SECONDS,
    create_agent_invocation_request,
    derive_request_state,
    sweep_expired_anchors,
)
from aria_kernel.judge_fanout import dispatch_judges_for_sample, pending_judge_counts
from aria_kernel.tool_registry import ensure_tools_dir


def _sample_item(finding_id: str = "F-1") -> dict:
    return {
        "tool_id": "tool-a",
        "run_id": "run-1",
        "finding_id": finding_id,
        "cycle_id": "cyc-1",
        "finding_fingerprint": f"fp-{finding_id}",
        "finding": {"id": finding_id, "rule": "r1", "message": "m"},
    }


class AnchorSweepTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-786-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.now = datetime(2026, 8, 21, 12, 0, 0, tzinfo=timezone.utc)
        self.request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="judge F-1",
            must_satisfy=[{"id": "verdict", "criterion": "verdict"}],
            allowed_scope=["**"],
            finding_id="F-1",
            finding_fingerprint="fp-F-1",
            tool_id="tool-a",
            run_id="run-1",
            judgment_group_id="judge:tool-a:g1",
            cycle_id="cyc-1",
            target_sha="a" * 40,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_pending_request_survives_inside_the_ttl(self) -> None:
        fresh = sweep_expired_anchors(base_dir=self.tools, now=self.now)
        self.assertEqual(fresh["swept"], 0)
        state = derive_request_state(
            request_id=self.request["request_id"], base_dir=self.tools, now=self.now
        )
        self.assertEqual(state, "PENDING")

    def test_expired_request_is_retired_and_stays_retired(self) -> None:
        # The clock anchor is the request's own created_at: a fixed test
        # time can sit before the mint and silently shrink the TTL window.
        from aria_kernel.agent_invocations import _parse_iso

        created = _parse_iso(self.request.get("created_at"))
        assert created is not None
        later = created + timedelta(seconds=DEFAULT_ANCHOR_MAX_AGE_SECONDS + 3600)
        first = sweep_expired_anchors(base_dir=self.tools, now=later)
        self.assertEqual(first["swept"], 1)
        self.assertEqual(first["by_role"].get("evidence_judgment"), 1)
        state = derive_request_state(
            request_id=self.request["request_id"], base_dir=self.tools, now=later
        )
        self.assertEqual(state, "ANCHOR_STALE")
        # Idempotent: terminal requests are never re-swept.
        second = sweep_expired_anchors(base_dir=self.tools, now=later)
        self.assertEqual(second["swept"], 0)

    def test_sweep_frees_the_mint_backlog_cap(self) -> None:
        # The measured defect, end to end: an expired judge envelope counts
        # as pending (mint_skipped_backlog), the sweep retires it, and the
        # same sample mints instead of skipping.
        from aria_kernel.agent_invocations import _parse_iso

        created = _parse_iso(self.request.get("created_at"))
        assert created is not None
        later = created + timedelta(seconds=DEFAULT_ANCHOR_MAX_AGE_SECONDS + 3600)
        before = pending_judge_counts(base_dir=self.tools)
        self.assertEqual(before.get("evidence_judgment"), 1)
        sweep_expired_anchors(base_dir=self.tools, now=later)
        after = pending_judge_counts(base_dir=self.tools)
        self.assertEqual(after.get("evidence_judgment"), 0)

        result = dispatch_judges_for_sample(
            sample={"cycle_id": "cyc-1", "items": [_sample_item()]},
            base_dir=self.tools,
            target_sha="a" * 40,
            max_pending_per_role=1,
        )
        skipped_reasons = {entry.get("reason") for entry in result["skipped"]}
        self.assertNotIn("mint_skipped_backlog", skipped_reasons)
        self.assertEqual(result["minted_count"], 2)


if __name__ == "__main__":
    unittest.main()
