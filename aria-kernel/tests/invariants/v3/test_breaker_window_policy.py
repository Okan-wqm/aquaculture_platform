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
from aria_kernel import genesis_policy
from aria_kernel.genesis_policy import (
    CIRCUIT_BREAKER_DEFAULTS,
    CIRCUIT_BREAKER_LEGACY_KEYS,
    circuit_breaker_policy,
    minimum_window_hours,
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
        # ORPHAN-MEDIUM-483 — the original assertion here was `window > 24`,
        # i.e. window > CADENCE, and pinned the literal 72. Both were wrong:
        # 72 is exactly the boundary for threshold 3, because the breaker is
        # read at the NEXT night's gate (t = threshold x cadence), where the
        # oldest failure lands precisely on the window edge and jitter decides
        # the verdict. The requirement is window > threshold x cadence, so the
        # assertion is now that RELATIONSHIP rather than a magic number.
        from aria_kernel.genesis_policy import (
            NIGHTLY_CADENCE_HOURS,
            minimum_window_hours,
        )

        threshold = CIRCUIT_BREAKER_DEFAULTS["failure_threshold"]
        self.assertGreater(
            window, threshold * NIGHTLY_CADENCE_HOURS,
            "window must exceed threshold x cadence, else the oldest failure "
            "sits on the window edge at the next night's gate",
        )
        self.assertEqual(window, minimum_window_hours(threshold))

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
        """A custom window ABOVE the derived floor is honoured verbatim.

        RC-4 migrated this test, and what it used to assert is the finding. It
        wrote ``{failure_threshold: 10, failure_window_hours: 48}`` and asserted
        the accessor returned 48 — but 48 is far below ``minimum_window_hours(10)``
        = 264, and the floor was applied one layer down in
        ``circuit_breaker._breaker_policy``. So the accessor answered 48 while the
        breaker ran on 264, and this invariant pinned the answer that was never
        used. Two validation sites disagreeing about one key, blessed by a green
        test.

        The window is now validated where it is read, so the honoured case must
        use a value production would accept.
        """
        with tempfile.TemporaryDirectory(prefix="aria-468-new-") as tmp:
            root = Path(tmp)
            above_floor = minimum_window_hours(10) + 24
            _write_override(
                root, {"failure_threshold": 10, "failure_window_hours": above_floor}
            )
            block = circuit_breaker_policy(root)
            self.assertEqual(block["failure_threshold"], 10)
            self.assertEqual(block["failure_window_hours"], above_floor)

    def test_a_window_below_the_derived_floor_is_refused_not_widened(self) -> None:
        """RC-4 — the operator learns, instead of running on a number they never wrote.

        Silently widening 48 to 264 left the operator's model of their own
        breaker wrong with nothing to reconcile it. The refusal names both the
        value given and the minimum required.
        """
        with tempfile.TemporaryDirectory(prefix="aria-468-floor-") as tmp:
            root = Path(tmp)
            _write_override(root, {"failure_threshold": 10, "failure_window_hours": 48})
            with self.assertRaises(GovernanceError) as ctx:
                circuit_breaker_policy(root)
            msg = str(ctx.exception)
            self.assertIn("genesis_policy_circuit_breaker_window_below_floor", msg)
            self.assertIn("48", msg)
            self.assertIn(str(minimum_window_hours(10)), msg)

    def test_the_shipped_default_carries_no_window_literal(self) -> None:
        """The value is derived, so the one place it must NOT appear is the file.

        A literal here is what made the default document 72 while the code ran
        on 96. Asserted against the shipped JSON rather than the accessor, because
        the accessor would happily fill a literal back in.
        """
        shipped = json.loads(
            (
                Path(genesis_policy.__file__).resolve().parent
                / "data"
                / genesis_policy.DEFAULT_FILENAME
            ).read_text(encoding="utf-8")
        )
        self.assertNotIn("failure_window_hours", shipped.get("circuit_breaker", {}))
        self.assertEqual(
            circuit_breaker_policy()["failure_window_hours"],
            minimum_window_hours(circuit_breaker_policy()["failure_threshold"]),
        )

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


class WindowSurvivesTheGateNotJustTheTrip(unittest.TestCase):
    """ORPHAN-MEDIUM-483 — evaluate at the GATE, which is where it broke.

    The earlier multi-night test counted at the trip instant (t=48 for three
    nightly failures) and passed with the boundary-valued 72h window. The
    breaker is not read then — it is read at the next night's preflight, t=72,
    where a 72h window puts the oldest failure exactly on the edge.

    NOTE ON ROW SHAPE: _count_failures_in_window reads a `ts` ISO timestamp and
    treats an unparseable one as IN-window (fail-closed, ORPHAN-CRITICAL-418).
    The first version of this test passed `age_hours` keys, so every row was
    unparseable and counted regardless of window — it asserted nothing. Only the
    negative control below revealed that, which is why it is here.
    """

    @staticmethod
    def _rows_aged(hours_ago: list[float]) -> list[dict]:
        now = datetime.now(timezone.utc)
        return [
            {"ts": (now - timedelta(hours=h)).isoformat(), "reason": "perimeter"}
            for h in hours_ago
        ]

    def test_the_bleed_still_counts_at_the_next_nights_gate_under_jitter(self) -> None:
        from aria_kernel.circuit_breaker import _count_failures_in_window
        from aria_kernel.genesis_policy import (
            NIGHTLY_CADENCE_HOURS as CAD,
            minimum_window_hours as _minimum_window_hours,
        )

        threshold = 3
        window = _minimum_window_hours(threshold)
        gate_at = threshold * CAD
        for jitter_minutes in (0, 5, 30, 59):
            with self.subTest(jitter=jitter_minutes):
                ages = [gate_at + jitter_minutes / 60.0 - (n * CAD) for n in range(threshold)]
                self.assertEqual(
                    _count_failures_in_window(self._rows_aged(ages), window_hours=window),
                    threshold,
                    f"jitter of {jitter_minutes}min must not drop a failure at the gate",
                )

    def test_the_old_boundary_window_would_have_dropped_it(self) -> None:
        """Negative control: the same bleed at the same gate loses a failure
        under the previous 72h window, so this suite cannot pass with the
        boundary value restored."""
        from aria_kernel.circuit_breaker import _count_failures_in_window

        threshold, gate_at = 3, 3 * 24
        ages = [gate_at + 0.5 - (n * 24) for n in range(threshold)]
        self.assertLess(
            _count_failures_in_window(self._rows_aged(ages), window_hours=72), threshold,
            "the 72h window must be shown to lose a failure",
        )
