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

    def _seed_minted_plan(self, tools: Path, *, cycle_id: str = "cycle-1") -> None:
        """The orchestrator's own evidence of a minted plan: its state row."""
        from aria_kernel.autonomy_state import PLAN_MINTED_PHASE, AutonomyStateReducer

        AutonomyStateReducer.transition(tools, cycle_id=cycle_id, phase=PLAN_MINTED_PHASE)

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


class CliSurface(unittest.TestCase):
    def test_doctor_parses_with_the_tools_dir_parent(self) -> None:
        args = build_parser().parse_args(["doctor", "--json", "--tools-dir", "/tmp/x"])
        self.assertEqual(args.command, "doctor")
        self.assertTrue(args.json)
        self.assertEqual(args.tools_dir, "/tmp/x")


if __name__ == "__main__":
    unittest.main()
