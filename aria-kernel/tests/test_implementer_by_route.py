"""ARIA-LOW-741 (package F3.1) — the implementer's episodes are scored per ROUTE, and an unstamped episode is a number.

WHAT BASE DOES TODAY. ``agent_eval._performance_episodes`` folds the plan ledger into episodes and ignores
``implementation_outcome_recorded`` events altogether; ``performance_kpis()["live"]`` has ``implementer_scorecard``
keyed by the agent NAME (``aria-implementer``) and nothing keyed by the provider and model that executed a change.
So a stamp on the outcome (``decision_stamp``: the executed route and the change's numstat) would be orphan memory:
recorded, read by nobody, and "which route's changes merge, and how big are they" unanswerable.

WHAT THIS PINS, on raw plan events (the ``_event`` helper of ``test_agent_eval_real_mode``, which do not validate)
folded by the REAL ``observe_agent_performance``:

* an implementer episode (``merged``, ``rejected``, ``self_reverted``) carries the plan's decision stamp under
  ``decision_stamp`` ONLY when the plan's outcome event carried one (the key is absent otherwise, like ``voided_by``);
  a drafter episode never carries one; the stamp is not part of an episode's judgement, so rows recorded before this
  slice are never re-judged or re-recorded (the ledger is append-only);
* ``performance_kpis()["live"]["implementer_by_route"]`` groups the same scorecard by ``stamp_route_key`` (episodes,
  attributable, succeeded, outcomes, success_rate) plus ``lines_changed`` (added + deleted per route; an unstamped
  episode adds 0); an episode with no stamp lands under ``"unstamped"`` — the unstamped share is a number, never hidden;
* ``implementer_scorecard`` (by subject) is unchanged.

NEW API. The new keys are reached with ``assertIn`` first, so base is red by assertion and not by ``KeyError``.
"""
from __future__ import annotations

import shutil
import unittest
from typing import Any

from aria_kernel import agent_eval
from aria_kernel.agent_eval import list_performance_observations, observe_agent_performance, performance_kpis
from tests.test_agent_eval_real_mode import MERGE_SHA, _event, _tools, seed_plan_ledger, seed_self_revert

S1 = {"schema_version": 1, "route": {"provider": "zai", "model": "glm-5.3"},
      "numstat": [{"path": "x.ts", "added": 1, "deleted": 1}]}
S2 = {"schema_version": 1, "route": {"provider": "anthropic", "model": "claude-opus-5"},
      "numstat": [{"path": "x.ts", "added": 1, "deleted": 2}, {"path": "y.ts", "added": 2, "deleted": 2}]}
OUTCOME = {
    "claim_id": "c", "pr_url": "https://github.com/o/r/pull/1", "diff_hash": "sha256:" + "c" * 64,
    "branch_tip_sha": "d" * 40, "base_branch_sha": "e" * 40, "validation_results": [], "signer_key_fp": "fp",
    "completed_at": "2026-09-01T11:00:00Z",
}
OTHER_MERGE_SHA = "b" * 40


def _outcome(plan_id: str, at: str, stamp: dict[str, Any] | None) -> dict[str, Any]:
    return _event(plan_id, "implementation_outcome_recorded", at, **OUTCOME, **({"decision_stamp": stamp} if stamp else {}))


def _delivered(plan_id: str, day: int, *, stamp: dict[str, Any] | None, end: str, with_outcome: bool = True) -> list[dict[str, Any]]:
    """One plan's ledger: converged, implemented, its outcome recorded (with a stamp or not), then merged or rejected."""
    at = f"2026-09-{day:02d}T10:00:00+00:00"
    later = f"2026-09-{day:02d}T12:00:00+00:00"
    ending = (_event(plan_id, "implementation_merged", later, merge_sha=MERGE_SHA if plan_id == "plan-p1" else OTHER_MERGE_SHA,
                     merged_at=later, idempotency_key_hash="h", head_lineage="delivered")
              if end == "merged" else
              _event(plan_id, "implementation_rejected", later, rejection_class="ci_check_red", rejected_at=later))
    return [
        _event(plan_id, "plan_started", at),
        _event(plan_id, "plan_evaluated", at, terminal_state="CONVERGED", reason_codes=[]),
        _event(plan_id, "implementation_requested", at, implementer_agent="aria-implementer"),
        _event(plan_id, "implementation_started", at, implementer_agent="aria-implementer", claim_id="c"),
        *([_outcome(plan_id, at, stamp)] if with_outcome else []),
        ending,
    ]


def history() -> list[dict[str, Any]]:
    """P1 merged on a zai route, P2 rejected on an anthropic route, P3 merged with nothing stamped."""
    return [*_delivered("plan-p1", 1, stamp=S1, end="merged"),
            *_delivered("plan-p2", 2, stamp=S2, end="rejected"),
            *_delivered("plan-p3", 3, stamp=None, end="merged")]


class _Observed(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _tools()
        self.addCleanup(shutil.rmtree, self.tools.parent, ignore_errors=True)

    def observe(self, cycle: str = "cyc-1") -> dict[str, Any]:
        return observe_agent_performance(base_dir=self.tools, cycle_id=cycle)

    def rows(self) -> list[dict[str, Any]]:
        return list_performance_observations(base_dir=self.tools)

    def implementer_rows(self) -> dict[str, dict[str, Any]]:
        return {row["plan_id"]: row for row in self.rows() if row["role"] == "implementer"}


class TheStampReachesTheEpisodeAndTheRouteCardTests(_Observed):
    def test_each_implementer_episode_carries_its_plans_stamp_and_the_card_splits_by_route(self) -> None:
        seed_plan_ledger(self.tools, history())
        self.observe()
        rows = self.implementer_rows()
        self.assertEqual({plan: row["outcome"] for plan, row in rows.items()},
                         {"plan-p1": "merged", "plan-p2": "rejected", "plan-p3": "merged"})
        self.assertIn("decision_stamp", rows["plan-p1"], "F3.1: the episode carries no stamp (the reader does not exist)")
        self.assertEqual(rows["plan-p1"]["decision_stamp"], S1)
        self.assertEqual(rows["plan-p2"]["decision_stamp"], S2)
        self.assertNotIn("decision_stamp", rows["plan-p3"], "an episode with no stamp has no key, not a null one")
        live = performance_kpis(base_dir=self.tools)["live"]
        self.assertIn("implementer_by_route", live)
        self.assertEqual(live["implementer_by_route"], {
            "zai/glm-5.3": {"episodes": 1, "attributable": 1, "succeeded": 1, "outcomes": {"merged": 1},
                            "success_rate": 1.0, "lines_changed": 2},
            "anthropic/claude-opus-5": {"episodes": 1, "attributable": 1, "succeeded": 0, "outcomes": {"rejected": 1},
                                        "success_rate": 0.0, "lines_changed": 7},
            "unstamped": {"episodes": 1, "attributable": 1, "succeeded": 1, "outcomes": {"merged": 1},
                          "success_rate": 1.0, "lines_changed": 0},
        })

    def test_a_drafter_episode_never_carries_a_stamp(self) -> None:
        seed_plan_ledger(self.tools, history())
        self.observe()
        rows = self.rows()
        drafters = [row for row in rows if row["role"] == "drafter"]
        self.assertTrue(drafters, "the history holds drafter episodes")
        for row in drafters:
            self.assertNotIn("decision_stamp", row)
        # The contrast, so base is red for the carrier and not green for the absence alone.
        self.assertTrue(any("decision_stamp" in row for row in rows if row["role"] == "implementer"))

    def test_a_self_revert_supersedes_the_merge_and_carries_the_stamp_and_the_plan_is_counted_once(self) -> None:
        seed_plan_ledger(self.tools, history())
        seed_self_revert(self.tools)
        self.observe()
        row = self.implementer_rows()["plan-p1"]
        self.assertEqual(row["outcome"], "self_reverted")
        self.assertIn("decision_stamp", row, "F3.1: the superseding episode dropped the stamp")
        self.assertEqual(row["decision_stamp"], S1)
        card = performance_kpis(base_dir=self.tools)["live"]["implementer_by_route"]["zai/glm-5.3"]
        self.assertEqual((card["episodes"], card["outcomes"], card["succeeded"], card["lines_changed"]),
                         (1, {"self_reverted": 1}, 0, 2))


class TheScorecardBySubjectIsUnchangedTests(_Observed):
    def test_the_agent_scorecard_and_the_not_computable_set_are_what_they_were(self) -> None:
        seed_plan_ledger(self.tools, history())
        self.observe()
        kpis = performance_kpis(base_dir=self.tools)
        # The new card sits BESIDE the old ones; it replaces none.
        self.assertEqual(set(kpis["live"]), {"repeat_failure_rate", "drafter_scorecard", "implementer_scorecard",
                                             "implementer_by_route"})
        self.assertEqual(kpis["live"]["implementer_scorecard"], {
            "aria-implementer": {"episodes": 3, "attributable": 3, "succeeded": 2,
                                 "outcomes": {"merged": 2, "rejected": 1}, "success_rate": 0.666667},
        })
        # The default grouping of the shared function is still the subject (the pre-change answer).
        self.assertEqual(agent_eval._scorecard(self.rows(), "implementer"), kpis["live"]["implementer_scorecard"])
        self.assertEqual(
            set(kpis["not_computable"]),
            {"repeat_failure_rate_by_class_key", "memory_ablation", "precision_after_fp_label",
             "impact_miss_rate", "implementer_scorecard_by_agent_version_hash"},
        )


class ObservationIsAppendOnlyTests(_Observed):
    def test_a_second_observation_appends_nothing(self) -> None:
        seed_plan_ledger(self.tools, history())
        first = self.observe("cyc-1")
        self.assertEqual(first["verdict"], "observed")
        self.assertTrue(any("decision_stamp" in row for row in self.rows()), "F3.1: nothing was stamped")
        again = self.observe("cyc-2")
        self.assertEqual(again["appended"], 0)
        self.assertEqual(len(self.rows()), first["appended"])

    def test_a_row_recorded_before_the_stamp_existed_is_not_re_recorded_when_a_stamp_appears_later(self) -> None:
        # Slice-era state: P1 was merged and observed with no outcome event at all (nothing stamped it).
        seed_plan_ledger(self.tools, _delivered("plan-p1", 1, stamp=None, end="merged", with_outcome=False))
        first = self.observe("cyc-1")
        before = self.implementer_rows()["plan-p1"]
        self.assertNotIn("decision_stamp", before)
        # A stamp for it appears afterwards (a late outcome event), and a new stamped plan arrives.
        seed_plan_ledger(self.tools, [_outcome("plan-p1", "2026-09-01T11:00:00+00:00", S1),
                                      *_delivered("plan-p2", 2, stamp=S2, end="rejected")])
        second = self.observe("cyc-2")
        # Only the NEW plan's episodes were appended (its drafter and implementer rows): P1 is not judged twice.
        self.assertEqual(second["appended"], 2, second)
        rows = self.implementer_rows()
        self.assertEqual(rows["plan-p1"], before, "a recorded episode was rewritten")
        self.assertNotIn("decision_stamp", rows["plan-p1"])
        self.assertIn("decision_stamp", rows["plan-p2"], "F3.1: the new plan's episode carries no stamp")
        self.assertEqual(rows["plan-p2"]["decision_stamp"], S2)
        self.assertEqual(len(self.rows()), first["appended"] + 2)


if __name__ == "__main__":
    unittest.main()
