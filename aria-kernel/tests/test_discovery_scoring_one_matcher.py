"""WP-D9a — one scorer of "a known defect was hit or missed, a clean commit was alarmed".

Two scorers of ONE notion sit side by side in ``role_fitness``:

  * ``score_zoo_discovery(responses, labels)`` (D3): same file, claim lines within
    ``ZOO_LINE_WINDOW`` (10) lines either side of the label's lines, NO class
    (zoo labels carry none);
  * ``measure_discovery_recall(cases, reports)`` (D9): same path, lines overlap
    (window 0), same ``defect_class`` (gold defects always name one).

The named resolution (SPEC ruling 1): ONE matcher. A report hits a defect when it is
on the same file and its lines overlap the defect's lines widened by ``window`` on each
side, and the class must agree when, and only when, the defect names a class. The window is
a caller argument: 0 for the gold corpus, ``ZOO_LINE_WINDOW`` for the zoo. Both public
functions stay and keep their return shapes; the Wilson interval has ONE spelling
(``judge_calibration.wilson_interval`` through ``_proportion``).

What is pinned here is behaviour through the two PUBLIC functions only: the unified
matcher, its fold and the window argument have no name in the specification, so no
test reaches them. The structure (the retired names gone, one matcher, one Wilson
route, the atlas family) is pinned in tests/invariants/test_atlas_one_owner.py.

RED at the branch base (9c968ce19), by assertion, for the defect's reason:
  * ``test_a_gold_defect_that_names_no_class_...`` and
    ``test_one_fixture_gives_one_partition_through_both_public_functions`` /
    ``test_one_fixture_gives_the_same_counts_and_the_same_wilson_through_both``: the D9
    matcher reads ``defect["defect_class"]`` unconditionally, so a defect that names no
    class is a KeyError in it (the "class required when the defect names none" mutant).
    The KeyError is turned into a failure naming the rule.

GREEN at the base on purpose (characterisation: both behaviours exist today, in two
matchers; the unification must keep every one of them, and each of these is the pin of
one mutant of it): the gold matcher's class and window-0 rows, the zoo matcher's ten
lines rows and its not-a-line-number claims, the Wilson-owner equality grid (exact
equality, not ``assertAlmostEqual``: an unrounded or differently rounded upper bound
differs from the owner's by less than the tolerance a places=4 comparison allows), the
return shapes ("byte for byte") and the window-per-caller rows.

What a CONTROL does with a claim whose lines are not line numbers is pinned by the last
class, ``ControlDrawsAnyClaimTests``: D3 counted any claim a control drew as a false alarm
(``if claims:`` before any validation), the unification first dropped a malformed claim and
so made the zoo's false-alarm rate optimistic, and the ruling is that a control that draws any
claim is a false alarm, malformed or not, while a malformed claim still cannot hit a defect.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel import role_fitness
from aria_kernel.judge_calibration import wilson_interval
from aria_kernel.tool_registry import GovernanceError

FARM = "apps/farm-service/src/pond.ts"
HR = "apps/hr-service/src/leave.ts"
TENANT = "tenant_scope"
AUTHZ = "authz"
RACE = "race_condition"


def _sha(n: int) -> str:
    return f"{n:040x}"


def _subject(n: int) -> str:
    return f"change:{_sha(n + 10**6)}..{_sha(n)}"


# --- the gold corpus's shapes (measure_discovery_recall) ---------------------------------------------------------

def _defect(defect_id: str, path: str, start: int, end: int, defect_class: str | None = TENANT) -> dict[str, Any]:
    """A gold defect; ``defect_class=None`` leaves the key out, the way a zoo label carries none."""
    defect: dict[str, Any] = {"defect_id": defect_id, "path": path, "start_line": start, "end_line": end}
    if defect_class is not None:
        defect["defect_class"] = defect_class
    return defect


def _case(n: int, defects: list[dict[str, Any]]) -> dict[str, Any]:
    return {"subject_ref": _subject(n), "x_sha": _sha(n), "defects": defects}


def _report(n: int, path: str, start: int, end: int, defect_class: str = TENANT) -> dict[str, Any]:
    return {"subject_ref": _subject(n), "path": path, "start_line": start, "end_line": end, "defect_class": defect_class}


# --- the zoo's shapes (score_zoo_discovery) ----------------------------------------------------------------------

def _label(label_id: str, kind: str, file: str, start: int, end: int) -> dict[str, Any]:
    return {"id": label_id, "kind": kind, "cls": "synthetic", "file": file, "line_start": start, "line_end": end}


def _claim(file: str, start: Any, end: Any, **fields: Any) -> dict[str, Any]:
    return {"file": file, "start_line": start, "end_line": end, "claim_type": "wrong_code", **fields}


def _answer(*claims: Any) -> dict[str, Any]:
    return {"role": "change_intelligence", "details": {"impact_map": {}, "defect_claims": list(claims)}}


class _Scoring(unittest.TestCase):
    def measure(self, cases: list[dict[str, Any]], reports: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            return role_fitness.measure_discovery_recall(cases, reports)
        except KeyError as missing:
            self.fail(
                f"measure_discovery_recall read {missing} that its fixture does not carry: the matcher requires "
                "a field the defect does not name (SPEC ruling 1: the class must agree when, and only when, "
                "the defect names a class)"
            )

    def gold_hits(self, defect: dict[str, Any], report: dict[str, Any]) -> bool:
        return self.measure([_case(1, [defect])], [report])["defects"]["hits"] == 1

    def zoo(self, responses: dict[str, Any], labels: list[dict[str, Any]]) -> dict[str, Any]:
        return role_fitness.score_zoo_discovery(responses, labels)

    def zoo_hits(self, label: dict[str, Any], *claims: Any) -> bool:
        return self.zoo({label["id"]: _answer(*claims)}, [label])["defects"]["hits"] == [label["id"]]


class GoldMatcherTests(_Scoring):
    """Window 0, and the class when the defect names one (the gold corpus's matcher)."""

    DEFECT = _defect("a", FARM, 40, 52, TENANT)

    def test_a_report_of_another_class_does_not_hit_an_overlapping_defect(self) -> None:
        for label, start, end in (("inside", 44, 44), ("on the first line", 40, 40), ("on the last line", 52, 52), ("wrapping", 1, 500)):
            with self.subTest(label):
                self.assertFalse(self.gold_hits(self.DEFECT, _report(1, FARM, start, end, AUTHZ)))
                self.assertTrue(self.gold_hits(self.DEFECT, _report(1, FARM, start, end, TENANT)))

    def test_a_same_class_report_five_lines_away_does_not_hit(self) -> None:
        for label, start, end in (
            ("five lines before", 35, 35), ("five lines after", 57, 57),
            ("ends five lines before", 30, 35), ("starts five lines after", 57, 70),
            ("ten lines before", 30, 30), ("ten lines after", 62, 62),
        ):
            with self.subTest(label):
                self.assertFalse(self.gold_hits(self.DEFECT, _report(1, FARM, start, end, TENANT)))

    def test_a_same_class_overlapping_report_hits_and_the_window_is_exactly_the_defects_lines(self) -> None:
        for label, start, end, expected in (
            ("inside", 44, 44, True),
            ("first line of the defect", 30, 40, True),
            ("last line of the defect", 52, 60, True),
            ("one line before the defect", 30, 39, False),
            ("one line after the defect", 53, 60, False),
        ):
            with self.subTest(label):
                self.assertEqual(self.gold_hits(self.DEFECT, _report(1, FARM, start, end, TENANT)), expected)

    def test_a_report_on_another_file_does_not_hit_whatever_its_lines_and_class(self) -> None:
        self.assertFalse(self.gold_hits(self.DEFECT, _report(1, HR, 44, 44, TENANT)))

    def test_a_gold_defect_that_names_no_class_is_hit_by_a_report_of_any_class_and_still_by_overlap_only(self) -> None:
        # SPEC ruling 1: "the class must agree when, and only when, the defect names a class". Red at the base:
        # the D9 matcher reads defect["defect_class"] unconditionally.
        classless = _defect("z", FARM, 40, 52, None)
        for defect_class in (TENANT, AUTHZ, RACE):
            with self.subTest(report_class=defect_class):
                self.assertTrue(self.gold_hits(classless, _report(1, FARM, 44, 44, defect_class)))
        self.assertFalse(self.gold_hits(classless, _report(1, FARM, 57, 57, AUTHZ)), "the window is still 0 for the gold corpus")
        self.assertFalse(self.gold_hits(classless, _report(1, HR, 44, 44, AUTHZ)), "another file is still no hit")


class ZooMatcherTests(_Scoring):
    """Window ``ZOO_LINE_WINDOW`` and no class (the zoo's matcher: labels carry none)."""

    LABEL = _label("Z1", "defect", FARM, 100, 102)

    def test_the_zoo_window_is_ten_lines(self) -> None:
        self.assertEqual(role_fitness.ZOO_LINE_WINDOW, 10)

    def test_a_claim_ten_lines_away_hits_and_eleven_does_not(self) -> None:
        for label, start, end, expected in (
            ("line ten before the label", 90, 90, True),
            ("range ending ten before the label", 80, 90, True),
            ("line eleven before the label", 89, 89, False),
            ("range ending eleven before the label", 80, 89, False),
            ("line ten after the label", 112, 112, True),
            ("range starting ten after the label", 112, 130, True),
            ("line eleven after the label", 113, 113, False),
            ("range starting eleven after the label", 113, 130, False),
            ("on the label", 101, 101, True),
            ("spanning the label", 1, 500, True),
        ):
            with self.subTest(label):
                self.assertEqual(self.zoo_hits(self.LABEL, _claim(FARM, start, end)), expected)

    def test_a_claim_on_another_file_does_not_hit_whatever_its_lines(self) -> None:
        self.assertFalse(self.zoo_hits(self.LABEL, _claim(HR, 101, 101)))

    def test_the_class_of_a_claim_is_not_read_when_the_label_names_none(self) -> None:
        for claim_type in ("wrong_code", "authz", "tenant_scope", "anything_else"):
            with self.subTest(claim_type=claim_type):
                self.assertTrue(self.zoo_hits(self.LABEL, _claim(FARM, 112, 112, claim_type=claim_type, defect_class=AUTHZ)))

    def test_a_claim_whose_lines_are_not_line_numbers_is_no_report_and_hides_no_hit(self) -> None:
        # "exactly as _claim_hits ignored it": a string, a float, None, a missing key, a claim that is not an object at
        # all, and a bool (an int in Python: True is line 1, so it is tried against a label that line 1 would hit).
        near_the_top = _label("Z0", "defect", FARM, 1, 2)
        malformed: list[tuple[dict[str, Any], Any]] = [
            (self.LABEL, _claim(FARM, "101", "101")), (self.LABEL, _claim(FARM, 101.0, 101.0)),
            (self.LABEL, _claim(FARM, None, None)), (self.LABEL, {"file": FARM}), (self.LABEL, "not a claim"),
            (self.LABEL, None), (self.LABEL, 7), (self.LABEL, [FARM, 101, 101]),
            (near_the_top, _claim(FARM, True, True)), (near_the_top, _claim(FARM, False, True)),
        ]
        for label, claim in malformed:
            with self.subTest(claim=repr(claim)):
                line = label["line_start"] + 1
                self.assertFalse(self.zoo_hits(label, claim))
                self.assertTrue(self.zoo_hits(label, claim, _claim(FARM, line, line)))


class OneFoldTests(_Scoring):
    """One fixture through both public functions: one partition of the known defects, one set of alarms."""

    # (name, lines of the claim/report relative to a defect at 100..102). Every row is insensitive to the window: it
    # overlaps the defect or it is more than ten lines from it, so ONE matcher with the same window gives one answer.
    WINDOW_INSENSITIVE = (
        ("inside", 101, 101, True),
        ("first line", 90, 100, True),
        ("last line", 102, 150, True),
        ("wrapping", 1, 500, True),
        ("eleven before", 89, 89, False),
        ("far before", 1, 20, False),
        ("eleven after", 113, 113, False),
        ("far after", 400, 450, False),
    )

    def test_one_fixture_gives_one_partition_through_both_public_functions(self) -> None:
        for name, start, end, expected in self.WINDOW_INSENSITIVE:
            with self.subTest(name):
                gold = self.gold_hits(_defect("g", FARM, 100, 102, None), _report(1, FARM, start, end, AUTHZ))
                zoo = self.zoo_hits(_label("Z1", "defect", FARM, 100, 102), _claim(FARM, start, end))
                self.assertEqual((gold, zoo), (expected, expected))

    def test_the_window_is_the_callers_not_the_matchers(self) -> None:
        # The same lines, five and ten lines from the defect: the zoo's window hits them, the gold corpus's does not.
        for offset in (1, 5, 10):
            with self.subTest(lines_away=offset):
                line = 102 + offset
                self.assertTrue(self.zoo_hits(_label("Z1", "defect", FARM, 100, 102), _claim(FARM, line, line)))
                self.assertFalse(self.gold_hits(_defect("g", FARM, 100, 102, TENANT), _report(1, FARM, line, line, TENANT)))

    def test_one_fixture_gives_the_same_counts_and_the_same_wilson_through_both(self) -> None:
        # Five defects (three hit), four clean controls (one alarmed), the same lines in both vocabularies.
        defects = (
            ("d1", FARM, 100, 102, (FARM, 101, 101)),     # hit
            ("d2", HR, 10, 20, (HR, 15, 40)),             # hit
            ("d3", FARM, 300, 310, (FARM, 1, 500)),       # hit
            ("d4", HR, 50, 55, (HR, 200, 200)),           # miss: far
            ("d5", FARM, 700, 701, (FARM, 700, 701)),     # a claim on the other file below
        )
        controls = (("c1", FARM, 5, 5, (FARM, 5, 5)), ("c2", HR, 5, 5, None), ("c3", FARM, 9, 9, None), ("c4", HR, 1, 1, None))
        labels = [_label(row[0], "defect", row[1], row[2], row[3]) for row in defects]
        labels += [_label(row[0], "control", row[1], row[2], row[3]) for row in controls]
        responses = {row[0]: _answer(_claim(*row[4])) for row in defects[:4]}
        responses["d5"] = _answer(_claim(HR, 700, 701))                      # wrong file: miss
        responses.update({row[0]: _answer(*([_claim(*row[4])] if row[4] else [])) for row in controls})
        zoo = self.zoo(responses, labels)

        cases = [_case(n, [_defect(row[0], row[1], row[2], row[3], None)]) for n, row in enumerate(defects, start=1)]
        cases += [_case(n, []) for n in range(len(defects) + 1, len(defects) + len(controls) + 1)]
        reports = [_report(n, *row[4], defect_class=AUTHZ) for n, row in enumerate(defects[:4], start=1)]
        reports.append(_report(5, HR, 700, 701, AUTHZ))
        reports.append(_report(len(defects) + 1, *controls[0][4], defect_class=RACE))
        block = self.measure(cases, reports)

        self.assertEqual(zoo["defects"]["hits"], ["d1", "d2", "d3"])
        self.assertEqual(zoo["defects"]["misses"], ["d4", "d5"])
        self.assertEqual(zoo["controls"]["false_alarms"], ["c1"])
        self.assertEqual((block["defects"]["n"], block["defects"]["hits"], block["defects"]["misses"]),
                         (zoo["defects"]["n"], len(zoo["defects"]["hits"]), len(zoo["defects"]["misses"])))
        self.assertEqual((block["clean_commits"]["n"], block["clean_commits"]["false_alarms"]),
                         (zoo["controls"]["n"], len(zoo["controls"]["false_alarms"])))
        self.assertEqual(block["defects"]["recall"], zoo["defects"]["recall"])
        self.assertEqual(block["clean_commits"]["false_alarm_rate"], zoo["controls"]["rate"])
        self.assertEqual((block["defects"]["wilson_lower"], block["defects"]["wilson_upper"]), zoo["defects"]["wilson"])
        self.assertEqual((block["clean_commits"]["wilson_lower"], block["clean_commits"]["wilson_upper"]),
                         zoo["controls"]["wilson"])


class WilsonOwnerTests(_Scoring):
    """The one Wilson spelling is ``judge_calibration.wilson_interval``: exact equality, never a tolerance."""

    def _gold_block(self, successes: int, trials: int) -> dict[str, Any]:
        """``trials`` known defects (``successes`` of them hit) and ``trials`` clean commits (``successes`` alarmed)."""
        cases = [_case(n, [_defect(f"d{n}", FARM, 10, 20, TENANT)]) for n in range(1, trials + 1)]
        cases += [_case(trials + n, []) for n in range(1, trials + 1)]
        reports = [_report(n, FARM, 15, 15, TENANT) for n in range(1, successes + 1)]
        reports += [_report(trials + n, FARM, 1, 1, TENANT) for n in range(1, successes + 1)]
        return self.measure(cases, reports)

    def _zoo_result(self, successes: int, trials: int) -> dict[str, Any]:
        labels = [_label(f"D{n:02d}", "defect", FARM, 10, 20) for n in range(1, trials + 1)]
        labels += [_label(f"C{n:02d}", "control", FARM, 10, 20) for n in range(1, trials + 1)]
        responses = {f"D{n:02d}": _answer(_claim(FARM, 15, 15)) if n <= successes else _answer() for n in range(1, trials + 1)}
        responses.update({f"C{n:02d}": _answer(_claim(FARM, 1, 1)) if n <= successes else _answer() for n in range(1, trials + 1)})
        return self.zoo(responses, labels)

    def test_the_gold_blocks_interval_is_the_owners_pair_exactly(self) -> None:
        for trials in (1, 2, 3, 4, 5, 7, 12):
            for successes in range(trials + 1):
                with self.subTest(successes=successes, trials=trials):
                    block, owner = self._gold_block(successes, trials), wilson_interval(successes, trials)
                    for part in (block["defects"], block["clean_commits"]):
                        self.assertEqual((part["wilson_lower"], part["wilson_upper"]), owner)

    def test_the_zoos_interval_is_the_owners_pair_exactly(self) -> None:
        for trials in (1, 2, 5, 12):
            for successes in range(trials + 1):
                with self.subTest(successes=successes, trials=trials):
                    result, owner = self._zoo_result(successes, trials), wilson_interval(successes, trials)
                    self.assertEqual(result["defects"]["wilson"], owner)
                    self.assertEqual(result["controls"]["wilson"], owner)

    def test_a_proportion_over_nothing_has_no_rate_and_no_interval_in_either_scorer(self) -> None:
        block = self.measure([_case(1, []), _case(2, [])], [])
        self.assertEqual(
            {key: block["defects"][key] for key in ("n", "recall", "wilson_lower", "wilson_upper")},
            {"n": 0, "recall": None, "wilson_lower": None, "wilson_upper": None},
        )
        result = self.zoo({"C1": _answer()}, [_label("C1", "control", FARM, 1, 1)])
        self.assertEqual((result["defects"]["n"], result["defects"]["recall"], result["defects"]["wilson"]), (0, None, None))
        only_defects = self.zoo({"D1": _answer()}, [_label("D1", "defect", FARM, 1, 1)])
        self.assertEqual((only_defects["controls"]["n"], only_defects["controls"]["rate"], only_defects["controls"]["wilson"]),
                         (0, None, None))


class ReturnShapeTests(_Scoring):
    """Each public function keeps its own return shape byte for byte."""

    def test_the_zoo_scorers_shape(self) -> None:
        labels = [_label("Z1", "defect", FARM, 5, 5), _label("Z2", "defect", HR, 5, 5), _label("Z3", "control", FARM, 1, 1)]
        result = self.zoo({"Z1": _answer(_claim(FARM, 5, 5)), "Z2": _answer(), "Z3": _answer(_claim(FARM, 1, 1))}, labels)
        self.assertEqual(set(result), {"defects", "controls"})
        self.assertEqual(set(result["defects"]), {"n", "hits", "misses", "recall", "wilson"})
        self.assertEqual(set(result["controls"]), {"n", "false_alarms", "rate", "wilson"})
        self.assertEqual((result["defects"]["hits"], result["defects"]["misses"], result["controls"]["false_alarms"]),
                         (["Z1"], ["Z2"], ["Z3"]))
        self.assertIsInstance(result["defects"]["wilson"], tuple)
        self.assertEqual(result["defects"]["recall"], 0.5)
        self.assertEqual(result["controls"]["rate"], 1.0)

    def test_the_zoo_scorer_still_refuses_a_label_without_an_answer_and_an_answer_for_no_label(self) -> None:
        with self.assertRaises(GovernanceError) as unanswered:
            self.zoo({}, [_label("Z1", "defect", FARM, 5, 5)])
        self.assertIn("Z1", str(unanswered.exception))
        with self.assertRaises(GovernanceError) as unknown:
            self.zoo({"Z1": _answer(), "Z9": _answer()}, [_label("Z1", "defect", FARM, 5, 5)])
        self.assertIn("Z9", str(unknown.exception))

    def test_the_gold_blocks_shape(self) -> None:
        block = self.measure([_case(1, [_defect("a", FARM, 1, 2)]), _case(2, [])], [_report(1, FARM, 1, 1), _report(2, FARM, 1, 1)])
        self.assertEqual(set(block), {"status", "defects", "clean_commits"})
        self.assertEqual(block["status"], role_fitness.MEASURED)
        self.assertEqual(set(block["defects"]), {"n", "hits", "misses", "recall", "wilson_lower", "wilson_upper"})
        self.assertEqual(set(block["clean_commits"]),
                         {"n", "false_alarms", "false_alarm_rate", "reports", "wilson_lower", "wilson_upper"})
        self.assertEqual((block["defects"]["hits"], block["defects"]["misses"], block["clean_commits"]["false_alarms"],
                          block["clean_commits"]["reports"]), (1, 0, 1, 1))

    def test_the_gold_block_without_cases_is_unmeasured_and_nothing_else(self) -> None:
        self.assertEqual(self.measure([], []), {"status": role_fitness.UNMEASURED_NO_DISCOVERY_CASES})


class ControlDrawsAnyClaimTests(_Scoring):
    """D3's rule the D9a unification dropped: a control that draws ANY claim is a false alarm, malformed or not.

    On origin/main the test was ``if claims:`` before any validation, so a noisy reviewer that answers a clean change
    with garbage claims scored as a false alarm. A malformed claim (lines that are not line numbers, or no claim object
    at all) still cannot HIT a defect: a defect is hit only by a claim whose file and line numbers are valid and within
    the window. Pinned through ``score_zoo_discovery`` only; the way a malformed claim is carried to the fold has no name
    in the specification.
    """

    # (name, the claim). Every row is a claim the matcher must never read lines from.
    MALFORMED: tuple[tuple[str, Any], ...] = (
        ("string lines", _claim(FARM, "101", "101")),
        ("float lines", _claim(FARM, 101.0, 101.0)),
        ("bool lines", _claim(FARM, True, True)),
        ("bool lines False and True", _claim(FARM, False, True)),
        ("bool start and int end", _claim(FARM, True, 101)),
        ("int start and bool end", _claim(FARM, 1, True)),
        ("None lines", _claim(FARM, None, None)),
        ("missing line keys", {"file": FARM, "claim_type": "wrong_code"}),
        ("start_line only", {"file": FARM, "start_line": 101}),
        ("end_line only", {"file": FARM, "end_line": 101}),
        ("string end_line", {"file": FARM, "start_line": 101, "end_line": "101"}),
        ("float start_line", {"file": FARM, "start_line": 101.0, "end_line": 101}),
        ("claim that is a string", "not a claim"),
        ("claim that is None", None),
        ("claim that is an int", 7),
        ("claim that is a list", [FARM, 101, 101]),
        ("empty dict", {}),
    )
    CONTROL = _label("C1", "control", FARM, 100, 102)
    # One defect the integer 101 / 101.0 would hit, one that a bool (True is line 1) would hit.
    DEFECTS = (_label("D1", "defect", FARM, 100, 102), _label("D2", "defect", FARM, 1, 2))

    def control_result(self, *claims: Any) -> dict[str, Any]:
        return self.zoo({"C1": _answer(*claims)}, [self.CONTROL])["controls"]

    def test_a_control_whose_only_claim_is_malformed_is_a_false_alarm(self) -> None:
        for name, claim in self.MALFORMED:
            with self.subTest(shape=name):
                controls = self.control_result(claim)
                self.assertEqual(
                    (controls["n"], controls["false_alarms"]), (1, ["C1"]),
                    f"a control that drew the claim {claim!r} is scored clean: a control that draws any claim is a "
                    "false alarm (D3), malformed or not",
                )
                self.assertEqual(controls["rate"], 1.0)
                self.assertEqual(controls["wilson"], wilson_interval(1, 1))

    def test_a_control_that_draws_several_malformed_claims_is_one_false_alarm(self) -> None:
        every_shape = [claim for _, claim in self.MALFORMED]
        controls = self.control_result(*every_shape)
        self.assertEqual((controls["n"], controls["false_alarms"]), (1, ["C1"]))
        for name, claim in self.MALFORMED:
            with self.subTest(shape=name, beside="the same shape twice"):
                self.assertEqual(self.control_result(claim, claim)["false_alarms"], ["C1"])

    def test_a_control_that_draws_a_malformed_claim_beside_a_well_formed_one_is_one_false_alarm(self) -> None:
        well_formed = _claim(FARM, 101, 101)
        for name, claim in self.MALFORMED:
            for order, claims in (("malformed first", (claim, well_formed)), ("malformed last", (well_formed, claim))):
                with self.subTest(shape=name, order=order):
                    controls = self.control_result(*claims)
                    self.assertEqual((controls["n"], controls["false_alarms"]), (1, ["C1"]))

    def test_a_control_whose_claim_is_well_formed_is_a_false_alarm_wherever_its_lines_are(self) -> None:
        # The rule is "any claim", not "a claim near the control's lines": the zoo's window is for defects.
        for name, claim in (("on the control", _claim(FARM, 101, 101)), ("far from it", _claim(FARM, 900, 950)),
                            ("on another file", _claim(HR, 101, 101)), ("no file named", {"start_line": 101, "end_line": 101})):
            with self.subTest(claim=name):
                self.assertEqual(self.control_result(claim)["false_alarms"], ["C1"])

    def test_a_control_with_no_claim_is_clean(self) -> None:
        answers: tuple[tuple[str, dict[str, Any]], ...] = (
            ("an empty claim list", _answer()),
            ("no details at all", {"role": "change_intelligence"}),
            ("details that are None", {"role": "change_intelligence", "details": None}),
            ("details with no claims key", {"role": "change_intelligence", "details": {"impact_map": {}}}),
            ("a claims key that is None", {"role": "change_intelligence", "details": {"defect_claims": None}}),
            ("a claims key that is an empty list", {"role": "change_intelligence", "details": {"defect_claims": []}}),
        )
        for name, answer in answers:
            with self.subTest(answer=name):
                controls = self.zoo({"C1": answer}, [self.CONTROL])["controls"]
                self.assertEqual((controls["n"], controls["false_alarms"], controls["rate"]), (1, [], 0.0))
                self.assertEqual(controls["wilson"], wilson_interval(0, 1))

    def test_a_malformed_claim_on_a_defect_is_never_a_hit_and_leaves_it_a_miss(self) -> None:
        for defect in self.DEFECTS:
            for name, claim in self.MALFORMED:
                with self.subTest(defect=defect["id"], shape=name):
                    defects = self.zoo({defect["id"]: _answer(claim)}, [defect])["defects"]
                    self.assertEqual(
                        (defects["n"], defects["hits"], defects["misses"], defects["recall"]),
                        (1, [], [defect["id"]], 0.0),
                        f"the claim {claim!r} is no claim with line numbers, so it hit {defect['id']}",
                    )
                    self.assertEqual(defects["wilson"], wilson_interval(0, 1))

    def test_a_malformed_claim_hides_no_hit_when_a_valid_claim_is_within_the_window(self) -> None:
        for defect in self.DEFECTS:
            valid = _claim(FARM, defect["line_start"] + 1, defect["line_start"] + 1)
            for name, claim in self.MALFORMED:
                for order, claims in (("malformed first", (claim, valid)), ("malformed last", (valid, claim))):
                    with self.subTest(defect=defect["id"], shape=name, order=order):
                        defects = self.zoo({defect["id"]: _answer(*claims)}, [defect])["defects"]
                        self.assertEqual((defects["n"], defects["hits"], defects["misses"]), (1, [defect["id"]], []))

    def test_two_controls_one_clean_and_one_with_only_a_malformed_claim_give_one_alarm_in_two(self) -> None:
        labels = [_label("C1", "control", FARM, 100, 102), _label("C2", "control", HR, 5, 5)]
        for name, claim in self.MALFORMED:
            for drawn_on, clean in (("C2", "C1"), ("C1", "C2")):
                with self.subTest(shape=name, drawn_on=drawn_on):
                    controls = self.zoo({clean: _answer(), drawn_on: _answer(claim)}, labels)["controls"]
                    self.assertEqual((controls["n"], controls["false_alarms"]), (2, [drawn_on]))
                    self.assertEqual(controls["rate"], 1 / 2)
                    self.assertEqual(controls["wilson"], wilson_interval(1, 2))

    def test_one_zoo_with_every_kind_of_answer_is_scored_whole(self) -> None:
        # Four controls (clean, malformed only, well-formed only, malformed beside well-formed) and four defects (a valid
        # claim in the window, a malformed claim only, a malformed claim beside a valid one, no claim).
        labels = [
            _label("C1", "control", FARM, 10, 10), _label("C2", "control", FARM, 10, 10),
            _label("C3", "control", FARM, 10, 10), _label("C4", "control", FARM, 10, 10),
            _label("D1", "defect", FARM, 100, 102), _label("D2", "defect", FARM, 100, 102),
            _label("D3", "defect", FARM, 100, 102), _label("D4", "defect", FARM, 100, 102),
        ]
        responses = {
            "C1": _answer(),
            "C2": _answer(_claim(FARM, "10", "10")),
            "C3": _answer(_claim(FARM, 10, 10)),
            "C4": _answer("garbage", _claim(FARM, 10, 10)),
            "D1": _answer(_claim(FARM, 105, 105)),
            "D2": _answer(_claim(FARM, "101", "101"), {}),
            "D3": _answer(None, _claim(FARM, 112, 112)),
            "D4": _answer(),
        }

        result = self.zoo(responses, labels)

        self.assertEqual(result["controls"], {
            "n": 4, "false_alarms": ["C2", "C3", "C4"], "rate": 3 / 4, "wilson": wilson_interval(3, 4),
        })
        self.assertEqual(result["defects"], {
            "n": 4, "hits": ["D1", "D3"], "misses": ["D2", "D4"], "recall": 2 / 4, "wilson": wilson_interval(2, 4),
        })

    def test_a_control_whose_claims_field_is_no_list_but_is_not_empty_is_a_false_alarm(self) -> None:
        # origin/main read ``details.defect_claims or []`` and tested its truth: any truthy value was "a claim".
        for name, claims in (("a string", "garbage"), ("a dict", {"file": FARM, "start_line": 101, "end_line": 101})):
            with self.subTest(claims=name):
                answer = {"role": "change_intelligence", "details": {"defect_claims": claims}}
                controls = self.zoo({"C1": answer}, [self.CONTROL])["controls"]
                self.assertEqual((controls["n"], controls["false_alarms"]), (1, ["C1"]))


if __name__ == "__main__":
    unittest.main()
