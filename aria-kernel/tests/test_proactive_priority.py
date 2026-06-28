"""Plan 027 §D3 — proactive Impact x Opportunity prioritization.

ARIA was reactive: no pressure → reflect only. This adds a value axis so it
always has a ranked "where to invest next" list. A high-impact (security) tool
outranks a domain tool at equal opportunity; promoting a gold corpus + adding
ground-truth verdicts lowers a tool's opportunity (and thus priority).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.goldset import promote_goldset_proposal
from aria_kernel.proactive_priority import _impact, compute_proactive_priorities
from aria_kernel.tool_registry import ensure_tools_dir, register_tool, utc_now


def _register(tools: Path, tool_id: str) -> None:
    register_tool(
        {
            "tool_id": tool_id, "kind": "adapter", "version": "0.1.0", "status": "SHADOW",
            "schema_version": 2, "owner": "platform", "claim_types": ["legacy"],
            "declared_scope": ["apps/**/*.ts"], "allowed_read_globs": ["apps/**/*.ts"],
            "forbidden_read_globs": [".git/**"], "fixture_set": "tools/aria-poc/fixtures/legacy",
            "health_thresholds": {"precision_min": 0.85, "non_critical_false_positives_30d": 3,
                                  "critical_false_positives": 0, "crash_rate_last_10": 0.2},
            "output_schema": {"type": "object", "required": ["observations", "read_paths"]},
            "runner": {"type": "subprocess", "argv": ["python3", "r.py", tool_id],
                       "cwd": "tools/aria-poc", "stdin_json": True, "timeout_ms": 15000},
        },
        base_dir=tools,
    )


class ProactivePriorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_impact_buckets(self) -> None:
        self.assertEqual(_impact("security-boundary-adapter"), 1.0)
        self.assertEqual(_impact("farm-feed-adapter"), 0.7)
        self.assertEqual(_impact("generic-thing-adapter"), 0.5)

    def test_high_impact_tool_outranks_domain_tool_at_equal_opportunity(self) -> None:
        _register(self.tools, "security-boundary-adapter")
        _register(self.tools, "farm-feed-adapter")
        result = compute_proactive_priorities(base_dir=self.tools)
        self.assertEqual(result["ranked_count"], 2)
        self.assertEqual(result["top"][0]["tool_id"], "security-boundary-adapter")
        # Both untouched → both flagged no_active_goldset + under_judged.
        for row in result["top"]:
            self.assertIn("no_active_goldset", row["reasons"])
            self.assertTrue(any(r.startswith("under_judged") for r in row["reasons"]))

    def test_promotion_and_verdicts_lower_opportunity(self) -> None:
        _register(self.tools, "security-boundary-adapter")
        before = compute_proactive_priorities(base_dir=self.tools)["top"][0]["opportunity"]
        # Add ground-truth verdicts + promote a gold corpus → less opportunity.
        for i in range(12):
            record_operator_feedback(
                tool_id="security-boundary-adapter", run_id=f"r{i}", finding_id=f"f{i}",
                verdict="true_positive", severity="medium", note="gt", source_type="human",
                base_dir=self.tools,
            )
        proposal = {
            "status": "ready", "recorded_at": utc_now(), "tool_id": "security-boundary-adapter",
            "true_positive_count": 1, "known_false_positive_count": 0,
            "true_positive_items": [{"run_id": "r0", "finding_id": "f0", "verdict": "true_positive"}],
            "known_false_positive_items": [],
        }
        promote_goldset_proposal(tool_id="security-boundary-adapter", curator="okan",
                                 base_dir=self.tools, proposal=proposal)
        after = compute_proactive_priorities(base_dir=self.tools)["top"][0]["opportunity"]
        self.assertLess(after, before)

    def test_no_tools_is_empty(self) -> None:
        result = compute_proactive_priorities(base_dir=self.tools)
        self.assertEqual(result["ranked_count"], 0)
        self.assertEqual(result["top"], [])


if __name__ == "__main__":
    unittest.main()
