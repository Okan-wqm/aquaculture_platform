"""SI-1 — a stage that converts nothing becomes a pressure, not a low draw.

The counters were already there; nothing acted on them. Measured
2026-08-19: 597 requests minted, ZERO plans ever CONVERGED, a wedge two
days old — and the only consumer of those numbers lowered a Thompson
sampling weight, so ARIA's own paralysis read as a scheduling
preference. A human found it by reading ledgers.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.funnel_health import (
    MIN_UPSTREAM_FOR_STALL,
    detect_funnel_stalls,
)
from aria_kernel.pressure import DRIFT_CLASS_BY_SOURCE, SOURCE_WEIGHTS, run_pressure


def _row(source: str, minted: int, converged: int, merged: int) -> dict:
    return {
        "source_type": source,
        "cycles_minted": minted,
        "cycles_converged": converged,
        "cycles_merged": merged,
    }


class TheStallIsNamed(unittest.TestCase):
    def test_the_measured_production_wedge_is_detected(self) -> None:
        # The real numbers from the night this was written.
        stalls = detect_funnel_stalls([_row("finding", 597, 0, 0)])
        stages = {s.stage for s in stalls}
        self.assertIn("convergence", stages)
        stall = next(s for s in stalls if s.stage == "convergence")
        self.assertEqual(stall.upstream, 597)
        self.assertIn("597 arrived", stall.summary)

    def test_a_small_sample_is_idle_not_stalled(self) -> None:
        # Below the volume floor "zero converged" says more about the
        # sample than the pipeline — a new source is not a defect.
        self.assertEqual(
            detect_funnel_stalls([_row("new-source", MIN_UPSTREAM_FOR_STALL - 1, 0, 0)]),
            [],
        )

    def test_a_flowing_funnel_is_silent(self) -> None:
        self.assertEqual(detect_funnel_stalls([_row("healthy", 40, 12, 5)]), [])

    def test_each_stage_is_judged_against_its_own_upstream(self) -> None:
        # Merge converts nothing, but only 3 plans ever converged — that is
        # a small sample at the merge stage, not a stalled one. Judging
        # merge against MINTED instead would fire a false alarm here.
        self.assertEqual(detect_funnel_stalls([_row("s", 500, 3, 0)]), [
            s for s in detect_funnel_stalls([_row("s", 500, 3, 0)])
            if s.stage == "convergence"
        ])
        stalls = detect_funnel_stalls([_row("s", 500, 3, 0)])
        self.assertEqual([s.stage for s in stalls], [])

    def test_the_merge_stage_can_stall_on_its_own(self) -> None:
        stalls = detect_funnel_stalls([_row("s", 500, 60, 0)])
        self.assertEqual([s.stage for s in stalls], ["merge"])

    def test_an_empty_ledger_is_not_a_stall(self) -> None:
        self.assertEqual(detect_funnel_stalls([]), [])


class TheSourceIsRegisteredEverywhere(unittest.TestCase):
    def test_the_pressure_source_is_in_both_closed_tables(self) -> None:
        # ORPHAN-733's lesson, paid once: a source registered in one table
        # and not the other kills the whole cycle at runtime.
        self.assertIn("pipeline_stalled", SOURCE_WEIGHTS)
        self.assertIn("pipeline_stalled", DRIFT_CLASS_BY_SOURCE)

    def test_a_stalled_pipeline_outranks_every_other_source(self) -> None:
        # Every other pressure describes work ARIA could do; this one says
        # the machinery that would do it is stuck.
        self.assertEqual(
            SOURCE_WEIGHTS["pipeline_stalled"], max(SOURCE_WEIGHTS.values())
        )


class TheReaderGuardIsNarrow(unittest.TestCase):
    """B1 (2026-09-12) — ``run_pressure`` wrapped ``rank_pressure_sources`` in
    ``except Exception`` and read every escape as "no stall". The same class
    as the orchestrator's memory-hook guard, where a signature-drift
    TypeError was laundered into a governance row for weeks. The guard is
    the reader's own declared fault set: a fault of the ledger is disclosed
    and the detector sees no rows; a programming error raises."""

    def setUp(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_dir

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.ledger = self.tools / "knowledge-graph" / "pressure-source-effectiveness.jsonl"

    def _governance(self, kind: str) -> list[dict]:
        from aria_kernel.ledger import load_jsonl

        path = self.tools / "governance.jsonl"
        rows = load_jsonl(path) if path.exists() else []
        return [row for row in rows if row.get("kind") == kind]

    def test_a_tampered_ledger_is_quarantined_and_the_run_continues(self) -> None:
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        self.ledger.write_text("{not json\n", encoding="utf-8")
        result = run_pressure(cycle_id="c-tamper", base_dir=self.tools)
        self.assertEqual([p for p in result["pressures"] if p["source"] == "pipeline_stalled"], [])
        self.assertFalse(self.ledger.exists(), "the reader quarantines the tampered file")
        self.assertEqual(len(list(self.ledger.parent.glob("pressure-source-effectiveness.jsonl.quarantined.*"))), 1)

    def test_a_reader_fault_is_a_governance_row_not_silence(self) -> None:
        from aria_kernel.knowledge_graph import KnowledgeGraphTamper

        with patch("aria_kernel.knowledge_graph.rank_pressure_sources",
                   side_effect=KnowledgeGraphTamper("chain mismatch mid-read")):
            result = run_pressure(cycle_id="c-fault", base_dir=self.tools)
        self.assertEqual([p for p in result["pressures"] if p["source"] == "pipeline_stalled"], [])
        rows = self._governance("pressure_source_effectiveness_unreadable")
        self.assertEqual(
            [(row["details"]["reader"], row["details"]["error_class"], row["details"]["cycle_id"]) for row in rows],
            [("run_pressure", "KnowledgeGraphTamper", "c-fault")],
        )

    def test_a_programming_error_in_the_reader_propagates(self) -> None:
        with patch("aria_kernel.knowledge_graph.rank_pressure_sources",
                   side_effect=TypeError("rank_pressure_sources() got an unexpected keyword argument")):
            with self.assertRaises(TypeError):
                run_pressure(cycle_id="c-drift", base_dir=self.tools)
        self.assertEqual(self._governance("pressure_source_effectiveness_unreadable"), [])

    def test_the_declared_fault_set_excludes_programming_errors(self) -> None:
        from aria_kernel.knowledge_graph import (
            KnowledgeGraphSchemaError, KnowledgeGraphTamper,
            effectiveness_reader_faults, effectiveness_writer_faults,
        )
        from aria_kernel.ledger import LedgerIntegrityError
        from aria_kernel.tool_registry import GovernanceError

        reader = effectiveness_reader_faults()
        writer = effectiveness_writer_faults()
        for programming_error in (TypeError, KeyError, ValueError, AttributeError, NameError, IndexError):
            self.assertFalse(issubclass(programming_error, reader), programming_error.__name__)
            self.assertFalse(issubclass(programming_error, writer), programming_error.__name__)
        for fault in (KnowledgeGraphTamper, KnowledgeGraphSchemaError, LedgerIntegrityError, OSError,
                      PermissionError, TimeoutError):
            self.assertTrue(issubclass(fault, reader), fault.__name__)
            self.assertTrue(issubclass(fault, writer), fault.__name__)
        self.assertTrue(issubclass(GovernanceError, writer))
        self.assertFalse(issubclass(GovernanceError, reader), "the reader never binds a tools root")


if __name__ == "__main__":
    unittest.main()
