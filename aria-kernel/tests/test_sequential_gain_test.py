"""PLAN-v2 F1.8(a) — the paired gain test is anytime-valid (ARIA-LOW-949).

WHY THIS EXISTS. ARIA recomputes the EVAL_WINDOW -> ACTIVE proof at every cycle and at
every ``record_transition(..., "ACTIVE")`` attempt, and a failed attempt records nothing.
F1.7's fixed-n exact McNemar test pays for every look: on an A/A comparison looked at every
cycle it says "improved" in about 10% of the runs at alpha = 0.05. The repair is one
sequential decision with a guarantee that holds at every look: the one-sided uniform-mixture
e-process of the discordant pairs, ``E(c, b) = c! b! / (n+1)! * sum_{k<=c} C(n+1, k)`` with
``n = c + b``, rejecting when ``E * alpha > 1``. It is valid only if the evidence ACCUMULATES,
so the comparison is anchored at the entity's EVAL_WINDOW entry and a case contributes its
FIRST real run on each side (no retry can manufacture a gain).

NEW API pinned here (red at the branch base on an assertion that names the missing name):
``agent_eval.paired_e_value``, ``agent_eval.sequential_paired_verdict``,
``agent_eval.SEQUENTIAL_TEST``, ``agent_eval._first_outcome_per_case``,
``compare_eval_windows(..., window_start=)`` and the result keys ``window_start``,
``e_value``, ``e_threshold``, ``genesis_lifecycle.eval_window_entered_at``.
Pinned on behaviour that exists at the base (red on the defect): the paired mode without an
anchor, the gate's A/A rate when looked at every cycle, the gate's anchor.

F1.8a — THE ANCHOR IS READ THROUGH SE-5. ``eval_window_entered_at`` is a second reader of the lifecycle ledger
and has no ledger walk of its own: it reads the entity through the replay owner (``_rows_by_entity`` and ``_replay``,
or ``lifecycle_chains``), so a row the replay refuses never moves the anchor. The anchor exists only for a LAWFUL
chain whose replayed state is EVAL_WINDOW; an invalid chain, an entity with no chain, or one that has left
EVAL_WINDOW has none, and the comparison does not run on it (fail closed, as ``production_block_reason`` blocks).
The fixtures write the chains SE-5's law accepts (``tests/_helpers/lifecycle_chain.py``: every rung from PRESSURE,
each row carrying the evidence ``validate_transition`` asks of it); the cases that fed it a chain it refuses
(a lone EVAL_WINDOW row without proof evidence, an ignored unknown ``to_state``, an ACTIVE row without the
kernel-computed proof) are rewritten to pin the refusal, not dropped (``LifecycleAnchorTests``, ``ForgedChainTests``,
``ReadsThroughTheReplayTests``). ``_entity_rows`` (F1.8's private iterator) is gone: ``_rows_by_entity`` is the
one loop.

ASSUMPTIONS the guarantee rests on, one test each:
  A1 nesting      later looks see the earlier pairs unchanged plus new ones
                  (``NestingTests``, ``AnchoredPairingTests``).
  A2 case supply  which cases run next may depend on what was observed, never on the outcome
                  of the case itself (the simulations draw outcomes independently of supply).
  A3 exchangeable under H0 the two sides are the same agent on the same model. Drift between
                  the sides is NOT defended here; the A/A fixtures prove the rule under
                  A1-A3 only.

THE SIMULATIONS are seeded and exact where they can be: ``AnytimeErrorTests`` is a dynamic
program over (candidate_only, incumbent_only) with Fractions, no sampling. The peeked
simulations serve the ledger rows from memory (``_MemoryLedger``) because the strict ledger
read costs ~35 ms a call and a simulation looks 4000 times; ``ReaderTransparencyTests`` pins
that the in-memory reader and the real ledger read give identical results.
"""
from __future__ import annotations

import ast
import dataclasses
import functools
import inspect
import json
import math
import random
import re
import statistics
import tempfile
import unittest
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest import mock

from aria_kernel import agent_eval, genesis_lifecycle, genesis_superiority
from aria_kernel.agent_eval import EVAL_RUNS_PATH, compare_eval_windows
from aria_kernel.genesis_policy import default_policy, superiority_policy
from aria_kernel.genesis_superiority import compute_eval_window_superiority
from aria_kernel.judge_calibration import wilson_lower
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.lifecycle_chain import LADDER, chain, evidence_for, forged_row

SEED = 1729
# The pre-registered decision values, read from the shipped policy, never typed.
POLICY = superiority_policy()
ALPHA: float = POLICY["alpha"]
MIN_PAIRS: int = POLICY["min_discordant_pairs"]
WINDOW_DAYS: int = POLICY["window_days"]
# The verdict table is arithmetic at THESE values, an override on purpose.
TABLE_ALPHA = 0.05
TABLE_MIN_PAIRS = 6
SEQUENTIAL_TEST_NAME = "uniform_mixture_e_process_one_sided"
FIXED_N_TEST_NAME = "exact_mcnemar_one_sided"

PASS_PROBABILITIES = (0.3, 0.5, 0.6, 0.7, 0.8, 0.9)
CYCLES = 10
CASES_PER_CYCLE = 10
TRIALS = 400
GATE_TRIALS = 100
GATE_CASES = CYCLES * CASES_PER_CYCLE
EFFECT = 0.30
SMALL_EFFECT = 0.15

_NOW = datetime.now(timezone.utc).replace(microsecond=0)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def _api(module: ModuleType, name: str) -> Any:
    """A new name, reported as an assertion that names it (never an import error)."""
    if not hasattr(module, name):
        raise AssertionError(f"F1.8(a): {module.__name__}.{name} does not exist (new API pinned by this suite)")
    return getattr(module, name)


def _e_value(candidate_only: int, incumbent_only: int) -> Fraction:
    return _api(agent_eval, "paired_e_value")(candidate_only, incumbent_only)


def _verdict(
    candidate_only: int, incumbent_only: int, *, alpha: float = TABLE_ALPHA, min_pairs: int = TABLE_MIN_PAIRS
) -> tuple[str, Fraction, Fraction]:
    return _api(agent_eval, "sequential_paired_verdict")(
        candidate_only, incumbent_only, alpha=alpha, min_discordant_pairs=min_pairs
    )


def _stamp(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _days_ago(days: int) -> str:
    """The stamp of an instant ``days`` before the suite's clock."""
    return _stamp(_NOW - timedelta(days=days))


def _parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def _run(agent: str, case: str, passed: bool, at: datetime, *, mock_mode: bool = False) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "target_agent": agent,
        "fixture_id": case,
        "passed": passed,
        "verdict_match": passed,
        "missing_evidence_refs": [] if passed else ["evidence.md:1"],
        "rounds_used": 1,
        "tokens_used": 100,
        "mock_mode": mock_mode,
        "recorded_at": _stamp(at),
    }


def _write_runs(tools: Path, rows: list[dict[str, Any]]) -> None:
    path = tools.joinpath(*EVAL_RUNS_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows), encoding="utf-8")


def _table(
    candidate_only: int, incumbent_only: int, *, at: datetime, both: int = 0, neither: int = 0
) -> list[dict[str, Any]]:
    """One run per agent per case, "cand" against "inc": a 2x2 McNemar table spelled out as eval rows."""
    cells = [(True, True)] * both + [(True, False)] * candidate_only
    cells += [(False, True)] * incumbent_only + [(False, False)] * neither
    rows: list[dict[str, Any]] = []
    for index, (cand, inc) in enumerate(cells):
        rows += [_run("cand", f"CASE-{index:04d}", cand, at), _run("inc", f"CASE-{index:04d}", inc, at)]
    return rows


def _require_anchor_api() -> None:
    if "window_start" not in inspect.signature(compare_eval_windows).parameters:
        raise AssertionError("F1.8(a): compare_eval_windows takes no window_start (the anchored comparison is new API)")


def _compare(
    tools: Path, *, window_start: datetime, target: str = "cand", incumbent: str = "inc", alpha: float = ALPHA,
    min_pairs: int = MIN_PAIRS, window_days: int = WINDOW_DAYS, mock_mode: bool = False,
) -> dict[str, Any]:
    _require_anchor_api()
    return compare_eval_windows(
        target_agent=target, incumbent_agent=incumbent, base_dir=tools, window_days=window_days,
        alpha=alpha, min_discordant_pairs=min_pairs, mock_mode=mock_mode, window_start=window_start,
    )


def _counts(result: dict[str, Any]) -> tuple[int, int]:
    pairs = result["discordant_pairs"]
    return pairs["candidate_only"], pairs["incumbent_only"]


def _tail(successes: int, trials: int) -> Fraction:
    """P(Binomial(trials, 1/2) >= successes), exact."""
    return Fraction(sum(math.comb(trials, k) for k in range(successes, trials + 1)), 2 ** trials)


def _fixed_n_improved(candidate_only: int, incumbent_only: int) -> bool:
    """The F1.7 rule, restated for contrast only: n >= min and the one-sided exact tail <= alpha."""
    pairs = candidate_only + incumbent_only
    return pairs >= MIN_PAIRS and _tail(candidate_only, pairs) <= Fraction(ALPHA)


def _ladder_stamps(last: datetime, through: str) -> dict[str, str]:
    """A stamp for every rung of the ladder up to ``through``, an hour apart, ``through`` at ``last``."""
    rungs = LADDER[: LADDER.index(through) + 1]
    return {state: _stamp(last - timedelta(hours=len(rungs) - 1 - index)) for index, state in enumerate(rungs)}


def _enter_eval_window(
    tools: Path, entity_id: str, at: datetime | None, *, stamp: str | None = None, shadow_at: datetime | None = None
) -> None:
    """The LAWFUL chain of an entity that entered EVAL_WINDOW at ``at`` (or at the literal ``stamp``).

    SE-5 replays an entity's rows from nothing, so the entry is the last rung of a chain that replays: every rung
    from PRESSURE to SHADOW (``shadow_at``, by default an hour before the entry) and an EVAL_WINDOW row that
    carries the proof evidence ``validate_transition`` demands (``eval_harness_id``, ``fixture_run_id``,
    ``transcript_hash``, ``operator_provenance_ref``). The F1.8 helper wrote a lone EVAL_WINDOW row with empty
    evidence and no predecessor: a chain SE-5 refuses, so it can no longer anchor anything.
    """
    if stamp is None:
        assert at is not None, "an entry needs an instant or a literal stamp"
        stamp = at.replace(microsecond=0).isoformat()
    if shadow_at is None:
        shadow_at = (at if at is not None else _NOW - timedelta(days=30)) - timedelta(hours=1)
    chain(tools, entity_id, "SHADOW", recorded_at=_ladder_stamps(shadow_at, "SHADOW"))
    forged_row(
        tools, entity_id, "EVAL_WINDOW", from_state="SHADOW", evidence=evidence_for("EVAL_WINDOW"), recorded_at=stamp
    )


class _MemoryLedger:
    """The eval-run rows, written to the real ledger path and served from memory.

    ``agent_eval.list_eval_runs`` is the one reader of the paired mode; replacing it for a
    simulation changes cost, not meaning, as long as the filters are the same ones. The rows are
    still written to disk, so a comparison that reads another way still sees the ledger."""

    def __init__(self, tools: Path) -> None:
        self.tools = tools
        self.rows: list[dict[str, Any]] = []

    def replace(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        _write_runs(self.tools, rows)

    def read(
        self, *, base_dir: Any = None, target_agent: str | None = None, fixture_id: str | None = None,
        mock_mode: bool | None = None, limit: int | None = None,
    ) -> list[dict[str, Any]]:
        selected = [
            dict(row) for row in self.rows
            if (target_agent is None or row.get("target_agent") == target_agent)
            and (fixture_id is None or row.get("fixture_id") == fixture_id)
            and (mock_mode is None or bool(row.get("mock_mode")) == mock_mode)
        ]
        return selected[-limit:] if limit is not None and limit > 0 else selected

    @contextmanager
    def serving(self) -> Iterator[None]:
        with mock.patch.object(agent_eval, "list_eval_runs", self.read):
            yield


class _LedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tools = Path(tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)


# ---------------------------------------------------------------------------
# 1-3. the decision procedure, exact and seed-free
# ---------------------------------------------------------------------------

class EValueMathTests(unittest.TestCase):
    """The e-value is a nonnegative martingale started at 1: kills a wrong normalisation, prior,
    sidedness or sign."""

    def test_the_empty_table_is_the_neutral_e_value(self) -> None:
        value = _e_value(0, 0)
        self.assertIsInstance(value, Fraction)
        self.assertEqual(value, 1)

    def test_the_martingale_identity_holds_at_theta_one_half(self) -> None:
        for c in range(13):
            for b in range(13):
                self.assertEqual((_e_value(c + 1, b) + _e_value(c, b + 1)) / 2, _e_value(c, b), f"c={c} b={b}")

    def test_e_is_a_supermartingale_for_every_theta_at_or_below_one_half(self) -> None:
        for theta in (Fraction(1, 2), Fraction(1, 3), Fraction(1, 4)):
            for c in range(13):
                for b in range(13):
                    expected = theta * _e_value(c + 1, b) + (1 - theta) * _e_value(c, b + 1)
                    self.assertLessEqual(expected, _e_value(c, b), f"theta={theta} c={c} b={b}")

    def test_known_values_pin_the_prior_and_the_direction(self) -> None:
        pins = {
            (7, 0): Fraction(255, 8), (6, 0): Fraction(127, 7), (9, 1): Fraction(1018, 55),
            (7, 1): Fraction(251, 36), (3, 0): Fraction(15, 4), (0, 3): Fraction(1, 4), (1, 9): Fraction(6, 55),
        }
        for (c, b), expected in pins.items():
            with self.subTest(candidate_only=c, incumbent_only=b):
                self.assertEqual(_e_value(c, b), expected)


class VerdictTableTests(unittest.TestCase):
    """``sequential_paired_verdict`` at alpha 0.05, min 6. Every NEAR-MISS row would be 'improved' (or
    'regressed') under the fixed-n rule; the e-rule needs one more pair."""

    # (candidate_only, incumbent_only, verdict, a fixed-n near-miss row)
    TABLE = (
        (7, 0, "improved", False),
        (6, 0, "flat", True),  # fixed-n p = 1/64 <= alpha, E = 127/7 < 20
        (7, 1, "flat", True),  # fixed-n p = 9/256 = 0.035
        (9, 1, "flat", True),
        (10, 0, "improved", False),  # E = 2047/11
        (0, 7, "regressed", False),
        (0, 6, "flat", True),  # the same near-miss on the regressed side
        (5, 5, "flat", False),
        (3, 0, "insufficient_evidence", False),
    )

    def test_the_verdict_table(self) -> None:
        for c, b, expected, near_miss in self.TABLE:
            with self.subTest(candidate_only=c, incumbent_only=b):
                verdict, gain, loss = _verdict(c, b)
                self.assertEqual(verdict, expected)
                self.assertEqual((gain, loss), (_e_value(c, b), _e_value(b, c)))
                if near_miss:
                    leader = max(c, b)
                    self.assertLessEqual(_tail(leader, c + b), Fraction(TABLE_ALPHA), "not a near-miss row")

    def test_min_discordant_pairs_is_a_floor_that_only_removes_rejections(self) -> None:
        # alpha 0.4: the e-threshold is 2.5, so the floor binds.
        self.assertEqual(_verdict(3, 0, alpha=0.4, min_pairs=6)[0], "insufficient_evidence")
        self.assertEqual(_verdict(3, 0, alpha=0.4, min_pairs=3)[0], "improved")  # E = 15/4 > 2.5
        self.assertEqual(_verdict(2, 0, alpha=0.4, min_pairs=2)[0], "flat")  # E = 7/3 < 2.5
        self.assertEqual(_verdict(0, 3, alpha=0.4, min_pairs=6)[0], "insufficient_evidence")

    def test_the_comparison_with_one_over_alpha_is_exact_and_strict(self) -> None:
        # (6, 0) crosses 1/alpha exactly when alpha > 7/127; the test decides that in exact arithmetic.
        boundary = Fraction(7, 127)
        alphas = (math.nextafter(7 / 127, 0.0), 7 / 127, math.nextafter(7 / 127, 1.0))
        crosses = [Fraction(alpha) > boundary for alpha in alphas]
        self.assertEqual(crosses, [False, False, True], "the fixture no longer straddles the boundary")
        for alpha, expected in zip(alphas, crosses):
            with self.subTest(alpha=repr(alpha)):
                self.assertEqual(_verdict(6, 0, alpha=alpha, min_pairs=6)[0] == "improved", expected)


def _ever_probability(decide: Callable[[int, int], bool], looks: int) -> Fraction:
    """P(decide(c, b) holds at some look 1..looks) under H0: every discordant pair is a candidate win
    with probability 1/2, and there is a look after EVERY pair. Exact, by dynamic programming."""
    alive = {0: Fraction(1)}  # candidate_only -> mass of the paths that have not fired yet
    fired = Fraction(0)
    for pairs in range(looks):
        following: dict[int, Fraction] = {}
        for c, mass in alive.items():
            for win in (1, 0):
                share = mass / 2
                if decide(c + win, pairs + 1 - (c + win)):
                    fired += share
                else:
                    following[c + win] = following.get(c + win, Fraction(0)) + share
        alive = following
    return fired


class AnytimeErrorTests(unittest.TestCase):
    """Ville's bound, computed exactly with the production decision function, at the shipped values."""

    LOOKS = 60

    def _decide(self, verdict: str) -> Callable[[int, int], bool]:
        return lambda c, b: _verdict(c, b, alpha=ALPHA, min_pairs=MIN_PAIRS)[0] == verdict

    def test_a_look_after_every_pair_never_improves_more_often_than_alpha(self) -> None:
        probability = _ever_probability(self._decide("improved"), self.LOOKS)
        self.assertGreater(probability, 0, "the rule can never fire")
        self.assertLessEqual(probability, Fraction(ALPHA), f"P(improved at some look) = {float(probability):.4f}")

    def test_the_same_holds_for_regressed(self) -> None:
        probability = _ever_probability(self._decide("regressed"), self.LOOKS)
        self.assertGreater(probability, 0)
        self.assertLessEqual(probability, Fraction(ALPHA), f"P(regressed at some look) = {float(probability):.4f}")

    def test_the_fixed_n_rule_fails_the_same_assertion(self) -> None:
        # The contrast that proves the assertion above can fail (reference 0.1637 at 60 looks).
        probability = _ever_probability(_fixed_n_improved, self.LOOKS)
        self.assertGreater(probability, 2 * Fraction(ALPHA), f"fixed-n peeked rate {float(probability):.4f}")


# ---------------------------------------------------------------------------
# 4-6. the comparison through the ledger
# ---------------------------------------------------------------------------

class StatelessnessTests(_LedgerCase):
    """The verdict is a pure function of the append-only ledgers: a look with no new data is free."""

    START = _NOW - timedelta(days=5)

    def test_ten_looks_at_one_ledger_return_identical_results(self) -> None:
        _write_runs(self.tools, _table(9, 1, both=5, neither=3, at=self.START + timedelta(days=1)))
        results = [_compare(self.tools, window_start=self.START, min_pairs=10) for _ in range(10)]
        for result in results[1:]:
            self.assertEqual(result, results[0])

    def test_two_gate_proofs_over_one_ledger_are_identical(self) -> None:
        anchor = _NOW - timedelta(days=35)
        _enter_eval_window(self.tools, "cand", anchor)
        rows = [_run("cand", f"CASE-{i:03d}", i % 3 == 0, _NOW - timedelta(days=40)) for i in range(30)]
        rows += [_run("cand", f"CASE-{i:03d}", i % 2 == 0, _NOW - timedelta(days=5)) for i in range(30)]
        _write_runs(self.tools, rows)
        first = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools)
        second = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools)
        self.assertEqual(first, second)
        # The anchor is the recorded entry, not the instant of the look: two looks carry the same stamp.
        self.assertIn("window_start", first["window"])
        self.assertEqual(_parse(first["window"]["window_start"]), anchor)


class AnchoredPairingTests(_LedgerCase):
    """The windows are anchored at ``window_start``; a case contributes its FIRST run on each side."""

    START = _NOW - timedelta(days=5)

    def _look(self, rows: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
        _write_runs(self.tools, rows)
        options.setdefault("min_pairs", 1)
        return _compare(self.tools, window_start=self.START, **options)

    def test_distinct_incumbent_the_anchor_is_inclusive_and_earlier_runs_are_ignored(self) -> None:
        s = self.START
        rows: list[dict[str, Any]] = []
        for i in range(8):
            rows += [_run("cand", f"WIN-{i}", True, s + timedelta(days=1)), _run("inc", f"WIN-{i}", False, s + timedelta(days=1))]
        rows += [_run("cand", "EDGE", True, s), _run("inc", "EDGE", False, s + timedelta(days=1))]
        # One second before the anchor: not a candidate run, not an incumbent run (distinct mode reads the current window).
        rows += [_run("cand", "BEFORE-CAND", True, s - timedelta(seconds=1)), _run("inc", "BEFORE-CAND", False, s + timedelta(days=1))]
        rows += [_run("inc", "BEFORE-INC", True, s - timedelta(seconds=1)), _run("cand", "BEFORE-INC", False, s + timedelta(days=1))]
        result = self._look(rows)
        self.assertEqual(_counts(result), (9, 0))
        self.assertEqual(result["paired_case_count"], 9)

    def test_self_mode_the_run_before_the_anchor_is_the_incumbent_side(self) -> None:
        s, w = self.START, 10
        rows = [
            # incumbent = one second before the anchor (previous window), candidate fails after it
            _run("cand", "S-PREV", True, s - timedelta(seconds=1)), _run("cand", "S-PREV", False, s + timedelta(days=1)),
            # the previous window is half-open at the far end: exactly start - W belongs to it
            _run("cand", "S-EDGE", True, s - timedelta(days=w)), _run("cand", "S-EDGE", False, s + timedelta(days=1)),
            # older than start - W: no incumbent run, so no pair
            _run("cand", "S-OLD", True, s - timedelta(days=w, seconds=1)), _run("cand", "S-OLD", False, s + timedelta(days=1)),
            # a run at exactly the anchor is a candidate run
            _run("cand", "S-AT", False, s - timedelta(days=5)), _run("cand", "S-AT", True, s),
            # a candidate run with no baseline never pairs
            _run("cand", "S-NEW", True, s + timedelta(days=2)),
        ]
        result = self._look(rows, incumbent="cand", window_days=w)
        self.assertEqual(_counts(result), (1, 2))
        self.assertEqual(result["paired_case_count"], 3)
        self.assertEqual(result["incumbent_agent"], "cand")

    def test_the_current_window_is_open_at_the_end_so_a_lingering_entity_keeps_accruing(self) -> None:
        # window_days only bounds the baseline look-back before the anchor. No run is dated after the look, so
        # an entity that stays in EVAL_WINDOW past W keeps adding evidence instead of locking itself out.
        start, w = _NOW - timedelta(days=60), 10
        late = start + timedelta(days=w + 15)
        rows = [
            _run("cand", "EARLY", True, start + timedelta(days=1)), _run("inc", "EARLY", False, start + timedelta(days=1)),
            _run("cand", "LATE", True, late), _run("inc", "LATE", False, late),
        ]
        _write_runs(self.tools, rows)
        self.assertEqual(_counts(_compare(self.tools, window_start=start, window_days=w, min_pairs=1)), (2, 0))
        rows = [
            _run("cand", "EARLY", False, start - timedelta(days=2)), _run("cand", "EARLY", True, start + timedelta(days=1)),
            _run("cand", "LATE", False, start - timedelta(days=2)), _run("cand", "LATE", True, late),
        ]
        _write_runs(self.tools, rows)
        own = _compare(self.tools, window_start=start, incumbent="cand", window_days=w, min_pairs=1)
        self.assertEqual(_counts(own), (2, 0))

    def test_a_candidate_retry_that_flips_a_failing_case_manufactures_no_gain(self) -> None:
        s = self.START
        rows = [
            _run("cand", "X", False, s + timedelta(days=1)), _run("cand", "X", True, s + timedelta(days=2)),
            _run("inc", "X", True, s + timedelta(days=1)),
        ]
        self.assertEqual(_counts(self._look(rows)), (0, 1))

    def test_an_incumbent_retry_leaves_the_table_unchanged(self) -> None:
        s = self.START
        rows = [
            _run("inc", "X", False, s + timedelta(days=1)), _run("inc", "X", True, s + timedelta(days=2)),
            _run("cand", "X", True, s + timedelta(days=1)),
        ]
        self.assertEqual(_counts(self._look(rows)), (1, 0))

    def test_first_is_by_time_not_by_file_position_and_a_tie_goes_to_the_earlier_row(self) -> None:
        s = self.START
        later_first = [
            _run("cand", "X", True, s + timedelta(days=2)), _run("cand", "X", False, s + timedelta(days=1)),
            _run("inc", "X", True, s + timedelta(days=1)),
        ]
        self.assertEqual(_counts(self._look(later_first)), (0, 1), "the first run by time is the failing one")
        tie = [
            _run("cand", "Y", False, s + timedelta(days=1)), _run("cand", "Y", True, s + timedelta(days=1)),
            _run("inc", "Y", True, s + timedelta(days=1)),
        ]
        self.assertEqual(_counts(self._look(tie)), (0, 1), "a tie goes to the earlier row")

    def test_self_mode_takes_the_first_run_inside_each_window(self) -> None:
        s = self.START
        rows = [
            # X: previous pass then fail (first = pass); current pass. first-run: concordant. newest-run would read fail -> pass.
            _run("cand", "X", True, s - timedelta(days=8)), _run("cand", "X", False, s - timedelta(days=2)),
            _run("cand", "X", True, s + timedelta(days=1)),
            # Y: previous fail then pass (first = fail); current fail. first-run: concordant. newest-run would read pass -> fail.
            _run("cand", "Y", False, s - timedelta(days=8)), _run("cand", "Y", True, s - timedelta(days=2)),
            _run("cand", "Y", False, s + timedelta(days=1)),
            # Z: previous pass; current fail then pass (first = fail): the candidate lost.
            _run("cand", "Z", True, s - timedelta(days=2)),
            _run("cand", "Z", False, s + timedelta(days=1)), _run("cand", "Z", True, s + timedelta(days=2)),
        ]
        result = self._look(rows, incumbent="cand")
        self.assertEqual(_counts(result), (0, 1))
        self.assertEqual(result["paired_case_count"], 3)

    def test_mock_runs_other_agents_and_unshared_cases_never_pair(self) -> None:
        s = self.START
        at = s + timedelta(days=1)
        rows = _table(1, 1, both=2, at=at)
        for i in range(20):
            rows += [_run("cand", f"MOCK-{i}", True, at, mock_mode=True), _run("inc", f"MOCK-{i}", False, at, mock_mode=True)]
            rows += [_run("cand", f"ONLY-CAND-{i}", True, at), _run("inc", f"ONLY-INC-{i}", False, at)]
            rows += [_run("third", f"CASE-{i:04d}", True, at)]
        result = self._look(rows)
        self.assertEqual(_counts(result), (1, 1))
        self.assertEqual(result["paired_case_count"], 4)
        with self.assertRaises(GovernanceError):
            self._look(rows, mock_mode=True)

    def test_undated_runs_are_counted_and_never_paired(self) -> None:
        at = self.START + timedelta(days=1)
        rows = _table(1, 0, at=at)
        undated = _run("cand", "UNDATED", True, at)
        undated["recorded_at"] = "not-a-time"
        rows += [undated, {**undated, "target_agent": "inc"}]
        result = self._look(rows)
        self.assertEqual(result["undated_run_count"], 2)
        self.assertEqual(result["paired_case_count"], 1)


class NestingTests(unittest.TestCase):
    """A1: the pairs an earlier look saw are unchanged at every later look, so the discordant counts
    never fall as an append-only ledger grows (a flipped re-run or a later run on a paired case
    changes neither). 200 seeded random ledgers, distinct and self mode."""

    LEDGERS = 200
    APPENDS = 14
    CASES = 6

    def test_discordant_counts_are_componentwise_non_decreasing_across_looks(self) -> None:
        rng = random.Random(SEED)
        start = _NOW - timedelta(days=5)
        flipped_reruns = 0
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            ledger = _MemoryLedger(tools)
            with ledger.serving():
                for index in range(self.LEDGERS):
                    self_mode = index % 4 == 3
                    rows: list[dict[str, Any]] = []
                    seen: dict[tuple[str, str], bool] = {}
                    if self_mode:
                        for case in range(self.CASES):
                            outcome = rng.random() < 0.5
                            rows.append(_run("cand", f"K{case}", outcome, start - timedelta(days=1)))
                    previous = (0, 0)
                    for step in range(self.APPENDS):
                        agent = "cand" if self_mode else rng.choice(("cand", "inc"))
                        case = f"K{rng.randrange(self.CASES)}"
                        outcome = rng.random() < 0.5
                        key = (agent, case)
                        if key in seen and seen[key] != outcome:
                            flipped_reruns += 1
                        seen.setdefault(key, outcome)
                        rows.append(_run(agent, case, outcome, start + timedelta(minutes=step + 1)))
                        ledger.replace(rows)
                        current = _counts(_compare(
                            tools, window_start=start, incumbent="cand" if self_mode else "inc", min_pairs=1
                        ))
                        self.assertGreaterEqual(current[0], previous[0], f"ledger {index} step {step}: candidate_only fell")
                        self.assertGreaterEqual(current[1], previous[1], f"ledger {index} step {step}: incumbent_only fell")
                        previous = current
        self.assertGreater(flipped_reruns, 100, "the generator no longer exercises flipped re-runs")


class ReaderTransparencyTests(_LedgerCase):
    """The simulations' in-memory reader changes the cost of a look, not its result."""

    def test_the_memory_reader_and_the_ledger_read_give_the_same_comparison(self) -> None:
        rng = random.Random(SEED)
        start = _NOW - timedelta(days=5)
        rows: list[dict[str, Any]] = []
        for i in range(40):
            at = start + timedelta(hours=rng.randrange(1, 90))
            rows.append(_run(rng.choice(("cand", "inc", "third")), f"K{rng.randrange(12)}", rng.random() < 0.5, at,
                             mock_mode=rng.random() < 0.15))
        rows.append({**_run("cand", "K0", True, start), "recorded_at": "not-a-time"})
        ledger = _MemoryLedger(self.tools)
        ledger.replace(rows)
        for options in ({}, {"incumbent": "cand"}):
            real = _compare(self.tools, window_start=start, min_pairs=1, **options)
            with ledger.serving():
                served = _compare(self.tools, window_start=start, min_pairs=1, **options)
            self.assertEqual(served, real)
        for filters in ({"target_agent": "cand"}, {"mock_mode": False}, {"fixture_id": "K3"}, {"limit": 5}):
            self.assertEqual(ledger.read(**filters), agent_eval.list_eval_runs(base_dir=self.tools, **filters), filters)


class ApiContractTests(_LedgerCase):
    START = _NOW - timedelta(days=5)

    def _write(self, rows: list[dict[str, Any]]) -> None:
        _write_runs(self.tools, rows)

    def test_the_paired_mode_refuses_a_missing_anchor(self) -> None:
        self._write(_table(7, 0, at=self.START + timedelta(days=1)))
        with self.assertRaises(GovernanceError) as raised:
            compare_eval_windows(
                target_agent="cand", incumbent_agent="inc", base_dir=self.tools,
                alpha=ALPHA, min_discordant_pairs=MIN_PAIRS, mock_mode=False,
            )
        self.assertIn("window_start", str(raised.exception))

    def test_the_paired_mode_refuses_a_naive_anchor(self) -> None:
        self._write(_table(7, 0, at=self.START + timedelta(days=1)))
        with self.assertRaises(GovernanceError) as raised:
            _compare(self.tools, window_start=self.START.replace(tzinfo=None))
        self.assertIn("window_start", str(raised.exception))

    def test_the_window_mode_refuses_an_anchor(self) -> None:
        _require_anchor_api()
        with self.assertRaises(GovernanceError) as raised:
            compare_eval_windows(target_agent="cand", base_dir=self.tools, window_start=self.START)
        self.assertIn("window_start", str(raised.exception))

    def test_the_sequential_test_is_named_by_its_prior(self) -> None:
        self.assertEqual(_api(agent_eval, "SEQUENTIAL_TEST"), SEQUENTIAL_TEST_NAME)
        self.assertNotEqual(SEQUENTIAL_TEST_NAME, FIXED_N_TEST_NAME)
        self._write(_table(7, 0, at=self.START + timedelta(days=1)))
        self.assertEqual(_compare(self.tools, window_start=self.START)["test"], SEQUENTIAL_TEST_NAME)

    def test_the_price_of_validity_on_the_f1_7_table(self) -> None:
        # 9 of 10 discordant pairs: the fixed-n test said 'improved' (p = 11/1024). The e-value is 18.51 < 20.
        self._write(_table(9, 1, both=5, neither=3, at=self.START + timedelta(days=1)))
        result = _compare(self.tools, window_start=self.START, min_pairs=10)
        self.assertEqual(result["mode"], "paired")
        self.assertEqual(result["paired_case_count"], 18)
        self.assertEqual(result["discordant_pairs"], {"candidate_only": 9, "incumbent_only": 1})
        self.assertAlmostEqual(result["p_value"], 11 / 1024, places=12)
        self.assertEqual(result["wilson_lower"], 0.5958)
        self.assertEqual(result["wilson_lower"], wilson_lower(9, 10))
        self.assertEqual((result["alpha"], result["min_discordant_pairs"]), (ALPHA, 10))
        self.assertAlmostEqual(result["e_value"], 1018 / 55, places=9)
        self.assertAlmostEqual(result["e_threshold"], 1 / ALPHA, places=9)
        self.assertEqual(result["verdict"], "flat")
        numbers = [float(token) for token in re.findall(r"\d+(?:\.\d+)?(?:e[+-]?\d+)?", result["reason"])]
        self.assertTrue(any(math.isclose(n, 1018 / 55, rel_tol=0.01) for n in numbers), result["reason"])
        self.assertTrue(
            any(math.isclose(n, 1 / ALPHA, rel_tol=0.01) for n in numbers) or "1/alpha" in result["reason"],
            result["reason"],
        )

    def test_the_anchor_is_echoed_as_an_iso_stamp(self) -> None:
        self._write(_table(7, 0, at=self.START + timedelta(days=1)))
        result = _compare(self.tools, window_start=self.START)
        self.assertIsInstance(result["window_start"], str)
        self.assertEqual(_parse(result["window_start"]), self.START)

    def test_a_huge_table_stays_finite_and_json_safe_in_both_directions(self) -> None:
        at = self.START + timedelta(days=1)
        for candidate_only, incumbent_only, expected in ((1100, 0, "improved"), (0, 1100, "regressed")):
            with self.subTest(candidate_only=candidate_only, incumbent_only=incumbent_only):
                self._write(_table(candidate_only, incumbent_only, at=at))
                result = _compare(self.tools, window_start=self.START)
                self.assertEqual(result["verdict"], expected)
                json.dumps(result, allow_nan=False)
                for key in ("e_value", "e_threshold", "p_value", "wilson_lower", "aa_noise_floor"):
                    self.assertTrue(math.isfinite(result[key]), key)
                if expected == "improved":
                    self.assertGreaterEqual(result["e_value"], result["e_threshold"])

    def test_the_noise_floor_is_the_exact_single_look_size_of_this_rule(self) -> None:
        at = self.START + timedelta(days=1)

        def brute_force(pairs: int) -> float:
            if pairs < MIN_PAIRS:
                return 0.0
            for c in range(pairs + 1):
                if _e_value(c, pairs - c) * Fraction(ALPHA) > 1:
                    return float(_tail(c, pairs))
            return 0.0

        for candidate_only, incumbent_only, expected in (
            (4, 3, 1 / 128),  # n = 7: only 7/0 crosses
            (15, 5, 6196 / 1048576),  # n = 20: c* = 16, 0.00591
            (4, 2, 0.0),  # n = 6: no c crosses
            (2, 1, 0.0),  # below the pair minimum
        ):
            with self.subTest(pairs=candidate_only + incumbent_only):
                self._write(_table(candidate_only, incumbent_only, at=at))
                floor = _compare(self.tools, window_start=self.START)["aa_noise_floor"]
                self.assertAlmostEqual(floor, expected, places=12)
                self.assertAlmostEqual(floor, brute_force(candidate_only + incumbent_only), places=12)
                self.assertLessEqual(floor, ALPHA)


# ---------------------------------------------------------------------------
# 7-8. looked at every cycle, real paired mode
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Trial:
    verdicts: tuple[str, ...]
    fixed_n: tuple[bool, ...]

    def first(self, verdict: str) -> int | None:
        return next((i + 1 for i, v in enumerate(self.verdicts) if v == verdict), None)


@functools.lru_cache(maxsize=None)
def _peeked_trials(shift: float) -> tuple[_Trial, ...]:
    """TRIALS comparisons of two agents over CYCLES cycles of CASES_PER_CYCLE new cases (case ids unique
    per cycle), the candidate passing with probability p + shift where the incumbent passes with p. The
    ledger is rewritten cumulatively and ``compare_eval_windows`` is called after EVERY cycle."""
    rng = random.Random(SEED)
    start = _NOW - timedelta(days=20)
    trials = []
    with tempfile.TemporaryDirectory() as tmp:
        tools = Path(tmp) / "aria-tools"
        ensure_tools_dir(tools)
        ledger = _MemoryLedger(tools)
        with ledger.serving():
            for _ in range(TRIALS):
                rows: list[dict[str, Any]] = []
                verdicts: list[str] = []
                fixed_n: list[bool] = []
                for cycle in range(CYCLES):
                    at = start + timedelta(hours=cycle + 1)
                    for i in range(CASES_PER_CYCLE):
                        probability = rng.choice(PASS_PROBABILITIES)
                        incumbent_passes = rng.random() < probability
                        candidate_passes = rng.random() < min(0.97, max(0.0, probability + shift))
                        rows += [_run("cand", f"C{cycle:02d}-{i:02d}", candidate_passes, at),
                                 _run("inc", f"C{cycle:02d}-{i:02d}", incumbent_passes, at)]
                    ledger.replace(rows)
                    result = _compare(tools, window_start=start)
                    verdicts.append(result["verdict"])
                    fixed_n.append(_fixed_n_improved(*_counts(result)))
                trials.append(_Trial(tuple(verdicts), tuple(fixed_n)))
    return tuple(trials)


def _ever(trials: tuple[_Trial, ...], verdict: str) -> int:
    return sum(1 for trial in trials if verdict in trial.verdicts)


class PeekedAATests(unittest.TestCase):
    def test_two_identical_agents_looked_at_every_cycle_improve_no_more_often_than_alpha(self) -> None:
        trials = _peeked_trials(0.0)
        self.assertEqual({len(trial.verdicts) for trial in trials}, {CYCLES})
        improved, regressed = _ever(trials, "improved"), _ever(trials, "regressed")
        self.assertLessEqual(improved, ALPHA * TRIALS, f"A/A improved at some look in {improved}/{TRIALS}")
        self.assertLessEqual(regressed, ALPHA * TRIALS, f"A/A regressed at some look in {regressed}/{TRIALS}")

    def test_the_fixed_n_rule_on_the_same_draws_is_inflated_by_looking(self) -> None:
        # The contrast: the assertion above can fail.
        fixed_n = sum(1 for trial in _peeked_trials(0.0) if any(trial.fixed_n))
        self.assertGreaterEqual(fixed_n, 1.5 * ALPHA * TRIALS, f"fixed-n improved at some look in {fixed_n}/{TRIALS}")


class PeekedEffectTests(unittest.TestCase):
    """The method must still decide when there is an effect."""

    def test_a_known_gain_is_found(self) -> None:
        trials = _peeked_trials(EFFECT)
        self.assertGreaterEqual(_ever(trials, "improved"), 0.90 * TRIALS)
        self.assertEqual(_ever(trials, "regressed"), 0)
        firsts = [trial.first("improved") for trial in trials if trial.first("improved") is not None]
        self.assertLessEqual(statistics.median(firsts), 6)

    def test_a_known_loss_is_found(self) -> None:
        trials = _peeked_trials(-EFFECT)
        self.assertGreaterEqual(_ever(trials, "regressed"), 0.90 * TRIALS)
        self.assertEqual(_ever(trials, "improved"), 0)

    def test_the_price_of_a_small_effect_is_reported_not_asserted(self) -> None:
        trials = _peeked_trials(SMALL_EFFECT)
        print(f"F1.8(a) +{SMALL_EFFECT} effect: improved at some look in {_ever(trials, 'improved')}/{TRIALS} "
              f"(fixed-n peeked: {sum(1 for t in trials if any(t.fixed_n))}/{TRIALS})")
        self.assertEqual(len(trials), TRIALS)


# ---------------------------------------------------------------------------
# 9. the lifecycle anchor, read through SE-5's replay
# ---------------------------------------------------------------------------

def _state(tools: Path, entity_id: str) -> Any:
    return genesis_lifecycle.current_lifecycle_state(entity_id=entity_id, base_dir=tools)


class LifecycleAnchorTests(_LedgerCase):
    """The anchor is the entry stamp of a LAWFUL chain whose replayed state is EVAL_WINDOW, and nothing else."""

    def _entered(self, entity_id: str) -> datetime | None:
        return _api(genesis_lifecycle, "eval_window_entered_at")(entity_id=entity_id, base_dir=self.tools)

    def test_it_returns_the_instant_the_entity_entered_eval_window(self) -> None:
        entered = _NOW - timedelta(days=3)
        _enter_eval_window(self.tools, "cand", entered, shadow_at=_NOW - timedelta(days=9))
        self.assertEqual(_state(self.tools, "cand"), "EVAL_WINDOW", "the fixture is not a lawful chain in EVAL_WINDOW")
        result = self._entered("cand")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsNotNone(result.tzinfo)
        self.assertEqual(result, entered)

    def test_the_anchor_is_the_entry_stamp_and_the_rows_of_other_entities_do_not_move_it(self) -> None:
        # The lawful twin of F1.8's "an unknown to_state row is ignored": the entry stamp is the anchor, and rows
        # written after it (here another entity's, to ACTIVE, stamped later) do not move it.
        entered = _NOW - timedelta(days=3)
        _enter_eval_window(self.tools, "cand", entered, shadow_at=_NOW - timedelta(days=9))
        chain(self.tools, "other", "ACTIVE", recorded_at=_ladder_stamps(_NOW - timedelta(days=1), "ACTIVE"))
        self.assertEqual(_state(self.tools, "cand"), "EVAL_WINDOW")
        self.assertEqual(_state(self.tools, "other"), "ACTIVE")
        self.assertIsNone(_state(self.tools, "nobody"))
        self.assertEqual(self._entered("cand"), entered)

    def test_an_unknown_to_state_makes_the_chain_invalid_so_there_is_no_anchor(self) -> None:
        # F1.8 asserted that the unknown row is IGNORED (state EVAL_WINDOW, anchor kept). SE-5's rule: a row naming
        # a state the vocabulary does not know breaks the chain, so the entity has no state and no anchor.
        _enter_eval_window(self.tools, "cand", _NOW - timedelta(days=3), shadow_at=_NOW - timedelta(days=9))
        forged_row(
            self.tools, "cand", "NOT-A-STATE", from_state="EVAL_WINDOW", recorded_at=_days_ago(2)
        )
        chain(self.tools, "other", "ACTIVE", recorded_at=_ladder_stamps(_NOW - timedelta(days=1), "ACTIVE"))
        self.assertIsInstance(_state(self.tools, "cand"), genesis_lifecycle.InvalidLifecycleChain)
        self.assertEqual(_state(self.tools, "other"), "ACTIVE")
        self.assertIsNone(_state(self.tools, "nobody"))
        self.assertIsNone(self._entered("cand"))

    def test_an_entity_that_left_eval_window_has_no_anchor(self) -> None:
        # Ruling 1: the anchor belongs to the entity that is in EVAL_WINDOW now. F1.8 kept it after ACTIVE, but its
        # ACTIVE row carried no kernel-computed proof, a chain SE-5 refuses; the lawful chain has left the window.
        chain(self.tools, "promoted", "ACTIVE", recorded_at=_ladder_stamps(_NOW - timedelta(days=1), "ACTIVE"))
        _enter_eval_window(self.tools, "rejected", _NOW - timedelta(days=3))
        forged_row(
            self.tools, "rejected", "REJECTED", from_state="EVAL_WINDOW", evidence={},
            recorded_at=_days_ago(1),
        )
        for entity, state in (("promoted", "ACTIVE"), ("rejected", "REJECTED")):
            with self.subTest(entity=entity):
                self.assertEqual(_state(self.tools, entity), state, "the fixture is not a lawful chain")
                self.assertIsNone(self._entered(entity))

    def test_an_entity_that_never_entered_has_no_anchor(self) -> None:
        # Every lawful chain that stops before EVAL_WINDOW (and a rejected draft) has rows with readable stamps; the
        # last row's stamp is not an anchor.
        for through in (*LADDER[: LADDER.index("SHADOW") + 1], "REJECTED"):
            with self.subTest(through=through):
                entity = f"before-{through.lower()}"
                chain(self.tools, entity, through)
                self.assertEqual(_state(self.tools, entity), through, "the fixture is not a lawful chain")
                self.assertIsNone(self._entered(entity))
        self.assertIsNone(self._entered("nobody"))

    def test_another_entitys_row_is_not_the_anchor(self) -> None:
        _enter_eval_window(self.tools, "entity-b", _NOW - timedelta(days=3))
        self.assertIsNone(self._entered("entity-a"))
        self.assertEqual(self._entered("entity-b"), _NOW - timedelta(days=3))

    def test_an_unreadable_stamp_is_no_anchor_and_a_naive_stamp_is_read_as_utc(self) -> None:
        _enter_eval_window(self.tools, "garbled", None, stamp="not-a-stamp")
        self.assertEqual(_state(self.tools, "garbled"), "EVAL_WINDOW", "the fixture is not a lawful chain")
        self.assertIsNone(self._entered("garbled"))
        _enter_eval_window(self.tools, "naive", None, stamp=(_NOW - timedelta(days=2)).replace(tzinfo=None).isoformat())
        self.assertEqual(self._entered("naive"), _NOW - timedelta(days=2))


class ForgedChainTests(_LedgerCase):
    """SE-5: a forged row cannot move an entity, so it cannot anchor one either (fail closed).

    Every forgery carries a perfectly readable EVAL_WINDOW stamp, so a reader that does not ask the replay
    returns it. Three of them are the inputs F1.8's own fixtures used: the lone entry row, the unknown state that
    was ignored, and the ACTIVE row without the kernel-computed proof."""

    def _forge_unknown_state_after_the_entry(self, entity: str) -> None:
        _enter_eval_window(self.tools, entity, _NOW - timedelta(days=3))
        forged_row(self.tools, entity, "NOT-A-STATE", from_state="EVAL_WINDOW", recorded_at=_days_ago(2))

    def _forge_entry_without_proof_evidence(self, entity: str) -> None:
        chain(self.tools, entity, "SHADOW", recorded_at=_ladder_stamps(_NOW - timedelta(days=4), "SHADOW"))
        forged_row(self.tools, entity, "EVAL_WINDOW", from_state="SHADOW", evidence={}, recorded_at=_days_ago(3))

    def _forge_lone_entry_row(self, entity: str) -> None:
        forged_row(self.tools, entity, "EVAL_WINDOW", from_state=None, evidence={}, recorded_at=_days_ago(3))

    def _forge_lone_entry_row_with_proof_evidence(self, entity: str) -> None:
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state=None, evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(3),
        )

    def _forge_skipped_state(self, entity: str) -> None:
        chain(self.tools, entity, "DRAFT", recorded_at=_ladder_stamps(_NOW - timedelta(days=4), "DRAFT"))
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state="DRAFT", evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(3),
        )

    def _forge_a_recorded_from_state_that_differs(self, entity: str) -> None:
        chain(self.tools, entity, "SHADOW", recorded_at=_ladder_stamps(_NOW - timedelta(days=4), "SHADOW"))
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state="DRAFT", evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(3),
        )

    def _forge_active_without_the_kernel_proof(self, entity: str) -> None:
        _enter_eval_window(self.tools, entity, _NOW - timedelta(days=3))
        forged_row(
            self.tools, entity, "ACTIVE", from_state="EVAL_WINDOW", evidence=evidence_for("ACTIVE", with_proof=False),
            recorded_at=_days_ago(1),
        )

    def _forge_a_second_entry(self, entity: str) -> None:
        # EVAL_WINDOW -> EVAL_WINDOW is no transition: an entity cannot enter the window twice.
        _enter_eval_window(self.tools, entity, _NOW - timedelta(days=3))
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state="EVAL_WINDOW", evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(1),
        )

    def _forge_a_re_entry_through_shadow(self, entity: str) -> None:
        # The replay ends in EVAL_WINDOW, but the way back to SHADOW is no transition: neither entry is the
        # anchor of a stay (the first row and the last row are both readable stamps).
        _enter_eval_window(self.tools, entity, _NOW - timedelta(days=3))
        forged_row(
            self.tools, entity, "SHADOW", from_state="EVAL_WINDOW", evidence=evidence_for("SHADOW"),
            recorded_at=_days_ago(2),
        )
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state="SHADOW", evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(1),
        )

    def _forge_an_entry_after_a_rejection(self, entity: str) -> None:
        chain(self.tools, entity, "REJECTED")
        forged_row(
            self.tools, entity, "EVAL_WINDOW", from_state="REJECTED", evidence=evidence_for("EVAL_WINDOW"),
            recorded_at=_days_ago(3),
        )

    def _forgeries(self) -> dict[str, Callable[[str], None]]:
        return {
            "unknown_state_after_the_entry": self._forge_unknown_state_after_the_entry,
            "entry_without_proof_evidence": self._forge_entry_without_proof_evidence,
            "lone_entry_row": self._forge_lone_entry_row,
            "lone_entry_row_with_proof_evidence": self._forge_lone_entry_row_with_proof_evidence,
            "skipped_state": self._forge_skipped_state,
            "a_recorded_from_state_that_differs": self._forge_a_recorded_from_state_that_differs,
            "active_without_the_kernel_proof": self._forge_active_without_the_kernel_proof,
            "a_second_entry": self._forge_a_second_entry,
            "a_re_entry_through_shadow": self._forge_a_re_entry_through_shadow,
            "an_entry_after_a_rejection": self._forge_an_entry_after_a_rejection,
        }

    def _entered(self, entity_id: str) -> datetime | None:
        return _api(genesis_lifecycle, "eval_window_entered_at")(entity_id=entity_id, base_dir=self.tools)

    def test_a_chain_the_replay_refuses_has_no_anchor(self) -> None:
        for name, forge in self._forgeries().items():
            with self.subTest(forgery=name):
                forge(name)
                # The premise, from API that exists at the base: SE-5 refuses the chain.
                self.assertIsInstance(
                    _state(self.tools, name), genesis_lifecycle.InvalidLifecycleChain,
                    f"the fixture {name!r} is a lawful chain, so it proves nothing",
                )
                self.assertIsNone(self._entered(name), f"{name}: a chain the replay refuses anchored the comparison")

    def test_a_forged_chain_does_not_cost_a_lawful_entity_its_anchor(self) -> None:
        entered = _NOW - timedelta(days=4)
        self._forge_entry_without_proof_evidence("forged")
        _enter_eval_window(self.tools, "lawful", entered)
        self._forge_a_second_entry("forged-too")
        self.assertIsNone(self._entered("forged"))
        self.assertIsNone(self._entered("forged-too"))
        self.assertEqual(self._entered("lawful"), entered)


class ReadsThroughTheReplayTests(_LedgerCase):
    """``eval_window_entered_at`` has no ledger walk of its own: SE-5's replay is the one reader of the events file."""

    LOADERS = frozenset({"load_declared_jsonl", "load_jsonl", "open"})
    READERS = ("current_lifecycle_state", "eval_window_entered_at")

    @classmethod
    def violations(cls, source: str) -> list[str]:
        """What SE-5's one-owner law finds wrong with a module's way of reading the lifecycle events ledger.

        The loop over the events file is ``_rows_by_entity`` and nothing else reaches the file (a loader called
        from a reader, or from any function a reader calls, is a second walk); both readers reach it through that
        loop AND replay what it returns (``_replay``, directly or through ``lifecycle_chains``); ``_entity_rows``,
        F1.8's private iterator, does not come back."""
        functions = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
        calls = {
            name: {c.func.id for c in ast.walk(node) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)}
            for name, node in functions.items()
        }

        def reachable(name: str) -> set[str]:
            seen: set[str] = set()
            pending = [name]
            while pending:
                current = pending.pop()
                if current in seen or current not in functions:
                    continue
                seen.add(current)
                pending.extend(calls[current])
            return seen

        found: list[str] = []
        if "_entity_rows" in functions:
            found.append("_entity_rows is back: a second iterator over the entity's rows")
        if "_rows_by_entity" not in functions or "_replay" not in functions:
            found.append("the replay owner (_rows_by_entity, _replay) is missing")
        for reader in cls.READERS:
            if reader not in functions:
                found.append(f"{reader} is missing")
                continue
            reached = reachable(reader)
            walkers = sorted(name for name in reached if calls[name] & cls.LOADERS)
            if walkers != ["_rows_by_entity"]:
                found.append(f"{reader} reads the ledger through {walkers}, not through _rows_by_entity alone")
            for owner in ("_rows_by_entity", "_replay"):
                if owner not in reached:
                    found.append(f"{reader} never reaches {owner}")
        return found

    def test_the_one_loop_over_the_events_file_is_rows_by_entity(self) -> None:
        _api(genesis_lifecycle, "eval_window_entered_at")
        self.assertEqual(self.violations(inspect.getsource(genesis_lifecycle)), [])
        self.assertFalse(hasattr(genesis_lifecycle, "_entity_rows"))

    def test_the_check_accepts_both_lawful_shapes_and_fails_the_mutant_readers(self) -> None:
        shared = (
            "def _rows_by_entity(base_dir):\n"
            "    return load_declared_jsonl(lifecycle_events_path(base_dir), expected_surface='x')\n"
            "def _replay(entity_id, rows, root):\n    return rows\n"
            "def lifecycle_chains(base_dir):\n"
            "    return {e: _replay(e, r, base_dir) for e, r in _rows_by_entity(base_dir).items()}\n"
            "def current_lifecycle_state(*, entity_id, base_dir=None):\n"
            "    return _replay(entity_id, _rows_by_entity(base_dir).get(entity_id, []), base_dir)\n"
        )
        lawful = (
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    return _replay(entity_id, _rows_by_entity(base_dir).get(entity_id, []), base_dir)\n"
        )
        lawful_through_the_chains = (
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    return lifecycle_chains(base_dir).get(entity_id)\n"
        )
        loops_the_file_itself = (
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    for row in load_declared_jsonl(lifecycle_events_path(base_dir), expected_surface='x'):\n"
            "        return row\n"
        )
        loops_the_file_through_another_loader = (
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    return [row for row in load_jsonl(events_file(base_dir))]\n"
        )
        walks_through_a_helper = (
            "def _entity_rows(*, entity_id, base_dir=None):\n"
            "    return [r for r in load_declared_jsonl(lifecycle_events_path(base_dir), expected_surface='x')]\n"
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    return _entity_rows(entity_id=entity_id, base_dir=base_dir)\n"
        )
        never_replays = (
            "def eval_window_entered_at(*, entity_id, base_dir=None):\n"
            "    return _rows_by_entity(base_dir).get(entity_id)\n"
        )
        self.assertEqual(self.violations(shared + lawful), [])
        self.assertEqual(self.violations(shared + lawful_through_the_chains), [])
        for name, mutant in (
            ("loops_the_file_itself", loops_the_file_itself),
            ("loops_the_file_through_another_loader", loops_the_file_through_another_loader),
            ("walks_through_a_helper", walks_through_a_helper),
            ("never_replays", never_replays),
        ):
            with self.subTest(mutant=name):
                self.assertTrue(self.violations(shared + mutant), f"the check accepts the mutant reader {name}")

    def test_each_reader_walks_the_events_ledger_once_and_replays_once(self) -> None:
        # One walk and one replay per question: a reader that asks the state first and then walks the rows itself
        # (two walks of the same ledger) reads the entity at two moments and can answer from two different chains.
        _enter_eval_window(self.tools, "cand", _NOW - timedelta(days=3))
        entered = _api(genesis_lifecycle, "eval_window_entered_at")
        readers = {
            "current_lifecycle_state": lambda: _state(self.tools, "cand"),
            "eval_window_entered_at": lambda: entered(entity_id="cand", base_dir=self.tools),
        }
        for name, ask in readers.items():
            with self.subTest(reader=name):
                with mock.patch.object(
                    genesis_lifecycle, "load_declared_jsonl", wraps=genesis_lifecycle.load_declared_jsonl
                ) as walks, mock.patch.object(genesis_lifecycle, "_replay", wraps=genesis_lifecycle._replay) as replays:
                    answer = ask()
                self.assertIsNotNone(answer)
                self.assertEqual(walks.call_count, 1, f"{name} walked the ledger {walks.call_count} times")
                self.assertEqual(replays.call_count, 1, f"{name} replayed {replays.call_count} times")

    def test_the_anchor_follows_what_the_replay_says_not_what_the_rows_say(self) -> None:
        # The rows are lawful. If the replay owner says the chain is invalid, or says the entity is elsewhere, the
        # entity has no anchor: a reader that reads the rows past the replay is a second owner.
        entered = _api(genesis_lifecycle, "eval_window_entered_at")
        stamp = _NOW - timedelta(days=3)
        _enter_eval_window(self.tools, "cand", stamp)
        real_replay = genesis_lifecycle._replay
        self.assertEqual(entered(entity_id="cand", base_dir=self.tools), stamp)
        verdicts = {
            "invalid": genesis_lifecycle.InvalidLifecycleChain("cand", ("forced_by_the_test",)),
            "shadow": "SHADOW",
            "active": "ACTIVE",
            "none": None,
        }
        for name, state in verdicts.items():
            with self.subTest(replayed_state=name):
                with mock.patch.object(
                    genesis_lifecycle, "_replay",
                    side_effect=lambda *a, _state=state, **k: dataclasses.replace(real_replay(*a, **k), state=_state),
                ):
                    self.assertIsNone(entered(entity_id="cand", base_dir=self.tools))
        with mock.patch.object(
            genesis_lifecycle, "_replay",
            side_effect=lambda *a, **k: dataclasses.replace(real_replay(*a, **k), state="EVAL_WINDOW"),
        ):
            self.assertEqual(entered(entity_id="cand", base_dir=self.tools), stamp)


# ---------------------------------------------------------------------------
# 10. the gate
# ---------------------------------------------------------------------------

GATE_ANCHOR = _NOW - timedelta(days=35)
GATE_BASELINE_AT = _NOW - timedelta(days=40)
GATE_CURRENT_AT = _NOW - timedelta(days=5)


class GateTests(_LedgerCase):
    """``compute_eval_window_superiority`` anchors the comparison at the entity's EVAL_WINDOW entry."""

    def _better_runs(self, entity: str, count: int = 100) -> list[dict[str, Any]]:
        rows = [_run(entity, f"CASE-{i:03d}", False, GATE_BASELINE_AT) for i in range(count)]
        return rows + [_run(entity, f"CASE-{i:03d}", True, GATE_CURRENT_AT) for i in range(count)]

    def _spied_calls(self, entity: str) -> list[Any]:
        with mock.patch.object(genesis_superiority, "compare_eval_windows", wraps=compare_eval_windows) as spy:
            compute_eval_window_superiority(entity_id=entity, base_dir=self.tools)
        return spy.call_args_list

    def test_the_comparison_starts_at_the_entry_and_keeps_the_registered_values(self) -> None:
        _enter_eval_window(self.tools, "cand", GATE_ANCHOR)
        _write_runs(self.tools, self._better_runs("cand", 20))
        calls = self._spied_calls("cand")
        self.assertTrue(calls, "the promotion decision ran no comparison")
        for call in calls:
            self.assertEqual(call.kwargs.get("window_start"), GATE_ANCHOR, "the comparison is not anchored at the entry")
            self.assertEqual(call.kwargs.get("incumbent_agent"), "cand")  # ARIA-HIGH-944 is not changed here
            self.assertEqual(call.kwargs.get("target_agent"), "cand")
            self.assertIs(call.kwargs.get("mock_mode"), False)
            self.assertEqual(call.kwargs.get("alpha"), ALPHA)
            self.assertEqual(call.kwargs.get("min_discordant_pairs"), MIN_PAIRS)

    def test_with_no_entry_the_anchor_is_the_instant_of_the_look_and_nothing_can_pass(self) -> None:
        _write_runs(self.tools, self._better_runs("cand"))
        before = datetime.now(timezone.utc)
        proof = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools)
        after = datetime.now(timezone.utc)
        self.assertFalse(proof["passed"], "100 better runs promoted an entity that never entered EVAL_WINDOW")
        self.assertEqual(proof["window"]["verdict"], "insufficient_evidence")
        self.assertIn("window_start", proof["window"])
        self.assertTrue(before <= _parse(proof["window"]["window_start"]) <= after)

    def test_one_entitys_entry_is_not_another_entitys_anchor(self) -> None:
        _enter_eval_window(self.tools, "entity-a", GATE_ANCHOR)
        _write_runs(self.tools, self._better_runs("entity-b"))
        proof = compute_eval_window_superiority(entity_id="entity-b", base_dir=self.tools)
        self.assertFalse(proof["passed"], "entity-b was measured from entity-a's EVAL_WINDOW entry")
        self.assertEqual(proof["window"]["verdict"], "insufficient_evidence")

    def test_each_entity_is_measured_from_its_own_entry(self) -> None:
        entry_b = _NOW - timedelta(days=36)
        _enter_eval_window(self.tools, "entity-a", GATE_ANCHOR)
        _enter_eval_window(self.tools, "entity-b", entry_b)
        _write_runs(self.tools, self._better_runs("entity-a", 10) + self._better_runs("entity-b", 10))
        for entity, entry in (("entity-a", GATE_ANCHOR), ("entity-b", entry_b)):
            for call in self._spied_calls(entity):
                self.assertEqual(call.kwargs.get("window_start"), entry, entity)

    def test_the_proof_survives_json_with_no_nan(self) -> None:
        _enter_eval_window(self.tools, "cand", GATE_ANCHOR)
        _write_runs(self.tools, self._better_runs("cand"))
        proof = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools)
        json.dumps(proof, allow_nan=False)
        self.assertEqual(proof["window"]["test"], SEQUENTIAL_TEST_NAME)
        self.assertEqual(_parse(proof["window"]["window_start"]), GATE_ANCHOR)
        self.assertTrue(proof["passed"], proof["reasons"])

    def test_a_forged_chain_gives_the_gate_no_anchor_and_nothing_can_pass(self) -> None:
        # F1.8 entered the window with a lone EVAL_WINDOW row without proof evidence. SE-5 refuses that chain, so the
        # entity has no anchor and the comparison starts at the look: no evidence, no promotion (as production
        # is blocked for the same entity). Read from the forged row it would be 'improved' (100 pairs).
        forged_row(self.tools, "cand", "EVAL_WINDOW", from_state=None, evidence={}, recorded_at=_stamp(GATE_ANCHOR))
        self.assertIsInstance(_state(self.tools, "cand"), genesis_lifecycle.InvalidLifecycleChain)
        _write_runs(self.tools, self._better_runs("cand"))
        before = datetime.now(timezone.utc)
        proof = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools)
        after = datetime.now(timezone.utc)
        self.assertFalse(proof["passed"], "100 better runs promoted an entity whose chain does not replay")
        self.assertEqual(proof["window"]["verdict"], "insufficient_evidence")
        self.assertTrue(
            before <= _parse(proof["window"]["window_start"]) <= after, "the comparison was anchored at a forged row"
        )

    def test_the_promotion_record_carries_the_proof_anchored_at_the_replayed_entry(self) -> None:
        # The producer path end to end: record_transition replays the chain, computes the proof kernel-side
        # (anchored at the entry the replay yields) and writes an ACTIVE row that itself replays.
        _enter_eval_window(self.tools, "cand", GATE_ANCHOR)
        _write_runs(self.tools, self._better_runs("cand"))
        row = genesis_lifecycle.record_transition(
            entity_id="cand", entity_kind="agent", to_state="ACTIVE", evidence={"reviewers": ["r1", "r2"]},
            base_dir=self.tools,
        )
        window = row["evidence"]["resolved_eval_window_superiority"]["window"]
        self.assertEqual(window["verdict"], "improved")
        self.assertEqual(_parse(window["window_start"]), GATE_ANCHOR)
        self.assertEqual(_state(self.tools, "cand"), "ACTIVE")


@functools.lru_cache(maxsize=None)
def _gate_trials(shift: float) -> tuple[tuple[int | None, ...], dict[str, Any] | None]:
    """GATE_TRIALS entities, each with a baseline run of GATE_CASES cases before its EVAL_WINDOW entry and
    CYCLES cycles of CASES_PER_CYCLE re-runs after it; the gate is asked after EVERY cycle. Returns the
    first cycle at which each trial's proof passed (None: never) and one passing proof's window.

    Cost only: the reader serves rows from memory, the duel and judge-fitness components (empty ledgers
    in a simulation, their ``not_evaluated`` / ``unmeasured`` answers) are fixed, and the lifecycle
    reader skips the tools-dir index refresh. The anchor read itself, the policy and the comparison are real."""
    rng = random.Random(SEED)
    unmeasured = {"status": "unmeasured", "rows": []}
    passed_at: list[int | None] = []
    sample: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory() as tmp:
        tools = Path(tmp) / "aria-tools"
        ensure_tools_dir(tools)
        _enter_eval_window(tools, "cand", GATE_ANCHOR)
        ledger = _MemoryLedger(tools)
        with ExitStack() as stack:
            stack.enter_context(ledger.serving())
            stack.enter_context(mock.patch.object(genesis_superiority, "duel_observations", return_value=[]))
            stack.enter_context(mock.patch.object(genesis_superiority, "judge_fitness", return_value=unmeasured))
            stack.enter_context(mock.patch.object(
                genesis_lifecycle, "ensure_tools_dir", side_effect=lambda base_dir=None: Path(str(base_dir))
            ))
            for _ in range(GATE_TRIALS):
                baseline, candidate = [], []
                for _case in range(GATE_CASES):
                    probability = rng.choice(PASS_PROBABILITIES)
                    baseline.append(rng.random() < probability)
                    candidate.append(rng.random() < min(0.97, max(0.0, probability + shift)))
                rows = [_run("cand", f"CASE-{i:03d}", baseline[i], GATE_BASELINE_AT) for i in range(GATE_CASES)]
                first_pass: int | None = None
                for cycle in range(CYCLES):
                    at = GATE_ANCHOR + timedelta(days=cycle + 1)
                    lo = cycle * CASES_PER_CYCLE
                    rows += [_run("cand", f"CASE-{i:03d}", candidate[i], at) for i in range(lo, lo + CASES_PER_CYCLE)]
                    ledger.replace(rows)
                    proof = compute_eval_window_superiority(entity_id="cand", base_dir=tools)
                    if proof["passed"]:
                        first_pass = cycle + 1
                        sample = sample or proof["window"]
                        break
                passed_at.append(first_pass)
    return tuple(passed_at), sample


class GateSimulationTests(unittest.TestCase):
    def test_two_identical_versions_looked_at_every_cycle_pass_the_gate_no_more_often_than_alpha(self) -> None:
        passed_at, _ = _gate_trials(0.0)
        passed = sum(1 for cycle in passed_at if cycle is not None)
        self.assertLessEqual(passed, ALPHA * GATE_TRIALS, f"A/A passed the gate in {passed}/{GATE_TRIALS} trials")

    def test_a_known_gain_passes_the_gate_so_the_aa_bound_is_not_vacuous(self) -> None:
        # Without the anchor the proof can never pass, and the A/A assertion above would still read '<= alpha'.
        passed_at, sample = _gate_trials(EFFECT)
        passed = sum(1 for cycle in passed_at if cycle is not None)
        self.assertGreaterEqual(passed, 0.90 * GATE_TRIALS, f"a +{EFFECT} gain passed the gate in {passed}/{GATE_TRIALS}")
        assert sample is not None
        self.assertEqual(sample["test"], SEQUENTIAL_TEST_NAME)
        self.assertEqual(_parse(sample["window_start"]), GATE_ANCHOR)


# ---------------------------------------------------------------------------
# 12. the fixed-n decision is gone, in code and in the shipped text
# ---------------------------------------------------------------------------

class FixedNDecisionIsGoneTests(unittest.TestCase):
    def test_the_fixed_n_names_are_deleted(self) -> None:
        for name in ("PAIRED_TEST", "_newest_outcome_per_case"):
            self.assertFalse(hasattr(agent_eval, name), f"agent_eval still defines {name}")

    def test_the_first_outcome_per_case_reads_the_earliest_run_and_ties_to_the_earlier_row(self) -> None:
        first = _api(agent_eval, "_first_outcome_per_case")
        t = _NOW
        runs = [
            (t + timedelta(days=2), {"fixture_id": "A", "passed": True}),
            (t + timedelta(days=1), {"fixture_id": "A", "passed": False}),
            (t, {"fixture_id": "B", "passed": True}),
            (t, {"fixture_id": "B", "passed": False}),
            (t + timedelta(days=1), {"fixture_id": "C", "passed": True}),
        ]
        self.assertEqual(first(runs), {"A": False, "B": True, "C": True})

    def test_the_shipped_policy_text_no_longer_states_the_fixed_n_rule(self) -> None:
        policy = default_policy()
        self.assertNotIn("smallest count at which p <= 0.05 is reachable", policy["superiority"]["_doc"])
        self.assertNotIn("'improved' only when p <= alpha", policy["superiority"]["_doc"])
        self.assertNotIn("exact one-sided McNemar", policy["service_expertise"]["genesis"]["_doc"])


if __name__ == "__main__":
    unittest.main()
