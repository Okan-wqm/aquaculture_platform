"""Plan 026R §A.3 — AST invariant banning bare silent-skip on JSONL reads.

2 tests:

* The bare ``except json.JSONDecodeError: continue`` pattern is
  forbidden inside ``aria-kernel/aria_kernel/*.py`` for modules NOT
  on the strict-reader / config-parser allowlist.
* Strict-reader modules (``governance_reader``, ``strict_jsonl_reader``,
  ``runs_reader`` — when added) are EXEMPT because they own the
  catch-and-re-raise primitive.

The invariant is structural: any new consumer that re-introduces the
pattern fails at build time.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path


ARIA_KERNEL = Path(__file__).resolve().parent.parent / "aria_kernel"


# Modules that legitimately use the silent-skip pattern (NOT ledger
# reads — config / subprocess output parsing). Each entry has a brief
# rationale recorded inline so future maintainers can audit removals.
_SILENT_SKIP_ALLOWLIST: dict[str, str] = {
    # Owns the strict-skip-or-raise primitive (the catch IS the surface).
    "governance_reader.py": "owns read_governance_rows strict/tolerant",
    "strict_jsonl_reader.py": "owns read_strict_jsonl strict/tolerant",
    # Tool output / subprocess parsers (not JSONL ledgers).
    "tool_runner.py": "parses tool subprocess stdout; failure → 'output_not_json'",
    "ci.py": "parses gh CLI subprocess output for branch-protection lookup",
    # Single-row JSON config readers (not JSONL ledgers).
    "workspace.py": "parses ARIA_ACTOR env var + feedback_index single-row JSON",
    # NOTE: runtime_profile.py REMOVED from allowlist after the §A.3
    # forward-fix migrated list_profile_history (a multi-row JSONL ledger
    # reader, missed in the original §A.3 sweep because the prior file-
    # level allowlist rationale only matched the single-row state-file
    # parser at lines 215-222). The single-row parser uses
    # `as exc: return FROZEN_PROFILE` typed-fallback (not bare
    # `continue`), so the AST predicate does not flag it.
    # Lower-level primitives that wrap json.loads for their own consumers.
    "ledger.py": "verify_jsonl owns the strict raise itself",
    "handoff_ledger.py": "uses read_governance_rows; remaining catch is reserved for handoff-specific parse",
    "feedback.py": "uses an `as exc:` block followed by a typed re-raise — caught for structured re-raise",
    "trailer_scan.py": "caught with `as exc:` and re-raised as PR-trailer error",
    # NOTE: report_ingestion.py REMOVED from allowlist after the §A.5
    # strict-mode migration. Strict mode routes through
    # ``read_strict_jsonl`` (no inline except); tolerant mode keeps a
    # 3-statement body (``malformed.append`` + ``emit_ledger_corruption_
    # diagnostic`` + ``continue``) which does NOT match the AST silent-
    # skip predicate that only flags bare-``continue`` bodies.
}


def _module_source(name: str) -> str:
    return (ARIA_KERNEL / name).read_text(encoding="utf-8")


def _module_ast(name: str) -> ast.Module:
    return ast.parse(_module_source(name))


def _is_jsondecodeerror_handler(handler: ast.ExceptHandler) -> bool:
    """True if handler matches `except json.JSONDecodeError[ as X]:`.

    Both ``except json.JSONDecodeError:`` and a tuple-clause containing
    JSONDecodeError count. ``except ValueError`` does NOT count.
    """
    expr = handler.type
    if expr is None:
        return False
    if isinstance(expr, ast.Attribute) and expr.attr == "JSONDecodeError":
        return True
    if isinstance(expr, ast.Name) and expr.id == "JSONDecodeError":
        return True
    if isinstance(expr, ast.Tuple):
        for elt in expr.elts:
            if isinstance(elt, ast.Attribute) and elt.attr == "JSONDecodeError":
                return True
            if isinstance(elt, ast.Name) and elt.id == "JSONDecodeError":
                return True
    return False


def _body_is_bare_continue(body: list[ast.stmt]) -> bool:
    """True if the except handler body is exactly a single ``continue``
    statement (the silent-skip pattern). A body that re-raises, sets a
    sentinel, calls a logger, or emits a diagnostic is NOT a silent-skip."""
    if len(body) != 1:
        return False
    return isinstance(body[0], ast.Continue)


def _is_inside_splitlines_loop(parents: dict[int, ast.AST], node: ast.AST) -> bool:
    """True if ``node`` is lexically inside a `for <var> in <X>.splitlines()`
    or `for <var> in <X>.read_text(...).splitlines()` loop.

    This is the JSONL-row-iteration signature. Per-file JSON document
    stores (``for path in dir.glob("*.json"): json.loads(path.read_text())``)
    do NOT match this pattern — those silent-skips are a different
    operational class (drop-corrupt-file, not drop-row-from-chain) and
    are governed by their own per-store invariants, not this one.
    """
    cursor: ast.AST = node
    while id(cursor) in parents:
        parent = parents[id(cursor)]
        if isinstance(parent, ast.For):
            iter_node = parent.iter
            # Look for `.splitlines(...)` anywhere in the iter expression.
            for sub in ast.walk(iter_node):
                if isinstance(sub, ast.Call):
                    f = sub.func
                    if isinstance(f, ast.Attribute) and f.attr == "splitlines":
                        return True
        cursor = parent
    return False


def _parent_map(module: ast.Module) -> dict[int, ast.AST]:
    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(module):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
    return parents


class JsonlSilentSkipInvariantTests(unittest.TestCase):
    def test_no_module_outside_allowlist_has_bare_silent_skip(self) -> None:
        offenders: list[str] = []
        for module_path in ARIA_KERNEL.glob("*.py"):
            if module_path.name == "__init__.py":
                continue
            if module_path.name in _SILENT_SKIP_ALLOWLIST:
                continue
            try:
                module = ast.parse(module_path.read_text(encoding="utf-8"))
            except SyntaxError as exc:
                offenders.append(f"{module_path.name}: parse error: {exc}")
                continue
            parents = _parent_map(module)
            for node in ast.walk(module):
                if not isinstance(node, ast.ExceptHandler):
                    continue
                if not _is_jsondecodeerror_handler(node):
                    continue
                if not _body_is_bare_continue(node.body):
                    continue
                # Only flag when the handler is inside a JSONL-row
                # iteration loop (`for line in X.splitlines():`). Per-
                # file JSON document stores have a different operational
                # tradeoff and are governed by their own invariants.
                if not _is_inside_splitlines_loop(parents, node):
                    continue
                offenders.append(
                    f"{module_path.name}:{node.lineno} — bare "
                    f"`except json.JSONDecodeError: continue` on a JSONL "
                    f"read; route through strict_jsonl_reader / "
                    f"governance_reader / runs_reader / load_jsonl_verified."
                )
        self.assertEqual(
            offenders,
            [],
            "Silent-skip violations:\n  " + "\n  ".join(offenders),
        )

    def test_allowlist_entries_have_rationale_strings(self) -> None:
        for module_name, rationale in _SILENT_SKIP_ALLOWLIST.items():
            self.assertTrue(
                rationale.strip(),
                f"{module_name} has empty allowlist rationale",
            )
            self.assertTrue(
                (ARIA_KERNEL / module_name).exists(),
                f"{module_name} allowlisted but file does not exist — "
                "stale allowlist entry",
            )


if __name__ == "__main__":
    unittest.main()
