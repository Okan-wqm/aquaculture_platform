"""ARIA-LOW-741 (package F3.1) — a change's line counts are read by ONE module: ``change_paths``.

WHY THIS EXISTS. ``git diff --numstat`` over a change is a measurement the delivery
stamps on every delivered change (the size of what ARIA shipped, per route). Left
unowned, the second reader appears the moment a module needs a size: the risk
classifier counts platform ``changedFiles`` (``risk_policy``), the gate truncates a
diff artifact by bytes (``verification_gate``), the merge lane names an HTTP 406
(``auto_merge``); none of them counts lines, and none may start to, because two
counters of one change disagree on rename handling (default rename detection prints
``old => new`` as one entry and quotes a tab in a path), binary files and mode-only
changes. ``change_paths.py`` owns the argv (``--raw --numstat -z --no-renames``) and
the parse of its output; everything else asks it.

THE PATTERN is ``test_digest_single_owner``: a static scan of the production trees
(``ownership_atlas.production_sources``: the kernel and the executor, tests
excluded), the owner exempt, and a forged module proving the scan sees the shape it
bans. A flag is "spelled" where a string CONSTANT is one of the diff-size flags
(``--numstat``, ``--shortstat``, ``--stat``, ``--stat=<w>``), alone in an argv list
or as a token of one command string. Docstrings and comments that merely mention a
flag spell no argv and stay legal.

WHAT BASE DOES TODAY. Nothing counts lines (``git grep numstat`` is empty), so the
repository scan is ``[]`` and green: this is the one guard in the package that is
green at base. Its discriminating assertions are the planted forgeries and the
owner's own spelling (red at base: ``change_paths.py`` does not yet spell the flag,
so a scan that bans it everywhere would be vacuous).
"""
from __future__ import annotations

import ast
import unittest
from collections.abc import Mapping
from pathlib import Path

from aria_kernel.ownership_atlas import production_sources

_REPO_ROOT = Path(__file__).resolve().parents[3]
_OWNER = "aria-kernel/aria_kernel/change_paths.py"
_FORGED = "aria-kernel/aria_kernel/forged_numstat.py"
_FLAGS = frozenset({"--numstat", "--shortstat", "--stat"})


def _is_diff_size_flag(token: str) -> bool:
    return token in _FLAGS or token.startswith("--stat=")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """The ids of the string constants that are a body's docstring (a bare expression statement)."""
    return {id(node.value) for node in ast.walk(tree)
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}


def numstat_readers(sources: Mapping[str, str]) -> list[str]:
    """``<path>:<line>`` of every diff-size flag spelled outside the owner."""
    found: list[str] = []
    for path, text in sorted(sources.items()):
        if path == _OWNER:
            continue
        tree = ast.parse(text, filename=path)
        docstrings = _docstring_nodes(tree)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
                    and any(_is_diff_size_flag(token) for token in node.value.split())):
                found.append(f"{path}:{node.lineno}")
    return found


class ChurnHasOneReader(unittest.TestCase):
    def test_no_production_module_but_the_owner_spells_a_diff_size_flag(self) -> None:
        self.assertEqual(
            numstat_readers(production_sources(_REPO_ROOT)), [],
            "a second reader of a change's line counts: ask change_paths.parse_change_z (ARIA-LOW-741)",
        )

    def test_the_scan_covers_the_kernel_and_the_executor_and_the_owner(self) -> None:
        sources = production_sources(_REPO_ROOT)
        for path in (_OWNER, "aria-kernel/aria_kernel/implementation_delivery.py", "tools/aria-poc/ci_executor.py"):
            with self.subTest(path=path):
                self.assertIn(path, sources)

    def test_the_owner_spells_the_flag_so_the_ban_is_not_vacuous(self) -> None:
        # RED AT BASE: change_paths.py has no churn spelling yet. A scan that bans the flag everywhere
        # except a module that never writes it proves nothing.
        owner = ast.parse(production_sources(_REPO_ROOT)[_OWNER])
        spelled = [node.value for node in ast.walk(owner) if isinstance(node, ast.Constant) and node.value == "--numstat"]
        self.assertTrue(spelled, "change_paths.py does not spell --numstat: the numstat owner does not exist (F3.1)")


class APlantedSecondReaderIsRed(unittest.TestCase):
    def test_every_shape_of_a_second_reader_is_reported(self) -> None:
        shapes = {
            "an argv list": 'argv = ["git", "diff", "--numstat"]\n',
            "the short form": 'argv = ["git", "diff", "--shortstat", base, head]\n',
            "the stat flag": 'argv = ["git", "diff", "--stat"]\n',
            "the stat flag with a width": 'argv = ["git", "diff", "--stat=200"]\n',
            "one command string": 'command = "git diff --numstat -z HEAD~1 HEAD"\n',
            "an f-string argv": 'argv = f"git diff --numstat {base}..{head}"\n',
        }
        for name, source in shapes.items():
            with self.subTest(shape=name):
                self.assertEqual(numstat_readers({_FORGED: source}), [f"{_FORGED}:1"])

    def test_the_owner_and_a_docstring_mention_are_not_offenders(self) -> None:
        owner_like = 'ARGV = ["diff", "--raw", "--numstat", "-z"]\n'
        self.assertEqual(numstat_readers({_OWNER: owner_like}), [])
        mention = 'def f():\n    """Reads the counts via ``git diff --numstat`` through change_paths."""\n    return 1\n'
        self.assertEqual(numstat_readers({_FORGED: mention}), [])
        similar = 'argv = ["git", "diff", "--status-only", "--statistics"]\n'
        self.assertEqual(numstat_readers({_FORGED: similar}), [])


if __name__ == "__main__":
    unittest.main()
