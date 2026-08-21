"""The judgment supply chain finally has a driver the cycle actually runs.

`generate_judgment_sample`, `dispatch_judges_for_sample`,
`generate_ai_consensus`, `replay_judges_on_goldset` and
`refresh_fixture_suite` were all driven by exactly one caller —
`heartbeat_tick` — and `heartbeat.py` had ZERO importers anywhere in the
repository. No samples were minted, no judges fanned out, no consensus was
computed, no fixture suite refreshed, no replay scored: `judged_judges` read
zero for months and three separate defects were blamed before the dead
driver was found.

The heartbeat file is DELETED with this change; its organs live as cycle
phases. These tests pin the wiring, the order, the fault containment, and
the one repair the extraction surfaced: heartbeat passed `target_sha=None`
into the fan-out, which would have graded every judge's real evidence
`baseline_unavailable` — the defect that rejected the autonomy planner's
first surviving run, reproduced in the judge lane before it ever opened.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.tool_registry import GovernanceError


def _context(base: str):
    return cycle_mod.build_phase_context(
        cycle_id="cyc-judge",
        workspace_root=Path(base),
        base_dir=Path(base) / "aria-tools",
    )


class PhaseRegistrationTest(unittest.TestCase):
    def test_the_chain_exists_in_dependency_order(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]

        for name in ("fixture_refresh", "judgment_pipeline", "judge_calibration", "judge_replay"):
            self.assertIn(name, names)
        self.assertLess(names.index("fixture_refresh"), names.index("judgment_pipeline"))
        self.assertLess(names.index("judgment_pipeline"), names.index("judge_calibration"))
        self.assertLess(names.index("judge_calibration"), names.index("judge_replay"))
        self.assertLess(names.index("judge_replay"), names.index("goldset_proposal"))

    def test_all_three_are_actions_that_cannot_fail_the_cycle(self) -> None:
        for name in ("fixture_refresh", "judgment_pipeline", "judge_replay"):
            phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == name)
            self.assertEqual(phase.precondition, cycle_mod.WRITES_PERMITTED, name)
            self.assertEqual(phase.on_error, "record_and_continue", name)

    def test_the_dead_driver_is_gone(self) -> None:
        # Deleted, not kept as a parallel copy — a superseded driver that
        # lingers is the next zero-importer finding.
        self.assertFalse(
            (Path(cycle_mod.__file__).parent / "heartbeat.py").exists(),
            "heartbeat.py must be deleted; its organs are cycle phases now",
        )


class JudgmentPipelinePhaseTest(unittest.TestCase):
    def _run(self, *, sample_raises: bool = False):
        with TemporaryDirectory() as tmp:
            ctx = _context(tmp)
            calls: dict[str, object] = {}

            def fake_sample(**kw):
                if sample_raises:
                    raise GovernanceError("no findings to sample")
                calls["sample_kw"] = kw
                return {"sample_id": "S1", "items": [{"finding_id": "F1"}, {"finding_id": "F2"}]}

            def fake_fanout(**kw):
                calls["fanout_kw"] = kw
                return {"minted": ["j1", "j2", "j3", "j4"]}

            def fake_consensus(**kw):
                calls["consensus_kw"] = kw
                return {"consensus": [{"finding_id": "F1"}]}

            with patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
                 patch("aria_kernel.feedback_store.generate_judgment_sample", fake_sample), \
                 patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_fanout), \
                 patch("aria_kernel.feedback_store.generate_ai_consensus", fake_consensus), \
                 patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value="a" * 40):
                result = cycle_mod._phase_judgment_pipeline(ctx)
            return result, calls

    def test_the_chain_runs_and_counts(self) -> None:
        result, calls = self._run()

        self.assertEqual(result["sampled_findings"], 2)
        self.assertEqual(result["judge_requests_minted"], 4)
        self.assertEqual(result["consensus_rows"], 1)
        self.assertEqual(result["blocked"], [])

    def test_judges_are_anchored_to_the_workspace_head(self) -> None:
        # The repair the extraction surfaced: heartbeat passed None here.
        _, calls = self._run()

        self.assertEqual(calls["fanout_kw"]["target_sha"], "a" * 40)

    def test_a_blocked_tool_costs_that_tool_not_the_batch(self) -> None:
        result, _ = self._run(sample_raises=True)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["blocked"]), 1)
        self.assertEqual(result["blocked"][0]["step"], "sample_or_fanout")
        # Consensus still ran for the tool despite the sampling refusal.
        self.assertEqual(result["consensus_rows"], 1)


class JudgeReplayPhaseTest(unittest.TestCase):
    def test_replay_runs_per_tool_and_scores_recall(self) -> None:
        with TemporaryDirectory() as tmp:
            ctx = _context(tmp)
            with patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
                 patch("aria_kernel.judge_replay.replay_judges_on_goldset",
                       return_value={"status": "no_active_goldset", "replayed_items": 0}) as rep, \
                 patch("aria_kernel.judge_replay.compute_replay_recall",
                       return_value={"judged_judges": 0}) as rec, \
                 patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value="b" * 40):
                result = cycle_mod._phase_judge_replay(ctx)

            rep.assert_called_once()
            self.assertEqual(rep.call_args.kwargs["target_sha"], "b" * 40)
            rec.assert_called_once()
            self.assertEqual(result["tools"][0]["status"], "no_active_goldset")


class FixtureRefreshPhaseTest(unittest.TestCase):
    def test_only_tools_with_fixture_sets_are_refreshed(self) -> None:
        with TemporaryDirectory() as tmp:
            ctx = _context(tmp)
            tools = [
                {"tool_id": "with-fixtures", "fixture_set": "tools/x"},
                {"tool_id": "without-fixtures"},
            ]
            with patch.object(cycle_mod, "list_tools", return_value=tools), \
                 patch("aria_kernel.fixture_runner.refresh_fixture_suite",
                       return_value={"status": "ok"}) as refresh:
                result = cycle_mod._phase_fixture_refresh(ctx)

            refresh.assert_called_once()
            self.assertEqual(refresh.call_args.args[0], "with-fixtures")
            self.assertEqual(len(result["tools"]), 1)
            self.assertEqual(result["blocked_count"], 0)
            self.assertEqual(result["skipped_no_fixture_set"], ["without-fixtures"])

    def test_a_blocked_refresh_is_a_governance_event_not_a_silent_pass(self) -> None:
        # ORPHAN-MEDIUM-783 — six nights of blocked fixture refresh were
        # invisible in every daily report because record_and_continue was
        # the only listener. The refusal must reach the governance feed,
        # which the reflection report's gate activity counts by kind.
        with TemporaryDirectory() as tmp:
            ctx = _context(tmp)
            tools = [{"tool_id": "blocked-adapter", "fixture_set": "tools/x"}]
            with patch.object(cycle_mod, "list_tools", return_value=tools), \
                 patch("aria_kernel.fixture_runner.refresh_fixture_suite",
                       side_effect=GovernanceError("fixture_path_escape_outside_repo: boom")), \
                 patch.object(cycle_mod, "append_tools_governance") as governance:
                result = cycle_mod._phase_fixture_refresh(ctx)

            self.assertEqual(result["status"], "completed")  # cycle still survives
            self.assertEqual(result["blocked_count"], 1)
            governance.assert_called_once()
            kind = governance.call_args.args[1]
            details = governance.call_args.args[2]
            self.assertEqual(kind, "fixture_refresh_blocked")
            self.assertEqual(details["blocked"][0]["tool_id"], "blocked-adapter")

    def test_a_registry_gap_with_no_refreshable_tools_is_also_loud(self) -> None:
        # Tools without fixture_set can never satisfy readiness checks 3-5;
        # a registry where NOTHING is refreshable must not read as a quiet
        # success.
        with TemporaryDirectory() as tmp:
            ctx = _context(tmp)
            tools = [{"tool_id": "no-fixtures"}]
            with patch.object(cycle_mod, "list_tools", return_value=tools), \
                 patch.object(cycle_mod, "append_tools_governance") as governance:
                result = cycle_mod._phase_fixture_refresh(ctx)

            self.assertEqual(result["tools"], [])
            governance.assert_called_once()
            self.assertEqual(governance.call_args.args[2]["skipped_no_fixture_set"], ["no-fixtures"])


if __name__ == "__main__":
    unittest.main()
