"""ARIA-HIGH-194 — a forced HUMAN_REQUIRED says why it was forced.

`force_plan_human_required` stamped `gate: max_rounds` and
`max_rounds_reached: true` on every call, so the drainer's round-1
`convergence_envelope_dead:challenger_plan` read as a plan that had
exhausted its rounds. The gate and the rollup now come from the caller's own
reason codes.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    FORCED_ESCALATION_GATE,
    events_path,
    force_plan_human_required,
    start_plan,
)
from aria_kernel.tool_registry import ensure_tools_dir

_PLAN = {
    "schema_version": 1,
    "title": "T",
    "summary": "S",
    "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
    "key_changes": ["x"],
    "validation_commands": [{"cmd": "nx affected --target=test"}],
    "evidence_refs": ["docs/aria/SPEC.md"],
    "architectural_tier": 2,
}


class ForcedEscalationGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h194-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=_PLAN, base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _forced(self, reason_codes: list[str]) -> dict:
        force_plan_human_required(
            plan_id="plan-1", round_number=1, reason_codes=reason_codes, base_dir=self.tools,
        )
        return [r for r in load_jsonl(events_path(self.tools)) if r.get("event_type") == "plan_evaluated"][-1]["payload"]

    def test_a_dead_envelope_is_not_max_rounds(self) -> None:
        payload = self._forced(["convergence_envelope_dead:challenger_plan"])
        self.assertFalse(payload["risks_rollup_summary"]["max_rounds_reached"])
        self.assertEqual(payload["gate_decisions"][0]["gate"], FORCED_ESCALATION_GATE)

    def test_max_rounds_reached_keeps_the_max_rounds_gate(self) -> None:
        payload = self._forced(["max_rounds_reached", "unresolved_material_risk"])
        self.assertTrue(payload["risks_rollup_summary"]["max_rounds_reached"])
        self.assertEqual(payload["gate_decisions"][0]["gate"], "max_rounds")


if __name__ == "__main__":
    unittest.main()
