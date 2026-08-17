"""Y2 (ORPHAN-704) — judge mint discipline.

Second sealed night measured 462 judge envelopes minted against ~9 drained
per night (296 dead of anchor staleness): the judgment group key folded
``run_id`` in, so every nightly adapter run re-minted every already-queued
finding, and no ceiling existed between the sampler and the queue.

Deliberate-breakage pins:
- the SAME finding sampled from a DIFFERENT run mints nothing (the old
  behavior — fresh envelopes per run — is the reversal this file pins out);
- a finding a judge already answered is skipped ``already_judged``;
- at the per-role pending ceiling the mint stops with a
  ``mint_skipped_backlog`` disclosure instead of queueing corpses;
- the policy block is real configuration (defaults + override both read).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.genesis_policy import (
    JUDGMENT_PIPELINE_DEFAULTS,
    POLICY_KEYS,
    judgment_pipeline_policy,
    merge_with_override,
)
from aria_kernel.judge_fanout import dispatch_judges_for_sample
from aria_kernel.tool_registry import ensure_tools_dir


def _item(i: int, run: str = "r1") -> dict:
    return {
        "tool_id": "tool-x", "run_id": run, "cycle_id": "c1", "finding_id": f"F{i}",
        "rule": "rule-a", "severity": "medium", "path": f"src/f{i}.py:1",
        "message": "suspicious", "evidence": [f"src/f{i}.py:1"],
        "finding_fingerprint": f"fp{i}",
    }


class MintDisciplineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_same_finding_from_a_new_run_mints_nothing(self) -> None:
        first = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(1, run="r1")]},
            base_dir=self.tools,
        )
        self.assertEqual(first["minted_count"], 2)
        # Next night: same finding, fresh run_id. The old run-folded group
        # key minted two MORE envelopes here — the measured re-mint treadmill.
        second = dispatch_judges_for_sample(
            sample={"cycle_id": "c2", "items": [_item(1, run="r2")]},
            base_dir=self.tools,
        )
        self.assertEqual(second["minted_count"], 0)
        reasons = {s["reason"] for s in second["skipped"]}
        self.assertEqual(reasons, {"already_dispatched"})

    def test_already_judged_finding_is_skipped_per_judge(self) -> None:
        from aria_kernel.feedback_store import record_operator_feedback

        record_operator_feedback(
            tool_id="tool-x", run_id="r0", finding_id="F1",
            verdict="true_positive", severity="medium",
            note="prior verdict", source_type="ai_judge",
            judge_id="aria-evidence-judge",
            finding_fingerprint="fp1",
            base_dir=self.tools,
        )
        result = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(1)]},
            base_dir=self.tools,
        )
        # Evidence judge answered already → skipped; adversarial still minted.
        self.assertEqual(result["minted_count"], 1)
        self.assertEqual(result["minted"][0]["target_agent"], "aria-adversarial-judge")
        self.assertEqual(result["skipped"][0]["reason"], "already_judged")

    def test_backlog_ceiling_stops_the_mint_with_disclosure(self) -> None:
        first = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(1)]},
            base_dir=self.tools,
            max_pending_per_role=1,
        )
        self.assertEqual(first["minted_count"], 2)  # one per role, cap reached
        second = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(2)]},
            base_dir=self.tools,
            max_pending_per_role=1,
        )
        self.assertEqual(second["minted_count"], 0)
        reasons = [s["reason"] for s in second["skipped"]]
        self.assertEqual(reasons, ["mint_skipped_backlog", "mint_skipped_backlog"])
        self.assertEqual(second["skipped"][0]["max_pending_per_role"], 1)

    def test_no_ceiling_means_no_gate(self) -> None:
        # max_pending_per_role=None preserves the pre-Y2 unbounded behavior
        # for callers that meter elsewhere (test harnesses, targeted smokes).
        result = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(1), _item(2), _item(3)]},
            base_dir=self.tools,
        )
        self.assertEqual(result["minted_count"], 6)


class JudgmentPipelinePolicyTests(unittest.TestCase):
    def test_defaults_are_read_without_a_repo(self) -> None:
        block = judgment_pipeline_policy()
        self.assertEqual(block["sample_size_per_tool"], 5)
        self.assertEqual(block["max_pending_per_role"], 32)

    def test_key_is_mergeable_so_an_override_is_not_dead_json(self) -> None:
        self.assertIn("judgment_pipeline", POLICY_KEYS)
        merged = merge_with_override(
            {"judgment_pipeline": dict(JUDGMENT_PIPELINE_DEFAULTS)},
            {"judgment_pipeline": {"sample_size_per_tool": 2, "max_pending_per_role": 8}},
        )
        self.assertEqual(merged["judgment_pipeline"]["max_pending_per_role"], 8)


if __name__ == "__main__":
    unittest.main()
