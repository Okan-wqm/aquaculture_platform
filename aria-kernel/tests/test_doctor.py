"""Plan 032 Faz 032a — `aria-kernel doctor` reads every organ and decides nothing.

The doctor is a report: each check is ok/warn/fail with a reason, an
unreadable check is a WARN naming the exception, and the exit code is
derived (0 healthy, 3 any fail) the way the runtime supervisor already
reports. The Claude CLI floor it enforces must be the floor the live lanes
enforce — three literals, one value.
"""
from __future__ import annotations

import json
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
    DOCTOR_EXIT_HEALTHY,
    DOCTOR_EXIT_UNHEALTHY,
    DoctorCheck,
    DoctorReport,
    render_doctor_text,
    run_doctor,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.git_fixtures import track_existing
from tests._helpers.orchestrator_exits import record_cycle_completed, record_exit, record_failed_night

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
    """ARIA-HIGH-500 — the Claude CLI floor has one owner, a manifest every consumer reads."""

    def test_the_doctor_reads_the_manifest(self) -> None:
        import json

        manifest = json.loads((_REPO_ROOT / doctor.CLAUDE_FLOOR_MANIFEST_RELPATH).read_text(encoding="utf-8"))
        self.assertEqual(doctor.claude_cli_version_floor(), manifest["claude_code_floor"])

    def test_no_consumer_restates_the_floor(self) -> None:
        for rel in (
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ):
            text = (_REPO_ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("claude_cli_version_floor", text, rel)
            self.assertIsNone(re.search(r'REQUIRED_CLAUDE_VERSION="[0-9.]+"', text), rel)
        provision = (_REPO_ROOT / "scripts/aria/provision_runner.sh").read_text(encoding="utf-8")
        # The provisioner reads through the same reader as the lanes, not a
        # private parse of the manifest.
        self.assertIn("claude_cli_version_floor", provision)
        self.assertNotIn('["claude_code_floor"]', provision)
        self.assertIsNone(re.search(r'CLAUDE_FLOOR="[0-9.]+"', provision))

    def test_an_unreadable_manifest_is_a_named_refusal(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(GovernanceError, "claude_floor_manifest_unreadable"):
                doctor.claude_cli_version_floor(repo_root=tmp)


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

    def test_the_learning_funnel_names_where_findings_stop_at_head(self) -> None:
        """ARIA-HIGH-004 — the learning funnel has a reader: ten raw findings
        no judge was ever asked about are a named stall at the workspace HEAD,
        and a workspace with no HEAD has no target to measure against."""
        from aria_kernel.feedback_store import record_raw_findings_for_run

        check = doctor._check_learning_funnel(self.tools, self.root)
        self.assertEqual((check.status, check.reason), ("warn", "learning_funnel_target_unresolved"))

        (self.root / "README.md").write_text("fixture\n", encoding="utf-8")
        track_existing(self.root, "README.md")
        check = doctor._check_learning_funnel(self.tools, self.root)
        self.assertEqual((check.status, check.reason), ("ok", ""))

        record_raw_findings_for_run(
            {"tool_id": "adapter-a", "run_id": "run-1", "status": "ok", "runner": {}},
            [{"id": f"F-{index}", "rule": "r", "path": "src/a.ts", "line": index, "message": f"m{index}"}
             for index in range(10)],
            base_dir=self.tools,
        )
        check = doctor._check_learning_funnel(self.tools, self.root)
        self.assertEqual((check.status, check.reason), ("warn", "learning_funnel_stalled:raw->judge_request"))
        self.assertEqual((check.detail["counts"]["raw"], check.detail["counts"]["judge_request"]), (10, 0))
        self.assertIn("learning_funnel", [c.name for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks])

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
        # ARIA-LOW-550 — lifted and ANNOUNCED (`host_fault`), never minted: a
        # dead daemon is restarted on its host, not by a change to ARIA's code.
        from aria_kernel.self_improvement import ANNOUNCE_REMEDY, scan_signals

        self._beat(age_seconds=4 * 24 * 3600)
        signals = {(s.kind, s.key): s for s in scan_signals(base_dir=self.tools, workspace_root=self.root).signals}
        self.assertEqual(signals[("host_fault", "gateway_heartbeat_fresh")].remedy, ANNOUNCE_REMEDY)
        self.assertNotIn(("doctor_fail", "gateway_heartbeat_fresh"), signals)


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
        record_exit(self.tools, reason, cycles_completed)

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
        record_cycle_completed(self.tools, cycle_id, status, summary)

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

        self.assertEqual((check.status, check.reason), ("fail", "orchestrator_exits_all_failed:3"))
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
        self.assertIn("[FAIL] orchestrator — orchestrator_exits_all_failed:3", render_doctor_text(report))

    def test_one_bad_night_after_good_ones_is_a_warn(self) -> None:
        self._exit("max_cycles", 1)
        self._exit("max_cycles", 1)
        self._cycle_completed("cyc-bad", "failed", {"status": "failed", "runtime_status": "failed", "failed_phases": [], "non_ok_tools": []})
        self._exit("cycle_failed", 0)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("warn", "last_orchestrator_exit_failed:cycle_failed"))
        self.assertEqual(check.detail["failed_cycles"][0]["cycle_id"], "cyc-bad")

    def test_a_degraded_night_is_not_a_cause_of_a_failed_exit(self) -> None:
        # ARIA-HIGH-098 — a degraded cycle completed and never produced a
        # cycle_failed exit; the tool it names belongs to the tools organ.
        self._exit("max_cycles", 1)
        self._cycle_completed("cyc-degraded", "degraded", {
            "status": "completed", "runtime_status": "degraded", "failed_phases": [],
            "non_ok_tools": [{"tool_id": "agent-harness-security-adapter", "status": "evidence_error"}],
        })
        self._exit("max_cycles", 1)
        self._cycle_completed("cyc-bad", "failed", {"status": "failed", "runtime_status": "failed", "failed_phases": [], "non_ok_tools": []})
        self._exit("cycle_failed", 0)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual(check.status, "warn")
        self.assertEqual([cause["cycle_id"] for cause in check.detail["failed_cycles"]], ["cyc-bad"])

    def test_a_single_failed_exit_is_a_warn_not_a_streak(self) -> None:
        self._exit("cycle_failed", 0)

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual((check.status, check.reason), ("warn", "last_orchestrator_exit_failed:cycle_failed"))

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

    def test_a_failing_streak_names_one_closed_cause_per_phase_and_reason(self) -> None:
        # ARIA-MEDIUM-417 — the 2026-10-09/10 nights: pr_lifecycle failed by
        # payload each night with its own refusal text (the PR-1 `error`),
        # then a night of the store failing integrity with no phase row.
        record_failed_night(self.tools, "cyc-a", failed_phases=[
            {"phase": "pr_lifecycle", "status": "failed", "error": "1 of 1 PR previews refused: open_pr_head_sha_unresolvable"}])
        record_failed_night(self.tools, "cyc-b", failed_phases=[
            {"phase": "pr_lifecycle", "status": "failed", "error": "2 of 2 PR previews refused: open_pr_head_sha_unresolvable"}])
        record_failed_night(self.tools, "cyc-c", failed_phases=[], runtime_status="integrity_failed")

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual(check.status, "fail")
        self.assertEqual([cause.key for cause in check.causes], ["cycle:integrity_failed", "pr_lifecycle:phase_failed"])
        self.assertEqual(
            check.causes[1].summary,
            "pr_lifecycle phase_failed: 2 of 2 PR previews refused: open_pr_head_sha_unresolvable",
            "the newest sighting writes the summary; the text is never part of the key",
        )

    def test_a_cause_key_carries_no_free_text_and_no_count(self) -> None:
        for night, error in enumerate(("1 of 1 PR previews refused: a", "7 of 9 PR previews refused: b: c", "KeyError: 'x'")):
            record_failed_night(self.tools, f"cyc-{night}", failed_phases=[{"phase": "pr_lifecycle", "status": "failed", "error": error}])

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual([cause.key for cause in check.causes], ["pr_lifecycle:phase_failed"])

    def test_the_live_streak_names_the_phase_and_the_store(self) -> None:
        self._live_streak()

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual([cause.key for cause in check.causes], ["cycle:integrity_failed", "product_fitness:phase_failed"])

    def test_a_whole_cycle_failure_is_keyed_on_its_runtime_verdict_or_unrecorded(self) -> None:
        # 2026-09-27: a deadline interrupted the cycle mid-phase; no phase row,
        # runtime_status failed, the reason in summary.error.
        record_failed_night(self.tools, "cyc-old", failed_phases=[], runtime_status=None)
        record_failed_night(self.tools, "cyc-cut", failed_phases=[], runtime_status="failed",
                            error="the remaining wall-clock entered the close-out margin mid-phase")

        check = doctor._check_orchestrator(self.tools)

        self.assertEqual([cause.key for cause in check.causes], ["cycle:failed", "cycle:unrecorded"])
        self.assertEqual(check.causes[0].summary, "cycle failed: the remaining wall-clock entered the close-out margin mid-phase")

    def test_a_warn_names_no_causes_and_the_report_carries_them(self) -> None:
        record_failed_night(self.tools, "cyc-1", failed_phases=[{"phase": "pr_lifecycle", "status": "failed", "error": "e"}])
        self.assertEqual(doctor._check_orchestrator(self.tools).causes, (), "one bad night is a warn, not a cause to mint")
        record_failed_night(self.tools, "cyc-2", failed_phases=[{"phase": "pr_lifecycle", "status": "failed", "error": "e"}])

        # As `aria-kernel doctor --json` prints it.
        report = json.loads(json.dumps(run_doctor(base_dir=self.tools, workspace_root=self.root).to_dict()))

        organ = next(check for check in report["checks"] if check["name"] == "orchestrator")
        self.assertEqual(organ["causes"], [{"key": "pr_lifecycle:phase_failed", "summary": "pr_lifecycle phase_failed: e"}])


class ToolsOrgan(unittest.TestCase):
    """ARIA-HIGH-098 — the adapters that are not answering, by name and class."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)
        (self.root / "src").mkdir()
        (self.root / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        # A checkout: the adapter room shows what git tracks (ARIA-MEDIUM-432).
        track_existing(self.root, "src")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _tool(self, tool_id: str, *, exit_code: int = 0) -> None:
        from aria_kernel import register_tool
        from tests.test_enterprise_cycle import fake_tool_argv, shadow_tool, tool_output

        tool = shadow_tool()
        tool["tool_id"] = tool_id
        tool["runner"] = {**tool["runner"], "argv": [*fake_tool_argv(tool_output()), "--exit-code", str(exit_code)]}
        register_tool(tool, base_dir=self.tools)

    def _run(self, tool_id: str, cycle_id: str) -> str:
        from aria_kernel import run_tool

        return run_tool(tool_id, {}, cycle_id, workspace_root=self.root, base_dir=self.tools)["envelope"]["status"]

    def test_an_empty_roster_and_an_answering_tool_are_ok(self) -> None:
        self.assertEqual(doctor._check_tools(self.tools).status, "ok")
        self._tool("fine-tool")
        self.assertEqual(self._run("fine-tool", "cyc-1"), "ok")
        check = doctor._check_tools(self.tools)
        self.assertEqual((check.status, check.detail["degraded"], check.detail["quarantined"]), ("ok", [], []))

    def test_a_degraded_tool_is_a_warn_naming_the_class_and_the_streak(self) -> None:
        self._tool("dark-tool", exit_code=2)
        self._run("dark-tool", "cyc-1")
        self._run("dark-tool", "cyc-2")
        check = doctor._check_tools(self.tools)
        self.assertEqual((check.status, check.reason), ("warn", "tools_degraded:dark-tool=crashx2"))
        self.assertEqual(check.detail["degraded"][0]["latest_cycle_id"], "cyc-2")
        self.assertFalse(check.detail["degraded"][0]["human_required"])
        self.assertIn("[WARN] tools — tools_degraded:dark-tool=crashx2", render_doctor_text(run_doctor(base_dir=self.tools, workspace_root=self.root)))

    def test_a_streak_at_the_human_required_line_is_a_fail(self) -> None:
        from aria_kernel.tool_degradation import TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK

        self._tool("dark-tool", exit_code=2)
        for n in range(TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK):
            self._run("dark-tool", f"cyc-{n}")
        check = doctor._check_tools(self.tools)
        self.assertEqual((check.status, check.reason), ("fail", "tools_degraded_human_required:dark-tool"))

    def test_a_recovered_tool_clears_the_streak(self) -> None:
        self._tool("flaky-tool", exit_code=2)
        self._run("flaky-tool", "cyc-1")
        self.assertEqual(doctor._check_tools(self.tools).status, "warn")
        # The operator ships the fix: the manifest re-registers with a runner
        # that answers, and the next night's run is ok.
        self._tool("flaky-tool")
        self.assertEqual(self._run("flaky-tool", "cyc-2"), "ok")
        check = doctor._check_tools(self.tools)
        self.assertEqual((check.status, check.detail["degraded"]), ("ok", []))

    def test_a_quarantined_tool_is_named_even_when_nothing_is_degraded(self) -> None:
        from aria_kernel.quarantine import quarantine_tool

        self._tool("benched-tool")
        quarantine_tool("benched-tool", "test: quarantined by hand", base_dir=self.tools)
        check = doctor._check_tools(self.tools)
        self.assertEqual((check.status, check.reason), ("warn", "tools_quarantined:benched-tool"))

    def test_the_cycles_a_quarantined_tool_sits_out_are_its_streak(self) -> None:
        # Verifier defect 2: a quarantined tool is never dispatched again, so
        # a streak read off its runs alone froze where the quarantine left
        # it and the organ could never reach FAIL for the trial-eleven class.
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.quarantine import quarantine_tool
        from aria_kernel.tool_degradation import TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK
        from aria_kernel.tool_registry import utc_now

        self._tool("benched-tool")
        quarantine_tool("benched-tool", "test: quarantined by hand", base_dir=self.tools)
        for n in range(1, TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK + 1):
            append_declared_jsonl(
                self.tools / "cycles.jsonl",
                {"schema_version": 3, "at": utc_now(), "cycle_id": f"cyc-{n}", "event": "started", "status": "started"},
                expected_surface="cycles",
            )
            check = doctor._check_tools(self.tools)
            if n < TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK:
                self.assertEqual((check.status, check.reason), ("warn", f"tools_degraded:benched-tool=quarantinedx{n}"))
            else:
                self.assertEqual((check.status, check.reason), ("fail", "tools_degraded_human_required:benched-tool"))
        self.assertEqual(check.detail["quarantined"], ["benched-tool"])
        self.assertEqual(check.detail["degraded"][0]["latest_cycle_id"], f"cyc-{TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK}")


class DeclaredAdapterDependenciesResolve(unittest.TestCase):
    """ARIA-MEDIUM-735 (PLAN-v2 F2.1) — the doctor names, before a night runs,
    an adapter whose declared repo-local dependencies the workspace does not
    provide. lint-rules-adapter needs ESLint's rule packs; a room whose
    node_modules lacks `eslint-plugin-security` (HARNESS B5) ran it into a
    crash and nothing read the cause beforehand. New API pinned here: the
    check named ``adapter_dependencies``, a FAIL naming each adapter and each
    missing path, ok once every declared path resolves."""

    CHECK = "adapter_dependencies"
    TOOL_ID = "lint-rules-adapter"
    MANIFEST_REL = "tools/aria-adapters/lint-rules-adapter.tool.json"

    def setUp(self) -> None:
        from aria_kernel import register_tool

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "work"
        manifest_text = (_REPO_ROOT / self.MANIFEST_REL).read_text(encoding="utf-8")
        (self.root / self.MANIFEST_REL).parent.mkdir(parents=True)
        (self.root / self.MANIFEST_REL).write_text(manifest_text, encoding="utf-8")
        track_existing(self.root, "tools")
        # The ts-node every `npx ts-node` runner derives is present; the rule
        # packs the lint-rules runner imports are not.
        ts_node = self.root / "node_modules" / "ts-node" / "dist" / "bin.js"
        ts_node.parent.mkdir(parents=True)
        ts_node.write_text("", encoding="utf-8")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        register_tool(json.loads(manifest_text), base_dir=self.tools)

    def _check(self) -> DoctorCheck:
        checks = {check.name: check for check in run_doctor(base_dir=self.tools, workspace_root=self.root).checks}
        self.assertIn(self.CHECK, sorted(checks), "the doctor has no declared-adapter-dependency check")
        return checks[self.CHECK]

    def test_a_missing_rule_pack_is_a_fail_naming_the_adapter_and_the_package(self) -> None:
        check = self._check()
        self.assertEqual(check.status, "fail", check)
        self.assertIn(self.TOOL_ID, check.reason)
        self.assertIn("eslint-plugin-security", check.reason + json.dumps(check.detail))

    def test_every_declared_dependency_present_is_ok(self) -> None:
        from aria_kernel.tool_registry import get_tool, runner_repo_local_dependencies

        for rel in runner_repo_local_dependencies(get_tool(self.TOOL_ID, self.tools)["runner"]):
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text("", encoding="utf-8")
        check = self._check()
        self.assertEqual((check.status, check.reason), ("ok", ""), check)


class CliSurface(unittest.TestCase):
    def test_doctor_parses_with_the_tools_dir_parent(self) -> None:
        args = build_parser().parse_args(["doctor", "--json", "--tools-dir", "/tmp/x"])
        self.assertEqual(args.command, "doctor")
        self.assertTrue(args.json)
        self.assertEqual(args.tools_dir, "/tmp/x")


if __name__ == "__main__":
    unittest.main()
