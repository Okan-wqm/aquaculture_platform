"""The promotion throat refuses a plan for a ping-ponging belief — ORPHAN-MEDIUM-808.

`guard_fix_dispatch`'s docstring says "the autonomous fix dispatcher calls it
before acting". Nothing did. `promote_converged_plan_to_dispatch` is that
dispatcher — the single point where a converged plan becomes a materialized
`aria/dispatch-request/v2` row a worker will act on — and it was admitting plans
for a belief that had already been fixed and reopened without limit.

The counter it consults was NOT safe to read until `record_resolution` was wired
(see `test_oscillation_resolution_wiring`): a monotonic streak would have refused
the first belief to break three times across the repository's whole life, and
refused it permanently. The two halves are one change, and the reset is the half
that makes the decider safe rather than merely present.

WHY THE REFUSAL IS A BLOCKER AND NOT A RAISE. The throat's contract is to report
EVERY reason a promotion was refused — a plan blocked for four reasons must name
four, or the operator fixes one and returns to discover the next. `guard_fix_dispatch`
raises by design (it is also the escalation point), so the raise is caught and
folded into the blocker list. The escalation still happens exactly once, inside
the module that owns the threshold: there is no second copy of the rule here.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.ledger import read_jsonl
from aria_kernel.oscillation_guard import (
    DEFAULT_OSCILLATION_THRESHOLD,
    record_reopen,
    record_resolution,
)
from aria_kernel.promotion_controller import promote_converged_plan_to_dispatch
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import workspace_paths

BELIEF_ID = "belief-that-ping-pongs"
FINGERPRINT = f"belief:{BELIEF_ID}"
PRESSURE_EVENT_ID = "pressure:belief-revalidation:belief-that-ping-pongs"


class OscillationPromotionGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.root = ensure_tools_dir(self.base)
        self.paths = workspace_paths(self.base, None)

    def _seed_pressure(self, *, belief_id: str | None = BELIEF_ID) -> None:
        """One pressure row, the way `pressure._pressure` shapes it."""
        target = self.paths.ledgers["pressure"]
        target.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "schema_version": 1,
            "event_id": PRESSURE_EVENT_ID,
            "pressure_id": PRESSURE_EVENT_ID,
            "cycle_id": "cycle-1",
            "type": "UNKNOWN",
            "source": "belief_revalidation",
            "severity": "medium",
            "belief_id": belief_id,
            "tool_id": None,
        }
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    def _promote(self) -> dict[str, Any]:
        return promote_converged_plan_to_dispatch(
            self.paths,
            plan_id="plan-1",
            cycle_id="cycle-1",
            pressure_event_id=PRESSURE_EVENT_ID,
            tools_root=self.root,
            impact_ref="impact.json",
            validation_ref="validation.json",
            base_sha="a" * 40,
            acknowledge=True,
        )

    def _reopen(self, times: int) -> None:
        for index in range(times):
            record_reopen(
                fingerprint=FINGERPRINT, cycle_id=f"cycle-{index}", base_dir=self.root
            )

    def _governance_kinds(self) -> list[str]:
        return [
            str(row.get("kind"))
            for row in read_jsonl(self.root / "governance.jsonl")
        ]

    def test_a_ping_ponging_belief_blocks_its_own_promotion(self) -> None:
        self._seed_pressure()
        self._reopen(DEFAULT_OSCILLATION_THRESHOLD)

        result = self._promote()

        self.assertEqual(result["status"], "blocked")
        self.assertIn(
            "oscillating_fingerprint",
            result["blockers"],
            "a belief reopened to the oscillation threshold was still admitted "
            "for another autonomous fix",
        )
        self.assertIn(
            "oscillation_escalated",
            self._governance_kinds(),
            "the refusal did not escalate — the loop must converge to 'ask a "
            "human', not to a silent block",
        )

    def test_below_the_threshold_the_guard_does_not_interfere(self) -> None:
        """A legitimate revision is not a loop."""
        self._seed_pressure()
        self._reopen(DEFAULT_OSCILLATION_THRESHOLD - 1)

        result = self._promote()

        self.assertNotIn("oscillating_fingerprint", result.get("blockers", []))
        self.assertNotIn("oscillation_escalated", self._governance_kinds())

    def test_a_resolved_belief_is_admitted_again(self) -> None:
        """The two halves compose: reset re-opens the door the decider closed.

        This is the property that makes the guard a convergence mechanism rather
        than a one-way ratchet — and it is only true because `record_resolution`
        now has a production caller.
        """
        self._seed_pressure()
        self._reopen(DEFAULT_OSCILLATION_THRESHOLD)
        self.assertIn("oscillating_fingerprint", self._promote()["blockers"])

        record_resolution(fingerprint=FINGERPRINT, cycle_id="cycle-fixed", base_dir=self.root)

        self.assertNotIn(
            "oscillating_fingerprint",
            self._promote().get("blockers", []),
            "a durably resolved belief stayed blocked — the guard is a permanent "
            "refusal rather than a convergence mechanism",
        )

    def test_a_pressure_with_no_belief_is_not_silently_treated_as_clean(self) -> None:
        """A tool-derived pressure has no belief key, so there is no question to ask.

        The counter's key space holds only `belief:<id>` today. Skipping is the
        honest answer to an absent question — but it must be skipping the LOOKUP,
        not skipping a threshold that was actually reached, so the reopen history
        of an unrelated belief must not leak into this promotion.
        """
        self._seed_pressure(belief_id=None)
        self._reopen(DEFAULT_OSCILLATION_THRESHOLD)

        result = self._promote()

        self.assertNotIn("oscillating_fingerprint", result.get("blockers", []))
        self.assertNotIn("oscillation_escalated", self._governance_kinds())


if __name__ == "__main__":
    unittest.main()
