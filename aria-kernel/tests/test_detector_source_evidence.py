"""ARIA-HIGH-325 — ARIA's detector source is not evidence that the product is wrong.

F-009, F-010 and F-011 were promoted on nine refs into tools/aria-adapters/:
the judges cited the rule's own code to show the rule fired, the consensus
row took the union of their refs, and promotion checked only that each ref
existed. The evidence class ``aria_detector_source`` (tools/aria-adapters/,
tools/aria-poc/, aria-kernel/) and the producing tool's declared scope now
decide what a true positive may stand on, at the trust layer:

* the consensus gate refuses a true_positive whose agreeing judges cite an
  inadmissible ref (``evidence_inadmissible``); a false_positive may cite the
  detector to explain why it misfired;
* a tool whose declared scope is ARIA itself may cite ARIA.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_trust import (
    ARIA_DETECTOR_SOURCE_CLASS,
    OUTSIDE_DECLARED_SCOPE_CLASS,
    tool_evidence_refusal,
)
from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT, register_contracted_tool

_WEB = ("web/**/*.{ts,tsx,js,json}",)
_KERNEL = ("aria-kernel/aria_kernel/**/*.py",)


class ToolEvidenceRefusalTests(unittest.TestCase):
    def test_detector_source_is_its_own_class(self) -> None:
        self.assertEqual(
            tool_evidence_refusal("tools/aria-adapters/bundle-budget-adapter.ts:113", declared_scope=_WEB),
            ARIA_DETECTOR_SOURCE_CLASS,
        )
        self.assertEqual(tool_evidence_refusal("tools/aria-poc/poc.py:1", declared_scope=_WEB), ARIA_DETECTOR_SOURCE_CLASS)
        self.assertEqual(tool_evidence_refusal("aria-kernel/aria_kernel/cycle.py", declared_scope=_WEB), ARIA_DETECTOR_SOURCE_CLASS)

    def test_the_class_is_judged_on_the_canonical_path(self) -> None:
        self.assertEqual(
            tool_evidence_refusal("web/../tools/aria-adapters/bundle-budget-adapter.ts", declared_scope=_WEB),
            ARIA_DETECTOR_SOURCE_CLASS,
        )

    def test_product_refs_inside_the_scope_are_admissible(self) -> None:
        self.assertIsNone(tool_evidence_refusal("web/apps/aquamobil/vite.config.ts:22", declared_scope=_WEB))

    def test_product_refs_outside_the_scope_are_refused(self) -> None:
        self.assertEqual(
            tool_evidence_refusal("docs/adr/024-compliance-retention-matrix.md:41", declared_scope=_WEB),
            OUTSIDE_DECLARED_SCOPE_CLASS,
        )

    def test_a_tool_scoped_to_aria_may_cite_aria(self) -> None:
        self.assertIsNone(tool_evidence_refusal("aria-kernel/aria_kernel/cli.py:12", declared_scope=_KERNEL))
        self.assertEqual(
            tool_evidence_refusal("tools/aria-adapters/kernel-dead-wire-adapter.ts:1", declared_scope=_KERNEL),
            ARIA_DETECTOR_SOURCE_CLASS,
        )

    def test_with_no_scope_only_the_class_rule_applies(self) -> None:
        self.assertEqual(tool_evidence_refusal("tools/aria-adapters/x.ts", declared_scope=None), ARIA_DETECTOR_SOURCE_CLASS)
        self.assertIsNone(tool_evidence_refusal("docs/x.md:1", declared_scope=None))


class ConsensusRefusesDetectorSourceForATruePositive(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(
            self.tools, "bundle-budget-adapter",
            rules={"bundle_budget_not_enforced": dict(DEFAULT_RULE_CONTRACT, claim_type="absence_in_scope", severity_cap="LOW")},
            declared_scope=list(_WEB),
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge(self, judge_id: str, verdict: str, refs: list[str]) -> None:
        record_operator_feedback(
            tool_id="bundle-budget-adapter", run_id="r1", finding_id="bundle-budget:not-enforced:web/apps/aquamobil",
            verdict=verdict, severity="medium", note="vote", source_type="ai_judge", judge_id=judge_id,
            model=f"model-{judge_id}", confidence=0.85, evidence_refs=refs, judgment_group_id="g1",
            finding_fingerprint="fp-bundle", base_dir=self.tools,
        )

    def test_a_true_positive_citing_the_adapter_is_refused(self) -> None:
        refs = ["web/apps/aquamobil/vite.config.ts:22", "tools/aria-adapters/bundle-budget-adapter.ts:113"]
        self._judge("aria-evidence-judge", "true_positive", refs)
        self._judge("aria-adversarial-judge", "true_positive", ["web/apps/aquamobil/vite.config.ts:69"])
        result = generate_ai_consensus(tool_id="bundle-budget-adapter", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 0)
        self.assertEqual([u["reason"] for u in result["uncertainties"]], ["evidence_inadmissible"])

    def test_a_true_positive_on_product_evidence_settles(self) -> None:
        self._judge("aria-evidence-judge", "true_positive", ["web/apps/aquamobil/vite.config.ts:22"])
        self._judge("aria-adversarial-judge", "true_positive", ["web/apps/aquamobil/vite.config.ts:69"])
        result = generate_ai_consensus(tool_id="bundle-budget-adapter", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)

    def test_a_false_positive_may_cite_the_detector_to_explain_the_misfire(self) -> None:
        refs = ["tools/aria-adapters/bundle-budget-adapter.ts:113"]
        self._judge("aria-evidence-judge", "false_positive", refs)
        self._judge("aria-adversarial-judge", "false_positive", refs)
        result = generate_ai_consensus(tool_id="bundle-budget-adapter", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)


if __name__ == "__main__":
    unittest.main()
