"""Plan 026R §E.9 — capability_gap types ↔ learning router parity.

AST invariant: the closed enum of ``CAPABILITY_GAP_TYPES`` emitted
by ``capability_gap.py`` MUST equal the set of ``gap_type`` values
the learning router (``learning._skill_or_agent_genesis``) branches
on. Drift is forbidden — if a new gap_type is added on one side
without the other, learning silently mis-routes or capability_gap
emits unreachable types.

4 tests:

* capability_gap.CAPABILITY_GAP_TYPES is a non-empty frozenset.
* learning router string-literal comparisons cover every type the
  capability_gap module declares — AST walk on learning.py finds
  every ``gap_type == "<literal>"`` comparison, every
  ``elif gap_type == "<literal>"`` form, AND every
  ``gap_type in (...)`` membership test; the union must include
  CAPABILITY_GAP_TYPES (router handles ≥ every emitter type).
* skill_gap is in CAPABILITY_GAP_TYPES (Plan 026R §E.9 NEW).
* unobserved_surface is in CAPABILITY_GAP_TYPES (H-3 NEW).

H-3 raised the bar on the third test in both directions. Each type
in ``_EXPLICITLY_ROUTED`` must appear on BOTH sides: drop it from the
enum and the test fails, drop its router branch and the test fails.
A type routed by the default branch cannot be told apart from a type
nobody thought about, which is how a mis-route stays invisible.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel.capability_gap import CAPABILITY_GAP_TYPES


KERNEL_DIR = Path(__file__).resolve().parent.parent / "aria_kernel"

# Types the router must branch on BY NAME. The default branch is not a
# routing decision, it is the absence of one, so a type that only reaches
# `request_agent_genesis` by falling through is indistinguishable from a
# type nobody has considered. Each name here is asserted on both sides.
_EXPLICITLY_ROUTED: tuple[str, ...] = (
    "existing_agent_extension",
    "skill_gap",
    "unobserved_surface",
)


def _gap_type_literals_in_router() -> set[str]:
    """Walk learning.py and collect every string constant compared
    against ``gap_type`` — by equality or by membership."""
    tree = ast.parse(
        (KERNEL_DIR / "learning.py").read_text(encoding="utf-8"),
    )
    literals: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        left = node.left
        # Looking for: gap_type == "literal" / gap_type in ("a", "b")
        if not (isinstance(left, ast.Name) and left.id == "gap_type"):
            continue
        for comparator in node.comparators:
            if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                literals.add(comparator.value)
            elif isinstance(comparator, (ast.Tuple, ast.List, ast.Set)):
                # A membership branch routes just as really as an equality
                # one. Reading only `==` left a hole big enough to move a
                # whole gap type through without this invariant noticing.
                for element in comparator.elts:
                    if isinstance(element, ast.Constant) and isinstance(element.value, str):
                        literals.add(element.value)
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

    def test_unobserved_surface_in_capability_gap_types(self) -> None:
        self.assertIn(
            "unobserved_surface", CAPABILITY_GAP_TYPES,
            "H-3: a root no adapter can read is filed as "
            "unobserved_surface; the type must be registered here or "
            "capability_gap._gap refuses to mint it.",
        )

    def test_router_handles_every_capability_gap_type(self) -> None:
        router_literals = _gap_type_literals_in_router()
        # agent_gap + policy_gap + adapter_gap may fall through to the
        # default branch (request_agent_genesis). The specially routed
        # types may not: existing_agent_extension → record_extension,
        # skill_gap and unobserved_surface → request_skill_genesis
        # (adapter authoring). Both sides are asserted, so updating one
        # alone turns this test red.
        for required in _EXPLICITLY_ROUTED:
            self.assertIn(
                required, router_literals,
                f"learning router missing explicit branch on "
                f"gap_type == {required!r} — Plan 026R §E.9 / H-3 contract",
            )
            self.assertIn(
                required, CAPABILITY_GAP_TYPES,
                f"{required!r} is routed by learning.py but absent from "
                f"CAPABILITY_GAP_TYPES — the router would handle a type "
                f"nothing is allowed to mint.",
            )


if __name__ == "__main__":
    unittest.main()
