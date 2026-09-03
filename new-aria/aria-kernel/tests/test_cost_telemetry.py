"""Plan 020 Phase 13 — cost telemetry + 13th metric tests."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cost_telemetry import (
    REQUIRED_RATIONALE_FIELDS,
    compose_dispatch_rationale,
    count_dispatch_rationales,
    list_dispatch_rationales,
    record_dispatch_rationale,
)
from aria_kernel.plan_016_metrics import (
    PLAN_016_METRIC_NAMES,
    PLAN_020_PHASE_13_METRIC_NAMES,
    compute_plan_016_metrics,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-cost-tel-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _rationale(request_id: str = "REQ-x") -> dict:
    return compose_dispatch_rationale(
        request_id=request_id, role="primary_plan",
        estimated_input_tokens=10_000, estimated_output_tokens=2_000,
        chosen_model="claude-opus-4-7", model_choice_reason="planner role caps",
        soft_cap_remaining=4.5, hard_cap_remaining=85.0,
        ci_off_hours_window=True,
    )


class TaxonomyTests(unittest.TestCase):
    def test_required_fields_locked(self) -> None:
        self.assertEqual(set(REQUIRED_RATIONALE_FIELDS), {
            "estimated_input_tokens", "estimated_output_tokens",
            "chosen_model", "model_choice_reason",
            "soft_cap_remaining", "hard_cap_remaining",
            "ci_off_hours_window",
        })

    def test_phase_13_metric_locked(self) -> None:
        self.assertEqual(PLAN_020_PHASE_13_METRIC_NAMES, ("aria_dispatch_rationale_total",))


class ComposeAndRecordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_compose_returns_full_rationale(self) -> None:
        r = _rationale()
        self.assertEqual(r["chosen_model"], "claude-opus-4-7")
        for field in REQUIRED_RATIONALE_FIELDS:
            self.assertIn(field, r)

    def test_negative_token_estimate_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            compose_dispatch_rationale(
                request_id="x", role="r",
                estimated_input_tokens=-1, estimated_output_tokens=0,
                chosen_model="m", model_choice_reason="why",
                soft_cap_remaining=1.0, hard_cap_remaining=1.0,
            )

    def test_record_persists_and_emits_event(self) -> None:
        record_dispatch_rationale(rationale=_rationale(), base_dir=self.tools)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("dispatch_rationale_recorded", kinds)
        self.assertEqual(len(list_dispatch_rationales(base_dir=self.tools)), 1)


class MetricExtensionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_13th_metric_present_in_compute(self) -> None:
        # Plan 016 baseline 9 + Plan 020 Phase 6 +2 + Phase 9 +1 + Phase 13 +1 = 13.
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(len(m), 13)
        self.assertIn("aria_dispatch_rationale_total", m)
        self.assertEqual(m["aria_dispatch_rationale_total"], 0)

    def test_metric_increments_on_record(self) -> None:
        record_dispatch_rationale(rationale=_rationale(), base_dir=self.tools)
        record_dispatch_rationale(rationale=_rationale(request_id="REQ-2"), base_dir=self.tools)
        self.assertEqual(count_dispatch_rationales(base_dir=self.tools), 2)
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_dispatch_rationale_total"], 2)


class ProfileGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_observe_blocks_record(self) -> None:
        # Phase 1.B observe permission table: cost_telemetry NOT permitted
        # under observe (telemetry mutates dispatch path).
        set_profile("observe", operator_approval_ref="op:observe",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            record_dispatch_rationale(rationale=_rationale(), base_dir=self.tools)

    def test_frozen_blocks_record(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            record_dispatch_rationale(rationale=_rationale(), base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
