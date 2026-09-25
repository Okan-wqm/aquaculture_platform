"""ARIA-HIGH-189 — pr_tracking rewrites findings.jsonl through its owner.

``_mark_findings_for_revalidation`` read and rewrote ``findings.jsonl`` with
the raw ``ledger.rewrite_jsonl``. The surface is declared, so the rewrite is
refused with ``raw_jsonl_declared_surface_rewrite_rejected`` the first time the
ledger holds a row — which it never had live, because no adapter was ACTIVE.
``feedback_store`` owns the ledger and fixed the same shape under ORPHAN-670.

These tests pin:
1. A declared, hash-chained findings ledger round-trips through
   ``_mark_findings_for_revalidation``: the matched open finding becomes
   ``needs_revalidation``, the other rows are untouched, the chain verifies.
2. ``pr_tracking`` imports no raw rewrite primitive at all.
"""
from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

from aria_kernel import feedback_store, pr_tracking
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


class MarkFindingsForRevalidationTests(unittest.TestCase):
    def test_declared_findings_ledger_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            path = feedback_store.findings_path(root)
            path.parent.mkdir(parents=True, exist_ok=True)
            feedback_store.append_jsonl(path, {"run_id": "run-1", "finding_id": "f-1", "status": "open"})
            feedback_store.append_jsonl(path, {"run_id": "run-1", "finding_id": "f-2", "status": "open"})

            pr_tracking._mark_findings_for_revalidation(root, [{"run_id": "run-1", "finding_id": "f-1"}])

            rows = load_declared_jsonl(path, expected_surface="findings")
            by_id = {row["finding_id"]: row for row in rows}
            self.assertEqual(by_id["f-1"]["status"], "needs_revalidation")
            self.assertEqual(by_id["f-2"]["status"], "open")


class NoRawRewriteImportTests(unittest.TestCase):
    def test_pr_tracking_imports_no_raw_rewrite(self) -> None:
        source = Path(pr_tracking.__file__).read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ImportFrom) and node.module == "ledger":
                names = {alias.name for alias in node.names}
                self.assertNotIn("rewrite_jsonl", names, "findings.jsonl is rewritten through feedback_store")


if __name__ == "__main__":
    unittest.main()
