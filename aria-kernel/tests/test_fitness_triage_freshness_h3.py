"""Plan 022 H-3 — fitness/triage timestamp dual-write + alias-aware reads.

Pre-Plan-022 fitness.py wrote 'computed_at'; triage.py read 'recorded_at'.
Fresh fitness rows had no recorded_at field, so triage's _is_fitness_stale
treated them as stale and silently demoted auto_fix_safe to needs_review.

Fix:
1. fitness._compute_agent_fitness writes BOTH recorded_at (canonical)
   and computed_at (legacy alias for 2-release deprecation).
2. triage._is_fitness_stale reads recorded_at first; falls back to
   computed_at for historical rows.
3. fitness._last_computed_at also alias-aware (weekly freshness gate).

Tests:
1. fresh fitness row (canonical recorded_at) -> triage stale=False.
2. legacy fitness row (only computed_at) -> triage stale=False (alias).
3. 8-day-old row -> stale=True.
4. write side dual-writes both fields (lint-style structural check).
5. _last_computed_at consumes canonical recorded_at.
6. _last_computed_at falls back to legacy computed_at on historical rows.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aria_kernel.fitness import _compute_agent_fitness, _last_computed_at
from aria_kernel.triage import _is_fitness_stale


def _now() -> datetime:
    return datetime.now(timezone.utc)


class FitnessStalenessAliasTests(unittest.TestCase):
    def test_fresh_row_with_canonical_recorded_at_not_stale(self) -> None:
        row = {"recorded_at": _now().isoformat()}
        self.assertFalse(_is_fitness_stale(row))

    def test_fresh_row_with_legacy_computed_at_only_not_stale(self) -> None:
        row = {"computed_at": _now().isoformat()}
        self.assertFalse(_is_fitness_stale(row))

    def test_old_row_stale(self) -> None:
        old = _now() - timedelta(days=10)
        row = {"recorded_at": old.isoformat()}
        self.assertTrue(_is_fitness_stale(row, threshold_days=7))

    def test_missing_both_fields_treated_as_stale(self) -> None:
        # Defensive default: a non-empty fitness row missing both
        # timestamp fields is treated as stale (silent absence cannot
        # promote auto_fix_safe). The truly-empty {} short-circuits at
        # `if not row:` -> returns False (caller handles 'no fitness
        # record' upstream).
        self.assertTrue(_is_fitness_stale({"agent_name": "x"}))

    def test_unparseable_timestamp_treated_as_stale(self) -> None:
        self.assertTrue(_is_fitness_stale({"recorded_at": "not-a-date"}))


class FitnessLastComputedAtAliasTests(unittest.TestCase):
    def test_canonical_recorded_at_used(self) -> None:
        rows = [
            {"recorded_at": "2026-05-08T10:00:00+00:00"},
            {"recorded_at": "2026-05-08T11:00:00+00:00"},
        ]
        result = _last_computed_at(rows)
        self.assertIsNotNone(result)
        self.assertEqual(result.hour, 11)

    def test_legacy_computed_at_fallback(self) -> None:
        rows = [{"computed_at": "2026-05-08T10:00:00+00:00"}]
        result = _last_computed_at(rows)
        self.assertIsNotNone(result)
        self.assertEqual(result.hour, 10)

    def test_canonical_takes_precedence_over_legacy(self) -> None:
        rows = [{
            "recorded_at": "2026-05-08T11:00:00+00:00",
            "computed_at": "2026-05-08T09:00:00+00:00",
        }]
        result = _last_computed_at(rows)
        self.assertEqual(result.hour, 11)


class DualWriteStructuralTests(unittest.TestCase):
    """Lint-style: verify the source code dual-writes BOTH fields. The
    actual data path needs Plan 016 ledger fixtures we don't synthesize
    here; this test pins the contract structurally so a future refactor
    that drops one alias regresses the suite."""

    def test_compute_agent_fitness_writes_both_fields(self) -> None:
        # Direct call with empty inputs -> empty rows; we verify the
        # source-level structure to lock the dual-write contract.
        import inspect
        src = inspect.getsource(_compute_agent_fitness)
        self.assertIn('"recorded_at": _format_dt(computed_at)', src)
        self.assertIn('"computed_at": _format_dt(computed_at)', src)


if __name__ == "__main__":
    unittest.main()
