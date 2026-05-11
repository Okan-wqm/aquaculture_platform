"""Plan 026R §H.1 — AST invariant: source-marker substring assertions
forbidden as SOLE safety proof.

BANNED pattern: a test reads a ``*.py`` file under
``aria-kernel/aria_kernel/`` or ``tools/aria-poc/`` and uses
``self.assertIn(<string literal>, <variable bound to that read>)``
as the assertion. The pattern proves only that a substring is
present in source code — NOT that the kernel exhibits the
intended behavior.

This invariant detects new violations via AST traversal:

  1. For each `*.py` under ``aria-kernel/tests/``, parse the file.
  2. Find every `read_text(...)` call where the receiver is a
     ``Path(...)`` literal containing ``aria_kernel`` or
     ``aria-poc`` and the path ends in ``.py``.
  3. Capture the LHS variable bound to that read.
  4. Find every ``self.assertIn(<literal_str>, <Name>)`` callsite
     where the second argument's id matches a captured variable.
  5. Flag the test file unless it is on
     ``tests/source_marker_exception_list.json``.

Tier-3 ("make it detectable"): the pattern is detected at CI time,
the offender either rewrites the test behaviorally or adds itself
to the exception list with an operator-approved rationale + exit
deadline. Tier-1 (make it impossible) is not achievable here
without a custom AST-walking import hook; tier-3 with an exception
list is the architectural maximum.
"""
from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path
from typing import Iterable


TESTS_DIR = Path(__file__).resolve().parent
EXCEPTION_LIST_PATH = TESTS_DIR / "source_marker_exception_list.json"
TARGET_PATH_FRAGMENTS: tuple[str, ...] = ("aria_kernel", "aria-poc")


def _load_exception_list() -> set[str]:
    if not EXCEPTION_LIST_PATH.exists():
        return set()
    payload = json.loads(EXCEPTION_LIST_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return set()
    exceptions = payload.get("exceptions") or []
    if not isinstance(exceptions, list):
        return set()
    return {
        str(entry.get("test_file") or "")
        for entry in exceptions
        if isinstance(entry, dict) and entry.get("test_file")
    }


def _path_call_targets_kernel_source(node: ast.AST) -> bool:
    """True iff the AST node represents ``Path(<str_concat>)`` whose
    resolved literal contains a banned fragment and ends in ``.py``.
    """
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    is_path_call = (
        isinstance(func, ast.Name) and func.id == "Path"
    ) or (
        isinstance(func, ast.Attribute) and func.attr == "resolve"
    )
    if not is_path_call:
        return False
    return False  # full literal-path inference is delegated to the
    # walker below via stringified ast.dump fallback.


def _read_text_targets_kernel_source(call: ast.Call, src: str) -> bool:
    """Whether the ``.read_text(...)`` callsite reads a *.py file
    under aria_kernel or aria-poc.

    Heuristic: dump the receiver subtree to text, search for both
    ``aria_kernel`` (or ``aria-poc``) AND ``.py`` literals AND
    NO ``.jsonl`` / ``.json`` / ``.md`` extension. The AST walker
    can't always resolve f-strings + Path() concatenation; the
    string-shape check is the architectural compromise.
    """
    receiver = call.func
    if not isinstance(receiver, ast.Attribute):
        return False
    if receiver.attr != "read_text":
        return False
    subtree_src = ast.unparse(receiver.value)
    has_target = any(
        fragment in subtree_src for fragment in TARGET_PATH_FRAGMENTS
    )
    if not has_target:
        return False
    # Exclude JSONL / markdown / JSON / fixture reads.
    if any(
        ext in subtree_src
        for ext in (".jsonl", ".json", ".md", "fixture", "fixtures")
    ):
        return False
    if ".py" not in subtree_src:
        return False
    return True


def _collect_kernel_source_vars(tree: ast.Module) -> set[str]:
    """Return variable names assigned from `Path(...).read_text()`
    on kernel source files."""
    src_vars: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not isinstance(node.value, ast.Call):
            continue
        if not _read_text_targets_kernel_source(node.value, ""):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                src_vars.add(target.id)
    return src_vars


def _violations_for_module(
    path: Path,
) -> list[tuple[int, str]]:
    """Return (lineno, snippet) pairs where ``assertIn(<literal>, <var>)``
    targets a kernel-source variable."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    src_vars = _collect_kernel_source_vars(tree)
    if not src_vars:
        return []
    violations: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        if func.attr != "assertIn":
            continue
        if len(node.args) < 2:
            continue
        first, second = node.args[0], node.args[1]
        # second arg must reference a kernel-source variable.
        target_id: str | None = None
        if isinstance(second, ast.Name):
            target_id = second.id
        elif isinstance(second, ast.Attribute):
            # cycle_src.something — base name match.
            base = second
            while isinstance(base, ast.Attribute):
                base = base.value
            if isinstance(base, ast.Name):
                target_id = base.id
        if target_id is None or target_id not in src_vars:
            continue
        # first arg must be a string literal.
        if not isinstance(first, ast.Constant) or not isinstance(
            first.value, str,
        ):
            continue
        violations.append((node.lineno, ast.unparse(node)))
    return violations


class SourceMarkerInvariantTests(unittest.TestCase):
    """Plan 026R §H.1 — the architectural enforcement surface.

    Any test under ``aria-kernel/tests/`` that combines
    ``Path(...).read_text(...)`` of an ``aria_kernel/*.py`` file
    with ``self.assertIn(<literal>, <var>)`` as the assertion
    violates the §H.1 banned-pattern rule UNLESS it appears on
    the operator-approved exception list.
    """

    def test_no_new_source_marker_violations_outside_exception_list(
        self,
    ) -> None:
        exceptions = _load_exception_list()
        violations_by_file: dict[str, list[tuple[int, str]]] = {}
        for test_path in sorted(TESTS_DIR.glob("test_*.py")):
            # Skip this invariant test itself.
            if test_path.name == Path(__file__).name:
                continue
            rel = (
                "aria-kernel/tests/" + test_path.name
            ).replace("\\", "/")
            module_violations = _violations_for_module(test_path)
            if not module_violations:
                continue
            if rel in exceptions:
                continue
            violations_by_file[rel] = module_violations
        if violations_by_file:
            lines = ["Plan 026R §H.1 source-marker violations:"]
            for rel, items in violations_by_file.items():
                lines.append(f"  {rel}")
                for lineno, snippet in items:
                    snippet_short = snippet.replace("\n", " ")[:120]
                    lines.append(f"    line {lineno}: {snippet_short}")
            lines.append("")
            lines.append(
                "Resolve by EITHER (a) rewriting the test to assert "
                "behavior (governance row / ledger state / return "
                "shape) OR (b) replacing assertIn with ast.parse + "
                "node-shape assertion OR (c) adding the file to "
                "aria-kernel/tests/source_marker_exception_list.json "
                "with operator-approved rationale + exit deadline."
            )
            self.fail("\n".join(lines))

    def test_exception_list_schema_well_formed(self) -> None:
        self.assertTrue(EXCEPTION_LIST_PATH.exists())
        payload = json.loads(
            EXCEPTION_LIST_PATH.read_text(encoding="utf-8"),
        )
        self.assertIsInstance(payload, dict)
        self.assertIn("exceptions", payload)
        self.assertIsInstance(payload["exceptions"], list)
        for entry in payload["exceptions"]:
            self.assertIsInstance(entry, dict)
            self.assertIn("test_file", entry)
            self.assertIn("rationale", entry)
            self.assertIn("exit_deadline", entry)
            self.assertTrue(
                isinstance(entry["rationale"], str)
                and len(entry["rationale"]) >= 40,
                f"{entry.get('test_file')}: rationale too short",
            )


if __name__ == "__main__":
    unittest.main()
