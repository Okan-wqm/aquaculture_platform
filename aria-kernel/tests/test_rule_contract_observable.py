"""WP-J slice A — a rule contract can state how its claim is observably
checked, and a claim that nothing can check is refused by name.

The defect (wpj-a-2): the registry gate's exact-set field check refuses any
``observable`` key, so no rule can declare a predicted observable; and a rule
with neither a checkable premise nor a reproduction recipe registers anyway
and its findings reach the judge lane with no named
``claim_not_falsifiable`` refusal anywhere (the F-011 shape: judges answered
the rule's predicate because nobody said what to observe).

The pins here:

* ``observable`` is OPTIONAL (the exact-set gate becomes subset-allowed:
  minus ``observable`` the fields are exactly the four);
* its shape is closed — a dict of exactly ``{"kind"}`` with a kind from
  ``RULE_CONTRACT_OBSERVABLE_KINDS`` — and a bad shape is refused at the
  registry write gate, the one gate every manifest passes;
* ``CLAIM_NOT_FALSIFIABLE`` is the named refusal tier-0 mints for a rule
  with neither observable nor recipe;
* the two shipped families that own 90.8% of the live backlog (6307 lint +
  2813 doc-staleness of 10048 rows, measured on
  origin/aria/state:tools/raw-findings.jsonl) declare their per-family
  observables in the same commit.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aria_kernel.rule_contract import (
    DYNAMIC_RULE_KEY,
    contract_for_tool,
    validate_rule_contracts,
)
from aria_kernel.tool_registry import GovernanceError

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTERS = REPO_ROOT / "tools" / "aria-adapters"


def _contract(**overrides: object) -> dict:
    base: dict[str, object] = {
        "claim_type": "wrong_code",
        "severity_cap": "HIGH",
        "defect_claim": "The cited code does the wrong thing.",
        "premises": ["The cited line runs."],
    }
    base.update(overrides)
    return base


class TheObservableFieldIsOptionalAndClosed(unittest.TestCase):
    def test_a_contract_with_an_observable_registers(self) -> None:
        contract = _contract(observable={"kind": "cited_line_bytes_at_sha"})
        cleaned = validate_rule_contracts({"rule_a": contract}, tool_id="tool-x")
        self.assertEqual(cleaned["rule_a"]["observable"], "cited_line_bytes_at_sha")

    def test_a_contract_without_an_observable_still_registers(self) -> None:
        cleaned = validate_rule_contracts({"rule_a": _contract()}, tool_id="tool-x")
        self.assertNotIn("observable", cleaned["rule_a"])

    def test_an_unknown_kind_is_refused_at_the_gate(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_rule_contracts(
                {"rule_a": _contract(observable={"kind": "gut_feeling"})}, tool_id="tool-x"
            )
        self.assertIn("observable_kind_unknown", str(ctx.exception))

    def test_a_non_object_or_extra_keyed_observable_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_rule_contracts(
                {"rule_a": _contract(observable="cited_line_bytes_at_sha")}, tool_id="tool-x"
            )
        self.assertIn("observable_invalid", str(ctx.exception))
        with self.assertRaises(GovernanceError) as ctx:
            validate_rule_contracts(
                {"rule_a": _contract(observable={"kind": "cited_line_bytes_at_sha", "how": "hard"})},
                tool_id="tool-x",
            )
        self.assertIn("observable_invalid", str(ctx.exception))

    def test_an_unknown_extra_field_is_still_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_rule_contracts(
                {"rule_a": _contract(surprise=1)}, tool_id="tool-x"
            )
        self.assertIn("fields must be exactly", str(ctx.exception))

    def test_the_kind_vocabulary_is_closed(self) -> None:
        from aria_kernel.rule_contract import RULE_CONTRACT_OBSERVABLE_KINDS
        self.assertEqual(
            sorted(RULE_CONTRACT_OBSERVABLE_KINDS),
            ["cited_line_bytes_at_sha", "referenced_path_absent_at_sha"],
        )

    def test_the_named_refusal_for_an_unfalsifiable_claim_exists(self) -> None:
        from aria_kernel.rule_contract import CLAIM_NOT_FALSIFIABLE
        self.assertEqual(CLAIM_NOT_FALSIFIABLE, "claim_not_falsifiable")

    def test_the_resolved_contract_carries_the_observable(self) -> None:
        tool = {
            "tool_id": "tool-x",
            "declared_scope": ["src/**"],
            "rules": {
                "rule_a": _contract(observable={"kind": "referenced_path_absent_at_sha"}),
                "rule_b": _contract(),
            },
        }
        with_observable = contract_for_tool(tool, "rule_a")
        without = contract_for_tool(tool, "rule_b")
        assert with_observable is not None and without is not None
        self.assertEqual(with_observable.observable, "referenced_path_absent_at_sha")
        self.assertIsNone(without.observable)


class TheShippedFamiliesDeclareObservables(unittest.TestCase):
    """Per-family observables for the two families that own the backlog."""

    def test_the_lint_dynamic_rule_declares_cited_line_bytes(self) -> None:
        manifest = json.loads((ADAPTERS / "lint-rules-adapter.tool.json").read_text(encoding="utf-8"))
        contract = contract_for_tool(manifest, DYNAMIC_RULE_KEY)
        assert contract is not None
        self.assertEqual(contract.observable, "cited_line_bytes_at_sha")

    def test_doc_staleness_declares_referenced_path_absence(self) -> None:
        manifest = json.loads((ADAPTERS / "doc-staleness-adapter.tool.json").read_text(encoding="utf-8"))
        contract = contract_for_tool(manifest, "doc_references_missing_path")
        assert contract is not None
        self.assertEqual(contract.observable, "referenced_path_absent_at_sha")

    def test_both_manifests_still_register(self) -> None:
        from aria_kernel.tool_registry import validate_tool_definition
        for name in ("lint-rules-adapter", "doc-staleness-adapter"):
            manifest = json.loads((ADAPTERS / f"{name}.tool.json").read_text(encoding="utf-8"))
            with self.subTest(tool=name):
                validate_tool_definition(manifest)


if __name__ == "__main__":
    unittest.main()
