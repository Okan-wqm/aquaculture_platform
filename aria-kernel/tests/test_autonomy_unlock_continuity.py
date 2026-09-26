"""Counted evidence is not the same as CONSECUTIVE evidence.

ORPHAN-HIGH-530. The scheduled-workflow watchdog reported ARIA's own
nightly loop as not-running, hourly, for seventeen days (issue #1005),
and nothing inside ARIA consumed that verdict. `verdict_from_rows` has no
time dimension at all: it counts acceptance events and compares the
counts against thresholds, so thirty successes with a seventeen-day hole
in the middle are indistinguishable from thirty consecutive nightly ones.

The ladder's premise is "N CONSECUTIVE clean cycles demonstrate
stability". A hole breaks *consecutive*, and the count cannot see it.

Note what is deliberately NOT built here: a second watchdog. Detection
already exists and works. The missing half is a consumer, and it is
answerable from ARIA's own ledger without any GitHub call — the rows
carry their own timestamps.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aria_kernel.autonomy_unlock import verdict_from_rows

POLICY = {
    "$schema": "aria/autonomy-unlock-policy/v1",
    "schema_version": 1,
    "policy_id": "test",
    "critical_violation_limit": 0,
    "lane_requirements": {"L1": {"observe_successes": 30}, "L2": {}, "L3": {}},
}

# The nightly lane runs once a day; two days of slack absorbs a delayed
# schedule or a single skipped night without calling the chain broken.
MAX_GAP_HOURS = 72


def _rows(count: int, *, start: datetime, step: timedelta, gap_after: int | None = None,
          gap: timedelta | None = None) -> list[dict]:
    rows: list[dict] = []
    stamp = start
    for index in range(count):
        rows.append(
            {
                "row_type": "acceptance_event",
                "event_type": "observe_success",
                "status": "success",
                "recorded_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "reason": f"clean_cycle:cycle-{index}:harness_accept",
            }
        )
        stamp = stamp + (gap if (gap_after is not None and index == gap_after and gap) else step)
    return rows


def _success(event_type: str, stamp: datetime) -> dict:
    return {
        "row_type": "acceptance_event",
        "event_type": event_type,
        "status": "success",
        "recorded_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reason": f"{event_type}:test",
    }


class UnlockContinuityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 8, 3, tzinfo=timezone.utc)

    def test_thirty_consecutive_nightly_successes_unlock(self) -> None:
        rows = _rows(30, start=self.now - timedelta(days=30), step=timedelta(days=1))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_a_seventeen_day_hole_does_not_unlock(self) -> None:
        """The exact shape of the 2026-07-17 outage."""
        rows = _rows(
            30,
            start=self.now - timedelta(days=47),
            step=timedelta(days=1),
            gap_after=14,
            gap=timedelta(days=17),
        )
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertTrue(
            any("continuity" in reason for reason in verdict.reasons),
            f"expected a continuity refusal, got {verdict.reasons}",
        )
        # The COUNT was satisfied — that is the whole point. Thirty rows
        # are present and the threshold is thirty; only the gap refuses.
        self.assertEqual(verdict.counts["observe_successes"], 30)

    def test_evidence_that_stopped_accruing_does_not_unlock(self) -> None:
        """Thirty perfect cycles that all ended a month ago prove nothing now."""
        rows = _rows(30, start=self.now - timedelta(days=70), step=timedelta(days=1))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertTrue(
            any("continuity" in reason for reason in verdict.reasons),
            f"expected a staleness refusal, got {verdict.reasons}",
        )

    def test_the_refusal_names_the_gap_it_found(self) -> None:
        """An operator must be able to act on the reason without digging."""
        rows = _rows(
            30,
            start=self.now - timedelta(days=47),
            step=timedelta(days=1),
            gap_after=14,
            gap=timedelta(days=17),
        )
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        continuity = [r for r in verdict.reasons if "continuity" in r]
        self.assertTrue(continuity)
        self.assertRegex(continuity[0], r"\d+")

    def test_a_count_short_of_the_threshold_still_fails_on_the_count(self) -> None:
        """Continuity must not mask the ordinary threshold refusal."""
        rows = _rows(5, start=self.now - timedelta(days=5), step=timedelta(days=1))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertTrue(any("threshold_missing" in r for r in verdict.reasons), verdict.reasons)

    def test_an_empty_ledger_does_not_report_a_continuity_break(self) -> None:
        """Nothing to be discontinuous about; the count refusal is the truth."""
        verdict = verdict_from_rows([], lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertFalse(
            any("continuity" in r for r in verdict.reasons),
            f"an empty ledger is not a broken chain: {verdict.reasons}",
        )

    def test_a_success_the_lane_does_not_count_neither_relocks_nor_refreshes_it(self) -> None:
        """ARIA-HIGH-223 — the finding's exact shape.

        Thirty consecutive clean cycles, then a `rollback_success` from
        `self_revert` ten days on. That row is not evidence L1 counts: it
        opens no gap in the window (the permanent re-lock the finding
        names), and it does not stand in for the clean cycles that stopped
        either — the open end of the counted chain is still stale.
        """
        rows = _rows(30, start=self.now - timedelta(days=40), step=timedelta(days=1))
        rows.append(_success("rollback_success", self.now - timedelta(days=1)))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(any("continuity_gap" in reason for reason in verdict.reasons), verdict.reasons)
        self.assertEqual(len(verdict.reasons), 1, verdict.reasons)
        self.assertTrue(verdict.reasons[0].startswith("autonomy_unlock_continuity_stale:"), verdict.reasons)

    def test_a_verdict_cannot_be_computed_without_a_clock(self) -> None:
        """ARIA-HIGH-223 — the staleness half is not optional: a verdict
        with no evaluation time was a verdict that skipped it, and the merge
        gate's own evaluation was exactly that."""
        rows = _rows(30, start=self.now - timedelta(days=30), step=timedelta(days=1))
        with self.assertRaises(TypeError):
            verdict_from_rows(rows, lane="L1", policy=POLICY)  # type: ignore[call-arg]

    def test_a_counted_success_after_a_gap_does_not_relock(self) -> None:
        """A later clean cycle is more evidence, not a hole in the old."""
        rows = _rows(30, start=self.now - timedelta(days=41), step=timedelta(days=1))
        rows.append(_success("observe_success", self.now - timedelta(days=1)))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_a_fresh_window_after_an_old_gap_unlocks(self) -> None:
        """A gap BEFORE the counted window is history, not part of it."""
        rows = _rows(10, start=self.now - timedelta(days=60), step=timedelta(days=1))
        rows += _rows(30, start=self.now - timedelta(days=30), step=timedelta(days=1))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_a_gap_inside_the_evidence_window_locks(self) -> None:
        """Twenty-nine, a four-day hole, one more: the count is thirty,
        and no thirty of them are consecutive."""
        rows = _rows(
            30,
            start=self.now - timedelta(days=33),
            step=timedelta(days=1),
            gap_after=28,
            gap=timedelta(days=4),
        )
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.counts["observe_successes"], 30)
        gaps = [r for r in verdict.reasons if r.startswith("autonomy_unlock_continuity_gap:")]
        self.assertEqual(len(gaps), 1, verdict.reasons)
        self.assertIn("96h>72h", gaps[0])

    def test_a_row_the_lane_does_not_count_cannot_bridge_a_gap(self) -> None:
        """A `rollback_success` in the middle of an outage is not a clean
        cycle; letting it split the hole in two would shrink the gap the
        timestamps of the counted rows expose."""
        rows = _rows(15, start=self.now - timedelta(days=20), step=timedelta(days=1))
        rows.append(_success("rollback_success", self.now - timedelta(days=4)))
        rows += _rows(15, start=self.now - timedelta(days=2), step=timedelta(hours=1))
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertTrue(
            any(r.startswith("autonomy_unlock_continuity_gap:") for r in verdict.reasons),
            verdict.reasons,
        )

    def test_a_row_without_a_timestamp_is_refused_not_ignored(self) -> None:
        """An undateable row must not silently pass the continuity check.

        Skipping it would let a malformed or hand-written row bridge a gap
        that the timestamps would otherwise expose.
        """
        rows = _rows(30, start=self.now - timedelta(days=30), step=timedelta(days=1))
        rows[10].pop("recorded_at")
        verdict = verdict_from_rows(rows, lane="L1", policy=POLICY, now=self.now)
        self.assertFalse(verdict.valid)
        self.assertTrue(
            any("continuity" in r for r in verdict.reasons),
            f"expected an undateable-row refusal, got {verdict.reasons}",
        )


class TheRealEvaluationReadsTheClock(unittest.TestCase):
    """ARIA-HIGH-223 — `evaluate_autonomy_unlock`, the merge gate's and the
    scheduler's evaluation, on a real ledger. It passed no evaluation time,
    so thirty cycles that ended a month ago still unlocked L1."""

    def setUp(self) -> None:
        import tempfile
        from pathlib import Path

        from aria_kernel.tool_registry import ensure_tools_dir

        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h223-clock-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _ledger(self, rows: list[dict]) -> None:
        from aria_kernel.ledger import append_declared_jsonl

        for row in rows:
            append_declared_jsonl(
                self.tools / "enterprise" / "acceptance-events.jsonl",
                {"schema_version": 1, "row_type": "enterprise_acceptance_event", **row},
                expected_surface="enterprise_acceptance_events",
            )

    def _evaluate(self):
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock

        return evaluate_autonomy_unlock(lane="L1", base_dir=self.tools, policy=POLICY)

    def test_evidence_that_stopped_accruing_is_refused_by_name(self) -> None:
        now = datetime.now(timezone.utc)
        self._ledger(_rows(30, start=now - timedelta(days=40), step=timedelta(days=1)))
        verdict = self._evaluate()
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.counts["observe_successes"], 30)
        self.assertEqual(len(verdict.reasons), 1, verdict.reasons)
        self.assertTrue(verdict.reasons[0].startswith("autonomy_unlock_continuity_stale:"), verdict.reasons)

    def test_recent_evidence_unlocks(self) -> None:
        now = datetime.now(timezone.utc)
        self._ledger(_rows(30, start=now - timedelta(hours=31), step=timedelta(hours=1)))
        verdict = self._evaluate()
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_the_merge_gate_refuses_stale_evidence(self) -> None:
        from aria_kernel.autonomy_unlock import assert_autonomy_unlocked
        from aria_kernel.tool_registry import GovernanceError

        now = datetime.now(timezone.utc)
        self._ledger(_rows(30, start=now - timedelta(days=40), step=timedelta(days=1)))
        with self.assertRaises(GovernanceError) as refused:
            assert_autonomy_unlocked(lane="L1", base_dir=self.tools, policy=POLICY)
        self.assertIn("autonomy_unlock_continuity_stale:", str(refused.exception))


class TheEvidenceStatusUsesTheSameRule(unittest.TestCase):
    """ARIA-HIGH-223 — `autonomy_evidence` streamed the acceptance ledger
    through its OWN copy of the rule: a literal 72h over every pair of
    success rows, forever, and no clock. It now asks `verdict_from_rows`."""

    def _stream(self, rows: list[dict]) -> dict:
        from pathlib import Path
        from unittest import mock

        from aria_kernel import autonomy_evidence

        accumulator = autonomy_evidence._StreamingEvidenceAccumulator()
        for row in rows:
            accumulator.consume("enterprise_acceptance_events", row)
        with mock.patch.object(autonomy_evidence, "_unlock_policy_at_target", return_value=(POLICY, None)):
            counts, blocker = autonomy_evidence._stream_unlock_verdict_counts(
                accumulator, repo_root=Path("."), target_sha="a" * 40,
            )
        self.assertIsNone(blocker)
        return counts

    def test_a_gap_before_a_fresh_qualifying_window_is_history(self) -> None:
        now = datetime.now(timezone.utc)
        rows = _rows(30, start=now - timedelta(days=12), step=timedelta(hours=1))
        rows += _rows(30, start=now - timedelta(hours=31), step=timedelta(hours=1))
        self.assertEqual(self._stream(rows)["autonomy_unlock_l1_valid"], 1)

    def test_stale_evidence_is_not_valid_evidence(self) -> None:
        now = datetime.now(timezone.utc)
        rows = _rows(30, start=now - timedelta(days=40), step=timedelta(days=1))
        self.assertEqual(self._stream(rows)["autonomy_unlock_l1_valid"], 0)


if __name__ == "__main__":
    unittest.main()
