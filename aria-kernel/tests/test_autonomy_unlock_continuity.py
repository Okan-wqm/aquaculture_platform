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


if __name__ == "__main__":
    unittest.main()
