"""Which of ARIA's own controls are actually connected to anything.

This module exists because one defect keeps recurring in this repository
under different names, and every instance was found by a human noticing
rather than by a gate firing:

    ORPHAN-CRITICAL-498  a perimeter with no production caller
    ORPHAN-HIGH-569      a project graph whose discovery list the repo outgrew
    ORPHAN-MEDIUM-571    a repository map nothing refreshed and nothing read
    ORPHAN-MEDIUM-572    a request vocabulary nothing consults

They are one defect: **a control that is correct, tested, exported — and
called by nobody.** A green suite says nothing about it, because the tests
call it directly; that is precisely how it stays green while governing
nothing.

`tests/invariants/invariant-reachability.spec.ts` already proved the cure for
TypeScript invariant specs: enumerate what should run, require a declared
waiver for anything that does not, and make the waiver's expiry load-bearing
against the clock. That spec learned the hard way that validating the SHAPE
of an expiry date instead of the date lets 25 waivers pass their deadline
together in silence. This module applies the same discipline to the kernel's
own control surface, deliberately reusing the proven mechanism rather than
inventing a second one.

WHAT COUNTS AS A CONTROL. A public, module-level callable in ``aria_kernel``
whose name begins with a control verb — ``validate_``, ``enforce_``,
``assert_``, ``require_``, ``verify_``, ``guard_``, ``refuse_``, ``check_``.
This is a naming convention the kernel already follows consistently, which is
what makes it a usable definition rather than an arbitrary one: it selects 85
functions today, and it selects them because their authors named them as
guarantees.

WHAT COUNTS AS REACHABLE, and why the bar is set here. A control is reachable
if any production module (not a test) mentions its name anywhere other than
its own ``def`` line and its own module's ``__all__`` block. That is
deliberately generous: a bare name in a registry tuple counts, a string in a
dispatch table counts, an import counts. Being generous means a control wired
by indirection is not falsely accused — and a gate that cries wolf is a gate
that gets waived into uselessness. Exporting is NOT using, which is why
``__all__`` is excluded: ORPHAN-MEDIUM-572 was in ``__all__`` and governed
nothing.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

CONTROL_VERBS = (
    "validate_",
    "enforce_",
    "assert_",
    "require_",
    "verify_",
    "guard_",
    "refuse_",
    "check_",
)

# Directories whose Python is not production: the tests that call a control
# directly are exactly what cannot count as evidence that anything else does.
_NON_PRODUCTION_PARTS = ("tests", "node_modules", ".git", "__pycache__", "build", "dist")


def kernel_root(repo_root: str | Path) -> Path:
    return Path(repo_root) / "aria-kernel" / "aria_kernel"


def declared_controls(repo_root: str | Path) -> dict[str, dict[str, Any]]:
    """Every public control-verb callable in the kernel, by name."""
    root = kernel_root(repo_root)
    controls: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        module = path.relative_to(root).as_posix()
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if node.name.startswith("_") or not node.name.startswith(CONTROL_VERBS):
                continue
            controls[node.name] = {"module": module, "lineno": node.lineno}
    return controls


def _all_block(path: Path) -> tuple[int, int]:
    """Line span of a module's ``__all__``, or (0, 0)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return (0, 0)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            getattr(target, "id", "") == "__all__" for target in node.targets
        ):
            return (node.lineno, node.end_lineno or node.lineno)
    return (0, 0)


def _import_lines(source: str) -> set[int]:
    """Every line occupied by an import statement.

    An import is NOT a use, and the distinction is load-bearing rather than
    pedantic: this gate's own mutation check — replace the one call to
    ``verify_no_secret_in_envelope`` with ``pass`` and leave the import —
    passed until imports stopped counting. A control that is imported and
    never invoked is exactly the defect being hunted, so counting the import
    would have let the gate certify it.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    spans: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            spans.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    return spans


def _production_sources(repo_root: str | Path) -> dict[Path, tuple[list[str], set[int]]]:
    sources: dict[Path, tuple[list[str], set[int]]] = {}
    for path in Path(repo_root).rglob("*.py"):
        if any(part in _NON_PRODUCTION_PARTS for part in path.parts):
            continue
        if path.name.startswith("test_") or path.name.endswith("_test.py"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        sources[path] = (text.splitlines(), _import_lines(text))
    return sources


def first_production_reference(
    name: str,
    control: dict[str, Any],
    *,
    repo_root: str | Path,
    sources: dict[Path, tuple[list[str], set[int]]] | None = None,
) -> dict[str, Any] | None:
    """Where production first USES this control, or None if nowhere.

    Uses, not mentions: the definition, the module's ``__all__``, any import
    statement, and prose are all excluded, because none of them causes the
    control to run.
    """
    root = kernel_root(repo_root)
    owner = root / control["module"]
    all_lo, all_hi = _all_block(owner)
    pattern = re.compile(rf"\b{re.escape(name)}\b")
    for path, (lines, import_lines) in (sources or _production_sources(repo_root)).items():
        is_owner = path.resolve() == owner.resolve()
        for lineno, line in enumerate(lines, 1):
            if not pattern.search(line):
                continue
            if lineno in import_lines:
                continue
            if is_owner and (lineno == control["lineno"] or all_lo <= lineno <= all_hi):
                continue
            stripped = line.lstrip()
            # Prose mentions are not wiring. A docstring naming a sibling
            # check is how `verify_no_secret_in_envelope` looked reachable.
            if stripped.startswith(("#", '"""', "'''", "*")) or "``" in line:
                continue
            return {
                "path": Path(path).relative_to(Path(repo_root)).as_posix(),
                "lineno": lineno,
                "line": stripped[:120],
            }
    return None


def unreachable_controls(repo_root: str | Path) -> dict[str, dict[str, Any]]:
    """Controls nothing in production refers to — the dormant surface."""
    sources = _production_sources(repo_root)
    controls = declared_controls(repo_root)
    return {
        name: control
        for name, control in controls.items()
        if first_production_reference(name, control, repo_root=repo_root, sources=sources)
        is None
    }


__all__ = [
    "CONTROL_VERBS",
    "declared_controls",
    "first_production_reference",
    "kernel_root",
    "unreachable_controls",
]
