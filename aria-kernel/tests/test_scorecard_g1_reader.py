"""F1.2 — the G1 reader: for a cycle history, the longest gap-free run, and the first gap by name.

WHY THIS EXISTS. PLAN-v2 §4, G1: "14 consecutive cycles, every field of the F1.2 field list measured. A gap is a
missing report, a state_integrity_gap, or a field going from measured back to None." The gate needs a reader
that turns a history into that run before anyone can evaluate it; this package writes the reader and NOT the
gate (nothing here says whether 14 was reached), so the reader's output carries a run length and a gap, never a
verdict.

THE API THIS PINS (new in F1.2; at the branch base it does not exist, so each test reports an assertion failure,
not an import error):
  autonomy_evidence.g1_gap_free_run(history, *, fields) -> {
      "fields": {name: "measured" | "none"},      every name of ``fields``, its state in the NEWEST cycle's report
      "run": int,                                 the longest run of consecutive gap-free cycles in the history
      "first_gap": None | {"cycle_id": str, "reason": str, "field": str | None},   the OLDEST gap, by name
  }
  history: a list, oldest first, one entry per cycle:
      {"cycle_id": str, "report": {field name: value or None} or None, "state_integrity_gap": bool}
      ``report`` None is a missing report; a field is measured when its value is not None (an absent key is None).
  a cycle is gap-free when its report is present, it carries no state_integrity_gap, and every listed field is
  measured. The three gap reasons are "missing_report", "state_integrity_gap" and "field_regressed_to_none" (a
  field None in a cycle after an earlier cycle of the history measured it; ``field`` names it).
  A field never measured at all is no regression: its cycles are in no run, and the reader does not call them a
  gap (first_gap is not pinned for that case).
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel import autonomy_evidence, genesis_policy

_FIELDS = ("alpha_rate", "beta_rate", "gamma_rate")
_VERDICT_KEYS = {"passed", "met", "g1_met", "verdict", "gate", "satisfied", "ok"}


def _reader() -> Any:
    reader = getattr(autonomy_evidence, "g1_gap_free_run", None)
    if reader is None:
        raise AssertionError("F1.2: aria_kernel.autonomy_evidence.g1_gap_free_run (the G1 reader) does not exist")
    return reader


def _cycle(index: int, fields: tuple[str, ...] = _FIELDS, *, none: tuple[str, ...] = (), missing: bool = False,
           integrity_gap: bool = False) -> dict[str, Any]:
    report = None if missing else {name: (None if name in none else 0.5) for name in fields}
    return {"cycle_id": f"cyc-{index:03d}", "report": report, "state_integrity_gap": integrity_gap}


def _history(count: int, **special: dict[str, Any]) -> list[dict[str, Any]]:
    """``count`` measured cycles, numbered from 1; ``special`` maps ``cyc-NNN`` to the keyword overrides of _cycle."""
    return [_cycle(index, **special.get(f"cyc-{index:03d}", {})) for index in range(1, count + 1)]


def _gap(result: dict[str, Any]) -> dict[str, Any]:
    """The three facts of a gap this package pins (the reader may report more beside them)."""
    gap = result["first_gap"]
    if gap is None:
        raise AssertionError("F1.2: the reader named no gap")
    return {key: gap[key] for key in ("cycle_id", "reason", "field")}


def _run(history: list[dict[str, Any]], fields: tuple[str, ...] = _FIELDS) -> dict[str, Any]:
    return _reader()(history, fields=fields)


class AScorecardRunReportsEveryFieldAndTheRun(unittest.TestCase):
    def test_a_fully_measured_history_reports_every_field_measured_and_its_whole_length(self) -> None:
        result = _run(_history(16))
        self.assertEqual(result["fields"], {name: "measured" for name in _FIELDS})
        self.assertEqual(result["run"], 16)
        self.assertIsNone(result["first_gap"])

    def test_it_reports_the_fields_of_the_registered_g1_list(self) -> None:
        accessor = getattr(genesis_policy, "gates_policy", None)
        if accessor is None:
            raise AssertionError("F1.2: aria_kernel.genesis_policy.gates_policy does not exist")
        g1 = accessor()["g1"]
        fields = tuple(g1["fields"])
        history = [_cycle(index, fields) for index in range(1, g1["consecutive_cycles"] + 3)]
        result = _run(history, fields)
        self.assertEqual(set(result["fields"]), set(fields))
        self.assertEqual(set(result["fields"].values()), {"measured"})
        self.assertEqual(result["run"], len(history))

    def test_a_field_none_in_the_newest_report_is_reported_none_and_the_rest_measured(self) -> None:
        history = _history(5, **{"cyc-005": {"none": ("beta_rate",)}})
        self.assertEqual(
            _run(history)["fields"],
            {"alpha_rate": "measured", "beta_rate": "none", "gamma_rate": "measured"},
        )

    def test_an_absent_key_is_none_like_an_explicit_none(self) -> None:
        history = _history(3)
        del history[-1]["report"]["gamma_rate"]
        result = _run(history)
        self.assertEqual(result["fields"]["gamma_rate"], "none")
        self.assertEqual(result["run"], 2)

    def test_the_states_are_those_of_the_newest_cycle_whatever_the_older_ones_were(self) -> None:
        history = _history(4, **{"cyc-001": {"none": ("alpha_rate",)}})
        self.assertEqual(set(_run(history)["fields"].values()), {"measured"})

    def test_a_missing_newest_report_leaves_every_field_none(self) -> None:
        history = _history(4, **{"cyc-004": {"missing": True}})
        self.assertEqual(set(_run(history)["fields"].values()), {"none"})

    def test_it_returns_a_run_and_a_gap_never_a_verdict(self) -> None:
        # Nothing in this package evaluates the gate: 14 is the policy's number and the gate's business.
        result = _run(_history(20))
        self.assertEqual(set(result) & _VERDICT_KEYS, set())
        self.assertEqual(result["run"], 20)

    def test_an_empty_history_has_no_run_and_no_gap(self) -> None:
        result = _run([])
        self.assertEqual(result["run"], 0)
        self.assertIsNone(result["first_gap"])
        self.assertEqual(set(result["fields"].values()), {"none"})


class AFieldRegressingToNoneResetsTheRunAndNamesItself(unittest.TestCase):
    def test_the_run_stops_before_the_regressed_cycle_and_the_gap_names_field_and_cycle(self) -> None:
        history = _history(14, **{"cyc-011": {"none": ("beta_rate",)}})
        result = _run(history)
        self.assertEqual(result["run"], 10)
        self.assertEqual(
            _gap(result),
            {"cycle_id": "cyc-011", "reason": "field_regressed_to_none", "field": "beta_rate"},
        )

    def test_the_run_restarts_after_the_gap_and_the_longest_one_is_reported(self) -> None:
        history = _history(13, **{"cyc-004": {"none": ("alpha_rate",)}})
        self.assertEqual(_run(history)["run"], 9)

    def test_the_longest_of_several_runs_is_reported(self) -> None:
        history = _history(
            20,
            **{"cyc-005": {"none": ("gamma_rate",)}, "cyc-012": {"none": ("alpha_rate",)}},
        )
        # runs: cyc-001..004 (4), cyc-006..011 (6), cyc-013..020 (8)
        self.assertEqual(_run(history)["run"], 8)

    def test_a_field_measured_again_after_its_gap_is_still_a_gap_at_the_first_regression(self) -> None:
        history = _history(
            12,
            **{"cyc-003": {"none": ("alpha_rate",)}, "cyc-008": {"none": ("alpha_rate",)}},
        )
        gap = _gap(_run(history))
        self.assertEqual((gap["cycle_id"], gap["field"]), ("cyc-003", "alpha_rate"))

    def test_the_first_gap_is_the_oldest_of_several_kinds(self) -> None:
        history = _history(
            12,
            **{"cyc-004": {"missing": True}, "cyc-009": {"none": ("gamma_rate",)}},
        )
        gap = _gap(_run(history))
        self.assertEqual((gap["cycle_id"], gap["reason"]), ("cyc-004", "missing_report"))


class AMissingReportOrAStateIntegrityGapIsAGapToo(unittest.TestCase):
    def test_a_missing_report_ends_the_run_and_is_named(self) -> None:
        history = _history(9, **{"cyc-006": {"missing": True}})
        result = _run(history)
        self.assertEqual(result["run"], 5)
        self.assertEqual(_gap(result), {"cycle_id": "cyc-006", "reason": "missing_report", "field": None})

    def test_a_state_integrity_gap_ends_the_run_though_the_cycle_reported_every_field(self) -> None:
        history = _history(9, **{"cyc-007": {"integrity_gap": True}})
        result = _run(history)
        self.assertEqual(result["run"], 6)
        self.assertEqual(
            _gap(result),
            {"cycle_id": "cyc-007", "reason": "state_integrity_gap", "field": None},
        )

    def test_a_missing_report_in_the_first_cycle_is_a_gap_and_the_run_starts_after_it(self) -> None:
        history = _history(6, **{"cyc-001": {"missing": True}})
        result = _run(history)
        self.assertEqual(result["run"], 5)
        self.assertEqual(_gap(result)["cycle_id"], "cyc-001")


class AFieldNeverMeasuredIsInNoRun(unittest.TestCase):
    def test_a_field_none_in_every_cycle_leaves_no_gap_free_cycle(self) -> None:
        history = [_cycle(index, none=("beta_rate",)) for index in range(1, 8)]
        result = _run(history)
        self.assertEqual(result["run"], 0)
        self.assertEqual(result["fields"]["beta_rate"], "none")

    def test_a_field_first_measured_late_starts_the_run_at_its_first_measurement(self) -> None:
        history = [
            *[_cycle(index, none=("gamma_rate",)) for index in range(1, 5)],
            *[_cycle(index) for index in range(5, 12)],
        ]
        self.assertEqual(_run(history)["run"], 7)


if __name__ == "__main__":
    unittest.main()
