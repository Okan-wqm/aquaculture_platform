"""ARIA-HIGH-098 (verifier defect 2) — the cycles a QUARANTINED tool sits out count as degraded.

A tool ``tool_health`` quarantines on the spot is never dispatched again by
``cycle._phase_tools``, so a streak read off its own runs froze at 1 and the
operator record could never open for the class trial eleven hit. These pin
the reader that turns the cycle ledger into the tool's sat-out cycles.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.quarantine import append_quarantine_event
from aria_kernel.tool_degradation import trailing_degraded_cycles
from aria_kernel.tool_registry import ensure_tools_dir, parse_utc_stamp, utc_now
from aria_kernel.tool_sit_out import (
    QUARANTINED_CLASS,
    cycles_started_since,
    quarantine_reason,
    quarantine_took_effect_at,
    released_after,
    sat_out_cycles,
)


# One clock reading per TEST: every stamp a fixture writes is an offset from
# the same second, so an assertion that recomputes "now" can never land one
# second after the row it compares against (the boundary these tests
# exercise is "at or after" to the second — a second-resolution race in the
# fixture itself read as a red gate under a four-hour pre-push suite). Read
# in setUp, not at import: unittest imports every module before it runs
# any, and a fixture stamped hours before the rows the kernel stamps "now"
# would invert the orderings the release tests rely on.
_BASE = parse_utc_stamp(utc_now())


def _reset_clock() -> None:
    global _BASE
    _BASE = parse_utc_stamp(utc_now())
    assert _BASE is not None


def _stamp(offset_seconds: int) -> str:
    assert _BASE is not None
    return (_BASE + timedelta(seconds=offset_seconds)).replace(microsecond=0).isoformat()


class SitOutReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_clock()
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-098-sitout-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")

    def _start_cycle(self, cycle_id: str, at: str) -> None:
        append_declared_jsonl(
            self.tools / "cycles.jsonl",
            {"schema_version": 3, "at": at, "cycle_id": cycle_id, "event": "started", "status": "started"},
            expected_surface="cycles",
        )

    def _quarantined_tool(self, at: str, *, reason: str = "invalid output schema") -> dict:
        return {
            "tool_id": "dark-adapter",
            "status": "QUARANTINED",
            "last_transition": {"at": at, "from": "SHADOW", "to": "QUARANTINED", "reason": reason},
        }

    def test_only_a_quarantined_tool_has_a_start_of_sit_out(self) -> None:
        tool = self._quarantined_tool(_stamp(0))
        self.assertIsNotNone(quarantine_took_effect_at(tool, self.tools))
        self.assertEqual(quarantine_reason(tool), "invalid output schema")
        self.assertIsNone(quarantine_took_effect_at({**tool, "status": "CALIBRATE"}, self.tools))
        self.assertEqual(sat_out_cycles({**tool, "status": "SHADOW"}, ran_in_cycles=set(), base_dir=self.tools), [])

    def test_cycles_started_at_or_after_the_quarantine_count_and_the_answered_one_does_not(self) -> None:
        # ``utc_now`` stamps to the second: the next cycle can start within
        # the same second the previous cycle's tools phase quarantined the
        # tool, so the boundary is "at or after" and the quarantining cycle
        # is excluded by the tool's run in it, never by the clock.
        self._start_cycle("cyc-0", _stamp(-10))
        self._start_cycle("cyc-1", _stamp(-5))
        self._start_cycle("cyc-2", _stamp(-5))
        self._start_cycle("cyc-3", _stamp(0))
        tool = self._quarantined_tool(_stamp(-5))
        self.assertEqual(cycles_started_since(parse_utc_stamp(_stamp(-5)), self.tools), ["cyc-1", "cyc-2", "cyc-3"])
        self.assertEqual(sat_out_cycles(tool, ran_in_cycles={"cyc-0", "cyc-1"}, base_dir=self.tools), ["cyc-3", "cyc-2"])

    def test_the_quarantine_ledger_dates_a_registry_row_with_no_dated_transition(self) -> None:
        append_quarantine_event({"tool_id": "dark-adapter", "run_id": "r-1", "reason": "x", "status": "QUARANTINED"}, self.tools)
        row = json.loads((self.tools / "quarantine.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        undated = {"tool_id": "dark-adapter", "status": "QUARANTINED"}
        self.assertEqual(quarantine_took_effect_at(undated, self.tools), parse_utc_stamp(row["at"]))
        # One anchor for the date AND the reason: the ledger row carries both.
        self.assertEqual(quarantine_reason(undated, self.tools), "x")
        self.assertIsNone(quarantine_reason(undated), "no ledger to read: no reason")

    def test_a_manifest_re_sync_that_drops_the_transition_keeps_the_reason(self) -> None:
        # The production path: the nightly manifest re-sync re-registers a
        # shipped adapter with its live status, which replaces the registry
        # row wholesale and drops ``last_transition``. The streak was already
        # dated from the quarantine ledger; the reason read only the row, so
        # from night 2 the operator record said ``QUARANTINED (None)``.
        from aria_kernel.quarantine import quarantine_tool
        from aria_kernel.tool_degradation import sat_out_record
        from aria_kernel.tool_registry import get_tool, register_tool
        from aria_kernel.tool_sit_out import standing_quarantine
        from tests.test_enterprise_cycle import shadow_tool

        manifest = shadow_tool()
        register_tool(manifest, base_dir=self.tools)
        quarantine_tool(manifest["tool_id"], "invalid output schema", base_dir=self.tools)
        dated = get_tool(manifest["tool_id"], self.tools)
        self.assertEqual(dated["last_transition"]["to"], "QUARANTINED")
        register_tool({**manifest, "status": "QUARANTINED"}, base_dir=self.tools)  # the re-sync
        resynced = get_tool(manifest["tool_id"], self.tools)
        self.assertNotIn("last_transition", resynced, "the premise: the re-sync drops the transition")
        standing = standing_quarantine(resynced, self.tools)
        self.assertEqual(standing.reason, "invalid output schema")
        self.assertEqual(standing.at, parse_utc_stamp(dated["last_transition"]["at"]))
        self.assertEqual(sat_out_record(resynced, self.tools)["quarantine_reason"], "invalid output schema")

    def test_a_quarantine_that_cannot_be_dated_yields_no_sat_out_cycles(self) -> None:
        self._start_cycle("cyc-1", _stamp(0))
        undated = {"tool_id": "dark-adapter", "status": "QUARANTINED", "last_transition": {"to": "QUARANTINED", "at": "not a stamp"}}
        self.assertIsNone(quarantine_took_effect_at(undated, self.tools))
        self.assertEqual(sat_out_cycles(undated, ran_in_cycles=set(), base_dir=self.tools), [])

    def test_the_trailing_streak_is_sat_out_cycles_on_top_of_the_degraded_runs(self) -> None:
        # No run rows at all for this tool: an operator quarantine of a tool
        # whose last runs were fine has a streak made only of dark nights.
        self._start_cycle("cyc-1", _stamp(-2))
        self._start_cycle("cyc-2", _stamp(-1))
        tool = self._quarantined_tool(_stamp(-2), reason="operator-confirmed critical false positive")
        streak = trailing_degraded_cycles(tool, self.tools)
        self.assertEqual(
            [(entry["cycle_id"], entry["degradation_class"], entry["run_id"]) for entry in streak],
            [("cyc-2", QUARANTINED_CLASS, None), ("cyc-1", QUARANTINED_CLASS, None)],
        )

    def _run(self, cycle_id: str, *, status: str, recorded_at: str) -> None:
        append_declared_jsonl(
            self.tools / "runs.jsonl",
            {
                "schema_version": 2, "cycle_id": cycle_id, "run_id": f"run-{cycle_id}", "tool_id": "dark-adapter",
                "status": status, "recorded_at": recorded_at, "artifact_status": "present",
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

    def test_a_release_ends_the_streak_even_when_the_tool_breaks_again(self) -> None:
        # Night 1: evidence_error, quarantined. The operator releases the tool
        # (QUARANTINED -> CALIBRATE); night 5 it answers evidence_error again
        # and is re-quarantined; nights 6 and 7 it sits out. The record for
        # night 1's streak may already be resolved — the new streak must be
        # keyed on night 5, so it opens its own record.
        self._start_cycle("cyc-1", _stamp(-60))
        self._run("cyc-1", status="evidence_error", recorded_at=_stamp(-59))
        append_quarantine_event({"tool_id": "dark-adapter", "run_id": "run-cyc-1", "reason": "x", "status": "QUARANTINED"}, self.tools)
        first_quarantine = json.loads((self.tools / "quarantine.jsonl").read_text(encoding="utf-8").splitlines()[-1])["at"]
        # The ledger stamps to the second; place the re-quarantine unambiguously later.
        later = (parse_utc_stamp(first_quarantine) + timedelta(seconds=30)).replace(microsecond=0).isoformat()
        self._start_cycle("cyc-5", later)
        self._run("cyc-5", status="evidence_error", recorded_at=later)
        second = (parse_utc_stamp(later) + timedelta(seconds=1)).replace(microsecond=0).isoformat()
        self._start_cycle("cyc-6", (parse_utc_stamp(second) + timedelta(seconds=5)).isoformat())
        self._start_cycle("cyc-7", (parse_utc_stamp(second) + timedelta(seconds=10)).isoformat())
        tool = self._quarantined_tool(second, reason="self-output evidence or invalid evidence chain")
        runs_at = [parse_utc_stamp(_stamp(-59)), parse_utc_stamp(later)]
        self.assertEqual(released_after("dark-adapter", runs_at, self.tools), parse_utc_stamp(first_quarantine))
        streak = trailing_degraded_cycles(tool, self.tools)
        self.assertEqual(
            [(entry["cycle_id"], entry["degradation_class"]) for entry in streak],
            [("cyc-7", QUARANTINED_CLASS), ("cyc-6", QUARANTINED_CLASS), ("cyc-5", "evidence_error")],
        )
        self.assertNotIn("cyc-1", [entry["cycle_id"] for entry in streak])

    def test_a_standing_quarantine_with_no_run_after_it_is_not_a_release(self) -> None:
        self._run("cyc-1", status="evidence_error", recorded_at=_stamp(-5))
        append_quarantine_event({"tool_id": "dark-adapter", "run_id": "run-cyc-1", "reason": "x", "status": "QUARANTINED"}, self.tools)
        self.assertIsNone(released_after("dark-adapter", [parse_utc_stamp(_stamp(-5))], self.tools))
        self.assertIsNone(released_after("dark-adapter", [], self.tools))


if __name__ == "__main__":
    unittest.main()
