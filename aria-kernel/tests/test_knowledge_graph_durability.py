"""M11/E12-b — the knowledge-graph ledgers join the declared surface system.

Five files (conventions, anti-patterns, pressure-source-effectiveness,
duel-ratings, embeddings) accumulated ARIA's learning through a raw
``open("a")`` writer, invisible to `iter_surfaces()` — so the aria/state
publish never carried them and every night's knowledge evaporated at job
teardown: the Thompson bandit restarted from zero nightly, and no
convention could survive long enough to be promoted. These pin the
migration: declared surfaces, dual-chain rows, mixed-format tolerance,
and a fail-closed roster for new files.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.knowledge_graph import (
    KnowledgeGraphSchemaError,
    _append_row,
    record_pressure_source_outcome,
    verify_chain_or_quarantine,
)
from aria_kernel.state_manifest import surface_for_path, surface_for_relative_path
from aria_kernel.tool_registry import ensure_tools_dir

_KG_FILES = (
    "conventions.jsonl",
    "anti-patterns.jsonl",
    "pressure-source-effectiveness.jsonl",
    "duel-ratings.jsonl",
    "embeddings.jsonl",
)


class DeclaredSurfaceTests(unittest.TestCase):
    def test_all_five_kg_files_are_declared(self) -> None:
        for name in _KG_FILES:
            surface = surface_for_relative_path(f"knowledge-graph/{name}")
            self.assertIsNotNone(surface, name)
            # Publishable knowledge, never action authority.
            self.assertFalse(surface.write_driving, name)
            self.assertEqual(surface.root_kind, "tools", name)

    def test_identity_bound_tools_root_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            path = root / "knowledge-graph" / "conventions.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            match = surface_for_path(path)
        self.assertIsNotNone(match)
        self.assertEqual(match[0].name, "kg_conventions")


class DualChainRowTests(unittest.TestCase):
    def test_appended_row_carries_both_chains(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            ensure_tools_dir(workspace / "aria-tools")
            record_pressure_source_outcome(
                workspace_root=workspace, source_type="git_diff", minted=1,
            )
            path = (
                workspace / "aria-tools" / "knowledge-graph"
                / "pressure-source-effectiveness.jsonl"
            )
            row = json.loads(path.read_text().strip().splitlines()[-1])
        # The kg's own chain survives the migration…
        self.assertIn("prev_row_hash", row)
        # …and the ledger envelope arrives on top.
        self.assertIn("ledger_hash", row)

    def test_mixed_format_chain_still_verifies(self) -> None:
        """Rows appended BEFORE the migration have no ledger envelope; an
        append-only ledger does not rewrite its history. The kg chain
        verifier must span both formats."""
        import hashlib

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            ensure_tools_dir(workspace / "aria-tools")
            path = (
                workspace / "aria-tools" / "knowledge-graph"
                / "pressure-source-effectiveness.jsonl"
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            # Hand-write a PRE-migration row (prev chain only, genesis).
            legacy = {
                "source_type": "finding", "cycles_minted": 2,
                "cycles_converged": 1, "cycles_merged": 0,
                "cycles_rejected": 0, "avg_cost_usd": None,
                "observed_at": "2026-08-01T00:00:00+00:00",
            }
            from aria_kernel.knowledge_graph import GENESIS_PREV_HASH

            legacy["prev_row_hash"] = GENESIS_PREV_HASH
            path.write_text(json.dumps(legacy, sort_keys=True, separators=(",", ":")) + "\n")
            # New-format append continues the SAME prev chain.
            record_pressure_source_outcome(
                workspace_root=workspace, source_type="finding", minted=1,
            )
            ok, count = verify_chain_or_quarantine(path)
        self.assertTrue(ok)
        self.assertEqual(count, 2)

    def test_unrostered_kg_file_is_refused(self) -> None:
        """Fail-closed: a NEW knowledge-graph file nobody declared must
        refuse the append rather than silently re-open the durability
        hole this migration closed."""
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            root = ensure_tools_dir(workspace / "aria-tools")
            rogue = root / "knowledge-graph" / "brand-new-idea.jsonl"
            with self.assertRaisesRegex(
                KnowledgeGraphSchemaError, "no declared surface"
            ):
                _append_row(rogue, {"schema_version": 1, "x": 1})


if __name__ == "__main__":
    unittest.main()
