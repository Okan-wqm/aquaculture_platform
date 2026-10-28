"""ARIA-MEDIUM-746 / F3.3a — "which merges happened, and which are ARIA's" has one reader: ``merge_record``.

WHY THIS EXISTS. The F0.9 atlas (item 3) measured three owners of the merge
index and three rules for ARIA authorship: ``change_outcome._merge_index``
(the pr-lifecycle ``merged`` rows joined to a change), ``self_revert._aria_merged_prs``
(the merge lane's ``decision == "merged"`` rows on ``auto-merge-decisions.jsonl``)
and ``own_pr_ci.scan_merged_own_prs`` (a merged PR is ARIA's when its head
branch carries an ARIA prefix). They disagreed on PR #1906 — ARIA's change,
merged by a person: ``merge_record`` recorded it as ARIA's by lineage, the
self-revert producer skipped it as ``not_an_aria_merge``, and the post-merge CI
scan never looked at it because its branch had no ``aria/`` prefix.

THE RULE. ``merge_record`` is the one reader of the merged rows
(``fold_merged_rows``) and the one judge of authorship (``merged_row_is_arias``,
by the head's lineage). This pin is the digest.py-style single-owner test: it
fails the build on

* the retired owners' names (``_merge_index``, ``_aria_merged_prs``) anywhere
  but ``merge_record`` — a definition, an import, an attribute or a
  ``getattr`` string;
* a fold of the merged rows outside the owner — a comparison of a row's
  ``event`` with ``"merged"``;
* authorship by head branch — a function that lists merged PRs
  (``list_merged_own_prs``) and asks ``is_own_pr_head`` /
  ``OWN_PR_HEAD_PREFIXES`` about them;
* authorship by the merge lane's decision — a function that reads
  ``auto-merge-decisions.jsonl`` and compares a row's ``decision`` with
  ``"merged"``;
* a restatement of the lineage rule — ``ARIAS_LINEAGES`` named outside the owner.

"Was it reverted" is not pinned here: F3.3b gives it its one resolver.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria")
_OWNER = "aria-kernel/aria_kernel/merge_record.py"

_RETIRED_OWNERS = frozenset({"_merge_index", "_aria_merged_prs"})
_MERGED = "merged"
_HEAD_PREFIX_RULE = frozenset({"is_own_pr_head", "OWN_PR_HEAD_PREFIXES"})
_MERGED_PR_LISTING = "list_merged_own_prs"
_DECISIONS_LEDGER = frozenset({"auto_merge_decisions", "auto-merge-decisions.jsonl"})
_LINEAGE_RULE = "ARIAS_LINEAGES"


def _sources() -> list[tuple[str, ast.AST]]:
    out = []
    for root in _SCANNED:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            relative = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" not in relative and relative != _OWNER:
                out.append((relative, ast.parse(path.read_text(encoding="utf-8"), filename=relative)))
    return out


def _names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        return [node.attr]
    if isinstance(node, ast.ImportFrom):
        return [alias.name for alias in node.names] + [alias.asname for alias in node.names if alias.asname]
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    return []


def _reads_field(node: ast.AST, field: str) -> bool:
    """``row.get("<field>")`` or ``row["<field>"]``."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
        return bool(node.args) and isinstance(node.args[0], ast.Constant) and node.args[0].value == field
    if isinstance(node, ast.Subscript):
        return isinstance(node.slice, ast.Constant) and node.slice.value == field
    return False


def _names_merged(node: ast.AST) -> bool:
    """The literal ``"merged"``, alone or inside a literal tuple/list/set."""
    if isinstance(node, ast.Constant):
        return node.value == _MERGED
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return any(isinstance(item, ast.Constant) and item.value == _MERGED for item in node.elts)
    return False


def _compares_field_with_merged(node: ast.AST, field: str) -> bool:
    if not isinstance(node, ast.Compare):
        return False
    operands = [node.left, *node.comparators]
    return any(_reads_field(o, field) for o in operands) and any(_names_merged(o) for o in operands)


def _functions(tree: ast.AST) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]


def retired_owner_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    return [
        f"{relative}:{getattr(node, 'lineno', '?')}:{name}"
        for relative, tree in sources
        for node in ast.walk(tree)
        for name in _names(node) if name in _RETIRED_OWNERS
    ]


def merged_row_fold_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    return [
        f"{relative}:{node.lineno}:event_compared_with_merged"
        for relative, tree in sources
        for node in ast.walk(tree) if _compares_field_with_merged(node, "event")
    ]


def head_prefix_authorship_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    offenders = []
    for relative, tree in sources:
        for function in _functions(tree):
            nodes = list(ast.walk(function))
            lists_merges = any(isinstance(n, ast.Call) and _MERGED_PR_LISTING in _names(n.func) for n in nodes)
            if lists_merges and any(set(_names(n)) & _HEAD_PREFIX_RULE for n in nodes
                                    if isinstance(n, (ast.Name, ast.Attribute))):
                offenders.append(f"{relative}:{function.lineno}:{function.name}:merged_pr_attributed_by_head_branch")
    return offenders


def merge_decision_authorship_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    offenders = []
    for relative, tree in sources:
        for function in _functions(tree):
            nodes = list(ast.walk(function))
            reads_decisions = any(isinstance(n, ast.Constant) and n.value in _DECISIONS_LEDGER for n in nodes)
            if reads_decisions and any(_compares_field_with_merged(n, "decision") for n in nodes):
                offenders.append(f"{relative}:{function.lineno}:{function.name}:merge_attributed_by_lane_decision")
    return offenders


def lineage_rule_offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    return [
        f"{relative}:{getattr(node, 'lineno', '?')}:{_LINEAGE_RULE}"
        for relative, tree in sources
        for node in ast.walk(tree) if _LINEAGE_RULE in _names(node)
    ]


class MergeIndexHasOneOwner(unittest.TestCase):
    def test_the_retired_merge_index_owners_are_gone(self) -> None:
        offenders = retired_owner_offenders(_sources())
        self.assertEqual(offenders, [], "a second merge index outside merge_record (ARIA-MEDIUM-746):\n"
                         + "\n".join(offenders))

    def test_no_module_but_merge_record_folds_the_merged_rows(self) -> None:
        offenders = merged_row_fold_offenders(_sources())
        self.assertEqual(offenders, [], "merged rows selected outside merge_record.fold_merged_rows:\n"
                         + "\n".join(offenders))

    def test_no_merged_pr_is_attributed_to_aria_by_its_head_branch(self) -> None:
        offenders = head_prefix_authorship_offenders(_sources())
        self.assertEqual(offenders, [], "ARIA authorship of a merge decided by head branch, not merge_record:\n"
                         + "\n".join(offenders))

    def test_no_merge_is_attributed_to_aria_by_the_merge_lane_decision(self) -> None:
        offenders = merge_decision_authorship_offenders(_sources())
        self.assertEqual(offenders, [], "ARIA authorship of a merge decided by auto-merge-decisions, not "
                         "merge_record:\n" + "\n".join(offenders))

    def test_the_lineage_rule_is_stated_in_merge_record_alone(self) -> None:
        self.assertEqual(lineage_rule_offenders(_sources()), [])

    def test_the_owner_still_exports_the_reader_and_the_judge(self) -> None:
        # A pin that bans every other reader is vacuous if the owner lost them.
        from aria_kernel import merge_record

        self.assertIn("fold_merged_rows", merge_record.__all__)
        self.assertIn("merged_row_is_arias", merge_record.__all__)

    def test_every_shape_the_atlas_named_is_caught(self) -> None:
        forged = ast.parse(
            "from aria_kernel.change_outcome import _merge_index\n"
            "def _aria_merged_prs(base_dir):\n"
            "    path = root / 'auto-merge-decisions.jsonl'\n"
            "    return {r['pr_number'] for r in load_declared_jsonl(path, expected_surface='auto_merge_decisions')\n"
            "            if r.get('decision') == 'merged'}\n"
            "def scan(reader):\n"
            "    for pr in reader.list_merged_own_prs(limit=20):\n"
            "        if not is_own_pr_head(pr['headRefName']):\n"
            "            continue\n"
            "merges = [row for row in rows if row.get('event') == 'merged']\n"
            "late = [row for row in rows if row['event'] in ('merged', 'closed_unmerged')]\n"
            "getattr(change_outcome, '_merge_index')\n"
            "ours = row.get('head_lineage') in ARIAS_LINEAGES\n"
        )
        sources = [("aria-kernel/aria_kernel/forged.py", forged)]
        self.assertEqual(len(retired_owner_offenders(sources)), 3)
        self.assertEqual(len(merged_row_fold_offenders(sources)), 2)
        self.assertEqual(len(head_prefix_authorship_offenders(sources)), 1)
        self.assertEqual(len(merge_decision_authorship_offenders(sources)), 1)
        self.assertEqual(len(lineage_rule_offenders(sources)), 1)

    def test_reading_the_owner_is_not_an_offence(self) -> None:
        legal = ast.parse(
            "from aria_kernel.merge_record import fold_merged_rows, lifecycle_rows, merged_row_is_arias\n"
            "def scan(reader, base_dir):\n"
            "    ours = {row['pr_number'] for row in fold_merged_rows(lifecycle_rows(base_dir))\n"
            "            if merged_row_is_arias(row)}\n"
            "    for pr in reader.list_merged_own_prs(limit=20):\n"
            "        if pr['number'] not in ours:\n"
            "            continue\n"
            "settled = sum(1 for row in decisions if row.get('decision') == 'merged')\n"
        )
        sources = [("aria-kernel/aria_kernel/legal.py", legal)]
        self.assertEqual(retired_owner_offenders(sources) + merged_row_fold_offenders(sources)
                         + head_prefix_authorship_offenders(sources) + merge_decision_authorship_offenders(sources)
                         + lineage_rule_offenders(sources), [])


if __name__ == "__main__":
    unittest.main()
