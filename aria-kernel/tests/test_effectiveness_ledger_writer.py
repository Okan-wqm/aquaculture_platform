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
        self.tools = self.root / "aria-tools"
        self.tools.mkdir()

    def test_rows_accumulate_per_source(self) -> None:
        record_pressure_source_outcome(
            base_dir=self.tools, source_type="git_diff",
            minted=1, converged=1, merged=0,
        )
        row = record_pressure_source_outcome(
            base_dir=self.tools, source_type="git_diff",
            minted=1, converged=0, merged=1, rejected=1,
        )
        self.assertEqual(row["cycles_minted"], 2)
        self.assertEqual(row["cycles_converged"], 1)
        self.assertEqual(row["cycles_merged"], 1)
        self.assertEqual(row["cycles_rejected"], 1)

    def test_reader_folds_latest_per_source(self) -> None:
        for _ in range(3):
            record_pressure_source_outcome(
                base_dir=self.tools, source_type="git_diff", minted=1, converged=1,
            )
        record_pressure_source_outcome(
            base_dir=self.tools, source_type="finding", minted=1,
        )
        rows = rank_pressure_sources(base_dir=self.tools)
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
                base_dir=self.tools, source_type="git_diff",
                minted=1, converged=1, merged=1,
            )
        draws = _thompson_source_draws(tools, "2026-08-12T00:00:00Z")
        self.assertIn("git_diff", draws)
        self.assertGreater(draws["git_diff"], 0.0)

    def test_base_dir_binds_the_ledger_to_the_tools_root(self) -> None:
        """B4 root cause (2026-09-12) — state_manifest declares
        kg_pressure_source_effectiveness a TOOLS-ROOT surface, but this
        writer/reader pair resolved it under <workspace_root>/aria-tools
        only. The live lane binds ARIA_TOOLS_DIR=<store>/tools and passes
        the checkout as workspace root, so a row written there would have
        landed in the checkout (dies with the runner); origin/aria/state
        never carried the ledger. The pair now names the tools root and
        nothing else: there is no workspace parameter to fall back to, so
        the shadow path cannot be re-opened by a caller holding the wrong
        root."""
        import inspect
        from aria_kernel.knowledge_graph import effectiveness_ledger_path

        store_tools = self.root / "store" / "tools"
        checkout = self.root / "checkout"
        checkout.mkdir()
        record_pressure_source_outcome(base_dir=store_tools, source_type="finding", minted=1)
        self.assertTrue((store_tools / "knowledge-graph" / "pressure-source-effectiveness.jsonl").is_file())
        self.assertFalse((checkout / "aria-tools").exists())
        self.assertEqual(
            [row["source_type"] for row in rank_pressure_sources(base_dir=store_tools)], ["finding"],
        )
        for api in (effectiveness_ledger_path, record_pressure_source_outcome, rank_pressure_sources):
            parameters = inspect.signature(api).parameters
            self.assertNotIn("workspace_root", parameters, api.__name__)
            self.assertIs(parameters["base_dir"].default, inspect.Parameter.empty, api.__name__)
            self.assertIs(parameters["base_dir"].kind, inspect.Parameter.KEYWORD_ONLY, api.__name__)

    def test_chain_is_hash_linked(self) -> None:
        record_pressure_source_outcome(
            base_dir=self.tools, source_type="git_diff", minted=1,
        )
        record_pressure_source_outcome(
            base_dir=self.tools, source_type="git_diff", minted=1,
        )
        from aria_kernel.knowledge_graph import verify_chain_or_quarantine, effectiveness_ledger_path

        ok, count = verify_chain_or_quarantine(effectiveness_ledger_path(base_dir=self.tools))
        self.assertTrue(ok)
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
