"""Plan 032 Faz 032a — `aria-kernel doctor` reads every organ and decides nothing.

The doctor is a report: each check is ok/warn/fail with a reason, an
unreadable check is a WARN naming the exception, and the exit code is
derived (0 healthy, 3 any fail) the way the runtime supervisor already
reports. The Claude CLI floor it enforces must be the floor the live lanes
enforce — three literals, one value.
"""
from __future__ import annotations

import os
import re
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import doctor
from aria_kernel.cli import build_parser
from aria_kernel.doctor import (
    CLAUDE_CLI_VERSION_FLOOR,
    DOCTOR_EXIT_HEALTHY,
    DOCTOR_EXIT_UNHEALTHY,
    DoctorCheck,
    DoctorReport,
    render_doctor_text,
    run_doctor,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]


class ReportShape(unittest.TestCase):
    def test_exit_code_follows_the_worst_check(self) -> None:
        healthy = DoctorReport(
            checks=(DoctorCheck("a", "ok"), DoctorCheck("b", "warn", "meh")),
            tools_dir="t", workspace_root="w",
        )
        sick = DoctorReport(
            checks=(DoctorCheck("a", "ok"), DoctorCheck("b", "fail", "bad")),
            tools_dir="t", workspace_root="w",
        )
        self.assertEqual(healthy.exit_code, DOCTOR_EXIT_HEALTHY)
        self.assertEqual(sick.exit_code, DOCTOR_EXIT_UNHEALTHY)
        self.assertEqual(healthy.to_dict()["summary"], {"ok": 1, "warn": 1, "fail": 0})
        self.assertIn("[FAIL] b — bad", render_doctor_text(sick))

    def test_an_unreadable_organ_is_a_warn_naming_the_exception(self) -> None:
        def boom() -> DoctorCheck:
            raise RuntimeError("no")

        check = doctor._guarded("x", boom)

        self.assertEqual((check.name, check.status, check.reason), ("x", "warn", "check_unreadable:RuntimeError"))


class TheFloorIsOneValue(unittest.TestCase):
    def test_workflows_and_provisioner_pin_the_same_claude_floor(self) -> None:
        literals: dict[str, str] = {}
        for rel in (
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ):
            text = (_REPO_ROOT / rel).read_text(encoding="utf-8")
            match = re.search(r'REQUIRED_CLAUDE_VERSION="([0-9.]+)"', text)
            self.assertIsNotNone(match, rel)
            literals[rel] = match.group(1)
        provision = (_REPO_ROOT / "scripts/aria/provision_runner.sh").read_text(encoding="utf-8")
        match = re.search(r'CLAUDE_FLOOR="([0-9.]+)"', provision)
        self.assertIsNotNone(match)
        literals["scripts/aria/provision_runner.sh"] = match.group(1)

        self.assertEqual(set(literals.values()), {CLAUDE_CLI_VERSION_FLOOR}, literals)


class ClaudeCliCheck(unittest.TestCase):
    def _fake_claude(self, version_line: str) -> str:
        tmp = tempfile.mkdtemp(prefix="aria-doctor-")
        binary = Path(tmp) / "claude"
        binary.write_text(f"#!/bin/sh\necho '{version_line}'\n", encoding="utf-8")
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
        return tmp

    def test_below_floor_fails_and_above_floor_passes(self) -> None:
        low = self._fake_claude("2.1.100 (Claude Code)")
        high = self._fake_claude("2.9.0 (Claude Code)")
        with mock.patch.dict(os.environ, {"PATH": low}):
            self.assertEqual(doctor._check_claude_cli(floor="2.1.197").status, "fail")
        with mock.patch.dict(os.environ, {"PATH": high}):
            self.assertEqual(doctor._check_claude_cli(floor="2.1.197").status, "ok")
        with mock.patch.dict(os.environ, {"PATH": tempfile.mkdtemp(prefix="aria-empty-")}):
            self.assertEqual(doctor._check_claude_cli().reason, "claude_binary_missing")

    def test_version_tuple_reads_only_the_numeric_prefix(self) -> None:
        self.assertEqual(doctor._version_tuple("2.1.197-beta"), (2, 1, 197))
        self.assertEqual(doctor._version_tuple("v2"), ())


class StoreChecks(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_an_unbound_tools_root_is_a_fail_and_host_checks_still_run(self) -> None:
        report = run_doctor(base_dir=self.root / "nowhere", workspace_root=self.root)

        names = [check.name for check in report.checks]
        self.assertEqual(report.checks[0].reason, "tools_root_unbound")
        self.assertIn("providers", names)
        self.assertIn("claude_cli", names)
        self.assertEqual(report.exit_code, DOCTOR_EXIT_UNHEALTHY)

    def test_live_requests_without_a_plan_ledger_is_the_2026_09_02_finding(self) -> None:
        append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl",
            {"request_id": "AIR-1", "role": "challenger_plan"},
            expected_surface="agent_invocation_requests",
        )
        self.assertEqual(
            doctor._check_plan_ledger(self.tools).reason,
            "plan_ledger_missing_with_live_requests",
        )
        append_declared_jsonl(
            self.tools / "plans" / "events.jsonl",
            {"plan_id": "plan-1", "event": "plan_started"},
            expected_surface="plan_convergence_events",
        )
        self.assertEqual(doctor._check_plan_ledger(self.tools).status, "ok")

    def _seed_live_requests(self, tools: Path) -> None:
        append_declared_jsonl(
            tools / "agent-invocations" / "requests.jsonl",
            {"request_id": "AIR-1", "role": "challenger_plan"},
            expected_surface="agent_invocation_requests",
        )

    def _seed_minted_plan(self, tools: Path, *, cycle_id: str = "cycle-1", funnel_recorded: bool = True) -> None:
        """The orchestrator's own evidence of a minted plan: its state row,
        stamped FUNNEL_RECORDED_DETAIL the way the orchestrator stamps it
        after writing the effectiveness ledger; ``funnel_recorded=False`` is
        the shape of a row written before the ledger existed."""
        from aria_kernel.autonomy_state import FUNNEL_RECORDED_DETAIL, PLAN_MINTED_PHASE, AutonomyStateReducer

        details = {FUNNEL_RECORDED_DETAIL: True} if funnel_recorded else {"plan_id": "plan-legacy"}
        AutonomyStateReducer.transition(tools, cycle_id=cycle_id, phase=PLAN_MINTED_PHASE, details=details)

    def test_a_minted_row_from_before_the_ledger_existed_is_not_a_fault(self) -> None:
        """The live store (origin/aria/state, 2026-08 → 09-04) holds twenty
        cycle_runner_synthesized_plan rows written when the effectiveness
        writer sat on the converged path, and no effectiveness ledger. Those
        rows never claimed a ledger row; counting them would make the first
        doctor run after deploy report data loss for a ledger that never
        existed and open a doctor_fail mission nothing could clear. Only a
        row that carries the orchestrator's stamp counts."""
        self._seed_minted_plan(self.tools, cycle_id="cycle-legacy", funnel_recorded=False)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual((check.detail["sources"], check.detail["plans_minted"]), (0, 0))
        self._seed_minted_plan(self.tools, cycle_id="cycle-new")
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "funnel_ledger_missing_with_minted_plans"))
        self.assertEqual(check.detail["plans_minted"], 1)

    def test_minted_plans_without_a_funnel_ledger_is_a_named_fault(self) -> None:
        """B4 (2026-09-12) — on the live store the orchestrator had minted a
        plan every night, knowledge-graph/pressure-source-effectiveness.jsonl
        did not exist, and the funnel organ reported ok with sources=0.
        Blind. The orchestrator records every mint in that ledger BEFORE it
        emits the PLAN_MINTED_PHASE row, so a state ledger that says "minted"
        beside no effectiveness ledger is a fault with a name, and the first
        recorded mint clears it."""
        from aria_kernel.knowledge_graph import record_pressure_source_outcome

        self._seed_minted_plan(self.tools)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "funnel_ledger_missing_with_minted_plans"))
        self.assertEqual((check.detail["sources"], check.detail["plans_minted"]), (0, 1))
        self.assertFalse(check.detail["effectiveness_ledger_present"])
        record_pressure_source_outcome(base_dir=self.tools, source_type="finding", minted=1)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason, check.detail["sources"]), ("ok", "", 1))
        self.assertTrue(check.detail["effectiveness_ledger_present"])
        self.assertEqual(
            check.detail["counters"],
            {"finding": {"cycles_minted": 1, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 0}},
        )

    def test_live_requests_alone_are_not_a_funnel_fault(self) -> None:
        """Requests are minted by a dozen producers that run with no plan in
        the funnel (judge fan-out, expert review, cross-review). A store that
        holds only those has never minted a plan, so its absent effectiveness
        ledger is bootstrap — the organ judges against the orchestrator's own
        PLAN_MINTED_PHASE row, not against the requests ledger."""
        self._seed_live_requests(self.tools)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual((check.detail["sources"], check.detail["plans_minted"]), (0, 0))

    def test_a_store_without_minted_plans_has_no_funnel_fault(self) -> None:
        """No plan has been minted yet: bootstrap, not a fault."""
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual((check.detail["sources"], check.detail["plans_minted"]), (0, 0))

    def test_blocked_only_cycles_are_counted_and_then_a_stall_not_a_fault(self) -> None:
        """The live store's shape after the writer moved to the funnel's
        entry: every cycle minted a plan and none converged. Each such cycle
        leaves minted=1 and rejected=1 for its source. Below the stall
        threshold the organ is ok with the counters in its detail; at the
        threshold it is a WARN naming the convergence stage — the stall the
        store exhibited and nothing could count. Never a data-loss reason."""
        from aria_kernel.funnel_health import MIN_UPSTREAM_FOR_STALL
        from aria_kernel.knowledge_graph import record_pressure_source_outcome

        for cycle in range(MIN_UPSTREAM_FOR_STALL - 1):
            self._seed_minted_plan(self.tools, cycle_id=f"cycle-{cycle}")
            record_pressure_source_outcome(base_dir=self.tools, source_type="finding", minted=1)
            record_pressure_source_outcome(base_dir=self.tools, source_type="finding", rejected=1)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual(check.detail["plans_minted"], MIN_UPSTREAM_FOR_STALL - 1)
        self.assertEqual(check.detail["counters"]["finding"], {
            "cycles_minted": MIN_UPSTREAM_FOR_STALL - 1, "cycles_converged": 0,
            "cycles_merged": 0, "cycles_rejected": MIN_UPSTREAM_FOR_STALL - 1,
        })
        self._seed_minted_plan(self.tools, cycle_id="cycle-last")
        record_pressure_source_outcome(base_dir=self.tools, source_type="finding", minted=1)
        record_pressure_source_outcome(base_dir=self.tools, source_type="finding", rejected=1)
        check = doctor._check_funnel(self.tools)
        self.assertEqual((check.status, check.reason), ("warn", "funnel_stalled:1"))
        self.assertEqual(
            [(stall["stage"], stall["upstream"], stall["downstream"]) for stall in check.detail["stalls"]],
            [("convergence", MIN_UPSTREAM_FOR_STALL, 0)],
        )

    def test_the_funnel_organ_reads_the_bound_tools_root_not_the_workspace(self) -> None:
        """The live lane's shape: ARIA_TOOLS_DIR=<store>/tools while
        --workspace-root is the checkout. The organ used to resolve
        <workspace>/aria-tools/knowledge-graph/... and the state ledger it
        is judged against lives under the tools root, so on the lane it
        could never see either. The manifest declares the effectiveness
        ledger a tools-root surface; the organ reads it where the store
        keeps it."""
        from aria_kernel.knowledge_graph import record_pressure_source_outcome

        store_tools = self.root / "store" / "tools"
        ensure_tools_dir(store_tools)
        checkout = self.root / "checkout"
        checkout.mkdir()
        self._seed_minted_plan(store_tools)
        report = run_doctor(base_dir=store_tools, workspace_root=checkout)
        funnel = next(check for check in report.checks if check.name == "funnel")
        self.assertEqual((funnel.status, funnel.reason), ("fail", "funnel_ledger_missing_with_minted_plans"))
        record_pressure_source_outcome(base_dir=store_tools, source_type="finding", minted=1, converged=1)
        self.assertFalse((checkout / "aria-tools").exists())
        report = run_doctor(base_dir=store_tools, workspace_root=checkout)
        funnel = next(check for check in report.checks if check.name == "funnel")
        self.assertEqual((funnel.status, funnel.detail["sources"]), ("ok", 1))

    def test_a_tripped_breaker_is_a_fail(self) -> None:
        with mock.patch("aria_kernel.cost_budget.current_state", return_value="tripped"):
            check = doctor._check_breakers(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "breaker_tripped:cost_breaker"))


class GatewayHeartbeatFresh(unittest.TestCase):
    """B6 — a dead gateway daemon must FAIL the doctor, not warn it.

    CONFIRMED LIVE 2026-09-12: `aria-gateway.service` on the runner host
    last beat on 2026-09-08 and is disabled/dead; the `gateway` organ read
    the four-day-old heartbeat as `warn`, the doctor stayed `healthy`, and
    `self_improvement.scan_signals` lifts only `fail` organs — so nothing
    noticed. Freshness is judged in missed BEATS (the heartbeat declares its
    own cadence), and an absent heartbeat is a fail exactly when a schedule
    table exists to expect one.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _beat(self, *, age_seconds: float, poll_interval_seconds: float | None = None) -> None:
        import json
        from datetime import datetime, timedelta, timezone

        from aria_kernel.gateway.server import HEARTBEAT_RELPATH

        stamp = (datetime.now(timezone.utc) - timedelta(seconds=age_seconds)).isoformat()
        beat = {"schema_version": 1, "recorded_at": stamp, "tick_at": stamp, "routed": 0, "ran": []}
        if poll_interval_seconds is not None:
            beat["poll_interval_seconds"] = poll_interval_seconds
        path = self.tools.joinpath(*HEARTBEAT_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(beat), encoding="utf-8")

    def test_the_live_shape_a_four_day_old_heartbeat_is_a_fail(self) -> None:
        # The live beat (2026-09-08) predates the cadence field; the daemon
        # default applies and four days is thousands of missed beats.
        self._beat(age_seconds=4 * 24 * 3600)
        check = doctor._check_gateway_heartbeat_fresh(self.tools)
        self.assertEqual(check.status, "fail")
        self.assertTrue(check.reason.startswith("gateway_heartbeat_stale:"), check.reason)
        self.assertGreater(check.detail["missed_beats"], doctor.HEARTBEAT_STALE_AFTER_BEATS)

    def test_staleness_is_measured_in_beats_of_the_declared_cadence(self) -> None:
        from aria_kernel.gateway.daemon import DEFAULT_POLL_INTERVAL_SECONDS

        # Twenty minutes is stale at the 60 s default but two beats at a
        # declared 600 s cadence: the beat's own promise decides.
        self._beat(age_seconds=20 * 60, poll_interval_seconds=600.0)
        self.assertEqual(doctor._check_gateway_heartbeat_fresh(self.tools).status, "ok")
        self._beat(age_seconds=20 * 60)
        stale = doctor._check_gateway_heartbeat_fresh(self.tools)
        self.assertEqual(stale.status, "fail")
        self.assertEqual(stale.detail["poll_interval_seconds"], DEFAULT_POLL_INTERVAL_SECONDS)

    def test_an_absent_heartbeat_with_a_schedule_table_is_a_fail(self) -> None:
        from aria_kernel.gateway.scheduler import add_schedule

        add_schedule(name="doctor", action="doctor", cron="*/30 * * * *", base_dir=self.tools)
        check = doctor._check_gateway_heartbeat_fresh(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "gateway_heartbeat_absent_with_schedules"))
        self.assertEqual(check.detail["schedules"], ["doctor"])

    def test_an_absent_heartbeat_without_schedules_is_not_deployed_here(self) -> None:
        check = doctor._check_gateway_heartbeat_fresh(self.tools)
        self.assertEqual((check.status, check.reason), ("ok", "gateway_not_deployed_here"))

    def test_an_unreadable_heartbeat_is_a_fail_when_schedules_exist(self) -> None:
        from aria_kernel.gateway.scheduler import add_schedule
        from aria_kernel.gateway.server import HEARTBEAT_RELPATH

        add_schedule(name="doctor", action="doctor", cron="*/30 * * * *", base_dir=self.tools)
        path = self.tools.joinpath(*HEARTBEAT_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        check = doctor._check_gateway_heartbeat_fresh(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "gateway_heartbeat_unreadable"))

    def test_the_organ_is_registered_and_owns_freshness(self) -> None:
        self._beat(age_seconds=4 * 24 * 3600)
        report = run_doctor(base_dir=self.tools, workspace_root=self.root)
        organs = {check.name: check for check in report.checks}
        self.assertEqual(organs["gateway_heartbeat_fresh"].status, "fail")
        self.assertEqual(report.exit_code, DOCTOR_EXIT_UNHEALTHY)
        # One fact, one owner: the `gateway` organ keeps inbox/backlog and no
        # longer issues a second, weaker verdict on the same heartbeat.
        self.assertNotEqual(organs["gateway"].reason, "gateway_heartbeat_stale")

    def test_a_dead_daemon_becomes_a_self_improvement_signal(self) -> None:
        from aria_kernel.self_improvement import scan_signals

        self._beat(age_seconds=4 * 24 * 3600)
        signals = scan_signals(base_dir=self.tools, workspace_root=self.root)
        self.assertIn(("doctor_fail", "gateway_heartbeat_fresh"), {(s.kind, s.key) for s in signals})


class OrchestratorOrgan(unittest.TestCase):
    """The doctor reads the orchestrator's exit streak (2026-09-12 finding).

    The fixture replays the live store's shape in miniature — the rows below
    are trimmed copies of `origin/aria/state` `tools/governance.jsonl` and
    `tools/autonomy_state.jsonl` for the last three runs (2026-08-22,
    2026-09-04 x2): every run exited ``cycle_failed``, each cycle's
    ``cycle_completed`` row recorded a DIFFERENT cause (a failed
    ``product_fitness`` phase; ``integrity_failed`` from 158 stranded
    artifact-index rows; the same plus a ``budget_exceeded`` tool). Before
    this organ the doctor read that store as healthy.

    The refusal rows are written here directly, one per cycle in the v2
    shape (owner named), to exercise the histogram reader; the adopter
    itself now discloses a refusal once per claim, so a live v2 ledger shows
    a standing block on the night it first appeared, not on every night.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _exit(self, reason: str, cycles_completed: int) -> None:
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(self.tools, "autonomy_orchestrator_exit", {
            "auto_merges_completed": 0, "cycles_completed": cycles_completed,
            "daemon_id": "autonomy", "exit_reason": reason,
            "planner_claims_dispatched": 0, "worker_assignments_dispatched": 0,
        })

    def _refused(self, cycle_id: str, source_id: str) -> None:
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(self.tools, "mission_candidate_refused", {
            "schema_version": 2, "cycle_id": cycle_id, "reason": "candidate_blocked",
            "source": "capability_gap", "source_id": source_id,
            "blocked_by": ["genesis_adjudication_required"], "owner": "agent_panel",
            "operator_action": "genesis_adjudication_required: none: the genesis panel adjudicates this gap",
            "unregistered_block_tokens": [],
        })

    def _cycle_completed(self, cycle_id: str, status: str, summary: dict) -> None:
        from aria_kernel.autonomy_state import AutonomyStateReducer

        AutonomyStateReducer.transition(
            self.tools, cycle_id=cycle_id, phase="cycle_started", status="ok", profile="standard",
        )
        AutonomyStateReducer.transition(
            self.tools, cycle_id=cycle_id, phase="cycle_completed", status=status,
            profile="standard", details={"summary": {"schema_version": 2, "cycle_id": cycle_id, **summary}},
        )

    def _live_streak(self) -> None:
        self._cycle_completed("cyc-20260822T153253Z-auto", "failed", {
            "status": "failed", "runtime_status": "failed",
            "failed_phases": [{"phase": "product_fitness", "status": "failed",
                               "error": "raw_jsonl_declared_surface_rejected: surface='product_fitness'"}],
            "non_ok_tools": [], "artifact_integrity": {"status": "ok", "valid": True, "issues": []},
        })
        self._refused("cyc-20260822T153253Z-auto", "shadow_run:doc-staleness-adapter")
        self._exit("cycle_failed", 0)
        self._cycle_completed("cyc-20260904T093220Z-auto", "failed", {
            "status": "failed", "runtime_status": "integrity_failed", "failed_phases": [],
            "non_ok_tools": [{"tool_id": "test-gap-adapter", "status": "budget_exceeded", "artifact_status": "present"}],
            "artifact_integrity": {"status": "drift", "valid": False, "issues": [
                {"code": "run_artifact_missing", "artifact_id": f"cyc-20260810T063724Z-auto.{n}.tool_run"}
                for n in range(158)
            ]},
        })
        self._refused("cyc-20260904T093220Z-auto", "shadow_run:doc-staleness-adapter")
        self._refused("cyc-20260904T093220Z-auto", "shadow_run:test-gap-adapter")
        self._exit("cycle_failed", 0)
        self._cycle_completed("cyc-20260904T194353Z-auto", "failed", {
            "status": "failed", "runtime_status": "integrity_failed", "failed_phases": [],
            "non_ok_tools": [],
            "artifact_integrity": {"status": "drift", "valid": False, "issues": [
                {"code": "run_artifact_missing", "artifact_id": f"cyc-20260810T063724Z-auto.{n}.tool_run"}
                for n in range(158)
            ]},
        })
        self._refused("cyc-20260904T194353Z-auto", "shadow_run:doc-staleness-adapter")
        self._exit("cycle_failed", 0)

    def test_the_live_streak_is_a_fail_that_names_each_cause_and_the_refusals(self) -> None:
        self._live_streak()

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("fail", "orchestrator_exits_all_cycle_failed:3"))
        self.assertEqual([e["exit_reason"] for e in check.detail["exits"]], ["cycle_failed"] * 3)
        causes = {c["cycle_id"]: c for c in check.detail["failed_cycles"]}
        self.assertEqual(
            [c["cycle_id"] for c in check.detail["failed_cycles"]],
            ["cyc-20260904T194353Z-auto", "cyc-20260904T093220Z-auto", "cyc-20260822T153253Z-auto"],
        )
        self.assertEqual(causes["cyc-20260822T153253Z-auto"]["failed_phases"][0]["phase"], "product_fitness")
        self.assertEqual(causes["cyc-20260904T093220Z-auto"]["runtime_status"], "integrity_failed")
        self.assertEqual(causes["cyc-20260904T093220Z-auto"]["artifact_integrity"], {"status": "drift", "issue_count": 158})
        self.assertEqual(causes["cyc-20260904T093220Z-auto"]["non_ok_tools"], [{"tool_id": "test-gap-adapter", "status": "budget_exceeded"}])
        self.assertEqual(check.detail["refusals_by_reason"], {"candidate_blocked": 4})
        self.assertEqual(check.detail["refusals_by_owner"], {"agent_panel": 4})

    def test_the_streak_reaches_the_report_and_its_exit_code(self) -> None:
        self._live_streak()

        report = run_doctor(base_dir=self.tools, workspace_root=self.root)

        by_name = {check.name: check for check in report.checks}
        self.assertEqual(by_name["orchestrator"].status, "fail")
        self.assertEqual(report.exit_code, DOCTOR_EXIT_UNHEALTHY)
        self.assertIn("[FAIL] orchestrator — orchestrator_exits_all_cycle_failed:3", render_doctor_text(report))

    def test_one_bad_night_after_good_ones_is_a_warn(self) -> None:
        self._exit("max_cycles", 1)
        self._exit("max_cycles", 1)
        self._cycle_completed("cyc-bad", "failed", {"status": "failed", "runtime_status": "failed", "failed_phases": [], "non_ok_tools": []})
        self._exit("cycle_failed", 0)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("warn", "last_orchestrator_exit_cycle_failed"))
        self.assertEqual(check.detail["failed_cycles"][0]["cycle_id"], "cyc-bad")

    def test_a_single_failed_exit_is_a_warn_not_a_streak(self) -> None:
        self._exit("cycle_failed", 0)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("warn", "last_orchestrator_exit_cycle_failed"))

    def test_a_single_clean_exit_is_ok_with_insufficient_history(self) -> None:
        self._exit("max_cycles", 1)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("ok", "insufficient_history"))

    def test_clean_exits_are_ok_and_an_empty_store_is_ok(self) -> None:
        self.assertEqual(doctor._check_orchestrator(self.tools).status, "ok")
        self._exit("max_cycles", 1)
        self._exit("max_cycles", 1)
        self._exit("max_cycles", 1)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual(check.detail["failed_cycles"], [])



class CliSurface(unittest.TestCase):
    def test_doctor_parses_with_the_tools_dir_parent(self) -> None:
        args = build_parser().parse_args(["doctor", "--json", "--tools-dir", "/tmp/x"])
        self.assertEqual(args.command, "doctor")
        self.assertTrue(args.json)
        self.assertEqual(args.tools_dir, "/tmp/x")


if __name__ == "__main__":
    unittest.main()
