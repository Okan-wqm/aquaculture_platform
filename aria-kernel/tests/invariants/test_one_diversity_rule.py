"""PLAN-v2 F0.8 — no second diversity rule exists in ``aria_kernel``.

WHY THIS EXISTS. The diversity law (operator decision 2026-10-18) has one
owner: the seat law in ``feedback_store`` (WP-P), which COUNTS the distinct
judge seats behind an agreement. Its consumers compare that count against
their floor — ``is_ground_truth_row`` does (``consensus_distinct_seats(row)
>= ANCHOR_MIN_JUDGE_COUNT``). Two consumers carried their own rule instead:

* ``feedback_store.generate_ai_consensus`` builds its own ``distinct_seats``
  set of judge ids under ``enforce`` and gates on its ``len``;
* ``genesis_policy.effective_calibration_gate`` gates on the span
  ``observation_span`` reports (distinct models or methods), which is the
  "different model >= 2" rule that never enforces on one provider.

A restated count is where the rules drift apart: each copy decides the
corner cases (a duplicate seat, a receipt with no model and no method, a
shared method) its own way. This pin is the "detectable" tier for every
later copy, scanned over every production module of ``aria_kernel``.

WHAT COUNTS AS A DIVERSITY RULE. A comparison whose operand is a raw
diversity count computed outside the seat law:

* ``len`` of a set / frozenset (comprehension or constructor) built over
  ``judge_id``, ``model`` or ``method`` — directly, or through a local name
  bound to that set or to its ``len``;
* any value obtained from ``observation_span`` (a recorded descriptor since
  the F0.3 landing, N3: it may be WRITTEN on a row, never COMPARED).

Comparing the seat law's own answer (a call to it) is how a consumer obeys
the law and is legal. Descriptors that are only recorded (``distinct_models``
listed on a ledger row, ``provider_span``) stay legal: they gate nothing.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_IDENTITY_FIELDS = frozenset({"judge_id", "model", "method"})
_DESCRIPTOR = "observation_span"


def _identity_set(node: ast.AST) -> bool:
    is_set = isinstance(node, ast.SetComp) or (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in {"set", "frozenset"}
    )
    return is_set and any(
        isinstance(c, ast.Constant) and isinstance(c.value, str) and c.value in _IDENTITY_FIELDS
        for c in ast.walk(node)
    )


def _descriptor_call(node: ast.AST) -> bool:
    if isinstance(node, ast.Subscript):
        node = node.value
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return (isinstance(func, ast.Name) and func.id == _DESCRIPTOR) or (
        isinstance(func, ast.Attribute) and func.attr == _DESCRIPTOR
    )


def _target_names(target: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(target) if isinstance(n, ast.Name)}


def _offenders(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    where = path.relative_to(_REPO_ROOT)
    found: list[str] = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        sets: set[str] = set()
        counts: set[str] = set()

        def raw_count(node: ast.AST) -> bool:
            if isinstance(node, ast.Name) and node.id in counts:
                return True
            if _descriptor_call(node):
                return True
            return (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "len"
                and len(node.args) == 1
                and (
                    _identity_set(node.args[0])
                    or (isinstance(node.args[0], ast.Name) and node.args[0].id in sets)
                )
            )

        # Two passes so a name bound to a set and then to its len is seen
        # whatever order ast.walk visits them in.
        for _ in range(2):
            for node in ast.walk(fn):
                if isinstance(node, ast.Assign):
                    value, targets = node.value, node.targets
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    value, targets = node.value, [node.target]
                else:
                    continue
                names = set().union(*(_target_names(t) for t in targets))
                if _identity_set(value):
                    sets |= names
                elif any(raw_count(sub) for sub in ast.walk(value)):
                    counts |= names
        for node in ast.walk(fn):
            if isinstance(node, ast.Compare) and any(raw_count(sub) for sub in ast.walk(node)):
                found.append(f"{where}:{node.lineno}:{fn.name}")
    return sorted(set(found))


class NoSecondDiversityRuleTest(unittest.TestCase):
    def test_no_kernel_module_gates_on_a_diversity_count_of_its_own(self) -> None:
        offenders = sorted(
            offender
            for path in sorted(_KERNEL.rglob("*.py"))
            if "tests" not in path.relative_to(_KERNEL).parts
            for offender in _offenders(path)
        )
        self.assertEqual(
            offenders, [],
            "a comparison gates on a diversity count computed outside the seat law "
            "(a len() over judge_id/model/method sets, or observation_span's span). "
            "Ask the ONE seat function in feedback_store and compare ITS answer (F0.8):\n"
            + "\n".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
