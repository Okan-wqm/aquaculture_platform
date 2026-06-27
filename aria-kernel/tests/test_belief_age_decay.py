"""Plan 028 §D4 — age-based belief decay for unchanged code.

Belief decay was purely change-coupled: a belief about code that never changes
could stay `supported` forever even if last verified long ago. This adds the
age trigger — a supported belief past its TTL becomes needs_revalidation (which
run_pressure then surfaces), independent of any diff.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.memory import (
    append_jsonl,
    decay_stale_beliefs_by_age,
    latest_beliefs,
    load_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class BeliefAgeDecayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.now = datetime(2026, 6, 27, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed(self, belief_id: str, verified_at: datetime, status: str = "supported") -> None:
        append_jsonl(
            self.tools / "memory" / "beliefs.jsonl",
            {
                "schema_version": 2, "belief_id": belief_id, "claim": f"{belief_id} holds",
                "confidence": 0.9, "status": status, "evidence_refs": ["src/a.ts:1"],
                "needs_revalidation_cycles": 0, "verified_at": _iso(verified_at),
                "recorded_at": _iso(verified_at), "updated_at": _iso(verified_at),
                "first_seen_cycle": "c0", "support_count": 1,
            },
        )

    def _status(self, belief_id: str) -> str:
        for b in latest_beliefs(load_jsonl(self.tools / "memory" / "beliefs.jsonl")):
            if b.get("belief_id") == belief_id:
                return str(b.get("status"))
        return "missing"

    def test_old_supported_belief_decays_fresh_one_does_not(self) -> None:
        self._seed("old", self.now - timedelta(days=200))   # past 90d TTL
        self._seed("fresh", self.now - timedelta(days=10))   # well within TTL
        result = decay_stale_beliefs_by_age(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 1)
        self.assertEqual(result["decayed"][0]["belief_id"], "old")
        self.assertEqual(self._status("old"), "needs_revalidation")
        self.assertEqual(self._status("fresh"), "supported")

    def test_non_supported_beliefs_are_left_alone(self) -> None:
        self._seed("already", self.now - timedelta(days=300), status="needs_revalidation")
        result = decay_stale_beliefs_by_age(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 0)

    def test_decay_is_idempotent_once_revalidating(self) -> None:
        self._seed("old", self.now - timedelta(days=200))
        first = decay_stale_beliefs_by_age(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(first["decayed_count"], 1)
        # Second pass: the belief is now needs_revalidation, not supported → skipped.
        second = decay_stale_beliefs_by_age(cycle_id="c2", base_dir=self.tools, now=self.now)
        self.assertEqual(second["decayed_count"], 0)

    def test_custom_ttl(self) -> None:
        self._seed("mid", self.now - timedelta(days=20))
        none = decay_stale_beliefs_by_age(cycle_id="c1", base_dir=self.tools, now=self.now, ttl_days=30)
        self.assertEqual(none["decayed_count"], 0)
        some = decay_stale_beliefs_by_age(cycle_id="c2", base_dir=self.tools, now=self.now, ttl_days=10)
        self.assertEqual(some["decayed_count"], 1)


if __name__ == "__main__":
    unittest.main()
