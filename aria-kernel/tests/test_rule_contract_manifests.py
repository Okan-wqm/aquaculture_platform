"""ARIA-HIGH-324 — every rule a shipped adapter emits states its product claim.

The judge fan-out refuses to judge, and the promotion refuses to promote, a
finding whose rule has no contract in its tool's manifest. A rule added to an
adapter without a contract would therefore go silently unjudged; this pins
the two in step, both directions:

* every literal rule id an adapter's source emits has its OWN contract (the
  ``*`` entry is only for rule ids derived at run time, and only an adapter
  that derives one may declare it);
* every contract names a rule the adapter can emit (no dead contracts).

The contract shape itself is refused at the registry write gate; the unit
tests below pin that refusal for each way a contract could not stand.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from aria_kernel.rule_contract import DYNAMIC_RULE_KEY, contract_for_tool, validate_rule_contracts
from aria_kernel.tool_registry import GovernanceError, validate_tool_definition

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTERS = REPO_ROOT / "tools" / "aria-adapters"

_TS_LITERAL_RULE = re.compile(r"\brule:\s*'([a-z0-9_]+)'")
_TS_DERIVED_RULE = re.compile(r"\brule:\s*[A-Za-z_][A-Za-z0-9_]*\s*,")
_PY_LITERAL_RULE = re.compile(r"_finding\(\s*\"([a-z0-9_]+)\"")


def _manifests() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(ADAPTERS.glob("*.tool.json"))]


def _sources(manifest: dict) -> list[Path]:
    runner = manifest.get("runner") or {}
    cwd = str(runner.get("cwd") or ".")
    return [
        (REPO_ROOT / cwd / arg).resolve()
        for arg in runner.get("argv") or []
        if isinstance(arg, str) and arg.endswith((".ts", ".py"))
    ]


def _emitted_rules(manifest: dict) -> tuple[set[str], bool]:
    literal: set[str] = set()
    derived = False
    for source in _sources(manifest):
        text = source.read_text(encoding="utf-8")
        if source.suffix == ".py":
            literal.update(_PY_LITERAL_RULE.findall(text))
        else:
            literal.update(_TS_LITERAL_RULE.findall(text))
            derived = derived or bool(_TS_DERIVED_RULE.search(text))
    return literal, derived


class ShippedManifestsDeclareEveryRule(unittest.TestCase):
    def test_every_manifest_registers_with_a_contract_block(self) -> None:
        for manifest in _manifests():
            with self.subTest(tool=manifest["tool_id"]):
                compiled = validate_tool_definition(manifest)
                self.assertTrue(compiled.get("rules"), "the manifest declares no rule contracts")

    def test_every_emitted_rule_has_its_own_contract_and_no_contract_is_dead(self) -> None:
        for manifest in _manifests():
            with self.subTest(tool=manifest["tool_id"]):
                literal, derived = _emitted_rules(manifest)
                self.assertTrue(literal or derived, "no rule emission found in the adapter source")
                declared = set(manifest["rules"]) - {DYNAMIC_RULE_KEY}
                self.assertEqual(sorted(literal - declared), [], "emitted rules without a contract")
                self.assertEqual(sorted(declared - literal), [], "contracts for rules the adapter never emits")
                self.assertEqual(DYNAMIC_RULE_KEY in manifest["rules"], derived,
                                 "'*' is declared exactly when the adapter derives rule ids at run time")

    def test_the_bundle_rule_promotes_as_a_low_absence(self) -> None:
        manifest = json.loads((ADAPTERS / "bundle-budget-adapter.tool.json").read_text(encoding="utf-8"))
        contract = contract_for_tool(manifest, "bundle_budget_not_enforced")
        self.assertIsNotNone(contract)
        assert contract is not None
        self.assertEqual((contract.claim_type, contract.severity_cap), ("absence_in_scope", "LOW"))


def _contract(**overrides: object) -> dict:
    base = {
        "claim_type": "wrong_code",
        "severity_cap": "HIGH",
        "defect_claim": "The cited code does the wrong thing.",
        "premises": ["The cited line runs."],
    }
    base.update(overrides)
    return base


class ContractShapeIsRefusedAtTheGate(unittest.TestCase):
    def _refused(self, contract: dict, needle: str) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_rule_contracts({"rule_a": contract}, tool_id="tool-x")
        self.assertIn(needle, str(ctx.exception))

    def test_a_valid_contract_passes_unchanged(self) -> None:
        self.assertEqual(validate_rule_contracts({"rule_a": _contract()}, tool_id="tool-x"), {"rule_a": _contract()})

    def test_unknown_claim_type(self) -> None:
        self._refused(_contract(claim_type="product_bug"), "unknown claim_type")

    def test_a_cap_below_the_claim_floor(self) -> None:
        self._refused(_contract(severity_cap="LOW"), "below the wrong_code floor MEDIUM")

    def test_no_premises(self) -> None:
        self._refused(_contract(premises=[]), "premises must be a non-empty list")

    def test_a_missing_field(self) -> None:
        contract = _contract()
        contract.pop("defect_claim")
        self._refused(contract, "fields must be exactly")

    def test_a_defect_claim_the_finding_gate_would_refuse(self) -> None:
        self._refused(_contract(defect_claim="Kept as a temporary measure."), "banned phrase")

    def test_the_registry_gate_runs_it(self) -> None:
        manifest = json.loads((ADAPTERS / "bundle-budget-adapter.tool.json").read_text(encoding="utf-8"))
        manifest["rules"]["bundle_budget_not_enforced"]["claim_type"] = "product_bug"
        with self.assertRaises(GovernanceError):
            validate_tool_definition(manifest)


if __name__ == "__main__":
    unittest.main()
