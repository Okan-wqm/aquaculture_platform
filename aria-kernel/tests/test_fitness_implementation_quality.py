"""F1.2 — the nightly fitness report gains ``implementation_quality`` read from agent_eval.performance_kpis, and nothing else.

WHY THIS EXISTS. ARIA-MEDIUM-733: ``agent_eval.performance_kpis`` (the repeat-failure rate and the drafter and
implementer scorecards the recorded episodes support, and the KPIs they cannot, each with the missing evidence
named) is read only by the CLI and the doctor, so the report the promotion lanes and the operator read has no
implementation-quality block. PLAN-v2 §2 'Mekanizma karnesi': fitness gains ONLY ``implementation_quality``, and
its content is the owner's computation, not a restatement. ``mechanism_contribution`` stays owned by
``autonomy_evidence`` (test_scorecard_mechanisms; the one-owner scan is tests/invariants/test_atlas_one_owner.py),
so the report must not carry a second computation of it.

THE API THIS PINS: ``fitness.generate_fitness_report(...)`` returns a row whose ``implementation_quality`` is
``agent_eval.performance_kpis(base_dir=<tools root>)``, verbatim, and whose keys beyond today's are exactly that
one. At the branch base the key does not exist, so each test reports an assertion failure, not an import error.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import agent_eval, fitness
from aria_kernel.agent_eval import observe_agent_performance, performance_kpis
from aria_kernel.fitness import generate_fitness_report
from aria_kernel.tool_registry import ensure_tools_dir
from tests.test_agent_eval_real_mode import fixture_history, seed_plan_ledger, seed_self_revert

# The keys of a report row at the branch base (an empty store; the two chain fields are the ledger's).
_BASE_KEYS = frozenset({
    "blocked_by", "convention_lift", "cycle_id", "dimensions", "evidence", "evidence_score", "finding_debt",
    "ledger_hash", "overall_score", "previous_ledger_hash", "recommendation_ready", "recommended_next_action",
    "recorded_at", "role_fitness", "schema_version", "score_explanation", "trend", "trust_score",
})
# Numbers no real store produces, so a block carrying them was read from the owner the test installed.
_CANNED_KPIS: dict[str, Any] = {
    "schema_version": 1,
    "episodes": 7919,
    "live": {
        "repeat_failure_rate": {
            "drafter": {"failures": 0, "repeats": 0, "rate": None, "by_failure_mode": {}},
            "implementer": {"failures": 7907, "repeats": 4999, "rate": 0.632226, "by_failure_mode": {"canned": 7907}},
        },
        "drafter_scorecard": {},
        "implementer_scorecard": {"canned-implementer": {"episodes": 7919, "attributable": 7907, "succeeded": 12,
                                                         "outcomes": {"rejected": 7907}, "success_rate": 0.001518}},
    },
    "not_computable": {"canned_kpi": "no canned evidence"},
}


def _block(report: dict[str, Any]) -> dict[str, Any]:
    if "implementation_quality" not in report:
        raise AssertionError("F1.2: the fitness report has no implementation_quality block")
    return report["implementation_quality"]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="aria-f12-fitness-")
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        self.tools = ensure_tools_dir(Path(self._tmp) / "aria-tools")

    def with_episodes(self) -> None:
        seed_plan_ledger(self.tools, fixture_history())
        seed_self_revert(self.tools)
        self.assertGreater(observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")["appended"], 0)

    def report(self) -> dict[str, Any]:
        return generate_fitness_report(cycle_id="cyc-f12", base_dir=self.tools)


class TheReportCarriesImplementationQuality(_Store):
    def test_the_report_gains_implementation_quality_and_no_other_key(self) -> None:
        report = self.report()
        self.assertEqual(set(report) - _BASE_KEYS, {"implementation_quality"})
        self.assertLessEqual(_BASE_KEYS, set(report), "a key the report had is gone")

    def test_it_is_the_owners_computation_over_recorded_episodes(self) -> None:
        self.with_episodes()
        report = self.report()
        self.assertGreater(_block(report)["episodes"], 0)
        self.assertEqual(_block(report), performance_kpis(base_dir=self.tools))

    def test_a_store_with_no_episode_reports_the_ratio_unmeasured_not_zero(self) -> None:
        report = self.report()
        self.assertEqual(_block(report), performance_kpis(base_dir=self.tools))
        self.assertEqual(_block(report)["episodes"], 0)
        self.assertIsNone(_block(report)["live"]["repeat_failure_rate"]["implementer"]["rate"])

    def test_the_kpis_the_evidence_cannot_compute_stay_named_with_their_reason(self) -> None:
        not_computable = _block(self.report())["not_computable"]
        self.assertEqual(set(not_computable), set(agent_eval.NOT_COMPUTABLE_KPIS))
        self.assertTrue(all(reason for reason in not_computable.values()))

    def test_the_block_is_read_from_performance_kpis_not_computed_beside_it(self) -> None:
        spy = mock.MagicMock(return_value=_CANNED_KPIS)
        # Wherever a caller can hold the owner: agent_eval for a lookup at call time, fitness for a bound name.
        for module in (agent_eval, fitness):
            if hasattr(module, "performance_kpis"):
                patcher = mock.patch.object(module, "performance_kpis", spy)
                patcher.start()
                self.addCleanup(patcher.stop)
        report = self.report()
        spy.assert_called_once()
        self.assertEqual(spy.call_args.kwargs.get("base_dir"), self.tools)
        self.assertEqual(_block(report), _CANNED_KPIS)

    def test_the_report_row_stays_one_row_on_the_declared_ledger(self) -> None:
        self.with_episodes()
        self.report()
        rows = fitness.list_fitness_reports(base_dir=self.tools)
        self.assertEqual([row["cycle_id"] for row in rows], ["cyc-f12"])
        self.assertEqual(_block(rows[0]), performance_kpis(base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
