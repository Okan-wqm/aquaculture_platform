"""M3/E8 — the pressure-source effectiveness ledger gets its first writer.

`rank_pressure_sources`, the mission scheduler's Thompson bandit and the
reflection source-effectiveness rollup all read
knowledge-graph/pressure-source-effectiveness.jsonl — and NOTHING wrote it,
so the bandit drew from the uninformative prior forever: exploration-aware
scheduling was pure decoration. These pin the writer-reader pair: cumulative
per-source counters, latest-per-source fold on read, and a real Beta draw
distribution once history exists.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.knowledge_graph import (
    rank_pressure_sources,
    record_pressure_source_outcome,
)


class EffectivenessWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "aria-tools").mkdir()

    def test_rows_accumulate_per_source(self) -> None:
        record_pressure_source_outcome(
            workspace_root=self.root, source_type="git_diff",
            minted=1, converged=1, merged=0,
        )
        row = record_pressure_source_outcome(
            workspace_root=self.root, source_type="git_diff",
            minted=1, converged=0, merged=1, rejected=1,
        )
        self.assertEqual(row["cycles_minted"], 2)
        self.assertEqual(row["cycles_converged"], 1)
        self.assertEqual(row["cycles_merged"], 1)
        self.assertEqual(row["cycles_rejected"], 1)

    def test_reader_folds_latest_per_source(self) -> None:
        for _ in range(3):
            record_pressure_source_outcome(
                workspace_root=self.root, source_type="git_diff", minted=1, converged=1,
            )
        record_pressure_source_outcome(
            workspace_root=self.root, source_type="finding", minted=1,
        )
        rows = rank_pressure_sources(workspace_root=self.root)
        # Two sources, ONE row each — cumulative snapshots never
        # double-count, and the effective source ranks first.
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["source_type"], "git_diff")
        self.assertEqual(rows[0]["cycles_minted"], 3)

    def test_bandit_finally_sees_history(self) -> None:
        """Deliberate-break: pre-M3 the ledger was always empty, so the
        scheduler's Thompson draw dict was {} on every night."""
        from aria_kernel.mission_scheduler import _thompson_source_draws
        from aria_kernel.tool_registry import ensure_tools_dir

        tools = ensure_tools_dir(self.root / "aria-tools")
        for _ in range(4):
            record_pressure_source_outcome(
                workspace_root=self.root, source_type="git_diff",
                minted=1, converged=1, merged=1,
            )
        draws = _thompson_source_draws(tools, "2026-08-12T00:00:00Z")
        self.assertIn("git_diff", draws)
        self.assertGreater(draws["git_diff"], 0.0)

    def test_chain_is_hash_linked(self) -> None:
        record_pressure_source_outcome(
            workspace_root=self.root, source_type="git_diff", minted=1,
        )
        record_pressure_source_outcome(
            workspace_root=self.root, source_type="git_diff", minted=1,
        )
        from aria_kernel.knowledge_graph import verify_chain_or_quarantine, _effectiveness_path

        ok, count = verify_chain_or_quarantine(_effectiveness_path(self.root))
        self.assertTrue(ok)
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
