"""Plan 025 §A — >=2-judge fan-out per sampled finding.

Each sampled finding is minted to two distinct judges (evidence + adversarial)
sharing one judgment_group_id, so the consensus gate (which needs >=2 unique
judges) can fire by construction. Idempotent across re-runs.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.judge_fanout import dispatch_judges_for_sample
from aria_kernel.tool_registry import ensure_tools_dir


def _item(i: int) -> dict:
    return {
        "tool_id": "tool-x", "run_id": f"r{i}", "cycle_id": "c1", "finding_id": f"F{i}",
        "rule": "rule-a", "severity": "medium", "path": f"src/f{i}.py:1",
        "message": "suspicious", "evidence": [f"src/f{i}.py:1"], "finding_fingerprint": f"fp{i}",
    }


class JudgeFanoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_two_distinct_judges_per_finding(self) -> None:
        sample = {"cycle_id": "c1", "items": [_item(1), _item(2)]}
        result = dispatch_judges_for_sample(sample=sample, base_dir=self.tools)
        self.assertEqual(result["minted_count"], 4)  # 2 findings x 2 judges
        # Each finding's group has exactly the two distinct judge roles.
        by_group: dict[str, set] = {}
        for m in result["minted"]:
            by_group.setdefault(m["judgment_group_id"], set()).add(m["target_agent"])
        self.assertEqual(len(by_group), 2)
        for agents in by_group.values():
            self.assertEqual(agents, {"aria-evidence-judge", "aria-adversarial-judge"})
        # Distinct request ids across the fan-out.
        ids = [m["request_id"] for m in result["minted"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_idempotent_across_reruns(self) -> None:
        sample = {"cycle_id": "c1", "items": [_item(1)]}
        first = dispatch_judges_for_sample(sample=sample, base_dir=self.tools)
        self.assertEqual(first["minted_count"], 2)
        second = dispatch_judges_for_sample(sample=sample, base_dir=self.tools)
        self.assertEqual(second["minted_count"], 0)
        self.assertEqual(len(second["skipped"]), 2)  # both judges already dispatched

    def test_partial_mint_self_heals_to_two_judges(self) -> None:
        # Simulate last cycle minting only judge-1 (the 2nd mint raised). The
        # group must NOT be skipped wholesale — the missing adversarial judge
        # must be minted, or consensus (needs >=2) starves this finding forever.
        item = _item(1)
        group = f"judge:{item['tool_id']}:{item['run_id']}:{item['finding_id']}"
        create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="seed", must_satisfy=[{"id": "v", "criterion": "c"}],
            allowed_scope=["**"], finding_id=item["finding_id"], tool_id=item["tool_id"],
            run_id=item["run_id"], judgment_group_id=group, base_dir=self.tools,
        )
        result = dispatch_judges_for_sample(sample={"cycle_id": "c1", "items": [item]}, base_dir=self.tools)
        self.assertEqual(result["minted_count"], 1)
        self.assertEqual(result["minted"][0]["target_agent"], "aria-adversarial-judge")

    def test_empty_sample_is_noop(self) -> None:
        result = dispatch_judges_for_sample(sample={"items": []}, base_dir=self.tools)
        self.assertEqual(result["minted_count"], 0)


if __name__ == "__main__":
    unittest.main()
