"""Every production reader of ``workspace_view.workspace_head_sha`` meets a checkout git cannot read.

``workspace_head_sha`` used to answer ``None`` on any git failure; it now
answers ``None`` only for "no checkout" and "no commit yet" and RAISES
``WorkspaceViewRefused("workspace_head_unreadable:...")`` for everything else
(PV R4, R12). The raise is right for the lanes whose verdicts bind to the
commit. It reached 21 call sites (22 once ``experiment_night`` took the owner
instead of its own subprocess), most of them in lanes that have nothing to
do with plan verdicts (cycle phases, the doctor, the fixture runner, judge
re-mint, the autonomy orchestrator, ...). The program lead ratified that
change on one condition (SPEC "Program-lead ratifications", SC3): every call
site must HOLD its lane with a named reason, or raise the named error exactly
where raising is the lane's designed contract, and none may crash a cycle with
an uncaught ``WorkspaceViewRefused``. Fifteen of the 21 sites had no test of
that path (conformance.md, PR-NOTES.md section 2).

The checkout under test is the one a real failure leaves: ``.git`` is a file
naming a ``gitdir`` that is gone (``git rev-parse`` exits 128). No owner is
patched, so what runs is the production reader on a real broken checkout.

Layout:

* ``LANE_TESTS`` names, for every function that calls the owner, the test
  that drives it. ``InventoryTests`` reads the source (AST) and fails when a
  new call site has no lane or a lane names a test that does not exist.
* One test class per lane group, each driving the lane through the nearest
  designed container (the phase driver, the executor's step, the CLI verb,
  the sweep, the orchestrator).
* ``CycleCascadeTests`` and ``OrchestratorContainsTheRefusalTests`` hold the
  two properties a "hold" needs beyond a named reason: the night's other work
  goes on, and a started cycle is sealed.
"""
from __future__ import annotations

import ast
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import aria_kernel
from aria_kernel import cycle as cycle_mod
from aria_kernel import doctor
from aria_kernel import executor_convergence as ec
from aria_kernel import fixture_runner
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.autonomy_orchestrator import (
    _calibration_reporter_and_auto_promotion,
    _drain_next_cycle_queue,
    run_autonomy_orchestrator,
)
from aria_kernel.autonomy_state import autonomy_state_path
from aria_kernel.cli import main as cli_main
from aria_kernel.convergence_drainer import run_convergence_drainer
from aria_kernel.convergent_planning_bridge import start_convergent_plan_with_challenger
from aria_kernel.cycle_phases.plan_source import V7GitDiffProvider, V9PressureSourceProvider
from aria_kernel.human_required_adjudication import sweep_human_required_adjudications
from aria_kernel.judge_remint import remint_judge_for_panel
from aria_kernel.ledger import load_jsonl
from aria_kernel.next_cycle_queue import append_pending, read_pending
from aria_kernel.plan_convergence import events_path, fold_plan_state, plan_verdict_anchor
from aria_kernel.plan_coverage import (
    _base_tree_error,
    compute_plan_coverage,
    compute_service_facts_at_head,
)
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.plan_synthesizer import PlanEvidenceGround, synthesize_plan_content_from_cycle
from aria_kernel.request_admission import admit_request
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, register_tool
from aria_kernel.workspace_view import WorkspaceViewRefused

from tests import test_autonomy_orchestrator as orchestrator_fixtures
from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore, item
from tests._helpers.adjudication import seed_adjudicator_opinion
from tests._helpers.git_fixtures import make_local_git_repo
from tests.test_cli_tool_fixture_refresh import tool_definition
from tests.test_plan_verdict_integrity import _PlanFixture
from tests.test_plan_verdict_roots_r2 import _break_checkout, _event_count

UNREADABLE = "workspace_head_unreadable"

# Every function that calls ``workspace_head_sha``, and the test that drives it.
# ``InventoryTests`` keeps this table equal to the source.
LANE_TESTS: dict[str, str] = {
    "aria_kernel.anchor_stale_effects.RemintGate.head":
        "AnchorStaleSweepLane.test_the_sweep_stops_before_its_first_write_and_the_next_sweep_remints",
    "aria_kernel.autonomy_orchestrator._calibration_reporter_and_auto_promotion":
        "AutonomyLanes.test_the_calibration_reporter_names_the_refusal_and_the_cycle_goes_on",
    "aria_kernel.autonomy_orchestrator._drain_next_cycle_queue":
        "AutonomyLanes.test_the_queue_drain_reads_head_before_it_consumes_an_item",
    "aria_kernel.convergence_drainer.run_convergence_drainer":
        "PlanLanes.test_the_executor_fails_the_one_plan_whose_checkout_cannot_be_read",
    "aria_kernel.convergent_planning_bridge.start_convergent_plan_with_challenger":
        "PlanLanes.test_the_operator_start_names_the_refusal_before_it_opens_the_plan",
    "aria_kernel.cycle._phase_goldset_proposal": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.cycle._phase_judge_calibration": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.cycle._phase_judge_replay": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.cycle._phase_judgment_pipeline": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.cycle._phase_outcome_calibration": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.cycle._phase_product_fitness": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.doctor._check_learning_funnel": "DoctorLane.test_the_doctor_names_the_refusal",
    "aria_kernel.experiment_night._head_sha": "CyclePhaseLanes.test_each_phase_holds_with_the_named_reason",
    "aria_kernel.fixture_runner._measured_code":
        "FixtureRunnerLanes.test_a_suite_on_an_unreadable_checkout_is_refused_by_name",
    "aria_kernel.fixture_runner.require_pinned_fixture_workspace":
        "FixtureRunnerLanes.test_the_refresh_verb_refuses_an_unreadable_checkout_by_name",
    "aria_kernel.judge_remint.remint_judge_for_panel":
        "JudgeRemintLane.test_the_panel_remint_writes_no_successor_and_the_sweep_names_the_refusal",
    "aria_kernel.plan_convergence.plan_verdict_anchor":
        "PlanLanes.test_the_verdict_anchor_names_the_refusal",
    "aria_kernel.plan_coverage._base_tree_error":
        "CoverageLanes.test_the_base_tree_check_names_the_refusal",
    "aria_kernel.plan_coverage.compute_plan_coverage":
        "CoverageLanes.test_the_coverage_closure_is_environment_unable_by_name",
    "aria_kernel.plan_coverage.compute_service_facts_at_head":
        "CoverageLanes.test_the_service_facts_are_held_by_name",
    "aria_kernel.plan_round_controller._ensure_planner_request":
        "PlanLanes.test_the_round_controller_mints_nothing_on_an_unreadable_checkout",
    "aria_kernel.plan_synthesizer.PlanEvidenceGround.of":
        "SynthesizerLanes.test_the_evidence_ground_names_the_refusal",
}


def _git_gone_checkout(parent: Path, name: str = "checkout") -> Path:
    """A work tree whose ``.git`` file names a ``gitdir`` that is gone."""
    root = parent / name
    root.mkdir(parents=True, exist_ok=True)
    (root / ".git").write_text(f"gitdir: {parent / (name + '-missing-gitdir')}\n", encoding="utf-8")
    return root


class _TempCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-head-lanes-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.broken = _git_gone_checkout(self.tmp)
        self.tools = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="head-lanes", base_dir=self.tools)


class InventoryTests(unittest.TestCase):
    """The table above is the source's own list of call sites."""

    @staticmethod
    def _callers() -> set[str]:
        package = Path(aria_kernel.__file__).resolve().parent
        found: set[str] = set()
        for path in sorted(package.rglob("*.py")):
            relative = path.relative_to(package.parent).with_suffix("")
            module = ".".join(relative.parts)
            if module == "aria_kernel.workspace_view":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))

            def visit(node: ast.AST, scope: tuple[str, ...]) -> None:
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        inner = (*scope, child.name)
                        if isinstance(child, ast.ClassDef):
                            visit(child, inner)
                            continue
                        calls = [
                            call for call in ast.walk(child)
                            if isinstance(call, ast.Call)
                            and getattr(call.func, "id", getattr(call.func, "attr", None)) == "workspace_head_sha"
                        ]
                        if calls:
                            found.add(".".join((module, *inner)))
                    else:
                        visit(child, scope)

            visit(tree, ())
        return found

    def test_every_caller_of_the_owner_has_a_lane(self) -> None:
        callers = self._callers()
        self.assertEqual(sorted(callers - set(LANE_TESTS)), [], "a caller of workspace_head_sha without a lane test")
        self.assertEqual(sorted(set(LANE_TESTS) - callers), [], "a lane test for a function that no longer reads HEAD")
        self.assertEqual(len(callers), 22)

    def test_every_lane_names_a_test_that_exists(self) -> None:
        for site, ref in LANE_TESTS.items():
            with self.subTest(site=site):
                cls_name, method = ref.split(".")
                self.assertTrue(callable(getattr(globals()[cls_name], method, None)), ref)


class CyclePhaseLanes(_TempCase):
    """Seven cycle phases read HEAD; the phase driver is their designed container.

    ``experiment_night`` joined the six when it stopped reading HEAD through its
    own ``git rev-parse`` subprocess (a second owner whose failure halted the
    sequence) and took the one owner: the 22nd call site.
    """

    PHASES = (
        "product_fitness", "judgment_pipeline", "judge_calibration",
        "judge_replay", "outcome_calibration", "goldset_proposal", "experiment_night",
    )

    def _drive(self, phase: str) -> cycle_mod.PhaseContext:
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-head-lane", workspace_root=self.broken, base_dir=self.tools,
        )
        cycle_mod._run_phase_stage("post_tool", context, phase_filter=phase)
        return context

    def test_each_phase_holds_with_the_named_reason(self) -> None:
        for phase in self.PHASES:
            with self.subTest(phase=phase):
                # An uncaught WorkspaceViewRefused would leave the driver here.
                context = self._drive(phase)
                outcome = context.outcomes[phase]
                self.assertNotEqual(outcome["outcome"], "ran", outcome)
                self.assertIn(UNREADABLE, str(outcome.get("error") or outcome.get("reason")), outcome)

    def test_the_outcome_phase_writes_no_truth_row_before_it_reads_head(self) -> None:
        # PV R12 — HEAD is read before `mint_outcome_truth` writes.
        context = self._drive("outcome_calibration")
        self.assertIn(UNREADABLE, str(context.outcomes["outcome_calibration"]))
        self.assertFalse((self.tools / "outcome-truth.jsonl").exists())


class CycleCascadeTests(_TempCase):
    """A phase that cannot read HEAD holds ITS work; the night's other work goes on.

    ``_run_phase_stage`` records any exception as a ``failed`` outcome, and
    ``_first_phase_failure`` makes every later ``halt_sequence`` phase (the
    default policy) skip with ``upstream_failure:<phase>``. Before PV the six
    phases that read HEAD ran on a checkout git could not read with
    ``target_sha=None``; now a refusal in any of them also stops
    ``judge_calibration`` (itself a HEAD reader), ``proactive_priority`` and
    ``reflection``, which read nothing from git (conformance.md SC3: "does not
    need ... halting the later ``halt_sequence`` phases, on a git error").

    The whole ``post_tool`` stage runs once, the way the driver runs it; a
    phase filter would rewrite the earlier outcomes as skips.
    """

    def test_a_head_refusal_does_not_halt_the_phases_after_it(self) -> None:
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-head-cascade", workspace_root=_git_gone_checkout(self.tmp, "stage"), base_dir=self.tools,
        )
        cycle_mod._run_phase_stage("post_tool", context)
        refused = {
            name for name, outcome in context.outcomes.items() if UNREADABLE in str(outcome.get("error") or "")
        }
        self.assertTrue(refused, "no phase read HEAD on this checkout")
        halted = {
            name: outcome["reason"] for name, outcome in context.outcomes.items()
            if outcome.get("outcome") == "skipped"
            and str(outcome.get("reason", "")).removeprefix("upstream_failure:") in refused
            and str(outcome.get("reason", "")).startswith("upstream_failure:")
        }
        self.assertEqual(halted, {}, "phases skipped because a phase could not read HEAD")


class DoctorLane(_PlanFixture):
    def test_the_doctor_names_the_refusal(self) -> None:
        _break_checkout(self)
        check = doctor._check_learning_funnel(self.tools, self.repo)
        self.assertEqual(check.status, "warn")
        self.assertTrue(check.reason.startswith(UNREADABLE), check.reason)


class PlanLanes(_PlanFixture):
    """Lanes where the raise is the contract: nothing is written, the named error leaves."""

    def _requests(self) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools, convergence_id="plan-1")

    def test_the_round_controller_mints_nothing_on_an_unreadable_checkout(self) -> None:
        self.start()  # DRAFT: the next step is the round-1 challenger request
        _break_checkout(self)
        before = (_event_count(self), self._requests())
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        self.assertEqual((_event_count(self), self._requests()), before)

    def test_the_verdict_anchor_names_the_refusal(self) -> None:
        _break_checkout(self)
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            plan_verdict_anchor(self.tools)

    def test_the_executor_fails_the_one_plan_whose_checkout_cannot_be_read(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        _break_checkout(self)
        before = _event_count(self)
        outcome = ec.advance_after_accepted_step(
            request={"request_id": "req-ch-1", "role": "challenger_plan", "convergence_id": "plan-1"},
            tools_dir=self.tools, workspace_root=self.repo, run_id="run-head-lane", budget=ec.AdvanceBudget(),
            drain_remaining=None, environ={ec.WRITER_LEASE_ENV: ec.WRITER_LEASE_HELD},
        )
        self.assertEqual((outcome["status"], outcome["error_class"]), (ec.ADVANCE_FAILED, "WorkspaceViewRefused"))
        self.assertEqual(_event_count(self), before)
        # The drainer is the raiser; called directly it names the reason before it writes.
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            run_convergence_drainer(
                cycle_id="cyc-head-lane", base_dir=self.tools, workspace_root=self.repo,
                plan_id="plan-1", plan_seed={},
            )
        self.assertEqual(_event_count(self), before)

    def test_the_operator_start_names_the_refusal_before_it_opens_the_plan(self) -> None:
        _break_checkout(self)
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            start_convergent_plan_with_challenger(
                plan_id="plan-op", plan_content=self.plan(), initial_revision_id="rev-0", operator_must_satisfy=[],
                admission=admit_request("operator_cli.convergent_plan", "challenger_plan", base_dir=self.tools),
                base_dir=self.tools, workspace_root=self.repo,
            )
        self.assertIsNone(fold_plan_state(plan_id="plan-op", base_dir=self.tools).get("state"))
        self.assertFalse(events_path(self.tools).exists() and "plan-op" in events_path(self.tools).read_text("utf-8"))


class CoverageLanes(_TempCase):
    def _compute(self) -> dict:
        return compute_plan_coverage(
            plan_content={"affected_surfaces": [{"paths": ["apps/farm-service/src/feed/feed.service.ts"]}]},
            plan_id="plan-cov", round_number=1, target_revision_id="rev-0",
            target_plan_content_hash="sha256:" + "0" * 64,
            workspace_root=self.broken, base_dir=self.tools,
        )

    def test_the_coverage_closure_is_environment_unable_by_name(self) -> None:
        payload = self._compute()
        self.assertEqual(payload["verdict"], "environment_unable")
        self.assertIn(UNREADABLE, json.dumps(payload["witness"]))
        self.assertNotEqual(payload["computed_at_sha"], "")

    def test_the_base_tree_check_names_the_refusal(self) -> None:
        error = _base_tree_error(self.broken, "a" * 40)
        self.assertIsNotNone(error)
        self.assertTrue(error.startswith("head_unreadable"), error)
        self.assertIn(UNREADABLE, error)

    def test_the_service_facts_are_held_by_name(self) -> None:
        facts = compute_service_facts_at_head(workspace_root=self.broken)
        self.assertEqual(facts["verdict"], "environment_unable")
        self.assertIn(UNREADABLE, json.dumps(facts["witness"]))


class FixtureRunnerLanes(_PlanFixture):
    """The fixture suite names the refusal; the refresh verb prints ``refused`` and exits 1."""

    def _register_suite(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools)
        cases = self.tools / "fixtures" / "learning-adapter" / "cases"
        cases.mkdir(parents=True)
        (cases / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}), encoding="utf-8",
        )

    def test_a_suite_on_an_unreadable_checkout_is_refused_by_name(self) -> None:
        self._register_suite()
        _break_checkout(self)
        with self.assertRaisesRegex(GovernanceError, f"fixture_suite_workspace_head_unreadable.*{UNREADABLE}"):
            fixture_runner.run_fixture_suite(
                "learning-adapter", workspace_root=self.repo, cycle_id="cyc-head-lane", base_dir=self.tools,
            )
        runs = self.tools / "fixture-runs.jsonl"
        self.assertFalse(runs.exists() and runs.read_text(encoding="utf-8").strip(), "a refused suite writes no row")

    def test_the_refresh_verb_refuses_an_unreadable_checkout_by_name(self) -> None:
        self._register_suite()
        _break_checkout(self)
        with self.assertRaisesRegex(GovernanceError, f"fixture_refresh_workspace_unreadable.*{UNREADABLE}"):
            fixture_runner.require_pinned_fixture_workspace(self.repo, base_dir=self.tools)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli_main([
                "--tools-dir", str(self.tools), "tool", "fixture-refresh",
                "--workspace-root", str(self.repo), "--cycle-id", "cyc-head-lane",
            ])
        self.assertEqual(code, 1)
        verdict = json.loads(out.getvalue())
        self.assertEqual(verdict["status"], "refused")
        self.assertIn("fixture_refresh_workspace_unreadable", verdict["reason"])
        self.assertIn(UNREADABLE, verdict["reason"])


class SynthesizerLanes(_TempCase):
    def test_the_evidence_ground_names_the_refusal(self) -> None:
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            PlanEvidenceGround.of(self.broken)

    def test_the_git_diff_providers_on_the_same_checkout(self) -> None:
        # The git-diff discovery cannot list a diff on this checkout: it answers
        # no plan, which its docstring promises ("returns None instead of propagating").
        self.assertIsNone(synthesize_plan_content_from_cycle(
            cycle_id="cyc-head-lane", workspace_root=self.broken, base_dir=self.tools,
        ))
        self.assertIsNone(V7GitDiffProvider().synthesize(
            cycle_id="cyc-head-lane", workspace_root=self.broken, base_dir=self.tools, profile="standard",
        ))
        # The ranked-candidate provider reads the ground first and names the refusal;
        # ``OrchestratorContainsTheRefusalTests`` pins what the orchestrator does with it.
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            V9PressureSourceProvider().synthesize(
                cycle_id="cyc-head-lane", workspace_root=self.broken, base_dir=self.tools, profile="standard",
            )


class AnchorStaleSweepLane(AnchorStaleStore):
    """The judge re-mint sweep anchors a successor at HEAD: it reads it before its first write."""

    def _break(self) -> None:
        shutil.move(str(self.repo / ".git"), str(self.repo.parent / "moved-git"))
        (self.repo / ".git").write_text(f"gitdir: {self.repo.parent / 'missing'}\n", encoding="utf-8")

    def _heal(self) -> None:
        (self.repo / ".git").unlink()
        shutil.move(str(self.repo.parent / "moved-git"), str(self.repo / ".git"))

    def test_the_sweep_stops_before_its_first_write_and_the_next_sweep_remints(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        head = self.head()
        self.expire(dead)
        self._break()
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            self.sweep()
        self.assertFalse(self.record_path(dead).exists())
        self.assertEqual(self.successors(dead), [])
        self._heal()
        self.sweep()
        [successor] = self.successors(dead)
        self.assertEqual(successor["target_sha"], head)


class JudgeRemintLane(AnchorStaleStore):
    """A panel's ``re_mint`` of a judge request anchors the successor at HEAD."""

    def _panel_has_voted_re_mint(self, request_id: str) -> None:
        from aria_kernel import human_required_adjudication as hra

        panel = self.open_record_with_panel(request_id, kind="lease_lifecycle")
        for envelope, agent in zip(panel, ("judge-a", "judge-b", "judge-c")):
            seed_adjudicator_opinion(
                self.tools, envelope, agent_id=agent, verdict=hra.RESOLVE_VERDICT,
                disposition=hra.DISPOSITION_RE_MINT,
            )

    def test_the_panel_remint_writes_no_successor_and_the_sweep_names_the_refusal(self) -> None:
        self.report(5)
        fingerprint = item(5)["finding_fingerprint"]
        self.seed_row(
            "AIR-panel-judge", role="evidence_judgment", target_agent=EVIDENCE_JUDGE, prompt="Did rule-a fire?",
            tool_id="tool-x", finding_id="F5", run_id="r1", finding_fingerprint=fingerprint,
            judgment_group_id=f"judge:tool-x:{fingerprint}", forbidden_scope=["tools/aria-adapters/**"],
            expire=False,
        )
        self._panel_has_voted_re_mint("AIR-panel-judge")
        shutil.move(str(self.repo / ".git"), str(self.repo.parent / "moved-git"))
        (self.repo / ".git").write_text(f"gitdir: {self.repo.parent / 'missing'}\n", encoding="utf-8")

        # The function raises before it writes a successor ...
        dead = self.row("AIR-panel-judge")
        admission = admit_request("human_required_panel.remint", str(dead["role"]), base_dir=self.tools)
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            remint_judge_for_panel(self.tools, dead, adjudication_ref=None, admission=admission)
        self.assertEqual(self.successors("AIR-panel-judge"), [])

        # ... and the sweep that calls it contains the raise to that one escalation, by name.
        summary = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(self.successors("AIR-panel-judge"), [])
        self.assertEqual(self.record("AIR-panel-judge")["status"], "open")
        self.assertEqual(summary["status"], "ok")
        named = [row for row in summary["skipped"] if UNREADABLE in row["reason"]]
        self.assertEqual([row["request_id"] for row in named], ["AIR-panel-judge"], summary)


class _OrchestratorCase(unittest.TestCase):
    """``run_autonomy_orchestrator`` with the happy-path fakes of its own suite."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-head-orch-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="head-lanes", base_dir=self.base)

    def run_orchestrator(self, workspace_root: Path, **overrides: object) -> dict:
        fixtures = orchestrator_fixtures
        kwargs: dict[str, object] = dict(
            base_dir=self.base, workspace_root=str(workspace_root), max_cycles=1, max_iterations_per_phase=3,
            cycle_runner=fixtures._fake_cycle_runner, planner_drainer=fixtures._fake_planner_drainer,
            worker_drainer=fixtures._fake_worker_drainer, bridge_drainer=fixtures._fake_bridge_drainer,
            auto_merge_runner=fixtures._fake_auto_merge_runner, github_adapter=fixtures._fake_github_adapter,
            convergence_runner=fixtures._fake_convergence_runner, review_runner=fixtures._fake_review_runner,
            specialist_review_runner=fixtures._fake_specialist_review_runner,
            plan_synthesizer=fixtures._fake_plan_synthesizer,
            skill_genesis_drainer=fixtures._fake_skill_genesis_drainer, profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def state_rows(self) -> list[dict]:
        return load_jsonl(autonomy_state_path(self.base))

    def assert_cycle_sealed_with_the_reason(self) -> None:
        """Each started cycle has its terminal row, and the refusal is named on the night's ledgers."""
        rows = self.state_rows()
        started = {row["cycle_id"] for row in rows if row.get("phase") == "cycle_started"}
        sealed = {row["cycle_id"] for row in rows if row.get("phase") == "cycle_completed"}
        self.assertTrue(started, "the orchestrator started no cycle")
        self.assertEqual(sorted(started - sealed), [], "a cycle was started and never sealed")
        governance = self.base / "governance.jsonl"
        ledgers = autonomy_state_path(self.base).read_text(encoding="utf-8") + (
            governance.read_text(encoding="utf-8") if governance.exists() else ""
        )
        self.assertIn(UNREADABLE, ledgers, "the refusal is not named on the autonomy state or governance ledger")


class AutonomyLanes(_OrchestratorCase):
    def test_the_queue_drain_reads_head_before_it_consumes_an_item(self) -> None:
        broken = _git_gone_checkout(self.tmp)
        item_row = append_pending(self.base, source_cycle_id="c1", pressure_id="p1")
        with self.assertRaisesRegex(WorkspaceViewRefused, UNREADABLE):
            _drain_next_cycle_queue(
                base_dir=self.base, daemon_agent_id="daemon-head-lane", limit=3, workspace_root=broken,
                cycle_id="cyc-head-lane",
            )
        self.assertEqual([row["queue_item_id"] for row in read_pending(self.base, limit=10)],
                         [item_row["queue_item_id"]])

    def test_the_calibration_reporter_names_the_refusal_and_the_cycle_goes_on(self) -> None:
        broken = _git_gone_checkout(self.tmp)
        summary: dict = {}
        adapter = {"tool_id": "adapter-x", "kind": "adapter", "status": "SHADOW"}
        with mock.patch("aria_kernel.tool_registry.list_tools", return_value=[adapter]):
            _calibration_reporter_and_auto_promotion(
                self.base, "cyc-head-lane", summary, {"profile": "standard"}, broken,
            )
        report = summary["calibration_reporter"]
        self.assertEqual(report["status"], "error")
        self.assertEqual(report["error_class"], "WorkspaceViewRefused")
        self.assertIn(UNREADABLE, report["error_message"])


class OrchestratorContainsTheRefusalTests(_OrchestratorCase):
    """A refusal inside a started cycle ends THAT cycle by name; it is not an uncaught crash.

    The orchestrator already holds a cycle runner that raises (``cycle_completed``
    status ``failed``, a failure notice) and a convergence step that raises
    ``GovernanceError`` (``convergence_invalid_plan``, the error text on the
    state ledger). The three refusals below run in the same cycle, outside
    those handlers.
    """

    def test_an_unreadable_workspace_ends_the_started_cycle_by_name(self) -> None:
        # The queue drain is the first read of the cycle, after `cycle_started`.
        self.run_orchestrator(_git_gone_checkout(self.tmp))
        self.assert_cycle_sealed_with_the_reason()

    def test_a_provider_that_cannot_read_head_ends_the_cycle_by_name(self) -> None:
        # `V9PressureSourceProvider.synthesize` reads the evidence ground and raises the refusal.
        repo = make_local_git_repo(self.tmp)

        class _Provider:
            def synthesize(self, **kwargs: object) -> None:
                raise WorkspaceViewRefused(f"{UNREADABLE}:git_exit_128")

        self.run_orchestrator(repo, plan_content_provider=_Provider())
        self.assert_cycle_sealed_with_the_reason()

    def test_a_convergence_step_that_cannot_read_head_ends_the_cycle_by_name(self) -> None:
        # `run_convergence_drainer` reads HEAD before it writes and raises the refusal.
        repo = make_local_git_repo(self.tmp)

        def refusing_convergence_runner(**kwargs: object) -> None:
            raise WorkspaceViewRefused(f"{UNREADABLE}:git_exit_128")

        self.run_orchestrator(repo, convergence_runner=refusing_convergence_runner)
        self.assert_cycle_sealed_with_the_reason()


if __name__ == "__main__":
    unittest.main()
