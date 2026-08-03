"""RC-2 — an observation cannot trip a safety breaker, proven structurally.

The property this file defends is not "no caller currently does that". It is
"there is no call path from observe-mode to the breaker producer", which is a
statement about the call graph and therefore checkable without running anything.

WHY IT NEEDS DEFENDING. `open_pr_for_action` runs the GATE_PRE_PR_OPEN perimeter
before its `dry_run` branch so a preview cannot skip the gate. A dry run has no
changed_files, no base_sha and no diff, so checks needing those refuse on data
that cannot exist at that stage. `cycle.py`'s pr_lifecycle phase fed those
refusals to `record_failure(kind="validator_rejection")`. Three
`approved_for_apply` proposals in one cycle would trip a breaker that gates
`standard` — the nightly halting itself on its own observations. It never fired
only because `_run_extended_phases` was unreachable (ORPHAN-CRITICAL-498). RC-1
has since deleted that function and made `pr_lifecycle` a row in
`cycle.CYCLE_PHASES`, so the phase is on the live lane for any profile holding
`pr_open` authority — which is precisely why the edge had to be gone first.

WHY AST AND NOT GREP. `grep` is what reported ORPHAN-CRITICAL-428 as wired. A
substring search cannot tell a call from a mention in a comment, and the fix for
this very finding added long comments naming `record_failure` — so a grep-based
version of this test would fail on its own documentation. Every check below
walks parsed syntax.
"""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

_KERNEL_ROOT = Path(__file__).resolve().parents[3]
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

_PKG = _KERNEL_ROOT / "aria_kernel"

BREAKER_PRODUCER = "record_failure"
OBSERVE_ENTRY = "observe_perimeter"

# The one module allowed to call the producer, and the kind it may record.
# Declared rather than discovered: the point is that this set is small and any
# growth is a review event, not a silent addition.
SANCTIONED_PRODUCER_CALLERS: frozenset[str] = frozenset({
    "planner_dispatch_hook.py",
    "circuit_breaker.py",  # its own definition + internal helpers
    "cli.py",              # operator-driven `breaker record`
    # PLAN Wave 1 §2.5 — `freeze_autonomous_writes` records
    # `state_integrity_gap` when a cycle finds a tree it cannot show descends
    # from the last published state. Added here as the review this gate exists
    # to force, and the reasoning is the same one that made it a breaker edge
    # rather than a new mechanism: `_cycle_preflight` already consults the
    # breaker for every profile holding action authority, so feeding it is how
    # a state-integrity gap stops the system by the route everything else
    # already uses. A separate freeze flag would be a second answer to "how
    # does ARIA stop".
    #
    # The narrow shape that keeps this safe: the producer is reachable only
    # from a POSITIVE finding. `freeze_autonomous_writes` raises on any status
    # other than GAP_CRITICAL, so `unknown` — the state this repository is
    # actually in until a reference exists — cannot trip a breaker. That is
    # the same distinction RC-2 drew when it stopped a dry-run observation
    # from counting as a rejected implementation.
    "memory_gap.py",
})


def _module_tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _called_names(node: ast.AST) -> set[str]:
    """Every function name CALLED anywhere under ``node``.

    Attribute calls contribute their attribute (``x.record_failure()`` ->
    ``record_failure``) so a call reached through a module object is not missed.
    """
    names: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        func = child.func
        if isinstance(func, ast.Name):
            names.add(func.id)
        elif isinstance(func, ast.Attribute):
            names.add(func.attr)
    return names


def _function_defs(tree: ast.Module) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


class ObserveModeHasNoBreakerEdge(unittest.TestCase):
    def test_the_observe_entry_point_does_not_call_the_producer(self) -> None:
        """Direct edge: observe_perimeter itself must not record a failure."""
        tree = _module_tree(_PKG / "implementation_safety.py")
        defs = _function_defs(tree)
        self.assertIn(OBSERVE_ENTRY, defs, msg="observe_perimeter is gone")
        self.assertNotIn(BREAKER_PRODUCER, _called_names(defs[OBSERVE_ENTRY]))

    def test_the_module_hosting_observe_mode_never_calls_the_producer(self) -> None:
        """Transitive edge, one hop out: nothing in implementation_safety records.

        implementation_safety owns the checks and the two result types. If it
        gained a breaker edge anywhere, every check would be one refactor away
        from feeding the breaker regardless of mode.
        """
        tree = _module_tree(_PKG / "implementation_safety.py")
        self.assertNotIn(BREAKER_PRODUCER, _called_names(tree))

    def test_the_pr_lifecycle_phase_no_longer_records_a_failure(self) -> None:
        """The edge RC-2 removed, asserted absent at its old location.

        Scoped to the function rather than the module: cycle.py may legitimately
        record failures elsewhere, and a module-wide ban would be a stronger
        claim than the finding supports.
        """
        tree = _module_tree(_PKG / "cycle.py")
        defs = _function_defs(tree)
        self.assertIn("_run_pr_lifecycle_phase", defs)
        self.assertNotIn(
            BREAKER_PRODUCER,
            _called_names(defs["_run_pr_lifecycle_phase"]),
            msg=(
                "the pr_lifecycle phase records a breaker failure again — a dry-run "
                "observation must not be counted as a rejected implementation"
            ),
        )

    def test_pr_manager_observes_on_dry_run_and_authorises_otherwise(self) -> None:
        """Both modes are present and neither replaced the other.

        A file that called only observe_perimeter would have a perimeter that
        reports and never blocks; one that called only run_hard_fail_checks would
        be back to authorising previews.
        """
        tree = _module_tree(_PKG / "pr_manager.py")
        defs = _function_defs(tree)
        called = _called_names(defs["open_pr_for_action"])
        self.assertIn(OBSERVE_ENTRY, called)
        self.assertIn("run_hard_fail_checks", called)
        self.assertNotIn(BREAKER_PRODUCER, called)

    def test_the_producer_is_called_from_a_declared_set_of_modules_only(self) -> None:
        """Where the breaker CAN be fed is a closed, reviewable set.

        Not a ban: the breaker needs a producer, and ORPHAN-CRITICAL-420 exists
        because it had none. This asserts the producers are the declared ones, so
        adding an edge is a deliberate act rather than a side effect.
        """
        unexpected: dict[str, int] = {}
        for path in sorted(_PKG.rglob("*.py")):
            if path.name in SANCTIONED_PRODUCER_CALLERS:
                continue
            calls = sum(
                1
                for node in ast.walk(_module_tree(path))
                if isinstance(node, ast.Call)
                and (
                    (isinstance(node.func, ast.Name) and node.func.id == BREAKER_PRODUCER)
                    or (
                        isinstance(node.func, ast.Attribute)
                        and node.func.attr == BREAKER_PRODUCER
                    )
                )
            )
            if calls:
                unexpected[path.name] = calls
        self.assertEqual(unexpected, {})

    def test_the_observation_type_exposes_no_authorisation_surface(self) -> None:
        """The runtime half of the same guarantee.

        A PerimeterObservation with `passed`/`failures`/`raise_if_blocked` could
        be handed to breaker code that reads a HardFailReport and would work by
        accident. Absence of those attributes is what makes the misuse fail at
        the first attribute rather than silently record a failure.
        """
        from aria_kernel.implementation_safety import HardFailReport, PerimeterObservation

        for attribute in ("passed", "failures", "raise_if_blocked"):
            with self.subTest(attribute=attribute):
                self.assertFalse(hasattr(PerimeterObservation, attribute))
                # The authorising type must keep them, or the split is backwards.
                self.assertTrue(hasattr(HardFailReport, attribute))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
