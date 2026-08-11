"""Z3-K2 (ORPHAN-HIGH-629) — cross-review direction attribution.

The V8 agent submits ONE envelope for both review directions, and
`submit_cross_review_v8` used to copy the SAME risk list + ONE
review_content_hash into both direction records: "who judged whom
right" was structurally unknowable, starving the duel-rating layer.

These tests pin the repaired contract:
* `applies_to_direction` routes a risk to exactly one direction record;
* rows without the field land in BOTH records (legacy envelopes are
  read back bit-identically);
* the two direction records carry DIFFERENT content hashes;
* per-direction `verdicts` land on their records, scalar `verdict` is
  the fallback; an unknown direction value is refused loudly.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_convergence import (
    fold_plan_state,
    start_plan,
    submit_challenger_plan,
    submit_cross_review_v8,
)
from aria_kernel.tool_registry import GovernanceError

P2C = "primary_to_challenger"
C2P = "challenger_to_primary"


def _risk(risk_id: str, direction: str | None = None) -> dict:
    row = {
        "risk_id": risk_id,
        "risk_category": "scope_drift",
        "severity": "material",
        "summary": f"{risk_id} summary",
        "recommendation": f"{risk_id} recommendation",
        "affected_files": ["aria-kernel/aria_kernel/plan_convergence.py"],
        "evidence_refs": ["aria-kernel/aria_kernel/plan_convergence.py:1"],
    }
    if direction is not None:
        row["applies_to_direction"] = direction
    return row


class CrossReviewDirectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        (self.root / ".claude" / "agents").mkdir(parents=True)
        (self.root / ".claude" / "agents" / "aria-cross-reviewer.md").write_text(
            "---\nname: aria-cross-reviewer\ndescription: CR.\n---\n\nBody.\n",
            encoding="utf-8",
        )
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        plan = {
            "schema_version": 1,
            "title": "Direction test plan",
            "summary": "Direction test.",
            "affected_surfaces": [
                {"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}
            ],
            "key_changes": ["change"],
            "validation_commands": [{"cmd": "true"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }
        start_plan(
            plan_id="plan-dir",
            initial_revision_id="rev-0",
            plan_content=plan,
            base_dir=self.tools_dir,
        )
        state = fold_plan_state(plan_id="plan-dir", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        submit_challenger_plan(
            plan_id="plan-dir",
            challenger={
                "challenger_agent": "aria-challenger-planner",
                "challenger_revision_id": "challenger-rev-0",
                "source_revision_id": latest["revision_id"],
                "source_plan_content_hash": latest["content_hash"],
                "plan_content": {**plan, "title": "Challenger plan"},
            },
            base_dir=self.tools_dir,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _submit(self, review: dict) -> dict:
        submit_cross_review_v8(
            plan_id="plan-dir",
            review=review,
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        return fold_plan_state(plan_id="plan-dir", base_dir=self.tools_dir)

    def _reviews_by_direction(self, state: dict) -> dict:
        # Fold shape: cross_reviews[round]["tasks"][packet_hash] =
        # {review_direction, ..., "review": {risks, verdict, ...}}.
        by_direction: dict = {}
        for round_state in (state.get("cross_reviews") or {}).values():
            for task in (round_state.get("tasks") or {}).values():
                review = task.get("review")
                if review:
                    by_direction[task.get("review_direction")] = review
        return by_direction

    def test_directional_risk_lands_only_on_its_direction(self) -> None:
        state = self._submit({
            "reviewer_agent": "aria-cross-reviewer",
            "verdict": "material_risks_present",
            "risks": [
                _risk("CR-P", P2C),
                _risk("CR-C", C2P),
                _risk("CR-BOTH"),
            ],
        })
        by_dir = self._reviews_by_direction(state)
        p2c_ids = [r["risk_id"] for r in by_dir[P2C]["risks"]]
        c2p_ids = [r["risk_id"] for r in by_dir[C2P]["risks"]]
        self.assertEqual(sorted(p2c_ids), ["CR-BOTH", "CR-P"])
        self.assertEqual(sorted(c2p_ids), ["CR-BOTH", "CR-C"])
        # Distinguishable records — one shared hash was half the defect.
        self.assertNotEqual(
            by_dir[P2C]["review_content_hash"],
            by_dir[C2P]["review_content_hash"],
        )

    def test_legacy_envelope_without_directions_hits_both(self) -> None:
        state = self._submit({
            "reviewer_agent": "aria-cross-reviewer",
            "verdict": "agreed",
            "risks": [_risk("CR-1"), _risk("CR-2")],
        })
        by_dir = self._reviews_by_direction(state)
        for direction in (P2C, C2P):
            self.assertEqual(
                sorted(r["risk_id"] for r in by_dir[direction]["risks"]),
                ["CR-1", "CR-2"],
            )
            self.assertEqual(by_dir[direction]["verdict"], "agreed")

    def test_per_direction_verdicts_and_scalar_fallback(self) -> None:
        state = self._submit({
            "reviewer_agent": "aria-cross-reviewer",
            "verdict": "agreed",
            "verdicts": {C2P: "material_risks_present"},
            "risks": [_risk("CR-C", C2P)],
        })
        by_dir = self._reviews_by_direction(state)
        self.assertEqual(by_dir[C2P]["verdict"], "material_risks_present")
        self.assertEqual(by_dir[P2C]["verdict"], "agreed")

    def test_unknown_direction_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._submit({
                "reviewer_agent": "aria-cross-reviewer",
                "verdict": "agreed",
                "risks": [_risk("CR-X", "sideways")],
            })

    def test_unknown_verdicts_key_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._submit({
                "reviewer_agent": "aria-cross-reviewer",
                "verdict": "agreed",
                "verdicts": {"sideways": "agreed"},
                "risks": [],
            })


if __name__ == "__main__":
    unittest.main()
