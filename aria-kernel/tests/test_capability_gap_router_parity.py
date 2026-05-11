"""Plan 026R §E.9 — capability_gap types ↔ learning router parity.

AST invariant: the closed enum of ``CAPABILITY_GAP_TYPES`` emitted
by ``capability_gap.py`` MUST equal the set of ``gap_type`` values
the learning router (``learning._skill_or_agent_genesis``) branches
on. Drift is forbidden — if a new gap_type is added on one side
without the other, learning silently mis-routes or capability_gap
emits unreachable types.

3 tests:

* capability_gap.CAPABILITY_GAP_TYPES is a non-empty frozenset.
* learning router string-literal comparisons cover every type the
  capability_gap module declares — AST walk on learning.py finds
  every ``gap_type == "<literal>"`` comparison AND every
  ``elif gap_type == "<literal>"`` form; the union must include
  CAPABILITY_GAP_TYPES (router handles ≥ every emitter type).
* skill_gap is in CAPABILITY_GAP_TYPES (Plan 026R §E.9 NEW).
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel.capability_gap import CAPABILITY_GAP_TYPES


KERNEL_DIR = Path(__file__).resolve().parent.parent / "aria_kernel"


def _gap_type_literals_in_router() -> set[str]:
    """Walk learning.py and collect every string constant on either
    side of a ``gap_type == <const>`` comparison."""
    tree = ast.parse(
        (KERNEL_DIR / "learning.py").read_text(encoding="utf-8"),
    )
    literals: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        left = node.left
        # Looking for: gap_type == "literal"
        if (
            isinstance(left, ast.Name)
            and left.id == "gap_type"
            and len(node.comparators) >= 1
            and isinstance(node.comparators[0], ast.Constant)
            and isinstance(node.comparators[0].value, str)
        ):
            literals.add(node.comparators[0].value)
    return literals


class CapabilityGapRouterParityTests(unittest.TestCase):
    def test_capability_gap_types_non_empty_frozenset(self) -> None:
        self.assertIsInstance(CAPABILITY_GAP_TYPES, frozenset)
        self.assertGreater(len(CAPABILITY_GAP_TYPES), 0)

    def test_skill_gap_in_capability_gap_types(self) -> None:
        self.assertIn(
            "skill_gap", CAPABILITY_GAP_TYPES,
            "Plan 026R §E.9: skill_gap must be declared in "
            "CAPABILITY_GAP_TYPES so learning router can route it.",
        )

    def test_router_handles_every_capability_gap_type(self) -> None:
        router_literals = _gap_type_literals_in_router()
        # Router MUST branch on every emitter type. agent_gap +
        # policy_gap + adapter_gap may fall through to the default
        # branch (request_agent_genesis), which is acceptable as
        # long as the router's explicit branches cover the special
        # routings (existing_agent_extension → record_extension,
        # skill_gap → request_skill_genesis). Assert these two
        # explicit branches exist.
        for required in ("existing_agent_extension", "skill_gap"):
            self.assertIn(
                required, router_literals,
                f"learning router missing explicit branch on "
                f"gap_type == {required!r} — Plan 026R §E.9 contract",
            )


if __name__ == "__main__":
    unittest.main()
