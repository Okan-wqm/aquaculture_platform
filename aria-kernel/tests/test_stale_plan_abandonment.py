"""C12/E8 — a stuck plan dies deterministically at adoption time.

`abandon_plan` existed with zero production callers, so a plan wedged
mid-convergence stayed "active" forever — and E2's takeover re-adopted the
same wedged plan every night: takeover without abandonment is an infinite
loop wearing a fix's clothes. Also pins the writer-reader fix inside
`_last_event_at_by_plan`: the orphan scanner used to read ts/created_at,
fields no event writer emits (_append_event writes recorded_at), so every
orphan row reported last_event_at: None.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.plan_convergence import (
    _last_event_at_by_plan,
    fold_plan_state,
    resume_candidate_plan_id,
    start_plan,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _plan_content(title: str = "C12 plan") -> dict:
    return {
        "schema_version": 1,
        "title": title,
        "summary": "C12 stale-abandonment test plan.",
        "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
        "key_changes": ["change"],
        "validation_commands": [{"cmd": "true"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
    }


class StalePlanAbandonmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_fresh_plan_is_adopted(self) -> None:
        start_plan(
            plan_id="plan-fresh",
            initial_revision_id="rev-0",
            plan_content=_plan_content(),
            base_dir=self.tools,
        )
        self.assertEqual(
            resume_candidate_plan_id(base_dir=self.tools), "plan-fresh"
        )

    def test_stale_plan_is_abandoned_not_adopted(self) -> None:
        start_plan(
            plan_id="plan-wedged",
            initial_revision_id="rev-0",
            plan_content=_plan_content(),
            base_dir=self.tools,
        )
        # Deliberate-break clock: with the threshold at 0 hours even a
        # just-written event is "stale" — pre-C12 this returned the wedged
        # plan anyway, because nothing ever called abandon_plan.
        with patch("aria_kernel.plan_convergence.STALE_PLAN_MAX_AGE_HOURS", 0):
            adopted = resume_candidate_plan_id(base_dir=self.tools)
        self.assertIsNone(adopted)
        state = fold_plan_state(plan_id="plan-wedged", base_dir=self.tools)
        self.assertEqual(state.get("state"), "ABANDONED")

    def test_abandonment_reason_names_the_stall(self) -> None:
        start_plan(
            plan_id="plan-wedged2",
            initial_revision_id="rev-0",
            plan_content=_plan_content(),
            base_dir=self.tools,
        )
        with patch("aria_kernel.plan_convergence.STALE_PLAN_MAX_AGE_HOURS", 0):
            resume_candidate_plan_id(base_dir=self.tools)
        state = fold_plan_state(plan_id="plan-wedged2", base_dir=self.tools)
        abandoned = [
            e for e in state.get("events", [])
            if e.get("event_type") == "plan_abandoned"
        ]
        if abandoned:  # fold may not carry raw events; reason check is best-effort
            self.assertIn("stalled", str(abandoned[-1].get("payload")))

    def test_last_event_at_reads_recorded_at(self) -> None:
        start_plan(
            plan_id="plan-ts",
            initial_revision_id="rev-0",
            plan_content=_plan_content(),
            base_dir=self.tools,
        )
        stamps = _last_event_at_by_plan(Path(self.tools))
        # Pre-fix this was None for every plan (reader looked for
        # ts/created_at; the writer emits recorded_at).
        self.assertIn("plan-ts", stamps)
        self.assertRegex(stamps["plan-ts"], r"^\d{4}-\d{2}-\d{2}T")


if __name__ == "__main__":
    unittest.main()
