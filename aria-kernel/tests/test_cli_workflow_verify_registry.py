"""ORPHAN-HIGH-573 (verify_workflow_registry) — the whole-inventory
workflow contract verdict gets its always-sees-the-real-repo caller.

The 2026-09-09 waiver reason records the constraint: preflight's live
verify_workflow_contract only visits workflows that already have a
contract, so an ARIA workflow added with neither contract nor audited
exclusion is invisible; wiring into verify_workflow_preflight was
reverted because preflight legitimately runs against synthetic
workspaces. A CLI verb invoked from the real repo root (and a
.github/workflows/aria-kernel.yml lane step that runs it) is the entry
point that always sees the real repo.

These tests pin the verb end-to-end through the real cli_main entry
point — no mocks.
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]


def _run(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue()


class WorkflowVerifyRegistryVerbTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools_dir = Path(self._tmp.name) / "aria-tools"
        self.tools_dir.mkdir()

    def test_real_repo_root_is_valid_and_exits_zero(self) -> None:
        """The live tree verdict: every registered contract matches its
        YAML and every discovered workflow is covered. The waiver's
        2026-09-09 note recorded valid=True against the live tree, so
        the verb must exit 0 the day it is wired."""
        code, out = _run([
            "--tools-dir", str(self.tools_dir),
            "workflow", "verify-registry",
            "--workspace-root", str(REPO_ROOT),
        ])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertTrue(payload["valid"])
        self.assertGreater(payload["registered_count"], 0)

    def test_uncovered_workflow_exits_one(self) -> None:
        """A synthetic workspace carrying an aria-* workflow with neither
        a contract nor an audited exclusion must fail the inventory
        verdict — exactly the drift class preflight cannot see."""
        root = Path(self._tmp.name) / "synthetic"
        workflows = root / ".github" / "workflows"
        workflows.mkdir(parents=True)
        (workflows / "aria-fixture-uncovered.yml").write_text(
            "name: fixture-uncovered\n"
            "on: [push]\n"
            "jobs:\n"
            "  probe:\n"
            "    runs-on: ubuntu-22.04\n"
            "    steps:\n"
            "      - run: echo probe\n",
            encoding="utf-8",
        )
        code, out = _run([
            "--tools-dir", str(self.tools_dir),
            "workflow", "verify-registry",
            "--workspace-root", str(root),
        ])
        self.assertEqual(code, 1, out)
        payload = json.loads(out)
        self.assertFalse(payload["valid"])
        self.assertIn(
            "aria-fixture-uncovered", payload["uncovered_workflows"]
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
