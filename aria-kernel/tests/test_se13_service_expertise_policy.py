"""SE-13 — the service-expertise values are pre-registered in genesis_policy blocks.

WHY (service-expertise PLAN §7.2, §7.3, §6.1, §8 SE-13; DECISIONS Q1, Q6): the keep
levels, the look budget, ``k_min`` and ``alpha`` decide whether a service pack or a
per-service agent survives the build. They must be written down BEFORE the first
DEV-check look, in the one policy owner (``genesis_policy``), so no reader can pick a
number after seeing a result. Two failure modes are pinned here:

1. The blocks do not exist (they are absent at base): a reader has no pre-registered
   value to read, so whatever literal it carries decides.
2. A block that omits one of the deciding values is filled from a default. Every other
   accessor in ``genesis_policy`` does exactly that (``rhythm_policy``,
   ``genesis_lifecycle_policy``: ``block.update(...)`` over a defaults dict), and
   ``merge_with_override`` is a SHALLOW merge, so an operator override that replaces the
   block and forgets ``k_min`` would silently run on the shipped number. For a
   pre-registered decision rule that is a forged registration; the parser REFUSES the
   block and names the missing key instead.

The block layout inside ``service_expertise`` is the implementer's (PLAN §6.1 names a
``genesis`` sub-block); these tests locate each deciding key wherever it sits in the
shipped block, so they pin the contract, not the nesting.

New API pinned by this module: ``genesis_policy.service_expertise_policy(repo_root=None)``
(the typed accessor PLAN §6.1 says parses ``service_expertise``), raising
``tool_registry.GovernanceError`` for a refused block.
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

NEW_BLOCKS = ("service_expertise", "change_review")

# The keys whose absence the parser must refuse (PLAN §8 SE-13 red-test column).
# ``keep_level_*`` expands to every key with that prefix; PLAN §7.2 names two.
REQUIRED_SCALAR_KEYS = ("k_min", "alpha", "look_budget")
REQUIRED_KEEP_LEVELS = ("keep_level_dev", "keep_level_final")


def _shipped_defaults() -> dict[str, Any]:
    path = Path(genesis_policy.__file__).resolve().parent / "data" / genesis_policy.DEFAULT_FILENAME
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(raw, dict)
    return raw


def _key_paths(block: Any, prefix: tuple[str, ...] = ()) -> dict[str, list[tuple[str, ...]]]:
    """Every key in a nested block -> the paths it sits at (keys starting with _ are annotations)."""
    found: dict[str, list[tuple[str, ...]]] = {}
    if isinstance(block, dict):
        for key, value in block.items():
            if key.startswith("_"):
                continue
            found.setdefault(key, []).append(prefix + (key,))
            for inner, paths in _key_paths(value, prefix + (key,)).items():
                found.setdefault(inner, []).extend(paths)
    return found


def _without(block: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    trimmed = copy.deepcopy(block)
    node = trimmed
    for key in path[:-1]:
        node = node[key]
    del node[path[-1]]
    return trimmed


def _value_at(block: dict[str, Any], path: tuple[str, ...]) -> Any:
    node: Any = block
    for key in path:
        node = node[key]
    return node


class Se13BlocksArePreRegisteredTests(unittest.TestCase):
    """Red at base by assertion: the blocks are absent from the shipped policy."""

    def test_new_blocks_ship_in_the_default_policy(self) -> None:
        shipped = _shipped_defaults()
        absent = [block for block in NEW_BLOCKS if not isinstance(shipped.get(block), dict)]
        self.assertEqual(absent, [], f"not pre-registered in {genesis_policy.DEFAULT_FILENAME}")

    def test_new_blocks_join_the_policy_contract(self) -> None:
        # A key absent from POLICY_KEYS is dropped by default_policy() and by
        # merge_with_override, so the block would be dead configuration (C8).
        defaults = genesis_policy.default_policy()
        outside_contract = [block for block in NEW_BLOCKS if block not in genesis_policy.POLICY_KEYS]
        dropped = [block for block in NEW_BLOCKS if block not in defaults]
        self.assertEqual(outside_contract, [], "absent from POLICY_KEYS")
        self.assertEqual(dropped, [], "dropped by default_policy()")

    def test_deciding_keys_are_registered_exactly_once(self) -> None:
        block = _shipped_defaults().get("service_expertise")
        self.assertIsInstance(block, dict, "service_expertise block absent")
        paths = _key_paths(block)
        keep_levels = sorted(k for k in paths if k.startswith("keep_level_"))
        for key in REQUIRED_KEEP_LEVELS:
            self.assertIn(key, keep_levels)
        for key in (*REQUIRED_SCALAR_KEYS, *keep_levels):
            with self.subTest(key=key):
                # One owner per value: a second copy inside the block is a second number
                # that can drift from the first.
                self.assertEqual(len(paths.get(key, [])), 1, f"{key} at {paths.get(key)}")

    def test_registered_values_are_the_plan_and_decision_values(self) -> None:
        block = _shipped_defaults().get("service_expertise")
        self.assertIsInstance(block, dict, "service_expertise block absent")
        paths = _key_paths(block)
        expected = {
            # DECISIONS Q1 (accepted): final keep iff P(theta > 0.5) >= 0.95 on HELD-OUT.
            "keep_level_final": 0.95,
            # PLAN §7.2: DEV-check keep level.
            "keep_level_dev": 0.90,
            # DECISIONS Q6: 6 looks per frozen SHA for the whole build.
            "look_budget": 6,
            # PLAN §6.1 gate 1: x_S >= k_min.
            "k_min": 3,
        }
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertIn(key, paths)
                self.assertEqual(_value_at(block, paths[key][0]), value)
        alpha = _value_at(block, paths["alpha"][0]) if "alpha" in paths else None
        self.assertIsInstance(alpha, float)
        self.assertTrue(0.0 < alpha < 1.0, alpha)


class Se13ParserRefusesAnIncompleteBlockTests(unittest.TestCase):
    """New API pin: service_expertise_policy. Red at base because the accessor is absent."""

    def _accessor(self):
        accessor = getattr(genesis_policy, "service_expertise_policy", None)
        self.assertTrue(callable(accessor), "genesis_policy.service_expertise_policy is not defined")
        return accessor

    def _shipped_block(self) -> dict[str, Any]:
        block = _shipped_defaults().get("service_expertise")
        self.assertIsInstance(block, dict, "service_expertise block absent")
        return block

    def _parse_override(self, block: dict[str, Any]) -> dict[str, Any]:
        accessor = self._accessor()
        with tempfile.TemporaryDirectory() as tmp:
            override = Path(tmp) / genesis_policy.OVERRIDE_RELPATH
            override.parent.mkdir(parents=True)
            override.write_text(json.dumps({"service_expertise": block}), encoding="utf-8")
            return accessor(tmp)

    def test_shipped_block_parses(self) -> None:
        accessor = self._accessor()
        parsed = accessor()
        paths = _key_paths(parsed)
        for key in (*REQUIRED_SCALAR_KEYS, *REQUIRED_KEEP_LEVELS):
            with self.subTest(key=key):
                self.assertIn(key, paths)

    def test_complete_override_parses(self) -> None:
        block = self._shipped_block()
        parsed = self._parse_override(block)
        parsed_paths = _key_paths(parsed)
        for key, paths in _key_paths(block).items():
            for path in paths:
                with self.subTest(path=".".join(path)):
                    self.assertIn(path, parsed_paths.get(key, []))
                    self.assertEqual(_value_at(parsed, path), _value_at(block, path))

    def test_block_missing_a_deciding_key_is_refused_by_name(self) -> None:
        block = self._shipped_block()
        paths = _key_paths(block)
        keep_levels = [k for k in paths if k.startswith("keep_level_")]
        self.assertTrue(set(REQUIRED_KEEP_LEVELS) <= set(keep_levels), keep_levels)
        for key in (*REQUIRED_SCALAR_KEYS, *keep_levels):
            for path in paths.get(key, []):
                with self.subTest(key=key, path=".".join(path)):
                    with self.assertRaises(GovernanceError) as refused:
                        self._parse_override(_without(block, path))
                    # Refused by name: the operator learns which value is missing,
                    # and the shipped default never stands in for it.
                    self.assertIn(key, str(refused.exception))

    def test_block_that_is_not_an_object_is_refused(self) -> None:
        accessor = self._accessor()
        with tempfile.TemporaryDirectory() as tmp:
            override = Path(tmp) / genesis_policy.OVERRIDE_RELPATH
            override.parent.mkdir(parents=True)
            override.write_text(json.dumps({"service_expertise": [3, 0.05]}), encoding="utf-8")
            with self.assertRaises(GovernanceError) as refused:
                accessor(tmp)
            self.assertIn("service_expertise", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
