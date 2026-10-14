"""ARIA-LOW-476 — ``Observation.discovered_by`` declares exactly what is minted.

The field used to be a bare ``str`` commented as ``"grep" | "ast" | "regex"``
next to a ``DISCOVERY_METHOD_RANK`` table "used by the cross-verify protocol
to weight evidence". Nothing read the table and the collector only ever mints
``"regex"``, so the declaration promised a ranking that did not exist. The
type now carries the vocabulary, and this test holds it to the mint sites.
"""
from __future__ import annotations

import ast
import typing
import unittest
from pathlib import Path

from aria_kernel import evidence_collector


def _minted_discovery_methods() -> set[str]:
    tree = ast.parse(Path(evidence_collector.__file__).read_text(encoding="utf-8"))
    minted: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.keyword) and node.arg == "discovered_by":
            if not isinstance(node.value, ast.Constant):
                raise AssertionError(
                    f"discovered_by minted from a non-literal at line {node.value.lineno}"
                )
            minted.add(node.value.value)
    return minted


class DiscoveryVocabulary(unittest.TestCase):
    def test_declared_vocabulary_is_exactly_what_the_collector_mints(self) -> None:
        hints = typing.get_type_hints(evidence_collector.Observation)
        declared = set(typing.get_args(hints["discovered_by"]))
        minted = _minted_discovery_methods()
        self.assertEqual(minted, {"regex"})
        self.assertEqual(declared, minted)
        self.assertFalse(hasattr(evidence_collector, "DISCOVERY_METHOD_RANK"))


if __name__ == "__main__":
    unittest.main()
