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



# ---------------------------------------------------------------------------
# ARIA-HIGH-004 — the learning funnel's join, folded in memory. The producers'
# end-to-end flow lives in test_promotion_funnel_e2e; these pin the join rules
# themselves: every stage advances only on the identities its producer
# stamped, bound to the target, and a legacy row is history, never proof.
# ---------------------------------------------------------------------------
_T = "a" * 40
_OTHER = "b" * 40
_TOOL = "tool-l"
_OBSERVERS = [
    {"judge_id": "aria-evidence-judge", "model": "claude-opus-5"},
    {"judge_id": "aria-adversarial-judge", "model": "claude-opus-5"},
    {"judge_id": "aria-consensus-arbiter", "model": "fable"},
]


def _learning_inputs(*, target: str | None = _T, fingerprints: int = 1, **overrides):
    from aria_kernel.funnel_health import LearningFunnelInputs
    from aria_kernel.readiness import readiness_verdict_hash

    fps = [f"finding:{index}" for index in range(fingerprints)]
    raw = [{"tool_id": _TOOL, "run_id": "run-1", "finding_fingerprint": fp, "status": "raw"} for fp in fps]
    requests = [
        {"request_id": f"AIR-{fp}-{role}", "role": role, "tool_id": _TOOL, "run_id": "run-1",
         "finding_fingerprint": fp, **({"target_sha": target} if target else {})}
        for fp in fps for role in ("evidence_judgment", "adversarial_judgment", "consensus_arbitration")
    ]
    feedback = [
        {"source_type": "ai_consensus", "verdict": "true_positive", "tool_id": _TOOL, "finding_fingerprint": fp,
         "judge_count": 3, "judges_voted": 3, "observers": _OBSERVERS,
         # WP-J ce6a53541 (ARIA-HIGH-686) — an anchor stands on code
         # evidence: a consensus row whose evidence union is empty is backed
         # by zero seats (feedback_store.consensus_distinct_seats), so the
         # complete chain's anchor cites the code it judged.
         "evidence_refs": [f"src/{fp.replace(':', '_')}.ts:10"],
         "request_ids": [f"AIR-{fp}-{role}" for role in ("evidence_judgment", "adversarial_judgment",
                                                          "consensus_arbitration")],
         "target_sha": target}
        for fp in fps
    ]
    promotions = [
        {"tool_id": _TOOL, "finding_fingerprint": fp, "finding_id": f"F-{fp}", "target_sha": target} for fp in fps
    ]
    fixture_row = {
        "row_type": "fixture_run_suite", "passed": True, "actual_status": "pass", "tool_version": "1.0.0",
        "fixture_set_hash": "sha256:corpus", "workspace_commit_sha": target or _OTHER, "execution_run_id": "exec-1",
    }
    judge_report = {
        "calibration_report_id": "jcal-1", "target_sha": target, "judgment_group_prefix": None,
        "judges": [{"judge_id": observer["judge_id"], "samples": 4} for observer in _OBSERVERS],
    }
    verdict = {"tool_id": _TOOL, "tool_version": "1.0.0", "active_ready": True,
               "fixture_status": {"current_tool_passed": True, "latest": {"execution_run_id": "exec-1"}}}
    verdict["verdict_hash"] = readiness_verdict_hash(verdict)
    adapter_row = {"report_id": "acal-1", "ledger_hash": "sha256:acal", "target_sha": target, "reports": [verdict]}
    tool = {
        "tool_id": _TOOL, "version": "1.0.0", "status": "ACTIVE",
        "last_transition": {"to": "ACTIVE", "active_evidence": {
            "calibration_report_ref": "acal-1", "calibration_report_hash": "sha256:acal",
            "readiness_verdict_hash": verdict["verdict_hash"], "fixture_run_refs": ["exec-1"],
            "tool_version": "1.0.0", "target_sha": target,
        }},
    }
    fields = {
        "raw_findings": tuple(raw), "requests": tuple(requests), "feedback": tuple(feedback),
        "promotions": tuple(promotions), "judge_calibrations": (judge_report,),
        "adapter_calibrations": (adapter_row,), "tools": {_TOOL: tool},
        "fixture_runs": {_TOOL: (fixture_row,)},
        "fixture_status": {_TOOL: {"current_fixture_set_hash": "sha256:corpus"}},
    }
    fields.update(overrides)
    return LearningFunnelInputs(**fields)


class TheLearningFunnelJoins(unittest.TestCase):
    def _fold(self, inputs, target: str = _T):
        from aria_kernel.funnel_health import fold_learning_funnel

        return fold_learning_funnel(inputs, target_sha=target)

    def test_a_complete_chain_reaches_every_stage(self) -> None:
        from aria_kernel.funnel_health import LEARNING_FUNNEL_STAGES

        health = self._fold(_learning_inputs())
        self.assertEqual(dict(health.counts), dict.fromkeys(LEARNING_FUNNEL_STAGES, 1))
        self.assertEqual(health.blockers, ())

    def test_legacy_rows_are_history_never_target_proof(self) -> None:
        # The display-only upcaster: rows that name no commit read as
        # target_sha=None, count in the history and prove nothing at a target.
        health = self._fold(_learning_inputs(target=None))
        self.assertEqual(health.counts["raw"], 1)
        self.assertEqual(health.counts["judge_request"], 0)
        self.assertEqual(health.historical_counts["adapter_active"], 1)

    def test_rows_of_another_commit_do_not_count_here(self) -> None:
        health = self._fold(_learning_inputs(target=_OTHER))
        self.assertEqual((health.counts["judge_request"], health.historical_counts["judge_request"]), (0, 1))

    def test_a_consensus_naming_another_findings_request_does_not_join(self) -> None:
        inputs = _learning_inputs(fingerprints=2)
        crossed = [dict(row) for row in inputs.feedback]
        crossed[1]["request_ids"] = crossed[0]["request_ids"]
        health = self._fold(_learning_inputs(fingerprints=2, feedback=tuple(crossed)))
        self.assertEqual((health.counts["judge_request"], health.counts["consensus"]), (2, 1))

    def test_an_active_tool_on_another_report_is_not_joined(self) -> None:
        inputs = _learning_inputs()
        tool = dict(inputs.tools[_TOOL])
        tool["last_transition"] = {
            **tool["last_transition"],
            "active_evidence": {**tool["last_transition"]["active_evidence"], "calibration_report_ref": "acal-other"},
        }
        health = self._fold(_learning_inputs(tools={_TOOL: tool}))
        self.assertEqual((health.counts["adapter_calibrated"], health.counts["adapter_active"]), (1, 0))

    def test_a_fixture_suite_of_a_changed_corpus_is_stale(self) -> None:
        health = self._fold(_learning_inputs(fixture_status={_TOOL: {"current_fixture_set_hash": "sha256:new"}}))
        self.assertEqual((health.counts["promoted"], health.counts["fixture_pass"]), (1, 0))

    def test_judges_scored_only_on_their_own_anchors_are_not_calibrated(self) -> None:
        inputs = _learning_inputs()
        report = {**inputs.judge_calibrations[0], "judges": [
            {"judge_id": observer["judge_id"], "samples": 0} for observer in _OBSERVERS
        ]}
        health = self._fold(_learning_inputs(judge_calibrations=(report,)))
        self.assertEqual((health.counts["fixture_pass"], health.counts["judge_calibrated"]), (1, 0))

    def test_ten_fed_and_none_through_is_a_stall_at_the_target(self) -> None:
        health = self._fold(_learning_inputs(fingerprints=10, requests=()))
        self.assertEqual(health.blockers, ("learning_funnel_stalled:raw->judge_request",))
        self.assertEqual(health.stalled_at, "judge_request")


if __name__ == "__main__":
    unittest.main()
