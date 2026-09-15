"""B6 — the schedule table exists by construction, not by an operator remembering a CLI.

CONFIRMED LIVE 2026-09-12: the gateway daemon ran on the runner host on
2026-09-07/08 with NO `gateway/schedules.jsonl` and zero
`gateway_schedule_changed` rows — `add_schedule` was reachable only through
`aria_kernel schedule add`, and nobody typed it. `self_improve`, `economy`,
`doctor` and `deliver` therefore never fired once. A lane whose only trigger
is a human remembering a command is a lane that is off: the ORPHAN-694 class
(mechanism present, caller absent) one more time.

Pins:
* the partition is TOTAL — every `SCHEDULE_ACTIONS` member is either a
  kernel default or operator-only WITH a stated reason, never both, never
  neither;
* every default is a schedule the scheduler itself would accept;
* the daemon seeds an empty store on start, records `gateway_schedule_changed`
  once per default and nothing on the next start;
* an operator's remove / pause / re-add is never undone by a restart, and a
  default whose code cadence drifted from the ledger is REPORTED, not
  rewritten.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.gateway import daemon as gd
from aria_kernel.gateway import scheduler as gs
from aria_kernel.gateway.default_schedules import (
    DEFAULT_SCHEDULES,
    DEFAULT_SCHEDULES_ENSURED_EVENT,
    KERNEL_DEFAULT_OPERATOR_REF,
    OPERATOR_ONLY_ACTIONS,
    ensure_default_schedules,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def governance_rows(self, kind: str) -> list[dict]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        return [row for row in load_declared_jsonl(path, expected_surface="tools_governance") if row.get("kind") == kind]

    def schedule_changes(self, event: str) -> list[dict]:
        return [row for row in self.governance_rows("gateway_schedule_changed") if (row.get("details") or {}).get("event") == event]


class ThePartitionIsTotal(unittest.TestCase):
    def test_every_schedule_action_is_a_default_or_operator_only_with_a_reason(self) -> None:
        defaults = {schedule.action for schedule in DEFAULT_SCHEDULES}
        operator_only = set(OPERATOR_ONLY_ACTIONS)
        self.assertEqual(defaults & operator_only, set(), "an action cannot be both unattended and operator-only")
        self.assertEqual(
            set(gs.SCHEDULE_ACTIONS), defaults | operator_only,
            "every closed-vocabulary action is a kernel default or an operator-only entry with a reason",
        )
        for action, reason in OPERATOR_ONLY_ACTIONS.items():
            self.assertTrue(reason.strip(), f"{action}: operator-only needs the reason it must not run unattended")

    def test_the_unattended_lanes_are_defaults(self) -> None:
        defaults = {schedule.action for schedule in DEFAULT_SCHEDULES}
        for action in ("self_improve", "economy", "doctor", "deliver"):
            self.assertIn(action, defaults)

    def test_every_default_is_a_schedule_the_scheduler_accepts(self) -> None:
        names = [schedule.name for schedule in DEFAULT_SCHEDULES]
        self.assertEqual(len(names), len(set(names)), "default names must be unique")
        for schedule in DEFAULT_SCHEDULES:
            self.assertRegex(schedule.name, gs._NAME_RE.pattern)
            self.assertEqual(gs.validate_action(schedule.action), schedule.action)
            self.assertEqual(gs.validate_cron(schedule.cron), schedule.cron)
            self.assertTrue(schedule.reason.strip(), f"{schedule.name}: a default states why it runs unattended")


class TheDaemonEnsuresTheTable(_Store):
    def _run_daemon(self) -> dict:
        # The beat is not this test's subject: `run_action` is patched so a
        # default that happens to be due in the wall-clock minute the test
        # runs does not execute a real organ here.
        with mock.patch("aria_kernel.gateway.scheduler.run_action", return_value={"action": "x", "status": "ran", "detail": {}}):
            return gd.run_gateway_daemon(base_dir=self.tools, workspace_root=self.ws, max_iterations=1, poll_interval_seconds=0.05,
                                         serve_http=False, runner=lambda argv: subprocess.CompletedProcess(argv, 0, "", ""))

    def test_the_live_shape_an_empty_store_gets_the_defaults_on_start(self) -> None:
        self.assertFalse(gs.schedules_path(self.tools).exists(), "the live store had no schedules.jsonl")
        result = self._run_daemon()
        self.assertEqual(result["exit_reason"], "max_iterations")
        table = gs.fold_schedules(self.tools)
        self.assertEqual(set(table), {schedule.name for schedule in DEFAULT_SCHEDULES})
        for schedule in DEFAULT_SCHEDULES:
            self.assertEqual((table[schedule.name].action, table[schedule.name].cron, table[schedule.name].paused),
                             (schedule.action, schedule.cron, False))
        adds = self.schedule_changes("add")
        self.assertEqual(len(adds), len(DEFAULT_SCHEDULES), "one gateway_schedule_changed row per seeded default")
        rows = load_declared_jsonl(gs.schedules_path(self.tools), expected_surface=gs.SCHEDULES_SURFACE)
        self.assertEqual({row.get("operator_ref") for row in rows if row.get("event") == "add"}, {KERNEL_DEFAULT_OPERATOR_REF})
        ensured = self.governance_rows(DEFAULT_SCHEDULES_ENSURED_EVENT)
        self.assertEqual(len(ensured), 1)
        self.assertEqual(sorted(ensured[0]["details"]["seeded"]), sorted(schedule.name for schedule in DEFAULT_SCHEDULES))

    def test_a_second_start_records_nothing(self) -> None:
        self._run_daemon()
        before = len(self.schedule_changes("add")), len(self.governance_rows(DEFAULT_SCHEDULES_ENSURED_EVENT))
        self.assertEqual(before, (len(DEFAULT_SCHEDULES), 1), "the first start seeded (not a vacuous comparison)")
        self._run_daemon()
        after = len(self.schedule_changes("add")), len(self.governance_rows(DEFAULT_SCHEDULES_ENSURED_EVENT))
        self.assertEqual(after, before, "an already-seeded table is not re-recorded on every start")

    def test_an_operator_removal_is_not_resurrected(self) -> None:
        ensure_default_schedules(base_dir=self.tools)
        gs.change_schedule("remove", name="self-improve", base_dir=self.tools, operator_ref="okan")
        result = ensure_default_schedules(base_dir=self.tools)
        self.assertNotIn("self-improve", gs.fold_schedules(self.tools), "the operator's removal stands")
        self.assertIn("self-improve", result["operator_owned"])
        self.assertEqual(result["seeded"], [])

    def test_an_operator_pause_survives_a_restart(self) -> None:
        ensure_default_schedules(base_dir=self.tools)
        gs.change_schedule("pause", name="economy", base_dir=self.tools, operator_ref="okan")
        ensure_default_schedules(base_dir=self.tools)
        self.assertTrue(gs.fold_schedules(self.tools)["economy"].paused)

    def test_a_cadence_drift_between_code_and_ledger_is_reported_not_rewritten(self) -> None:
        ensure_default_schedules(base_dir=self.tools)
        gs.change_schedule("remove", name="doctor", base_dir=self.tools, operator_ref="okan")
        gs.add_schedule(name="doctor", action="doctor", cron="7 * * * *", base_dir=self.tools, operator_ref="okan")
        result = ensure_default_schedules(base_dir=self.tools)
        self.assertEqual(gs.fold_schedules(self.tools)["doctor"].cron, "7 * * * *", "the ledger is the SSoT after seeding")
        self.assertEqual([row["name"] for row in result["drift"]], ["doctor"])
        self.assertEqual(result["drift"][0]["ledger"]["cron"], "7 * * * *")


if __name__ == "__main__":
    unittest.main()
