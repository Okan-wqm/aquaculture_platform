"""ARIA-HIGH-390 — "this ARIA PR merged" has one writer, and nothing reaches either fact around it.

The runtime closes both facts at the source: the plan event's writer is
``plan_convergence._record_implementation_merged`` (private, imported by
``merge_record`` alone) and ``auto_merge.record_pr_lifecycle`` refuses the
owned lifecycle events without ``auto_merge._MERGED_ROW_OWNER``. This pin
fails the build on every other road the review of #1910 (F4) named: an
import or alias of either private name, a ``record_pr_lifecycle`` call with a
``**`` splat or a non-literal event, an ``implementation_merged`` event type
handed to any writer, and a direct append to the ``pr_lifecycle`` surface.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria")
_OWNER = "aria-kernel/aria_kernel/merge_record.py"
_PRIVATE = {
    "_record_implementation_merged": {"aria-kernel/aria_kernel/plan_convergence.py", _OWNER},
    "_MERGED_ROW_OWNER": {"aria-kernel/aria_kernel/auto_merge.py", _OWNER},
}
_APPENDERS = {"append_jsonl", "append_declared_jsonl", "append_declared_jsonl_rows", "_append_jsonl_unlocked"}


def _sources() -> list[tuple[str, ast.AST]]:
    out = []
    for root in _SCANNED:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            relative = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" not in relative:
                out.append((relative, ast.parse(path.read_text(encoding="utf-8"))))
    return out


def _name(func: ast.expr) -> str:
    return func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")


def private_name_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    offenders = []
    for relative, tree in sources:
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Name):
                names = [node.id]
            elif isinstance(node, ast.Attribute):
                names = [node.attr]
            elif isinstance(node, ast.ImportFrom):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.FunctionDef):
                names = [node.name]
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                names = [node.value]  # getattr(module, "_record_implementation_merged")
            for name in names:
                if name in _PRIVATE and relative not in _PRIVATE[name]:
                    offenders.append(f"{relative}:{getattr(node, 'lineno', '?')}:{name}")
    return offenders


def lifecycle_write_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    offenders = []
    for relative, tree in sources:
        if relative in (_OWNER, "aria-kernel/aria_kernel/auto_merge.py"):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _name(node.func)
            if name == "record_pr_lifecycle":
                event = next((k.value for k in node.keywords if k.arg == "event"), None)
                if any(k.arg is None for k in node.keywords) or (
                        event is not None and not (isinstance(event, ast.Constant)
                                                   and event.value not in ("merged", "closed_unmerged",
                                                                           "merge_unproven",
                                                                           "merge_lineage_unverified"))):
                    offenders.append(f"{relative}:{node.lineno}:record_pr_lifecycle")
            if name in _APPENDERS and any(
                    k.arg == "expected_surface" and isinstance(k.value, ast.Constant)
                    and k.value.value == "pr_lifecycle" for k in node.keywords):
                offenders.append(f"{relative}:{node.lineno}:direct_pr_lifecycle_append")
    return offenders


def merged_event_type_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    return [
        f"{relative}:{node.lineno}"
        for relative, tree in sources if relative != "aria-kernel/aria_kernel/plan_convergence.py"
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and any(
            k.arg == "event_type" and isinstance(k.value, ast.Constant) and k.value.value == "implementation_merged"
            for k in node.keywords)
    ]


class MergedHasOneWriter(unittest.TestCase):
    def test_no_module_but_the_owner_names_a_private_writer(self) -> None:
        self.assertEqual(private_name_offenders(_sources()), [])

    def test_lifecycle_rows_are_written_only_with_a_literal_event_or_by_the_owner(self) -> None:
        self.assertEqual(lifecycle_write_offenders(_sources()), [])

    def test_no_writer_is_handed_the_implementation_merged_event_type(self) -> None:
        self.assertEqual(merged_event_type_offenders(_sources()), [])

    def test_every_bypass_the_review_named_is_caught(self) -> None:
        forged = ast.parse(
            "from aria_kernel.plan_convergence import _record_implementation_merged as rim\n"
            "import aria_kernel.plan_convergence as pc\n"
            "getattr(pc, '_record_implementation_merged')\n"
            "from aria_kernel.auto_merge import _MERGED_ROW_OWNER\n"
            "record_pr_lifecycle(pr, **kwargs)\n"
            "record_pr_lifecycle(pr, event=chosen)\n"
            "record_pr_lifecycle(pr, event='merged')\n"
            "pc._mutate(plan_id=p, event_type='implementation_merged', payload={})\n"
            "append_declared_jsonl(path, row, expected_surface='pr_lifecycle')\n"
        )
        sources = [("aria-kernel/aria_kernel/forged.py", forged)]
        self.assertEqual(len(private_name_offenders(sources)), 3)
        self.assertEqual(len(lifecycle_write_offenders(sources)), 4)
        self.assertEqual(len(merged_event_type_offenders(sources)), 1)


if __name__ == "__main__":
    unittest.main()
