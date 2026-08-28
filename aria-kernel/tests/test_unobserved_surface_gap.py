"""H-3 — ARIA files its own blindness, and only when it has proved it.

`observation_coverage` measured, on 2026-08-19, that 71.8% of tracked
files fall inside some adapter's declared_scope and that seventeen roots
are seen by nothing at all. A measurement nothing consumes is a number,
not a capability; these tests pin the consumption.

What is pinned, and why each one is a refusal rather than a feature:

* ONE NIGHT MINTS NOTHING. A single blind measurement is a snapshot — a
  manifest mid-edit, a root that landed at 23:00 — and filing it would
  train the operator to ignore the gap type.
* A NIGHT THAT MEASURED NOTHING BREAKS THE STREAK. `unknown` is not
  blindness, exactly as `unknown` is not green.
* TWO CYCLES IN ONE NIGHT ARE ONE NIGHT, so a re-run cannot buy evidence.
* A ROOT SEEN IN BETWEEN STARTS OVER — the claim is "consecutive".
* THE PAYLOAD IS AN ASSIGNMENT. Root, file count, and the file types no
  adapter in the toolbox can parse: the last one names the parser that
  has to exist, which is the difference between a gap and a complaint.
* AN UNREGISTERED gap_type IS REFUSED AT MINT, so a type can never reach
  the learning router without a branch that knows what to do with it.
"""
from __future__ import annotations

import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

import aria_kernel.capability_gap as cg  # noqa: E402
from aria_kernel.observation_coverage import (  # noqa: E402
    MIN_UNOBSERVED_NIGHTS_BEFORE_GAP,
    ObservationVerdict,
    RootCoverage,
    unobserved_nights_before_gap,
)
from aria_kernel.tool_registry import GovernanceError  # noqa: E402


def _blind_root(root: str, *, files: int = 42, types_: tuple[str, ...] = (".rs", ".toml")) -> RootCoverage:
    return RootCoverage(
        root=root,
        files=files,
        observed_files=0,
        observing_adapters=(),
        verdict="unobserved",
        reason="no adapter declares a scope that matches any file here",
        unparsed_file_types=types_,
    )


def _verdict(*rows: RootCoverage, verdict: str = "red") -> ObservationVerdict:
    return ObservationVerdict(
        verdict=verdict,
        reason="unobserved roots: " + ", ".join(row.root for row in rows),
        observed_ratio=0.718,
        roots=tuple(rows),
    )


def _nights_ago(count: int) -> str:
    """Dates are RELATIVE to the running clock on purpose: tonight's own
    measurement occupies today's date, so a fixture pinned to a literal
    date would silently lose a night the day the calendar caught up."""
    stamp = datetime.now(timezone.utc) - timedelta(days=count)
    return stamp.date().isoformat()


def _night(nights_ago: int, blind: list[str] | None) -> dict:
    """One recorded gap batch, as `detect_capability_gaps` writes it."""
    date = _nights_ago(nights_ago)
    return {
        "schema_version": 1,
        "recorded_at": f"{date}T02:00:00+00:00",
        "cycle_id": f"cyc-{date}",
        "gap_count": 0,
        "unobserved_roots": blind,
        "gaps": [],
    }


class UnobservedSurfaceGapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = (cg.evaluate_observation_coverage, cg.list_capability_gaps)
        self.paths = types.SimpleNamespace(repo_root="/repo")

    def tearDown(self) -> None:
        cg.evaluate_observation_coverage, cg.list_capability_gaps = self._orig

    def _run(self, verdict: ObservationVerdict, history: list[dict]):
        cg.evaluate_observation_coverage = lambda repo_root: verdict
        cg.list_capability_gaps = lambda base_dir=None: history
        return cg._gaps_from_unobserved_surface("c1", self.paths, Path("/tmp"), "idx")

    def test_a_single_blind_night_mints_nothing(self) -> None:
        gaps, tonight = self._run(_verdict(_blind_root("sens-api-gateway")), [])
        self.assertEqual(gaps, [])
        # The measurement is still RECORDED. Without tonight's record the
        # first N-1 nights leave no trace and the streak can never start.
        self.assertEqual(tonight, ["sens-api-gateway"])

    def test_three_consecutive_blind_nights_mint_one_gap(self) -> None:
        gaps, _ = self._run(
            _verdict(_blind_root("sens-api-gateway")),
            [
                _night(2, ["sens-api-gateway"]),
                _night(1, ["sens-api-gateway"]),
            ],
        )
        self.assertEqual(len(gaps), 1)
        gap = gaps[0]
        self.assertEqual(gap["gap_type"], "unobserved_surface")
        self.assertEqual(gap["capability_gap_key"], "observation:sens-api-gateway")
        self.assertEqual(gap["primary_source"], "observation-coverage")
        # Actionable: it must reach the genesis router, not park on a human.
        self.assertEqual(gap["blocked_by"], [])
        # A reader, not a reviewer.
        self.assertEqual(gap["recommended_action"], "author_new_aria_adapter")
        self.assertEqual(gap["related_existing_agents"], [])

    def test_the_payload_names_the_root_its_size_and_the_unparsable_types(self) -> None:
        gaps, _ = self._run(
            _verdict(_blind_root("sens-api-gateway", files=799, types_=(".rs", ".toml"))),
            [
                _night(2, ["sens-api-gateway"]),
                _night(1, ["sens-api-gateway"]),
            ],
        )
        details = gaps[0]["details"]
        self.assertEqual(details["root"], "sens-api-gateway")
        self.assertEqual(details["files"], 799)
        self.assertEqual(details["unparsed_file_types"], [".rs", ".toml"])
        self.assertEqual(details["consecutive_blind_nights"], 3)
        self.assertEqual(details["nights_required"], 3)
        self.assertIn(".rs", gaps[0]["title"])
        self.assertIn("sens-api-gateway", gaps[0]["evidence_refs"])

    def test_a_night_that_measured_nothing_breaks_the_streak(self) -> None:
        # `unobserved_roots: None` is a night ARIA could not measure. It did
        # not prove sight, but it did not prove blindness either, and the
        # claim being made is "unseen for three consecutive nights".
        gaps, _ = self._run(
            _verdict(_blind_root("sens-api-gateway")),
            [
                _night(3, ["sens-api-gateway"]),
                _night(2, None),
                _night(1, ["sens-api-gateway"]),
            ],
        )
        self.assertEqual(gaps, [])

    def test_two_cycles_in_one_night_count_as_one_night(self) -> None:
        gaps, _ = self._run(
            _verdict(_blind_root("sens-api-gateway")),
            [
                _night(1, ["sens-api-gateway"]),
                _night(0, ["sens-api-gateway"]),
            ],
        )
        # Two nights of evidence (yesterday + tonight); the second cycle
        # recorded today buys nothing.
        self.assertEqual(gaps, [])

    def test_a_root_seen_in_between_starts_the_count_over(self) -> None:
        gaps, _ = self._run(
            _verdict(_blind_root("sens-api-gateway")),
            [
                _night(4, ["sens-api-gateway"]),
                _night(3, ["sens-api-gateway"]),
                _night(2, []),  # measured, and it was covered
                _night(1, ["sens-api-gateway"]),
            ],
        )
        self.assertEqual(gaps, [])

    def test_each_root_carries_its_own_streak(self) -> None:
        gaps, tonight = self._run(
            _verdict(_blind_root("sens-api-gateway"), _blind_root("loginsample")),
            [
                _night(2, ["sens-api-gateway"]),
                _night(1, ["sens-api-gateway"]),
            ],
        )
        self.assertEqual([gap["details"]["root"] for gap in gaps], ["sens-api-gateway"])
        self.assertEqual(sorted(tonight), ["loginsample", "sens-api-gateway"])

    def test_an_unmeasurable_night_records_no_measurement(self) -> None:
        gaps, tonight = self._run(_verdict(verdict="unknown"), [])
        self.assertEqual(gaps, [])
        # None, never [] — an empty list would claim "measured, nothing
        # blind" and would silently break every streak it touched.
        self.assertIsNone(tonight)

    def test_an_exploding_measurement_never_takes_the_cycle_down(self) -> None:
        def boom(repo_root):
            raise RuntimeError("git unavailable")

        cg.evaluate_observation_coverage = boom
        cg.list_capability_gaps = lambda base_dir=None: []
        self.assertEqual(
            cg._gaps_from_unobserved_surface("c1", self.paths, Path("/tmp"), "idx"),
            ([], None),
        )

    def test_longer_blindness_scores_higher_than_the_minimum(self) -> None:
        history = [_night(day, ["sens-api-gateway"]) for day in range(10, 0, -1)]
        gaps, _ = self._run(_verdict(_blind_root("sens-api-gateway")), history)
        minimum, _ = self._run(
            _verdict(_blind_root("sens-api-gateway")),
            history[-2:],
        )
        self.assertGreater(gaps[0]["score"], minimum[0]["score"])


class NightlyRecordTests(unittest.TestCase):
    """The ledger row is the evidence chain. If `detect_capability_gaps`
    does not WRITE tonight's measurement, the streak has nothing to read
    tomorrow and a root can be blind forever without ever reaching three."""

    def setUp(self) -> None:
        self._orig = (cg.evaluate_observation_coverage, cg.effective_workspace_pressures)
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        self.paths = types.SimpleNamespace(repo_root=str(Path(self.tmp.name) / "repo"))
        cg.effective_workspace_pressures = lambda paths: []

    def tearDown(self) -> None:
        cg.evaluate_observation_coverage, cg.effective_workspace_pressures = self._orig
        self.tmp.cleanup()

    def test_the_gap_batch_records_tonights_blind_roots(self) -> None:
        cg.evaluate_observation_coverage = lambda repo_root: _verdict(
            _blind_root("sens-api-gateway"),
        )
        cg.detect_capability_gaps(cycle_id="cyc-record", paths=self.paths, base_dir=self.tools_dir)
        rows = cg.list_capability_gaps(base_dir=self.tools_dir)
        self.assertEqual(rows[-1]["unobserved_roots"], ["sens-api-gateway"])
        # First night: recorded, not filed.
        self.assertEqual(rows[-1]["gaps"], [])

    def test_a_night_that_could_not_measure_records_null_not_empty(self) -> None:
        cg.evaluate_observation_coverage = lambda repo_root: _verdict(verdict="unknown")
        cg.detect_capability_gaps(cycle_id="cyc-unknown", paths=self.paths, base_dir=self.tools_dir)
        rows = cg.list_capability_gaps(base_dir=self.tools_dir)
        self.assertIsNone(rows[-1]["unobserved_roots"])


class ForwardPointerTests(unittest.TestCase):
    """`recommended_action` is a closed vocabulary with two readers: the
    learning router picks the genesis surface, and `task._gap_next_action`
    turns it into the sentence a mission hands an agent. A word only the
    first reader knows makes the mission path refuse the candidate."""

    def test_the_adapter_recommendation_names_the_parser_to_write(self) -> None:
        from aria_kernel.task import _candidate_from_capability_gap

        candidate = _candidate_from_capability_gap("c1", {
            "gap_id": "gap-x",
            "capability_gap_key": "observation:sens-api-gateway",
            "recommended_action": "author_new_aria_adapter",
            "title": "t",
            "score": 73,
            "details": {"root": "sens-api-gateway", "unparsed_file_types": [".rs", ".toml"]},
        })
        action = candidate["next_action"]
        self.assertIn("adapter", action)
        self.assertIn("sens-api-gateway", action)
        self.assertIn(".rs", action)


class UnregisteredGapTypeTests(unittest.TestCase):
    def test_an_unregistered_gap_type_is_refused_at_mint(self) -> None:
        with self.assertRaises(GovernanceError) as caught:
            cg._gap(
                cycle_id="c1",
                gap_type="blindness",  # never registered
                source_id="x",
                title="t",
                evidence_refs=[],
                related_agents=[],
                score=10,
                blocked_by=[],
                capability_gap_key="k",
                primary_source="observation-coverage",
                source_types=["observation-coverage"],
                index_hash_at_decision=None,
            )
        self.assertIn("unregistered capability gap_type", str(caught.exception))

    def test_every_minted_source_is_ranked(self) -> None:
        # The vocabulary lives in two places; an unranked source silently
        # sorts last and loses its key in the dedup.
        self.assertLess(cg._source_rank("observation-coverage"), cg._source_rank("nonsense"))


class BlindnessThresholdTests(unittest.TestCase):
    def test_policy_may_raise_the_bar_but_not_lower_it_to_one_night(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "aria-config"
            config.mkdir()
            (config / "observation_map.json").write_text(
                '{"intentionally_unowned": [], "unobserved_nights_before_gap": 1}',
                encoding="utf-8",
            )
            self.assertEqual(
                unobserved_nights_before_gap(tmp), MIN_UNOBSERVED_NIGHTS_BEFORE_GAP,
            )
            (config / "observation_map.json").write_text(
                '{"intentionally_unowned": [], "unobserved_nights_before_gap": 7}',
                encoding="utf-8",
            )
            self.assertEqual(unobserved_nights_before_gap(tmp), 7)


if __name__ == "__main__":
    unittest.main()
