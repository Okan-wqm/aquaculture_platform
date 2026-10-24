"""SE-13 — the strict parser's refusals beyond a missing deciding key.

WHY: test_se13_service_expertise_policy pins that a missing k_min / alpha /
keep_level_* / look_budget is refused by name. A registration can also be
forged by an unknown key that a reader would never see, by a coerced type
(``true`` read as 1), by a look plan that spends more looks than the budget,
and by a change_review block that falls back to shipped caps. Each is pinned
here against ``genesis_policy`` (service-expertise PLAN §3.7, §4.3, §7.3).
"""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import genesis_policy
from aria_kernel.tool_registry import GovernanceError


def _shipped(block: str) -> dict[str, Any]:
    path = Path(genesis_policy.__file__).resolve().parent / "data" / genesis_policy.DEFAULT_FILENAME
    return copy.deepcopy(json.loads(path.read_text(encoding="utf-8"))[block])


class PreregisteredRelationsTests(unittest.TestCase):
    def _refusal(self, accessor: Any, override: dict[str, Any]) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / genesis_policy.OVERRIDE_RELPATH
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(override), encoding="utf-8")
            with self.assertRaises(GovernanceError) as refused:
                accessor(tmp)
        return str(refused.exception)

    def test_change_review_policy_parses_the_shipped_caps(self) -> None:
        parsed = genesis_policy.change_review_policy()
        self.assertEqual(parsed["seats"]["handoff_seats_per_change"], 2)  # DECISIONS Q7
        self.assertEqual(parsed["knowledge"]["sections_in_render_order"][0], "missed")

    def test_change_review_block_missing_a_cap_is_refused_by_path(self) -> None:
        block = _shipped("change_review")
        del block["seats"]["seats_per_dev_look"]
        message = self._refusal(genesis_policy.change_review_policy, {"change_review": block})
        self.assertIn("change_review.seats.seats_per_dev_look", message)

    def test_unknown_key_is_refused_by_path(self) -> None:
        block = _shipped("service_expertise")
        block["genesis"]["k_minimum"] = 2
        message = self._refusal(genesis_policy.service_expertise_policy, {"service_expertise": block})
        self.assertIn("key_unknown", message)
        self.assertIn("service_expertise.genesis", message)

    def test_bool_is_not_read_as_a_count(self) -> None:
        block = _shipped("service_expertise")
        block["genesis"]["k_min"] = True
        message = self._refusal(genesis_policy.service_expertise_policy, {"service_expertise": block})
        self.assertIn("service_expertise.genesis.k_min", message)

    def test_looks_over_the_budget_are_refused(self) -> None:
        block = _shipped("service_expertise")
        block["dev_check"]["look_budget"] = 2
        message = self._refusal(genesis_policy.service_expertise_policy, {"service_expertise": block})
        self.assertIn("looks_over_budget", message)

    def test_contract_edges_cannot_be_registered_for_removal(self) -> None:
        block = _shipped("service_expertise")
        block["final"]["removed_on_fail"].append("contract_edges")
        message = self._refusal(genesis_policy.service_expertise_policy, {"service_expertise": block})
        self.assertIn("service_expertise.final.removed_on_fail", message)

    def test_more_ablations_than_sections_are_refused(self) -> None:
        block = _shipped("change_review")
        block["knowledge"]["sections_in_render_order"] = ["missed"]
        message = self._refusal(genesis_policy.service_expertise_policy, {"change_review": block})
        self.assertIn("service_expertise.dev_check.section_ablation_looks", message)


if __name__ == "__main__":
    unittest.main()
