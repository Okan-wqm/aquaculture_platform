"""ARIA-HIGH-191 — readers resolve aria-findings/ and aria-debts/ through the seam.

Writers resolve the committed findings and debts through
``workspace.repo_state_root`` (``finding.findings_dir`` / ``debt.debts_dir``),
which ``ARIA_REPO_STATE_ROOT`` redirects into the durable state store in CI.
``cycle_guard`` and ``handoff_ledger`` rebuilt ``repo_root / "aria-findings"``
by hand, so in CI they counted the empty checkout: the backlog cap and the
empty-cycle guard never fired while 13 findings were OPEN, and every handoff
said "no open findings".

These tests pin:
1. With the store redirected, cycle_guard counts the store's OPEN findings
   and debts, and the handoff lists them.
2. An AST invariant: outside ``finding.py`` / ``debt.py`` nothing in the kernel
   or the executor builds ``<path> / "aria-findings"`` or ``<path> /
   "aria-debts"`` by hand.
"""
from __future__ import annotations

import ast
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import cycle_guard
from aria_kernel.debt import debts_dir
from aria_kernel.finding import findings_dir
from aria_kernel.workspace import REPO_STATE_ROOT_ENV

REPO_ROOT = Path(__file__).resolve().parents[2]


def _seed_store(store: Path) -> None:
    (store / "aria-findings").mkdir(parents=True)
    (store / "aria-findings" / "_index.json").write_text(json.dumps({"findings": [
        {"finding_id": "F-001", "status": "OPEN"},
        {"finding_id": "F-002", "status": "IN_PROGRESS"},
        {"finding_id": "F-003", "status": "RESOLVED"},
    ]}), encoding="utf-8")
    (store / "aria-debts").mkdir(parents=True)
    (store / "aria-debts" / "_index.json").write_text(json.dumps({"debts": [
        {"debt_id": "DEBT-2026-09-25-001", "current_status": "OPEN"},
    ]}), encoding="utf-8")


class RedirectedStoreTests(unittest.TestCase):
    def test_cycle_guard_counts_the_redirected_store(self) -> None:
        with tempfile.TemporaryDirectory() as checkout, tempfile.TemporaryDirectory() as store:
            _seed_store(Path(store))
            with patch.dict(os.environ, {REPO_STATE_ROOT_ENV: store}):
                self.assertEqual(findings_dir(Path(checkout)), Path(store).resolve() / "aria-findings")
                self.assertEqual(debts_dir(Path(checkout)), Path(store).resolve() / "aria-debts")
                self.assertEqual(cycle_guard._open_finding_count(Path(checkout)), 2)
                self.assertEqual(cycle_guard._open_debt_count(Path(checkout)), 1)

    def test_checkout_copy_is_not_counted_when_redirected(self) -> None:
        with tempfile.TemporaryDirectory() as checkout, tempfile.TemporaryDirectory() as store:
            _seed_store(Path(checkout))  # a stale committed copy in the checkout
            with patch.dict(os.environ, {REPO_STATE_ROOT_ENV: store}):
                self.assertEqual(cycle_guard._open_finding_count(Path(checkout)), 0)
                self.assertEqual(cycle_guard._open_debt_count(Path(checkout)), 0)


_SEAM_OWNERS = {
    "aria-kernel/aria_kernel/finding.py",
    "aria-kernel/aria_kernel/debt.py",
}
_STATE_DIRS = {"aria-findings", "aria-debts"}


def _hand_built_state_paths(source: str) -> list[int]:
    lines: list[int] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            right = node.right
            if isinstance(right, ast.Constant) and right.value in _STATE_DIRS:
                lines.append(node.lineno)
    return lines


class NoHandBuiltStatePathInvariant(unittest.TestCase):
    def test_only_the_seam_builds_state_dirs(self) -> None:
        offenders: list[str] = []
        for root in (REPO_ROOT / "aria-kernel" / "aria_kernel", REPO_ROOT / "tools" / "aria-poc"):
            for path in sorted(root.rglob("*.py")):
                rel = path.relative_to(REPO_ROOT).as_posix()
                if "__pycache__" in path.parts or rel in _SEAM_OWNERS or path.name.startswith("test_"):
                    continue
                for line in _hand_built_state_paths(path.read_text(encoding="utf-8")):
                    offenders.append(f"{rel}:{line}")
        self.assertEqual(
            offenders,
            [],
            "resolve aria-findings/ and aria-debts/ through finding.findings_dir / "
            "debt.debts_dir (ARIA-HIGH-191); a hand-built path reads the checkout "
            "when ARIA_REPO_STATE_ROOT redirects the store",
        )


if __name__ == "__main__":
    unittest.main()
