"""Plan 026R §E.1 — spine _is_fresh status-aware freshness check.

3 tests:

* Cached run with status="ok" → fresh.
* Cached run with status="crash" → NOT fresh (re-run).
* Cached run with missing status → NOT fresh.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from aria_kernel.spine_orchestrator import _is_fresh


def _now() -> datetime:
    return datetime(2026, 5, 11, 13, 0, 0, tzinfo=timezone.utc)


def _run(status: str | None, *, age_seconds: int = 60) -> dict:
    recorded_at = (_now().timestamp() - age_seconds)
    return {
        "status": status,
        "recorded_at": datetime.fromtimestamp(
            recorded_at, tz=timezone.utc,
        ).isoformat(),
        "repo_snapshot": {"repo_state_id": "rs-1"},
    }


class SpineCacheStatusAwareTests(unittest.TestCase):
    def test_status_ok_is_fresh(self) -> None:
        self.assertTrue(_is_fresh(
            run_row=_run("ok"),
            target_repo_state_id="rs-1",
            freshness_max_age_seconds=300,
            now=_now(),
        ))

    def test_status_crash_is_not_fresh(self) -> None:
        # Pre-§E.1 a cached crash satisfied "fresh"; post-§E.1 it does not.
        self.assertFalse(_is_fresh(
            run_row=_run("crash"),
            target_repo_state_id="rs-1",
            freshness_max_age_seconds=300,
            now=_now(),
        ))
        for failed in (
            "budget_exceeded", "schema_error", "tool_unhealthy", "error",
        ):
            self.assertFalse(_is_fresh(
                run_row=_run(failed),
                target_repo_state_id="rs-1",
                freshness_max_age_seconds=300,
                now=_now(),
            ), f"status {failed!r} should NOT be fresh")

    def test_missing_status_is_not_fresh(self) -> None:
        # Status field missing on the row → re-run.
        self.assertFalse(_is_fresh(
            run_row=_run(None),
            target_repo_state_id="rs-1",
            freshness_max_age_seconds=300,
            now=_now(),
        ))


if __name__ == "__main__":
    unittest.main()
