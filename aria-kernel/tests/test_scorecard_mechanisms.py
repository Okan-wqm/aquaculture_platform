"""F1.2 — the learning log's liveness is read from the journal, and a mechanism with 30 silent cycles is listed.

WHY THIS EXISTS. ARIA-LOW-732 and ARIA-MEDIUM-733: the 2026-10-15 measurement found 5 of 69 learning
mechanisms working, and nothing in the scorecard told a dormant learner from a working one. PLAN-v2 F1.1 made
``memory/learning-events.jsonl`` the one learning journal (``memory.record_learning_event`` its one writer); F1.2
derives each mechanism's liveness from THAT journal, by the kind of its rows, and not from a separate counter
that a second writer or a stale cache could contradict. PLAN-v2 §3: a mechanism with zero contribution over 30
cycles is a quarantine candidate. This package RECORDS the candidates in the scorecard output; it deletes and
tombstones nothing.

THE API THIS PINS (new in F1.2; at the branch base none of it exists, so each test reports an assertion
failure, not an import error):
  autonomy_evidence.mechanism_contribution(rows, cycle_ids) -> {kind: count}
      the ONE computation of a mechanism's contribution: the journal rows whose ``cycle_id`` is among
      ``cycle_ids``, counted by ``event_type``. A kind with no counted row may be absent (read it with .get).
  autonomy_evidence.mechanism_scorecard(*, base_dir, cycle_ids) -> {
      "learning_log": {"rows_by_kind": {kind: rows in the whole journal}, "live": any row at all},
      "mechanisms": {name: {"contribution": int, "live": bool}},    one entry per CAPABILITY_SPECS
                                                                    ["learning_from_memory"].mechanisms
      "quarantine_candidates": [name, ...],                         sorted
  }
      ``cycle_ids`` is the cycle history, oldest first. ``contribution`` is mechanism_contribution over the NEWEST 30
      cycle ids, called through the module attribute so a second computation cannot hide beside it; ``live`` is "the
      journal holds a row of that kind" (any cycle). A declared mechanism is a candidate when its contribution is 0
      and the history holds at least 30 cycles; with fewer, nothing can be called silent for 30 cycles, so nothing
      is listed. The call reads the journal and writes nothing.
The journal fixtures below are written the way every writer writes a row (append_declared_jsonl on the
``memory_learning_events`` surface, the row shape of the F1.1 pins), so these tests do not depend on which
function appends them.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import autonomy_evidence
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

_SURFACE = "memory_learning_events"
_KINDS = ("belief_proposed", "belief_corrected", "belief_confirmed", "evidence_invalidated", "goldset_promoted")
_WINDOW = 30


def _cycles(count: int) -> list[str]:
    return [f"cyc-{index:03d}" for index in range(1, count + 1)]


def _row(cycle_id: str | None, kind: str) -> dict[str, Any]:
    return {
        "schema_version": 1, "recorded_at": "2026-10-20T00:00:00+00:00", "cycle_id": cycle_id, "event_type": kind,
        "target_type": "belief", "target_id": "B-1", "repo_state_id": None, "base_commit_sha": None,
        "evidence_hashes": [], "details": {},
    }


def _api(name: str) -> Any:
    function = getattr(autonomy_evidence, name, None)
    if function is None:
        raise AssertionError(f"F1.2: aria_kernel.autonomy_evidence.{name} does not exist")
    return function


class _Journal(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="aria-f12-")
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        self.root = ensure_tools_dir(Path(self._tmp) / "aria-tools")
        self.journal = self.root / "memory" / "learning-events.jsonl"

    def write(self, *rows: tuple[str | None, str]) -> None:
        for cycle_id, kind in rows:
            append_declared_jsonl(self.journal, _row(cycle_id, kind), expected_surface=_SURFACE)

    def scorecard(self, cycle_ids: list[str]) -> dict[str, Any]:
        return _api("mechanism_scorecard")(base_dir=self.root, cycle_ids=cycle_ids)

    @staticmethod
    def log(card: dict[str, Any]) -> dict[str, Any]:
        """The two facts of the learning log this package pins (an owner may report more beside them)."""
        return {key: card["learning_log"][key] for key in ("rows_by_kind", "live")}

    def files(self) -> list[str]:
        return sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*"))


class ContributionIsOneComputation(unittest.TestCase):
    def test_it_counts_the_rows_of_the_given_cycles_by_kind(self) -> None:
        rows = [
            _row("cyc-001", "belief_confirmed"), _row("cyc-002", "belief_confirmed"),
            _row("cyc-002", "belief_proposed"), _row("cyc-009", "belief_proposed"),
            _row(None, "belief_proposed"),
        ]
        contribution = _api("mechanism_contribution")(rows, ["cyc-001", "cyc-002", "cyc-003"])
        self.assertEqual(contribution.get("belief_confirmed", 0), 2)
        self.assertEqual(contribution.get("belief_proposed", 0), 1, "a row of another cycle or of no cycle counts for none")
        self.assertEqual(contribution.get("goldset_promoted", 0), 0)

    def test_a_kind_the_vocabulary_does_not_know_is_counted_under_its_own_name_not_refused(self) -> None:
        # Rows written before the closed vocabulary stay readable as they are (F1.1): the reader applies none.
        contribution = _api("mechanism_contribution")([_row("cyc-001", "belief_recorded")], ["cyc-001"])
        self.assertEqual(contribution.get("belief_recorded", 0), 1)

    def test_no_row_and_no_cycle_contribute_nothing(self) -> None:
        compute = _api("mechanism_contribution")
        self.assertEqual(sum(compute([], ["cyc-001"]).values()), 0)
        self.assertEqual(sum(compute([_row("cyc-001", "belief_confirmed")], []).values()), 0)


class TheLearningLogsLivenessFollowsTheJournalRows(_Journal):
    def test_a_store_with_no_journal_has_a_dormant_learning_log(self) -> None:
        card = self.scorecard(_cycles(3))
        self.assertEqual(self.log(card), {"rows_by_kind": {}, "live": False})
        self.assertEqual({entry["live"] for entry in card["mechanisms"].values()}, {False})

    def test_a_row_of_a_kind_makes_that_kind_and_the_log_live_and_no_other(self) -> None:
        self.write(("cyc-001", "belief_confirmed"))
        card = self.scorecard(_cycles(3))
        self.assertEqual(self.log(card), {"rows_by_kind": {"belief_confirmed": 1}, "live": True})
        live = {name for name, entry in card["mechanisms"].items() if entry["live"]}
        self.assertEqual(live, {"belief_confirmed"})

    def test_the_rows_by_kind_are_the_journals_counts_and_follow_it_between_calls(self) -> None:
        self.write(("cyc-001", "belief_confirmed"), ("cyc-002", "belief_confirmed"), ("cyc-002", "goldset_promoted"))
        first = self.scorecard(_cycles(3))
        self.assertEqual(first["learning_log"]["rows_by_kind"], {"belief_confirmed": 2, "goldset_promoted": 1})
        self.write(("cyc-003", "evidence_invalidated"), ("cyc-003", "belief_confirmed"))
        second = self.scorecard(_cycles(3))
        self.assertEqual(
            second["learning_log"]["rows_by_kind"],
            {"belief_confirmed": 3, "goldset_promoted": 1, "evidence_invalidated": 1},
        )
        self.assertTrue(second["mechanisms"]["evidence_invalidated"]["live"])
        self.assertFalse(first["mechanisms"]["evidence_invalidated"]["live"])

    def test_a_kind_older_than_the_window_is_still_live_though_it_contributes_nothing(self) -> None:
        self.write(("cyc-001", "belief_proposed"))
        card = self.scorecard(_cycles(_WINDOW + 1))
        self.assertTrue(card["mechanisms"]["belief_proposed"]["live"])
        self.assertEqual(card["mechanisms"]["belief_proposed"]["contribution"], 0)

    def test_a_row_of_no_cycle_or_of_a_cycle_outside_the_history_is_in_the_log_but_contributes_to_no_window(self) -> None:
        # F1.1 lets a writer give a row no cycle; the journal outlives the cycle history a caller passes.
        self.write((None, "belief_corrected"), ("cyc-999", "goldset_promoted"))
        card = self.scorecard(_cycles(_WINDOW))
        self.assertEqual(self.log(card), {"rows_by_kind": {"belief_corrected": 1, "goldset_promoted": 1}, "live": True})
        for name in ("belief_corrected", "goldset_promoted"):
            with self.subTest(mechanism=name):
                self.assertTrue(card["mechanisms"][name]["live"])
                self.assertEqual(card["mechanisms"][name]["contribution"], 0)
                self.assertIn(name, card["quarantine_candidates"])

    def test_a_row_of_a_kind_no_writer_gives_today_is_counted_in_the_log_and_breaks_nothing(self) -> None:
        self.write(("cyc-001", "belief_recorded"))
        card = self.scorecard(_cycles(3))
        self.assertEqual(card["learning_log"]["rows_by_kind"], {"belief_recorded": 1})
        self.assertTrue(card["learning_log"]["live"])
        self.assertNotIn("belief_recorded", card["mechanisms"])

    def test_the_liveness_is_a_function_of_the_journal_alone_no_counter_is_kept(self) -> None:
        self.write(("cyc-001", "belief_confirmed"), ("cyc-002", "goldset_promoted"))
        before = self.files()
        card = self.scorecard(_cycles(3))
        self.assertEqual(self.files(), before, "reading the scorecard wrote a file")
        # The same journal bytes in a store that has nothing else give the same answer: nothing but the journal was read.
        other = ensure_tools_dir(Path(self._tmp) / "other-tools")
        (other / "memory").mkdir(exist_ok=True)
        shutil.copyfile(self.journal, other / "memory" / "learning-events.jsonl")
        moved = _api("mechanism_scorecard")(base_dir=other, cycle_ids=_cycles(3))
        self.assertEqual(self.log(moved), self.log(card))
        self.assertEqual(moved["mechanisms"], card["mechanisms"])
        self.assertEqual(moved["quarantine_candidates"], card["quarantine_candidates"])


class AMechanismSilentForThirtyCyclesIsListedAsAQuarantineCandidate(_Journal):
    def _fixture(self, cycles: int) -> dict[str, Any]:
        # belief_confirmed: every cycle; belief_corrected: only the OLDEST cycle of the newest-30 window;
        # belief_proposed: only the cycle just before that window; evidence_invalidated, goldset_promoted: never.
        ids = _cycles(cycles)
        window = ids[-_WINDOW:]
        self.write(*[(cycle_id, "belief_confirmed") for cycle_id in ids])
        self.write((window[0], "belief_corrected"))
        if len(ids) > _WINDOW:
            self.write((ids[-_WINDOW - 1], "belief_proposed"))
        return self.scorecard(ids)

    def test_silent_and_never_written_mechanisms_are_listed_and_the_contributing_ones_are_not(self) -> None:
        card = self._fixture(_WINDOW + 1)
        self.assertEqual(card["quarantine_candidates"], ["belief_proposed", "evidence_invalidated", "goldset_promoted"])
        contribution = {name: entry["contribution"] for name, entry in card["mechanisms"].items()}
        self.assertEqual(contribution, {
            "belief_confirmed": _WINDOW, "belief_corrected": 1, "belief_proposed": 0,
            "evidence_invalidated": 0, "goldset_promoted": 0,
        })
        self.assertEqual(set(card["mechanisms"]), set(_KINDS))

    def test_a_row_in_the_oldest_cycle_of_the_window_still_counts(self) -> None:
        self.write(("cyc-002", "goldset_promoted"))
        card = self.scorecard(_cycles(_WINDOW + 1))
        self.assertEqual(card["mechanisms"]["goldset_promoted"]["contribution"], 1)
        self.assertNotIn("goldset_promoted", card["quarantine_candidates"])

    def test_a_row_one_cycle_before_the_window_does_not_count(self) -> None:
        self.write(("cyc-001", "goldset_promoted"))
        card = self.scorecard(_cycles(_WINDOW + 1))
        self.assertEqual(card["mechanisms"]["goldset_promoted"]["contribution"], 0)
        self.assertIn("goldset_promoted", card["quarantine_candidates"])

    def test_exactly_thirty_cycles_of_silence_is_enough(self) -> None:
        self.write(*[(cycle_id, "belief_confirmed") for cycle_id in _cycles(_WINDOW)])
        card = self.scorecard(_cycles(_WINDOW))
        self.assertEqual(card["quarantine_candidates"], ["belief_corrected", "belief_proposed", "evidence_invalidated",
                                                         "goldset_promoted"])

    def test_fewer_than_thirty_cycles_cannot_make_a_mechanism_silent_for_thirty(self) -> None:
        card = self.scorecard(_cycles(_WINDOW - 1))
        self.assertEqual(card["quarantine_candidates"], [])
        self.assertEqual({entry["contribution"] for entry in card["mechanisms"].values()}, {0})

    def test_a_store_with_no_journal_lists_every_mechanism_once_thirty_cycles_have_passed(self) -> None:
        card = self.scorecard(_cycles(_WINDOW))
        self.assertEqual(card["quarantine_candidates"], sorted(_KINDS))

    def test_recording_the_candidates_deletes_nothing(self) -> None:
        self.write(("cyc-031", "belief_confirmed"))
        before = self.journal.read_bytes()
        self.scorecard(_cycles(_WINDOW + 1))
        self.assertEqual(self.journal.read_bytes(), before)

    def test_the_scorecards_contribution_is_the_one_computation_not_a_second_one(self) -> None:
        self.write(("cyc-001", "belief_confirmed"))
        sentinel = {"belief_confirmed": 99, "goldset_promoted": 7}
        calls: list[Any] = []

        def computed(rows: Any, cycle_ids: Any) -> dict[str, int]:
            calls.append(list(cycle_ids))
            return sentinel

        _api("mechanism_contribution")
        with mock.patch.object(autonomy_evidence, "mechanism_contribution", computed):
            card = self.scorecard(_cycles(_WINDOW + 5))
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            (len(calls[0]), set(calls[0])), (_WINDOW, set(_cycles(_WINDOW + 5)[-_WINDOW:])),
            "the contribution is computed over the newest 30 cycles",
        )
        self.assertEqual(card["mechanisms"]["belief_confirmed"]["contribution"], 99)
        self.assertEqual(card["mechanisms"]["goldset_promoted"]["contribution"], 7)
        self.assertNotIn("goldset_promoted", card["quarantine_candidates"])
        self.assertIn("belief_proposed", card["quarantine_candidates"])


if __name__ == "__main__":
    unittest.main()
