"""ORPHAN-MEDIUM-468 — the failure window is policy, and the rename is safe.

Two properties, both of which were false before this change.

WINDOW. The sliding window was a hardcoded 24h while the nightly producer fires
on cron '0 1 * * *' — also 24h. A prior night's failure therefore sat exactly on
the boundary, so whether it still counted depended on where inside each run the
failure landed rather than on how many failures there were. The window is now
policy-driven and defaults to 72h, strictly longer than the cadence.

RENAME SAFETY. genesis_policy.merge_with_override is a SHALLOW top-level merge:
an operator file containing a `circuit_breaker` block REPLACES the default block
wholesale. So renaming `threshold_24h` without a migration path would silently
discard a deployed operator override and run on defaults, telling nobody. The
deployed override file is untracked, so the repo cannot migrate it by grep --
raising at read time is the only place the operator can find out.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.circuit_breaker import (
    _count_failures_in_window,
    evaluate_breaker,
    record_failure,
)
from aria_kernel.genesis_policy import (
    CIRCUIT_BREAKER_DEFAULTS,
    CIRCUIT_BREAKER_LEGACY_KEYS,
    circuit_breaker_policy,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _write_override(root: Path, block: dict) -> None:
    (root / "aria-config").mkdir(parents=True, exist_ok=True)
    (root / "aria-config" / "genesis_policy.json").write_text(
        json.dumps({"circuit_breaker": block}), encoding="utf-8",
    )


class WindowPolicyTests(unittest.TestCase):

    def test_the_default_window_is_longer_than_the_producer_cadence(self) -> None:
        """72h vs the 24h nightly cron. Equal would restore the boundary
        coin-flip this finding closed, so the assertion is the inequality,
        not the literal."""
        window = CIRCUIT_BREAKER_DEFAULTS["failure_window_hours"]
        self.assertGreater(window, 24, "window must exceed the nightly cadence")
        self.assertEqual(window, 72)

    def test_rows_older_than_the_window_age_out_and_newer_ones_count(self) -> None:
        now = datetime.now(timezone.utc)
        def row(hours_ago: float) -> dict:
            return {"ts": (now - timedelta(hours=hours_ago)).isoformat().replace("+00:00", "Z")}
        rows = [row(1), row(30), row(50), row(100)]
        # A 24h window sees only the 1h row; 72h sees three of the four.
        self.assertEqual(_count_failures_in_window(rows, window_hours=24), 1)
        self.assertEqual(_count_failures_in_window(rows, window_hours=72), 3)

    def test_three_nights_of_one_failure_accumulate_under_72h(self) -> None:
        """The bleed case: one refusal per night, 24h apart. Under the old
        24h window these sat on the boundary; under 72h they accumulate
        deterministically."""
        now = datetime.now(timezone.utc)
        nightly = [
            {"ts": (now - timedelta(hours=h)).isoformat().replace("+00:00", "Z")}
            for h in (0.1, 24.2, 48.3)
        ]
        self.assertEqual(_count_failures_in_window(nightly, window_hours=72), 3)


class RenameMigrationTests(unittest.TestCase):

    def test_a_stale_key_raises_instead_of_reverting_to_defaults(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-468-stale-") as tmp:
            root = Path(tmp)
            _write_override(root, {"threshold_24h": 10})
            with self.assertRaises(GovernanceError) as ctx:
                circuit_breaker_policy(root)
            msg = str(ctx.exception)
            self.assertIn("genesis_policy_renamed_circuit_breaker_key", msg)
            self.assertIn("threshold_24h", msg)
            self.assertIn("failure_threshold", msg)

    def test_every_legacy_key_maps_to_a_key_that_exists(self) -> None:
        """A migration map pointing at a key the accessor does not read would
        send the operator to a name that also does nothing."""
        for old, new in CIRCUIT_BREAKER_LEGACY_KEYS.items():
            with self.subTest(old=old):
                self.assertIn(new, CIRCUIT_BREAKER_DEFAULTS)
                self.assertNotIn(old, CIRCUIT_BREAKER_DEFAULTS)

    def test_new_keys_are_honoured_including_a_custom_window(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-468-new-") as tmp:
            root = Path(tmp)
            _write_override(root, {"failure_threshold": 10, "failure_window_hours": 48})
            block = circuit_breaker_policy(root)
            self.assertEqual(block["failure_threshold"], 10)
            self.assertEqual(block["failure_window_hours"], 48)

    def test_an_override_reaches_the_breaker_verdict(self) -> None:
        """End to end: policy -> evaluate_breaker, not just the accessor."""
        with tempfile.TemporaryDirectory(prefix="aria-468-e2e-") as tmp:
            root = Path(tmp)
            base = root / "aria-tools"
            ensure_tools_dir(base)
            _write_override(root, {"failure_threshold": 2, "failure_window_hours": 96})
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.threshold, 2)
            self.assertEqual(verdict.window_hours, 96)
            record_failure(base_dir=base, kind="ci_red", materialize_event_id="e1")
            self.assertEqual(evaluate_breaker(base).state, "ok")
            record_failure(base_dir=base, kind="ci_red", materialize_event_id="e2")
            self.assertEqual(evaluate_breaker(base).state, "tripped")


if __name__ == "__main__":
    unittest.main()
