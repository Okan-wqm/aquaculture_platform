"""ARIA-HIGH-285 — agent_eval measures real drafter and implementer performance.

THE DEFECT. ``run_agent_eval`` defaulted to ``mock_mode=True``
(``agent_eval.py:272``), the CLI's ``agent-eval run`` defaulted to it too
(``cli.py:1222``), and the only scheduled caller, ``aria-agent-eval.yml``,
never turned it off: on ``aria/state`` all 30 eval rows are mock rows whose
synthesized envelope copies the fixture's expected verdict and so always
passes. The autonomy cycle never ran an evaluation at all, no procedural
memory event had a writer, and no planner or implementer read one.

WHAT IS PINNED HERE:

  1. no mock switch remains in the kernel or its CLI: a mock envelope can
     only be a test's own fake ledger;
  2. real mode is the cycle's path: reflection observes the recorded plan
     outcomes, and with no plan ledger the observation is refused by name
     in governance, with no eval row written;
  3. every finished drafter / implementer episode becomes ONE
     ``performance_observed`` row on the declared procedural memory ledger,
     append-only; a later self-revert supersedes the merge it reverts with a
     new row;
  4. the implementer must-check reads them: a failure mode the implementer
     hit in three episodes becomes an obligation of its next envelope;
  5. the KPIs are computed from a fixture history, and the ones the recorded
     evidence cannot support are named with the reason.
"""
from __future__ import annotations

import dataclasses
import inspect
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from typing import Any

from aria_kernel import agent_eval
from aria_kernel.failure_attribution import InvocationLedgersSource
from aria_kernel.agent_eval import (
    LESSON_EPISODE_THRESHOLD,
    PERFORMANCE_SURFACE,
    list_performance_observations,
    observe_agent_performance,
    performance_kpis,
    recurring_failure_modes,
    run_agent_eval,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.state_manifest import surface_by_name
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.request_admission import admit_request

PROCEDURAL = Path("memory") / "procedural.jsonl"
MERGE_SHA = "a" * 40


def _tools() -> Path:
    tools = Path(tempfile.mkdtemp(prefix="aria-k10-")) / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _event(plan_id: str, event_type: str, at: str, **payload: Any) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "event_id": f"{plan_id}:{event_type}",
        "event_type": event_type,
        "plan_id": plan_id,
        "recorded_at": at,
        "idempotency_key": f"sha256:{plan_id}:{event_type}",
        "payload": payload,
    }


def _implemented(plan_id: str, day: int, terminal: dict[str, Any]) -> list[dict[str, Any]]:
    at = f"2026-09-{day:02d}T10:00:00+00:00"
    return [
        _event(plan_id, "plan_started", at),
        _event(plan_id, "plan_evaluated", at, terminal_state="CONVERGED", reason_codes=[]),
        _event(plan_id, "implementation_requested", at, implementer_agent="aria-implementer"),
        _event(plan_id, "implementation_started", at, implementer_agent="aria-implementer", claim_id="c"),
        {**terminal, "plan_id": plan_id, "event_id": f"{plan_id}:{terminal['event_type']}",
         "recorded_at": f"2026-09-{day:02d}T12:00:00+00:00"},
    ]


def fixture_history() -> list[dict[str, Any]]:
    """Six plans the way the plan ledger records them: two stopped by the lane
    (a stalled abandon, a dead challenger envelope), one revised by the
    primary planner and merged, three rejected on a red CI check."""
    rejected = _event("x", "implementation_rejected", "", rejection_class="ci_check_red", rejected_at="t")
    merged = _event("x", "implementation_merged", "", merge_sha=MERGE_SHA, merged_at="t", idempotency_key_hash="h")
    return [
        _event("plan-a", "plan_started", "2026-09-01T10:00:00+00:00"),
        _event("plan-a", "plan_abandoned", "2026-09-01T11:00:00+00:00",
               abandoned_from_state="DRAFT", reason="stalled: no plan event since 2026-09-01 (> 72h at adoption)"),
        _event("plan-b", "plan_started", "2026-09-02T10:00:00+00:00"),
        _event("plan-b", "plan_evaluated", "2026-09-02T11:00:00+00:00", terminal_state="HUMAN_REQUIRED",
               reason_codes=["convergence_envelope_dead:challenger_plan"]),
        _event("plan-c", "plan_started", "2026-09-03T09:00:00+00:00"),
        _event("plan-c", "revision_recorded", "2026-09-03T09:30:00+00:00", round=2,
               revised_by_agent="aria-primary-planner"),
        *_implemented("plan-c", 3, merged)[1:],
        *_implemented("plan-d", 4, rejected),
        *_implemented("plan-e", 5, rejected),
        *_implemented("plan-f", 6, rejected),
    ]


def seed_plan_ledger(tools: Path, events: list[dict[str, Any]]) -> None:
    for event in events:
        append_declared_jsonl(tools / "plans" / "events.jsonl", event, expected_surface="plan_convergence_events")


def seed_self_revert(tools: Path) -> None:
    append_declared_jsonl(
        tools / "enterprise" / "self-reverts.jsonl",
        {"schema_version": 1, "recorded_at": "2026-09-07T10:00:00+00:00", "cycle_id": "cyc-r",
         "key": f"revert:{MERGE_SHA}", "decision": "revert_opened", "terminal": True,
         "trigger": "post_merge_ci_red", "pr_number": 7, "merge_sha": MERGE_SHA, "head_ref": "aria-impl-1",
         "evidence": {}},
        expected_surface="enterprise_self_reverts",
    )


def _governance(tools: Path) -> list[dict[str, Any]]:
    path = tools / "governance.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class NoMockSwitchTests(unittest.TestCase):
    def test_the_kernel_has_no_mock_mode_and_no_envelope_synthesizer(self) -> None:
        self.assertNotIn("mock_mode", inspect.signature(run_agent_eval).parameters)
        self.assertFalse(hasattr(agent_eval, "_mock_response_envelope"))

    def test_the_cli_refuses_a_mock_flag(self) -> None:
        from aria_kernel.cli import build_parser

        accepted = []
        for flag in ("--mock-mode", "--no-mock-mode"):
            try:
                with redirect_stderr(io.StringIO()):
                    build_parser().parse_args(["agent-eval", "run", "--fixture-id", "F1",
                                               "--real-envelope-file", "e.json", flag])
                accepted.append(flag)
            except SystemExit:
                pass
        self.assertEqual(accepted, [])


class RealModeIsTheCyclePathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_missing_plan_ledger_is_refused_by_name_and_nothing_is_mocked(self) -> None:
        result = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")

        self.assertEqual(result["verdict"], "refused")
        self.assertEqual(result["reason"], "agent_eval_inputs_missing:plan_convergence_events")
        refusals = [row for row in _governance(self.tools) if row.get("kind") == "agent_eval_real_refused"]
        self.assertEqual(len(refusals), 1)
        self.assertEqual(refusals[0]["details"]["reason"], "agent_eval_inputs_missing:plan_convergence_events")
        self.assertFalse((self.tools / "agent-evals" / "runs.jsonl").exists())
        self.assertFalse((self.tools / PROCEDURAL).exists())

    def test_a_plan_ledger_that_fails_verification_is_refused_by_name(self) -> None:
        from aria_kernel.reflection import run_reflection

        seed_plan_ledger(self.tools, fixture_history())
        ledger = self.tools / "plans" / "events.jsonl"
        ledger.write_text(ledger.read_text(encoding="utf-8").replace("plan-a", "plan-z", 1), encoding="utf-8")

        reflection = run_reflection(cycle_id="cyc-4", base_dir=self.tools)

        self.assertEqual(reflection["agent_performance"]["reason"], "agent_eval_inputs_unverified")
        refusals = [row for row in _governance(self.tools) if row.get("kind") == "agent_eval_real_refused"]
        self.assertIn("ledger_hash_mismatch", refusals[-1]["details"]["detail"])
        self.assertFalse((self.tools / PROCEDURAL).exists())

    def test_cycle_reflection_takes_real_mode_when_its_inputs_exist(self) -> None:
        from aria_kernel.reflection import run_reflection

        seed_plan_ledger(self.tools, fixture_history())
        reflection = run_reflection(cycle_id="cyc-2", base_dir=self.tools)

        self.assertEqual(reflection["agent_performance"]["verdict"], "observed")
        self.assertEqual(reflection["agent_performance"]["appended"], 10)
        self.assertEqual(len(list_performance_observations(base_dir=self.tools)), 10)
        self.assertFalse((self.tools / "agent-evals" / "runs.jsonl").exists())

    def test_cycle_reflection_reports_the_refusal_without_inputs(self) -> None:
        from aria_kernel.reflection import run_reflection

        reflection = run_reflection(cycle_id="cyc-3", base_dir=self.tools)

        self.assertEqual(reflection["agent_performance"]["verdict"], "refused")
        kinds = [row.get("kind") for row in _governance(self.tools)]
        self.assertIn("agent_eval_real_refused", kinds)


class PerformanceObservedLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _tools()
        seed_plan_ledger(self.tools, fixture_history())

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_each_episode_is_recorded_once_on_the_procedural_memory_ledger(self) -> None:
        first = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")
        second = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-2")

        self.assertEqual((first["appended"], second["appended"]), (10, 0))
        rows = list_performance_observations(base_dir=self.tools)
        self.assertEqual({row["kind"] for row in rows}, {"performance_observed"})
        self.assertEqual({row["stream"] for row in rows}, {"procedural"})
        by_plan = {(row["role"], row["plan_id"]): row for row in rows}
        self.assertEqual(by_plan[("drafter", "plan-c")]["subject"], "aria-primary-planner")
        self.assertEqual(by_plan[("drafter", "plan-d")]["subject"], "kernel:plan_synthesizer")
        self.assertEqual(by_plan[("drafter", "plan-a")]["failure_mode"], "stalled")
        self.assertFalse(by_plan[("drafter", "plan-b")]["attributable"])
        self.assertEqual(by_plan[("implementer", "plan-d")]["failure_mode"], "ci_check_red")
        self.assertTrue(by_plan[("implementer", "plan-c")]["success"])

    def test_a_self_revert_supersedes_the_merge_append_only(self) -> None:
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")
        before = (self.tools / PROCEDURAL).read_bytes()
        seed_self_revert(self.tools)

        result = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-2")

        self.assertEqual(result["appended"], 1)
        after = (self.tools / PROCEDURAL).read_bytes()
        self.assertTrue(after.startswith(before), "a recorded episode was rewritten")
        current = {(row["role"], row["plan_id"]): row for row in list_performance_observations(base_dir=self.tools)}
        reverted = current[("implementer", "plan-c")]
        self.assertEqual((reverted["outcome"], reverted["failure_mode"]),
                         ("self_reverted", "self_revert:post_merge_ci_red"))
        self.assertIsNotNone(reverted["supersedes"])

    def test_the_surface_is_declared_exactly_like_the_memory_ledgers(self) -> None:
        # K2 (fix/aria-memory-not-compactable) flags the memory/* ledgers with
        # `memory=True`. Equal-but-for-name-and-path keeps this ledger in that
        # set: once the flag lands, a declaration that lacks it fails here.
        procedural = surface_by_name(PERFORMANCE_SURFACE)
        learning = surface_by_name("memory_learning_events")
        self.assertEqual(procedural.path_pattern, PROCEDURAL.as_posix())
        self.assertEqual(
            dataclasses.replace(procedural, name=learning.name, path_pattern=learning.path_pattern),
            learning,
        )


class ImplementerMustCheckReadsTheLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _tools()
        seed_plan_ledger(self.tools, fixture_history())
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_a_failure_mode_seen_three_times_is_recurring(self) -> None:
        recurring = recurring_failure_modes(base_dir=self.tools, role="implementer", subject="aria-implementer")

        self.assertEqual(LESSON_EPISODE_THRESHOLD, 3)
        self.assertEqual([(r["failure_mode"], r["episodes"]) for r in recurring], [("ci_check_red", 3)])
        self.assertEqual(recurring[0]["plan_ids"], ["plan-d", "plan-e", "plan-f"])
        self.assertEqual(recurring_failure_modes(base_dir=self.tools, role="implementer", subject="other"), [])

    def test_the_envelope_obligations_carry_it(self) -> None:
        from aria_kernel.cross_review_bridge import _observed_failure_obligations
        from aria_kernel.must_satisfy import OBSERVED_FAILURE_KIND, validate_must_satisfy

        obligations = _observed_failure_obligations(base_dir=self.tools, implementer="aria-implementer")

        self.assertEqual(validate_must_satisfy(obligations), obligations)
        self.assertEqual([(o["id"], o["kind"], o["failure_mode"], o["episodes"]) for o in obligations],
                         [("observed_failure:ci_check_red", OBSERVED_FAILURE_KIND, "ci_check_red", 3)])

    def test_two_episodes_are_not_a_lesson(self) -> None:
        from aria_kernel.cross_review_bridge import _observed_failure_obligations

        tools = _tools()
        try:
            seed_plan_ledger(tools, [e for e in fixture_history() if e["plan_id"] != "plan-f"])
            observe_agent_performance(base_dir=tools, cycle_id="cyc-1")
            self.assertEqual(_observed_failure_obligations(base_dir=tools, implementer="aria-implementer"), [])
        finally:
            shutil.rmtree(tools.parent, ignore_errors=True)


class ImplementationEnvelopeCarriesTheLessonTests(unittest.TestCase):
    """End to end: a real envelope, minted on a plan the real gate drove to
    CONVERGED, carries the recurring failure mode as an obligation, and the
    request contract accepts it."""

    def setUp(self) -> None:
        from tests._helpers.operator_acts import operator_set_profile
        from tests.test_implementation_lifecycle_continuity import (
            converging_plan_content,
            drive_plan_to_converged,
            seed_reviewer_agent,
        )

        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        workspace = root / "workspace"
        seed_reviewer_agent(workspace)
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        drive_plan_to_converged(
            plan_id="plan-k10", tools=self.tools, workspace_root=workspace,
            plan_content=converging_plan_content(
                "K10 lesson plan",
                affected_surfaces=[{"paths": ["apps/farm-service/src/sample.ts"]}],
                key_changes=[{"id": "kc-1", "description": "set it", "paths": ["apps/farm-service/src/sample.ts"]}],
                finding_id="ORPHAN-HIGH-104",
            ),
        )
        # The three red-CI episodes, built by the kernel's own episode builder
        # and appended the way the observation appends them.
        for row in agent_eval._performance_episodes(fixture_history(), {}, InvocationLedgersSource(self.tools)):
            append_declared_jsonl(self.tools / PROCEDURAL, {**row, "recorded_at": "2026-09-08T00:00:00+00:00"},
                                  expected_surface=PERFORMANCE_SURFACE)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_minted_envelope_names_the_recurring_failure(self) -> None:
        from aria_kernel.agent_contract import validate_request
        from aria_kernel.cross_review_bridge import issue_implementation_envelope

        row = issue_implementation_envelope(
            plan_id="plan-k10", cross_review_revision_id="cr-1", cross_review_summary_text="{}",
            proposal_id="proposal-k10", change_id="chg-k10", branch="aria-impl-0123456789abcdef",
            base_sha="0" * 40, base_dir=self.tools, cycle_id="cyc-k10",
            admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
        )

        validate_request(row, base_dir=self.tools)
        lesson = [item for item in row["must_satisfy"] if item["id"] == "observed_failure:ci_check_red"]
        self.assertEqual(len(lesson), 1)
        self.assertEqual(lesson[0]["episodes"], 3)


class LearningKpiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _tools()
        seed_plan_ledger(self.tools, fixture_history())
        seed_self_revert(self.tools)
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-1")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_kpis_from_the_fixture_history(self) -> None:
        kpis = performance_kpis(base_dir=self.tools)

        repeat = kpis["live"]["repeat_failure_rate"]
        # implementer: self_revert, then ci_check_red x3 -> the 2nd and 3rd red repeat.
        self.assertEqual((repeat["implementer"]["failures"], repeat["implementer"]["repeats"]), (4, 2))
        self.assertEqual(repeat["implementer"]["rate"], 0.5)
        self.assertEqual(repeat["implementer"]["by_failure_mode"],
                         {"ci_check_red": 3, "self_revert:post_merge_ci_red": 1})
        self.assertEqual(repeat["drafter"]["rate"], 0.0)
        implementer = kpis["live"]["implementer_scorecard"]["aria-implementer"]
        self.assertEqual((implementer["episodes"], implementer["attributable"], implementer["succeeded"]), (4, 4, 0))
        drafters = kpis["live"]["drafter_scorecard"]
        self.assertEqual(drafters["kernel:plan_synthesizer"]["episodes"], 5)
        self.assertEqual(drafters["kernel:plan_synthesizer"]["attributable"], 3)
        self.assertEqual(drafters["kernel:plan_synthesizer"]["success_rate"], 1.0)
        self.assertEqual(drafters["aria-primary-planner"]["success_rate"], 1.0)
        self.assertEqual(
            set(kpis["not_computable"]),
            {"repeat_failure_rate_by_class_key", "memory_ablation", "precision_after_fp_label",
             "impact_miss_rate", "implementer_scorecard_by_agent_version_hash"},
        )

    def test_a_ratio_over_no_episodes_is_unmeasured_not_zero(self) -> None:
        tools = _tools()
        try:
            kpis = performance_kpis(base_dir=tools)
            self.assertEqual(kpis["episodes"], 0)
            self.assertIsNone(kpis["live"]["repeat_failure_rate"]["implementer"]["rate"])
            self.assertEqual(kpis["live"]["implementer_scorecard"], {})
        finally:
            shutil.rmtree(tools.parent, ignore_errors=True)

    def test_the_doctor_reads_them(self) -> None:
        from aria_kernel.doctor import _check_learning

        check = _check_learning(self.tools)

        self.assertEqual(check.status, "ok")
        self.assertEqual(check.detail["live"]["repeat_failure_rate"]["implementer"]["rate"], 0.5)

    def test_the_doctor_warns_when_episodes_go_unobserved(self) -> None:
        from aria_kernel.doctor import _check_learning

        tools = _tools()
        try:
            seed_plan_ledger(tools, fixture_history())
            check = _check_learning(tools)
            self.assertEqual((check.status, check.reason), ("warn", "performance_unobserved:10"))
        finally:
            shutil.rmtree(tools.parent, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
