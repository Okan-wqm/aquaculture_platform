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

    def test_every_manifests_declared_scope_is_walked_by_its_input_roots(self) -> None:
        """ARIA-LOW-594 — no shipped adapter declares coverage it never walks."""
        for manifest in _manifests():
            with self.subTest(tool=manifest["tool_id"]):
                validate_tool_definition(manifest)

    def test_every_emitted_rule_has_its_own_contract_and_no_contract_is_dead(self) -> None:
        for manifest in _manifests():
            with self.subTest(tool=manifest["tool_id"]):
                literal, derived = _emitted_rules(manifest)
                self.assertTrue(literal or derived, "no rule emission found in the adapter source")
                declared = set(manifest["rules"]) - {DYNAMIC_RULE_KEY}
                self.assertEqual(sorted(literal - declared), [], "emitted rules without a contract")
                if not derived:
                    self.assertEqual(sorted(declared - literal), [], "contracts for rules the adapter never emits")
                # An adapter that derives its rule ids at run time (the lint-rules
                # adapter: the ESLint rule id) has no literal to read them from, so
                # the contracts it declares beside ``*`` cannot be checked against
                # its source text. They are proven live where the rules really run:
                # lint-rules-adapter.test.ts runs the engine over its policy fixture
                # and asserts the declared set equals the set of rules that fired.
                self.assertEqual(DYNAMIC_RULE_KEY in manifest["rules"], derived,
                                 "'*' is declared exactly when the adapter derives rule ids at run time")

    def test_the_bundle_rule_promotes_as_a_low_absence(self) -> None:
        manifest = json.loads((ADAPTERS / "bundle-budget-adapter.tool.json").read_text(encoding="utf-8"))
        contract = contract_for_tool(manifest, "bundle_budget_not_enforced")
        self.assertIsNotNone(contract)
        assert contract is not None
        self.assertEqual((contract.claim_type, contract.severity_cap), ("absence_in_scope", "LOW"))


class LintRulesPolicyPackStatesItsOwnPremise(unittest.TestCase):
    """ARIA-DET Z-B1 step 1 — a repository-policy rule is judged on the policy, not on the generic claim.

    The ``*`` contract of lint-rules-adapter says a true positive is "not a
    style preference the codebase allows". For a console call in a project
    whose developer lint allows it, a judge would rightly refute that, yet
    CLAUDE.md forbids the construct everywhere: ``console.*``, ``as any`` and
    ``as unknown as X``. The rules that carry that policy therefore declare
    their own entry (an exact key is preferred over ``*``), whose premises
    name the policy, and keep the mechanical observable ``*`` has, because an
    entry that replaced ``*`` without one would be refused at tier-0 as
    ``claim_not_falsifiable``. That the entries and the rules that really
    fire are the same set is pinned where the engine runs
    (lint-rules-adapter.test.ts).
    """

    POLICY_RULES = (
        "no-console",
        "@typescript-eslint/no-explicit-any",
        "aria-policy/no-double-type-assertion",
    )
    GENERIC_PREMISE = "style preference the codebase allows"

    def setUp(self) -> None:
        self.manifest = json.loads((ADAPTERS / "lint-rules-adapter.tool.json").read_text(encoding="utf-8"))

    def test_each_policy_rule_declares_an_entry_of_its_own(self) -> None:
        for rule in self.POLICY_RULES:
            with self.subTest(rule=rule):
                self.assertIn(rule, self.manifest["rules"], "the rule falls back to the generic ``*`` contract")
                self.assertNotEqual(self.manifest["rules"][rule], self.manifest["rules"][DYNAMIC_RULE_KEY])

    def test_a_policy_premise_names_the_repository_policy_and_not_the_generic_claim(self) -> None:
        for rule in self.POLICY_RULES:
            with self.subTest(rule=rule):
                contract = contract_for_tool(self.manifest, rule)
                assert contract is not None
                self.assertTrue(
                    any("CLAUDE.md" in premise for premise in contract.premises),
                    f"no premise of {rule} says that CLAUDE.md forbids the construct: {contract.premises}",
                )
                self.assertFalse(
                    any(self.GENERIC_PREMISE in premise for premise in contract.premises),
                    f"{rule} repeats the generic premise a judge would refute for a policy rule",
                )

    def test_a_policy_rule_keeps_the_mechanical_observable_of_the_lint_family(self) -> None:
        for rule in self.POLICY_RULES:
            with self.subTest(rule=rule):
                self.assertIn(rule, self.manifest["rules"], "the rule has no entry of its own to carry one")
                self.assertEqual(
                    self.manifest["rules"][rule].get("observable"), {"kind": "cited_line_bytes_at_sha"},
                )


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


class DeclaredScopeMustLieInsideTheWalkedRoots(unittest.TestCase):
    """ARIA-LOW-594 — a declared scope production never walks is coverage theatre.

    observation_coverage.adapter_scopes counts a path as observed when an
    adapter DECLARES it, never asking whether the production input ever
    reaches it: bundle-budget-adapter declared ``web/**`` while
    default_input.roots walked only web/shell, web/modules and web/apps, so
    every web/shared-ui file counted as observed without being read. The
    registry write gate is the one point every manifest passes, so the tie
    lives there: with roots (or coverageRoots) declared, each declared_scope
    glob's literal prefix must be a root or lie under one. A manifest
    without default_input walks its declared scope directly and is exempt.
    """

    def _manifest(self, scope: list[str], roots: list[str], coverage_roots: list[str] | None = None) -> dict:
        manifest = json.loads((ADAPTERS / "bundle-budget-adapter.tool.json").read_text(encoding="utf-8"))
        manifest["declared_scope"] = scope
        # The signature is derived; dropping it lets the gate recompute it
        # over the synthetic shape instead of refusing the stale one.
        manifest.pop("parse_window_signature", None)
        default_input: dict[str, list[str]] = {"roots": roots}
        if coverage_roots is not None:
            default_input["coverageRoots"] = coverage_roots
        manifest["default_input"] = default_input
        return manifest

    def test_a_scope_wider_than_the_walked_roots_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_tool_definition(self._manifest(["web/**/*.{ts,tsx}"], ["web/shell"]))
        self.assertIn("declared_scope_outside_walked_roots:web/**/*.{ts,tsx}", str(ctx.exception))

    def test_a_scope_above_the_roots_is_refused_even_when_they_share_a_prefix(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_tool_definition(self._manifest(["web/**/*.{ts,tsx}"], ["web/shell", "web/modules"]))
        self.assertIn("declared_scope_outside_walked_roots", str(ctx.exception))

    def test_a_scope_equal_to_a_root_and_one_under_it_are_admitted(self) -> None:
        compiled = validate_tool_definition(
            self._manifest(["web/shell/**/*.{ts,tsx}", "web/shell/src/vite.config.ts"], ["web/shell"])
        )
        self.assertEqual(
            compiled["declared_scope"], ["web/shell/**/*.{ts,tsx}", "web/shell/src/vite.config.ts"]
        )

    def test_coverage_roots_are_roots_for_the_check(self) -> None:
        compiled = validate_tool_definition(
            self._manifest(["apps/**/*.ts", "e2e/**/*.ts"], ["apps"], coverage_roots=["e2e"])
        )
        self.assertEqual(compiled["declared_scope"], ["apps/**/*.ts", "e2e/**/*.ts"])

    def test_a_manifest_without_default_input_walks_its_scope_directly(self) -> None:
        manifest = self._manifest(["web/**/*.{ts,tsx}"], ["web/shell"])
        manifest.pop("default_input")
        compiled = validate_tool_definition(manifest)
        self.assertEqual(compiled["declared_scope"], ["web/**/*.{ts,tsx}"])


if __name__ == "__main__":
    unittest.main()
