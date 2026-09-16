"""ARIA-HIGH-064 — the job deadline belongs to one run, not to the process.

`ARIA_JOB_DEADLINE_EPOCH` is a cross-process contract: spawned children read it
(`tools/aria-poc/claude_runtime.py` clamps a spawn, `ci_executor_drain.py` stops
the drain, `agent_env.py` passes it through), so it must be an env var and not a
parameter. Pre-fix the autonomy CLI handler assigned it with no restore, so the
FIRST autonomy command in an interpreter pinned a deadline over everything after
it. In the kernel suite — 258 modules, one interpreter, ~2 hours — every later
cycle eventually saw a deadline in the past and raised PhaseDeadlineExceeded
before doing any work: 30 burn-in cycles dead in one second each with
`discovery_not_complete`, the drain returning nothing with
`stop=job_deadline_reached`, and `test_enterprise_cycle` failing a different
number of cases per run because the outcome depended on elapsed wall-clock.

These tests pin the scope, the narrowing, and — with an AST scan — the rule that
no other code may assign the variable.
"""

from __future__ import annotations

import ast
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel import autonomy_orchestrator  # noqa: E402
from aria_kernel.cycle import (  # noqa: E402
    JOB_DEADLINE_EPOCH_ENV,
    PhaseDeadlineExceeded,
    _remaining_wallclock_seconds,
    _run_phase_with_deadline,
    job_deadline_epoch,
)

KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"


class JobDeadlineScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prior = os.environ.pop(JOB_DEADLINE_EPOCH_ENV, None)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        if self._prior is None:
            os.environ.pop(JOB_DEADLINE_EPOCH_ENV, None)
        else:
            os.environ[JOB_DEADLINE_EPOCH_ENV] = self._prior

    def test_binding_is_released_when_the_run_ends(self) -> None:
        with job_deadline_epoch(1800) as cap:
            self.assertAlmostEqual(float(os.environ[JOB_DEADLINE_EPOCH_ENV]), cap, places=3)
        self.assertNotIn(JOB_DEADLINE_EPOCH_ENV, os.environ)

    def test_binding_is_released_even_when_the_run_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            with job_deadline_epoch(1800):
                raise RuntimeError("cycle exploded")
        self.assertNotIn(JOB_DEADLINE_EPOCH_ENV, os.environ)

    def test_an_inherited_deadline_is_restored_not_erased(self) -> None:
        outer = str(time.time() + 3600)
        os.environ[JOB_DEADLINE_EPOCH_ENV] = outer
        with job_deadline_epoch(60):
            self.assertLess(float(os.environ[JOB_DEADLINE_EPOCH_ENV]), float(outer))
        self.assertEqual(os.environ[JOB_DEADLINE_EPOCH_ENV], outer)

    def test_an_inherited_deadline_is_narrowed_never_widened(self) -> None:
        near = time.time() + 30
        os.environ[JOB_DEADLINE_EPOCH_ENV] = str(near)
        with job_deadline_epoch(86_400) as cap:
            self.assertAlmostEqual(cap, near, places=3)

    def test_zero_or_none_binds_nothing_and_leaves_an_inherited_cap_alone(self) -> None:
        outer = str(time.time() + 3600)
        os.environ[JOB_DEADLINE_EPOCH_ENV] = outer
        for seconds in (None, 0):
            with job_deadline_epoch(seconds):
                self.assertEqual(os.environ[JOB_DEADLINE_EPOCH_ENV], outer)
            self.assertEqual(os.environ[JOB_DEADLINE_EPOCH_ENV], outer)

    def test_a_malformed_inherited_epoch_is_ignored_like_the_readers_ignore_it(self) -> None:
        os.environ[JOB_DEADLINE_EPOCH_ENV] = "garbage"
        with job_deadline_epoch(60) as cap:
            self.assertGreater(cap, time.time())
        self.assertEqual(os.environ[JOB_DEADLINE_EPOCH_ENV], "garbage")

    def test_a_finished_run_does_not_poison_the_next_one(self) -> None:
        """The regression itself: run 1 must not leave run 2 out of runway."""
        with job_deadline_epoch(0.0001):
            pass
        time.sleep(0.05)
        self.assertEqual(_remaining_wallclock_seconds(), float("inf"))
        self.assertEqual(_run_phase_with_deadline(lambda ctx: "ran", None), "ran")

    def test_an_expired_binding_still_interrupts_inside_its_own_run(self) -> None:
        with job_deadline_epoch(-1):
            with self.assertRaises(PhaseDeadlineExceeded):
                _run_phase_with_deadline(lambda ctx: "should not run", None)

    def test_the_orchestrator_binds_and_releases_around_its_own_run(self) -> None:
        seen: dict[str, str | None] = {}

        def fake(**kwargs: object) -> dict[str, object]:
            seen["inside"] = os.environ.get(JOB_DEADLINE_EPOCH_ENV)
            return {"ok": True}

        wrapped = autonomy_orchestrator._bound_job_deadline(fake)
        with mock.patch.object(time, "time", wraps=time.time):
            wrapped(cycle_deadline_seconds=1800)
        self.assertIsNotNone(seen["inside"])
        self.assertNotIn(JOB_DEADLINE_EPOCH_ENV, os.environ)

    def test_the_orchestrator_is_actually_decorated(self) -> None:
        self.assertIsNot(
            autonomy_orchestrator.run_autonomy_orchestrator.__wrapped__,
            autonomy_orchestrator.run_autonomy_orchestrator,
            "run_autonomy_orchestrator must carry _bound_job_deadline",
        )


class NoUnscopedDeadlineWriteTests(unittest.TestCase):
    """The rule, enforced structurally: only a restoring owner may assign it.

    An AST scan rather than a grep, so a rename of the variable or an
    `os.environ.update({...})` spelling cannot slip past a substring match.

    The table is the contract: each cross-process environment variable the
    kernel exports names the ONE writer allowed to assign it — a context
    manager that restores it — or names nobody. The budget caps name nobody:
    the CLI and the orchestrator used to export MAX_BUDGET_USD_PER_RUN /
    MAX_BUDGET_USD_PER_CYCLE for a child dollar gate that ORPHAN-HIGH-472
    removed, so the export had no reader left and only the leak remained.
    """

    # (env var literal, module constant name) -> {(file, function)} allowed
    CONTRACT: dict[tuple[str, str | None], set[tuple[str, str]]] = {
        (JOB_DEADLINE_EPOCH_ENV, "JOB_DEADLINE_EPOCH_ENV"): {("cycle.py", "job_deadline_epoch")},
        ("MAX_BUDGET_USD_PER_RUN", None): set(),
        ("MAX_BUDGET_USD_PER_CYCLE", None): set(),
    }

    @staticmethod
    def _names(node: ast.AST, literal: str, constant: str | None) -> bool:
        """True for both spellings: the literal and the module constant.

        The first draft of this scan matched only ``ast.Constant`` and so missed
        `os.environ[JOB_DEADLINE_EPOCH_ENV] = ...` — the exact spelling the fix
        itself uses, and the one a future leak would most naturally copy. A
        detector that cannot see the idiom it is guarding is not a gate.
        """
        if isinstance(node, ast.Constant):
            return node.value == literal
        if constant is None:
            return False
        if isinstance(node, ast.Name):
            return node.id == constant
        if isinstance(node, ast.Attribute):
            return node.attr == constant
        return False

    def _assignments(
        self, literal: str, constant: str | None, root: Path = KERNEL,
    ) -> list[tuple[str, str]]:
        found: list[tuple[str, str]] = []
        for path in sorted(root.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            scopes: list[tuple[ast.AST, str]] = [(tree, "<module>")]
            while scopes:
                node, owner = scopes.pop()
                for child in ast.iter_child_nodes(node):
                    name = (
                        child.name
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                        else owner
                    )
                    scopes.append((child, name))
                    if isinstance(child, (ast.Assign, ast.AugAssign)):
                        targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                        for target in targets:
                            if (
                                isinstance(target, ast.Subscript)
                                and isinstance(target.value, ast.Attribute)
                                and target.value.attr == "environ"
                                and self._names(target.slice, literal, constant)
                            ):
                                found.append((path.name, name))
                    if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
                        if child.func.attr in {"update", "setdefault", "pop"} and isinstance(
                            child.func.value, ast.Attribute,
                        ) and child.func.value.attr == "environ":
                            source = ast.unparse(child)
                            if literal in source and child.func.attr != "pop":
                                found.append((path.name, name))
        return found

    def test_only_the_context_manager_writes_the_deadline(self) -> None:
        self.assertEqual(
            set(self._assignments(JOB_DEADLINE_EPOCH_ENV, "JOB_DEADLINE_EPOCH_ENV")),
            self.CONTRACT[(JOB_DEADLINE_EPOCH_ENV, "JOB_DEADLINE_EPOCH_ENV")],
            "ARIA_JOB_DEADLINE_EPOCH may only be written by cycle.job_deadline_epoch, "
            "which restores it; an unscoped write leaks the deadline into the rest "
            "of the process (ARIA-HIGH-064)",
        )

    def test_nothing_in_the_kernel_exports_the_budget_caps(self) -> None:
        for (literal, constant), allowed in self.CONTRACT.items():
            if literal == JOB_DEADLINE_EPOCH_ENV:
                continue
            with self.subTest(variable=literal):
                self.assertEqual(
                    set(self._assignments(literal, constant)),
                    allowed,
                    f"{literal} has no reader in any child process since "
                    "ORPHAN-HIGH-472; an os.environ write of it can only leak "
                    "across the interpreter (ARIA-HIGH-064)",
                )

    def test_the_scan_sees_the_idiom_it_guards(self) -> None:
        """A detector that cannot see a write is not a gate: prove it on a stub."""
        import tempfile

        stub = (
            "import os\n"
            "def leak():\n"
            "    os.environ['MAX_BUDGET_USD_PER_RUN'] = '1'\n"
            "    os.environ.update({'MAX_BUDGET_USD_PER_CYCLE': '2'})\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "leaky.py").write_text(stub, encoding="utf-8")
            self.assertEqual(
                set(self._assignments("MAX_BUDGET_USD_PER_RUN", None, Path(tmp))),
                {("leaky.py", "leak")},
            )
            self.assertEqual(
                set(self._assignments("MAX_BUDGET_USD_PER_CYCLE", None, Path(tmp))),
                {("leaky.py", "leak")},
            )


if __name__ == "__main__":
    unittest.main()
