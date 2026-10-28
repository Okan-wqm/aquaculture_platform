"""WP-D3 — the deterministic scorer hook on the defect zoo (SPEC exit-metric note).

The exit metric of D3 (hypothesis recall on DEV against the plain-Claude arm) is measured
LATER, on DEV. This package builds only the hook: a helper that takes the change-review
answers and the zoo labels (the operator-side ``zoo/labels.json`` of the 2026-10-21 hand-over:
synthetic, not sealed; the records below carry its exact keys) and returns hits, misses and
false alarms with n and the Wilson interval. The D9 discovery-recall block (``role_fitness``,
DESIGN row 13) is not on main yet; when it is, this helper reuses it. It reads no model output
beyond ``details.defect_claims`` and calls nothing.

New API pinned here (red at the branch base because it does not exist yet; each test asserts
the function is there before it calls it, so the red is an assertion):

  ``role_fitness.score_zoo_discovery(responses, labels)``

  * ``labels`` — the zoo records: ``id``, ``kind`` (``defect`` | ``control``), ``file``,
    ``line_start``, ``line_end`` (the other keys are carried by the file and ignored).
  * ``responses`` — ``{label id: agent response}``; the claims of a response are
    ``response["details"]["defect_claims"]`` (a response without them holds none). A label
    with no response, or a response for no label, is refused by name (``GovernanceError``
    naming the id): a change that was not asked about is not a miss and not a clean control.
  * A claim HITS a defect when it names the label's file and its lines ``start_line..end_line``
    come within 10 lines of the defect's ``line_start..line_end`` (the zoo's own scoring rule:
    file match, patched line within +-10). A defect with a hit is a hit, otherwise a miss; a
    control that draws any claim is a false alarm.
  * The result: ``{"defects": {"n", "hits", "misses", "recall", "wilson"}, "controls": {"n",
    "false_alarms", "rate", "wilson"}}``; ``hits``, ``misses`` and ``false_alarms`` are the
    sorted label ids, ``wilson`` the (lower, upper) 95% Wilson interval of the proportion
    (z = 1.96, as the zoo report states it).
"""
from __future__ import annotations

import math
import unittest
from typing import Any

from aria_kernel import role_fitness
from aria_kernel.tool_registry import GovernanceError

WILSON_Z = 1.96
WINDOW = 10


def _label(label_id: str, kind: str, file: str, start: int, end: int) -> dict[str, Any]:
    return {
        "id": label_id, "kind": kind, "cls": "synthetic", "difficulty": "logic", "file": file,
        "line_start": start, "line_end": end, "description": f"zoo case {label_id}",
        "why_real": "synthetic", "expected_detectors": [],
    }


def _response(*claims: tuple[str, int, int]) -> dict[str, Any]:
    return {
        "role": "change_intelligence",
        "details": {
            "impact_map": {},
            "defect_claims": [{"file": file, "start_line": start, "end_line": end} for file, start, end in claims],
        },
    }


def _wilson(successes: int, trials: int) -> tuple[float, float]:
    """The 95% Wilson interval, written out here so the test does not borrow the helper it checks."""
    p = successes / trials
    z2 = WILSON_Z * WILSON_Z
    centre = (p + z2 / (2 * trials)) / (1 + z2 / trials)
    half = WILSON_Z * math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / (1 + z2 / trials)
    return max(0.0, centre - half), min(1.0, centre + half)


A, B, C, D, E = ("apps/a/src/a.ts", "apps/b/src/b.ts", "apps/c/src/c.ts", "libs/d/src/d.ts", "libs/e/src/e.ts")
LABELS = [
    _label("Z01", "defect", A, 40, 42),
    _label("Z02", "defect", B, 100, 100),
    _label("Z03", "defect", C, 100, 100),
    _label("Z04", "defect", D, 100, 100),
    _label("Z05", "defect", E, 7, 7),
    _label("Z06", "control", A, 1, 1),
    _label("Z07", "control", B, 1, 1),
]


class _Scorer(unittest.TestCase):
    def score(self, responses: dict[str, Any], labels: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        function = getattr(role_fitness, "score_zoo_discovery", None)
        self.assertIsNotNone(
            function,
            "role_fitness has no score_zoo_discovery: nothing scores the change review's claims against the zoo",
        )
        assert function is not None
        return function(responses, LABELS if labels is None else labels)


class ScoreTests(_Scorer):
    def test_hits_misses_and_false_alarms_with_n_and_wilson(self) -> None:
        responses = {
            "Z01": _response((A, 41, 41)),            # on the defect: hit
            "Z02": _response((B, 90, 90)),            # 10 lines above: hit
            "Z03": _response((C, 111, 111)),          # 11 lines below: miss
            "Z04": _response((A, 100, 100)),          # right line, wrong file: miss
            "Z05": _response(),                       # no claim at all: miss
            "Z06": _response(),                       # clean control, nothing said
            "Z07": _response((B, 1, 1)),              # clean control with a claim: false alarm
        }

        result = self.score(responses)

        defects, controls = result["defects"], result["controls"]
        self.assertEqual((defects["n"], defects["hits"], defects["misses"]), (5, ["Z01", "Z02"], ["Z03", "Z04", "Z05"]))
        self.assertAlmostEqual(defects["recall"], 2 / 5)
        for got, want in zip(defects["wilson"], _wilson(2, 5)):
            self.assertAlmostEqual(got, want, delta=5e-4)
        self.assertEqual((controls["n"], controls["false_alarms"]), (2, ["Z07"]))
        self.assertAlmostEqual(controls["rate"], 1 / 2)
        for got, want in zip(controls["wilson"], _wilson(1, 2)):
            self.assertAlmostEqual(got, want, delta=5e-4)

    def test_the_line_window_is_ten_lines_either_side_of_the_labelled_lines(self) -> None:
        label = _label("Z50", "defect", A, 100, 102)
        cases = {
            "range_ends_ten_above": ((A, 80, 90), True),
            "range_ends_eleven_above": ((A, 80, 89), False),
            "range_starts_ten_below": ((A, 112, 130), True),
            "range_starts_eleven_below": ((A, 113, 130), False),
            "range_spans_the_defect": ((A, 1, 500), True),
            "single_line_on_the_defect": ((A, 101, 101), True),
        }
        for name, (claim, expected) in cases.items():
            with self.subTest(case=name):
                result = self.score({"Z50": _response(claim)}, [label])
                self.assertEqual(result["defects"]["hits"], ["Z50"] if expected else [])
                self.assertEqual(result["defects"]["misses"], [] if expected else ["Z50"])

    def test_one_matching_claim_among_others_is_a_hit(self) -> None:
        result = self.score(
            {"Z50": _response((B, 5, 5), (A, 900, 900), (A, 99, 99))}, [_label("Z50", "defect", A, 100, 100)],
        )

        self.assertEqual(result["defects"]["hits"], ["Z50"])

    def test_wilson_is_the_95_percent_interval_the_zoo_report_states(self) -> None:
        # ZOO-REPORT: stage D found 3 of 36 defects, Wilson 95% [3%, 22%]; the plain LLM 35 of 36, [86%, 100%].
        for found, low, high in ((3, 0.03, 0.22), (35, 0.86, 1.0)):
            with self.subTest(found=found):
                labels = [_label(f"Z{index:02d}", "defect", A, 100, 100) for index in range(36)]
                responses = {
                    label["id"]: _response((A, 100, 100)) if index < found else _response()
                    for index, label in enumerate(labels)
                }
                result = self.score(responses, labels)
                self.assertEqual(len(result["defects"]["hits"]), found)
                self.assertEqual(result["defects"]["n"], 36)
                self.assertAlmostEqual(result["defects"]["wilson"][0], low, delta=0.005)
                self.assertAlmostEqual(result["defects"]["wilson"][1], high, delta=0.005)

    def test_a_label_without_a_response_is_refused_by_name(self) -> None:
        responses = {label["id"]: _response() for label in LABELS if label["id"] != "Z03"}

        with self.assertRaises(GovernanceError) as refused:
            self.score(responses)

        self.assertIn("Z03", str(refused.exception))

    def test_a_response_for_no_label_is_refused_by_name(self) -> None:
        responses = {label["id"]: _response() for label in LABELS}
        responses["Z99"] = _response((A, 1, 1))

        with self.assertRaises(GovernanceError) as refused:
            self.score(responses)

        self.assertIn("Z99", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
