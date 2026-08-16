"""E12-a — M7 (decay moves confidence) + M2 (conventions become servable).

M7: all three belief-decay paths (age, head-distance, quarantined-source)
wrote only ``status``; a stale belief kept confidence 1.0 and outranked
fresh-but-modest ones in every confidence-sorted consumer. The drop now
rides the SAME transition row.

M2: every convention was written at 0.5 ("hypothesis") and the only reader
called `conventions_for_paths` at the default 0.7 floor — NOTHING written
was ever readable; and the promised "promotion on a VERIFIED outcome" had
no producer. The merge reconciler now promotes by plan_id, and envelopes
see hypotheses labelled as such.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.memory import (
    _decayed_confidence,
    append_jsonl,
    decay_beliefs_by_head_distance,
    decay_stale_beliefs_by_age,
    latest_beliefs,
    load_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir


class DecayMovesConfidenceTests(unittest.TestCase):
    def test_penalties_are_status_shaped_and_bounded(self) -> None:
        self.assertEqual(
            _decayed_confidence({"confidence": 1.0}, "needs_revalidation"), 0.9
        )
        self.assertEqual(_decayed_confidence({"confidence": 1.0}, "stale"), 0.8)
        self.assertEqual(_decayed_confidence({"confidence": 0.05}, "stale"), 0.0)

    def test_age_decay_writes_the_drop_on_the_transition_row(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            old = (
                datetime.now(timezone.utc) - timedelta(days=365)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            append_jsonl(
                root / "memory" / "beliefs.jsonl",
                {
                    "schema_version": 1,
                    "belief_id": "B-old",
                    "claim": "aged claim",
                    "evidence_refs": ["apps/x.ts"],
                    "confidence": 1.0,
                    "status": "supported",
                    "verified_at": old,
                    "needs_revalidation_cycles": 0,
                },
            )
            decay_stale_beliefs_by_age(cycle_id="cyc-m7", base_dir=root)
            latest = next(
                b
                for b in latest_beliefs(
                    load_jsonl(root / "memory" / "beliefs.jsonl")
                )
                if b.get("belief_id") == "B-old"
            )
        # Pre-M7 this row said needs_revalidation with confidence 1.0.
        self.assertNotEqual(latest.get("status"), "supported")
        self.assertLess(float(latest["confidence"]), 1.0)


class ConventionServabilityTests(unittest.TestCase):
    def _seed_hypothesis(self, workspace: Path, plan_id: str) -> None:
        from aria_kernel.knowledge_graph import Pattern, record_convention

        record_convention(
            Pattern(
                pattern_id=f"conv_test_{plan_id}",
                pattern_type="convention",
                confidence=0.5,
                evidence_refs=("docs/aria/SPEC.md",),
                discovered_by_cycle_id="cyc-m2",
                observed_at="2026-08-13T00:00:00Z",
                outcome_status="hypothesis",
                plan_id=plan_id,
            ),
            workspace_root=workspace,
            signer_key_fp="SHA256:testfingerprint",
        )

    def test_merge_promotes_the_hypothesis_to_verified(self) -> None:
        from aria_kernel.knowledge_graph import (
            VERIFIED_CONVENTION_CONFIDENCE,
            conventions_for_paths,
            promote_convention_for_plan,
        )

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "aria-tools").mkdir()
            self._seed_hypothesis(workspace, "plan-m2")

            # Pre-promotion: invisible at the default serving floor.
            self.assertEqual(
                conventions_for_paths(
                    workspace_root=workspace, paths=["docs/aria/SPEC.md"]
                ),
                [],
            )
            promoted = promote_convention_for_plan(
                plan_id="plan-m2", workspace_root=workspace
            )
            self.assertIsNotNone(promoted)
            self.assertEqual(promoted["outcome_status"], "verified")
            served = conventions_for_paths(
                workspace_root=workspace, paths=["docs/aria/SPEC.md"]
            )
        # The FIRST convention ever servable at the default floor.
        self.assertEqual(len(served), 1)
        self.assertEqual(served[0]["confidence"], VERIFIED_CONVENTION_CONFIDENCE)

    def test_promotion_is_idempotent_and_missing_plan_is_noop(self) -> None:
        from aria_kernel.knowledge_graph import promote_convention_for_plan

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "aria-tools").mkdir()
            self.assertIsNone(
                promote_convention_for_plan(
                    plan_id="plan-ghost", workspace_root=workspace
                )
            )
            self._seed_hypothesis(workspace, "plan-twice")
            first = promote_convention_for_plan(
                plan_id="plan-twice", workspace_root=workspace
            )
            second = promote_convention_for_plan(
                plan_id="plan-twice", workspace_root=workspace
            )
        self.assertIsNotNone(first)
        self.assertIsNone(second)

    def test_hypotheses_reach_envelopes_labelled(self) -> None:
        """The envelope projection carries outcome_status and admits
        hypotheses — a judge reads them as context, never as rules."""
        from aria_kernel.knowledge_graph import conventions_for_paths

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "aria-tools").mkdir()
            self._seed_hypothesis(workspace, "plan-label")
            rows = conventions_for_paths(
                workspace_root=workspace,
                paths=["docs/aria/SPEC.md"],
                min_confidence=0.5,
            )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["outcome_status"], "hypothesis")


if __name__ == "__main__":
    unittest.main()
