"""ARIA-HIGH-081 — the round-2+ primary revision request carries what it revises.

The request said "addressing cross-review findings" and carried none of them:
the planner was expected to read the round's plans and the review from the
store. A route with no file tools (Codex, Z.ai) cannot, and a sandboxed
Claude cannot see a store bound outside its workspace — trial eight's round-2
primary (2026-09-12) answered that no round-1 primary plan, challenger plan
or cross-review envelope was readable, and revised blind.

What this pins, one property per test:

* The prompt built from kernel state carries the latest primary body, the
  challenger body and the last cross-review's risks, each inside an
  untrusted-content tag, and tells the planner the kernel owns the round.
* `issue_primary_envelope` builds that prompt by default from the plan
  state it already folds for its legal-state check.
* A state with no challenger body or no risks names the absence instead of
  inventing content.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cross_review_bridge import (
    _primary_revision_prompt_from_state,
    _primary_revision_suggested_prompt,
    issue_primary_envelope,
)
from aria_kernel.plan_convergence import content_hash


def _body(title: str) -> dict:
    return {"schema_version": 2, "title": title, "summary": "s", "affected_surfaces": [{"paths": ["a.ts"]}],
            "key_changes": ["k"], "validation_commands": [], "evidence_refs": ["a.ts:1"]}


def _state() -> dict:
    primary = _body("primary r1")
    challenger = _body("challenger c1")
    return {
        "state": "CROSS_REVIEWED", "current_round": 1,
        "plan_started": {"plan_content": primary, "must_satisfy": [{"id": "m1", "kind": "obligation", "description": "d"}]},
        "latest_revision": {"revision_id": "flow-x-r1", "content_hash": content_hash(primary), "content": json.dumps(primary)},
        "challenger": {"challenger_revision_id": "chal-flow-x-c1", "plan_content": challenger, "content_hash": content_hash(challenger)},
        "cross_review_risks_by_round": {1: [
            {"risk_id": "CR-001", "severity": "blocking", "applies_to_direction": "challenger_to_primary",
             "summary": "the primary restates the task", "surfaced_in_revision_id": "flow-x-r1"},
            {"risk_id": "CR-003", "severity": "material", "applies_to_direction": "primary_to_challenger",
             "summary": "specs unreachable from nx affected", "surfaced_in_revision_id": "chal-flow-x-c1"},
        ]},
    }


class ThePromptCarriesTheRound(unittest.TestCase):
    def test_plans_and_risks_ride_inside_untrusted_tags(self) -> None:
        prompt = _primary_revision_prompt_from_state(_state(), plan_id="flow-x", round_number=2)
        self.assertIn('<untrusted_primary_plan revision_id="flow-x-r1">', prompt)
        self.assertIn('"title": "primary r1"', prompt)
        self.assertIn('<untrusted_challenger_plan revision_id="chal-flow-x-c1">', prompt)
        self.assertIn('"title": "challenger c1"', prompt)
        self.assertIn('<untrusted_cross_review_risks round="1">', prompt)
        self.assertIn('"risk_id": "CR-001"', prompt)
        self.assertIn('"risk_id": "CR-003"', prompt)
        self.assertIn("The kernel records the round and the parent revision itself", prompt)
        self.assertIn("SECURITY CONTRACT", prompt)

    def test_absence_is_named_never_invented(self) -> None:
        state = _state()
        state.pop("challenger")
        state["cross_review_risks_by_round"] = {}
        prompt = _primary_revision_prompt_from_state(state, plan_id="flow-x", round_number=2)
        self.assertIn("challenger plan_content unavailable in plan state", prompt)
        self.assertIn('<untrusted_cross_review_risks round="1">\n[]\n', prompt)

    def test_the_builder_is_pure_text_over_its_inputs(self) -> None:
        text = _primary_revision_suggested_prompt(
            plan_id="p", round_number=3, primary_revision_id="r2", primary_plan_text="{}",
            challenger_revision_id="c2", challenger_plan_text="{}", cross_review_risks=[{"risk_id": "R"}],
        )
        self.assertIn("(round 3)", text)
        self.assertIn('<untrusted_cross_review_risks round="2">', text)


class TheEnvelopeUsesItByDefault(unittest.TestCase):
    def test_issue_primary_envelope_builds_the_prompt_from_state(self) -> None:
        captured: dict = {}

        def fake_create(**kwargs):
            captured.update(kwargs)
            return {"request_id": "AIR-aria-primary-planner-fixture"}

        with tempfile.TemporaryDirectory() as tmp, \
             patch("aria_kernel.cross_review_bridge.fold_plan_state", return_value=_state()), \
             patch("aria_kernel.cross_review_bridge.create_agent_invocation_request", side_effect=fake_create):
            issue_primary_envelope(
                plan_id="flow-x", round_number=2, must_satisfy=[{"id": "m1"}], evidence_refs=["a.ts:1"],
                allowed_scope=["**"], base_dir=Path(tmp) / "aria-tools",
            )
        self.assertEqual(captured["role"], "primary_plan")
        self.assertIn('<untrusted_cross_review_risks round="1">', captured["suggested_prompt"])
        self.assertIn('"risk_id": "CR-001"', captured["suggested_prompt"])
        self.assertIn('<untrusted_challenger_plan revision_id="chal-flow-x-c1">', captured["suggested_prompt"])
        # The revision prompt names the contract the body is judged by, and
        # the envelope carries the machine block it points at.
        self.assertIn("including `architectural_tier` and only admissible `validation_commands`", captured["suggested_prompt"])
        self.assertEqual(captured["plan_contract"]["architectural_tier"]["allowed"], [1, 2, 3, 4])


if __name__ == "__main__":
    unittest.main()
