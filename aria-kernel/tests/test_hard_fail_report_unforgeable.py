"""A gate verdict nobody can forge, and no number can argue past.

ORPHAN-CRITICAL-428 introduced an opaque construction token so that
``HardFailReport`` — the verdict of the 17-check pre-PR-open / pre-merge
perimeter — could only be produced by the registry that ran the checks. Its
docstring states the property as settled: "constructed only by
`run_hard_fail_checks`, so a caller cannot assemble a passing report by hand",
and calls hand-assembly "impossible rather than merely discouraged".

IT WAS NEVER ENFORCED. `_token` is written by both producers and read by
nothing, and it defaults to ``None``, so

    HardFailReport(results=(HardFailResult("no_force_push", True, "ok"),))

builds a report whose ``passed`` is True and whose ``raise_if_blocked()``
returns silently. One line, inside the kernel, and the entire perimeter is
bypassed — not by defeating a check, but by never running one.

That is the strongest form of the rule this file also pins: a hard gate's
verdict is a CONJUNCTION OVER CHECKS THAT ACTUALLY RAN. No score may stand in
for one, and neither may a hand-built object claiming they all passed.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
import unittest

from aria_kernel import implementation_safety
from aria_kernel.implementation_safety import (
    GATE_PRE_PR_OPEN,
    HardFailContext,
    HardFailReport,
    HardFailResult,
    PerimeterObservation,
    PerimeterVerdict,
    observe_perimeter,
    run_hard_fail_checks,
)

PASSING = (HardFailResult(name="no_force_push", passed=True, reason="ok"),)
CLEAN_VERDICT = (
    PerimeterVerdict(name="no_force_push", passed=True, reason="ok", evaluable=True),
)


class UnforgeableVerdictTests(unittest.TestCase):
    def test_a_hand_assembled_passing_report_is_refused(self) -> None:
        """The one line that used to bypass seventeen checks."""
        with self.assertRaises(implementation_safety.ForgedVerdict):
            HardFailReport(results=PASSING)

    def test_a_hand_assembled_failing_report_is_refused_too(self) -> None:
        """Not "forging a PASS is refused" — forging a VERDICT is. A report
        that claims a check failed is equally unearned, and letting it through
        would make the guard a rule about optimism rather than about provenance."""
        failing = (HardFailResult(name="no_force_push", passed=False, reason="nope"),)
        with self.assertRaises(implementation_safety.ForgedVerdict):
            HardFailReport(results=failing)

    def test_an_empty_hand_assembled_report_is_refused(self) -> None:
        with self.assertRaises(implementation_safety.ForgedVerdict):
            HardFailReport(results=())

    def test_a_wrong_token_is_refused(self) -> None:
        with self.assertRaises(implementation_safety.ForgedVerdict):
            HardFailReport(results=PASSING, _token=object())

    def test_a_hand_assembled_observation_is_refused(self) -> None:
        with self.assertRaises(implementation_safety.ForgedVerdict):
            PerimeterObservation(verdicts=CLEAN_VERDICT, gate=GATE_PRE_PR_OPEN)

    def test_the_registry_is_still_able_to_produce_a_report(self) -> None:
        """The guard must refuse forgeries without refusing the producer —
        a check that made the real path raise would be worse than the hole."""
        report = run_hard_fail_checks(HardFailContext(), gate=GATE_PRE_PR_OPEN)
        self.assertTrue(report.results)
        self.assertIsInstance(report.passed, bool)

    def test_observe_perimeter_is_still_able_to_produce_an_observation(self) -> None:
        observation = observe_perimeter(HardFailContext(), gate=GATE_PRE_PR_OPEN)
        self.assertTrue(observation.verdicts)

    def test_the_refusal_is_not_a_generic_error(self) -> None:
        """A forged verdict must be distinguishable from a programming slip:
        `ForgedVerdict` is the signal an audit greps for."""
        self.assertTrue(issubclass(implementation_safety.ForgedVerdict, Exception))
        with self.assertRaises(implementation_safety.ForgedVerdict) as ctx:
            HardFailReport(results=PASSING)
        self.assertIn("run_hard_fail_checks", str(ctx.exception))


class NoScoreBypassesAHardGateTests(unittest.TestCase):
    """The math-kernel document's rule, pinned at the source.

    It was already TRUE — `HardFailReport.passed` is a plain conjunction — and
    unpinned, which is the state in which properties quietly stop being true.
    """

    def _property_tree(self, owner: type, name: str) -> ast.AST:
        source = inspect.getsource(getattr(owner, name).fget)
        return ast.parse(textwrap.dedent(source))

    def test_the_gate_verdict_carries_no_numeric_term(self) -> None:
        tree = self._property_tree(HardFailReport, "passed")
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                self.assertIsInstance(
                    node.value, bool,
                    "a hard gate's verdict must not compare against a number",
                )
            self.assertNotIsInstance(
                node, ast.Compare,
                "a hard gate's verdict must be a conjunction, not a threshold",
            )

    def test_the_failure_set_is_selected_by_the_boolean_not_by_a_rank(self) -> None:
        tree = self._property_tree(HardFailReport, "failures")
        for node in ast.walk(tree):
            self.assertNotIsInstance(
                node, ast.Compare,
                "which checks count as failures must not depend on an ordering",
            )

    def test_a_hard_fail_result_verdict_is_a_boolean_not_a_score(self) -> None:
        self.assertEqual(
            HardFailResult.__dataclass_fields__["passed"].type, "bool",
        )
        self.assertIsInstance(
            HardFailResult(name="x", passed=True, reason="ok").passed, bool
        )

    def test_no_registered_check_decides_on_a_confidence_or_score(self) -> None:
        """A check that graded itself would let a number buy a pass. Pinned by
        AST rather than by review, because the wrong version of this is one
        `if score > threshold` away and reads as reasonable."""
        banned = {"confidence", "score", "probability", "likelihood", "weight"}
        offenders: list[str] = []
        for entry in implementation_safety.HARD_FAIL_CHECKS:
            try:
                source = inspect.getsource(entry.check)
            except (OSError, TypeError):
                continue
            tree = ast.parse(textwrap.dedent(source))
            for node in ast.walk(tree):
                name = None
                if isinstance(node, ast.Name):
                    name = node.id
                elif isinstance(node, ast.Attribute):
                    name = node.attr
                if name and any(token in name.lower() for token in banned):
                    offenders.append(f"{entry.name}:{name}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
