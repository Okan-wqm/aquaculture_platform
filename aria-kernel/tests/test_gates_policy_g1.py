"""F1.2 — the G1 field list is pre-registered once, in genesis_policy's ``gates`` block, parsed strictly.

WHY THIS EXISTS. PLAN-v2 §4: G1 is "14 consecutive cycles, every field of the F1.2 field list measured
(not None)". The list decides what a measured cycle means, so it is a pre-registered decision (PLAN §1.3: the
thresholds are registered in genesis_policy BEFORE the measurement), and it must have one definition: the
scorecard reader (``autonomy_evidence.g1_gap_free_run``) takes the names it reports from the policy and restates
none. Nothing in this package evaluates the gate; the block only carries what the gate will read.

THE API THIS PINS (new in F1.2; at the branch base neither the key nor the accessor exists, so each test
that needs them reports an assertion failure, not an import error):
  genesis_policy.POLICY_KEYS contains ``gates`` (an operator override carrying it is merged, never dropped);
  the shipped aria_kernel/data/genesis_policy_default.json carries the block;
  genesis_policy.gates_policy(repo_root=None) -> {"g1": {"consecutive_cycles": 14, "fields": [name, ...]}}
    parsed through preregistered_policy (SE-13): every key required, an unknown or out-of-range key refused by
    its dotted path (``gates.g1.fields``), no default filled in code. A field name is a snake_case name,
    distinct within the list, and the list is not empty.
The names themselves are not pinned here: test_scorecard_lens_specs pins that each one is a measured field of
exactly one lens spec, and that every lens contributes at least one.
"""
from __future__ import annotations

import copy
import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import genesis_policy
from aria_kernel.tool_registry import GovernanceError

_SNAKE_CASE = re.compile(r"[a-z][a-z0-9_]*")


def _accessor() -> Any:
    accessor = getattr(genesis_policy, "gates_policy", None)
    if accessor is None:
        raise AssertionError("F1.2: aria_kernel.genesis_policy.gates_policy (the pre-registered gates block) does not exist")
    return accessor


def _shipped_block() -> dict[str, Any]:
    path = Path(genesis_policy.__file__).resolve().parent / "data" / genesis_policy.DEFAULT_FILENAME
    block = json.loads(path.read_text(encoding="utf-8")).get("gates")
    if block is None:
        raise AssertionError(f"F1.2: {path.name} carries no gates block")
    return copy.deepcopy(block)


def _override(override: dict[str, Any]) -> tuple[tempfile.TemporaryDirectory[str], str]:
    tmp = tempfile.TemporaryDirectory()
    path = Path(tmp.name) / genesis_policy.OVERRIDE_RELPATH
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(override), encoding="utf-8")
    return tmp, tmp.name


class TheShippedGatesBlockCarriesTheG1FieldList(unittest.TestCase):
    def test_gates_is_a_policy_key_so_an_override_is_merged_not_dropped(self) -> None:
        self.assertIn("gates", genesis_policy.POLICY_KEYS)
        self.assertIn("gates", genesis_policy.default_policy())

    def test_g1_is_fourteen_consecutive_cycles(self) -> None:
        self.assertEqual(_accessor()()["g1"]["consecutive_cycles"], 14)

    def test_the_field_list_is_distinct_snake_case_names_and_not_empty(self) -> None:
        fields = _accessor()()["g1"]["fields"]
        self.assertIsInstance(fields, list)
        self.assertGreater(len(fields), 0)
        self.assertEqual(len(set(fields)), len(fields), "a field listed twice")
        for name in fields:
            with self.subTest(name=name):
                self.assertRegex(name, _SNAKE_CASE)

    def test_the_block_names_nothing_but_the_g1_decision(self) -> None:
        # Nothing here evaluates the gate: G0, aşama-2 and G3 are other packages' registrations.
        self.assertEqual(set(_shipped_block()) - {"_doc"}, {"g1"})
        self.assertEqual(set(_accessor()()["g1"]), {"consecutive_cycles", "fields"})


class AnOverrideIsParsedStrictly(unittest.TestCase):
    def _refusal(self, override: dict[str, Any]) -> str:
        tmp, root = _override(override)
        self.addCleanup(tmp.cleanup)
        with self.assertRaises(GovernanceError) as refused:
            _accessor()(root)
        return str(refused.exception)

    def test_an_override_carrying_a_valid_block_replaces_the_shipped_list(self) -> None:
        block = _shipped_block()
        block["g1"]["fields"] = ["alpha_rate", "beta_rate"]
        tmp, root = _override({"gates": block})
        self.addCleanup(tmp.cleanup)
        self.assertEqual(_accessor()(root)["g1"]["fields"], ["alpha_rate", "beta_rate"])

    def test_a_missing_field_list_is_refused_by_path_not_filled_from_the_shipped_one(self) -> None:
        block = _shipped_block()
        del block["g1"]["fields"]
        self.assertIn("gates.g1.fields", self._refusal({"gates": block}))

    def test_a_missing_g1_is_refused_by_path(self) -> None:
        block = _shipped_block()
        del block["g1"]
        self.assertIn("gates.g1", self._refusal({"gates": block}))

    def test_an_unknown_key_is_refused_by_path(self) -> None:
        block = _shipped_block()
        block["g1"]["cycles"] = 14
        message = self._refusal({"gates": block})
        self.assertIn("key_unknown", message)
        self.assertIn("gates.g1", message)

    def test_a_bool_is_not_read_as_a_cycle_count(self) -> None:
        block = _shipped_block()
        block["g1"]["consecutive_cycles"] = True
        self.assertIn("gates.g1.consecutive_cycles", self._refusal({"gates": block}))

    def test_a_cycle_count_of_zero_is_refused(self) -> None:
        block = _shipped_block()
        block["g1"]["consecutive_cycles"] = 0
        self.assertIn("gates.g1.consecutive_cycles", self._refusal({"gates": block}))

    def test_an_empty_field_list_is_refused(self) -> None:
        block = _shipped_block()
        block["g1"]["fields"] = []
        self.assertIn("gates.g1.fields", self._refusal({"gates": block}))

    def test_a_field_listed_twice_is_refused(self) -> None:
        block = _shipped_block()
        block["g1"]["fields"] = ["alpha_rate", "alpha_rate"]
        self.assertIn("gates.g1.fields", self._refusal({"gates": block}))

    def test_a_name_that_is_not_snake_case_is_refused(self) -> None:
        block = _shipped_block()
        block["g1"]["fields"] = ["Alpha Rate"]
        self.assertIn("gates.g1.fields", self._refusal({"gates": block}))


if __name__ == "__main__":
    unittest.main()
