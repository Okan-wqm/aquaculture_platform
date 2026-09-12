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


class CliSurface(unittest.TestCase):
    def test_doctor_parses_with_the_tools_dir_parent(self) -> None:
        args = build_parser().parse_args(["doctor", "--json", "--tools-dir", "/tmp/x"])
        self.assertEqual(args.command, "doctor")
        self.assertTrue(args.json)
        self.assertEqual(args.tools_dir, "/tmp/x")


if __name__ == "__main__":
    unittest.main()
