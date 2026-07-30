"""ORPHAN-CRITICAL-420 S2 — the failure breaker gates every profile that acts.

Why this file exists
====================
`_cycle_preflight` (formerly `_autonomous_preflight`) short-circuited OK for
every profile except `autonomous`, justified in its own docstring by the claim
that "strict/standard/observe/frozen have their own gates". They did not.
`strict` holds pr_open authority and `standard` holds change_committed
authority, and neither consulted the failure breaker anywhere in the tree — so
a tripped breaker stopped nothing on the profile the scheduled lane runs.

These tests pin the SCOPE of the gate, not the breaker's arithmetic (which
test_phase_b2_autonomous_profile_breaker.py already covers):

  * a profile with action authority is blocked when the breaker is tripped,
  * a profile without action authority is NOT blocked, so an operator keeps a
    read-only cycle with which to diagnose the trip,
  * the gated set stays DERIVED from ACTION_PERMISSIONS, so granting a new
    profile authority cannot silently exempt it from the breaker,
  * autonomous reason-code precedence (cost before failure) is unchanged.
"""
from __future__ import annotations

import tempfile
import unittest
import unittest.mock
from pathlib import Path

from aria_kernel.autonomy_orchestrator import _cycle_preflight
from aria_kernel.runtime_profile import (
    ACTION_PERMISSIONS,
    PROFILES,
    PROFILES_WITH_ACTION_AUTHORITY,
)


class BreakerProfileScopeTests(unittest.TestCase):

    def _preflight(self, profile: str, breaker: str) -> tuple[str, str | None]:
        with tempfile.TemporaryDirectory(prefix="aria-420-s2-") as tmp:
            base = Path(tmp) / "aria-tools"
            with unittest.mock.patch(
                "aria_kernel.circuit_breaker.current_state", return_value=breaker,
            ), unittest.mock.patch(
                "aria_kernel.cost_budget.current_state", return_value="ok",
            ), unittest.mock.patch(
                "aria_kernel.autonomous_host_lease.acquire_lease", return_value=None,
            ):
                return _cycle_preflight(base_dir=base, profile_snapshot=profile)

    def test_every_acting_profile_is_blocked_by_a_tripped_breaker(self) -> None:
        """standard is the one that matters: it is what the nightly runs."""
        for profile in sorted(PROFILES_WITH_ACTION_AUTHORITY):
            with self.subTest(profile=profile):
                self.assertEqual(
                    self._preflight(profile, "tripped"),
                    ("blocked", "failure_breaker_tripped"),
                )

    def test_acting_profiles_proceed_when_the_breaker_is_ok(self) -> None:
        for profile in sorted(PROFILES_WITH_ACTION_AUTHORITY):
            with self.subTest(profile=profile):
                self.assertEqual(self._preflight(profile, "ok"), ("ok", None))

    def test_non_acting_profiles_keep_running_while_tripped(self) -> None:
        """observe/frozen mutate nothing, and blocking them would deny the
        operator the read-only cycle needed to diagnose the trip."""
        for profile in sorted(set(PROFILES) - PROFILES_WITH_ACTION_AUTHORITY):
            with self.subTest(profile=profile):
                self.assertEqual(self._preflight(profile, "tripped"), ("ok", None))

    def test_the_gated_set_is_derived_not_enumerated(self) -> None:
        """A literal set here would rot the first time ACTION_PERMISSIONS
        changed -- which is exactly how the original gate came to be wrong.
        Granting a profile any authority must enroll it in breaker gating."""
        self.assertEqual(
            PROFILES_WITH_ACTION_AUTHORITY,
            frozenset().union(*ACTION_PERMISSIONS.values()),
        )
        # Every profile holding any cell is gated; the observe/frozen exemption
        # is a consequence of holding none, not a hardcoded carve-out.
        for kind, permitted in ACTION_PERMISSIONS.items():
            for profile in permitted:
                with self.subTest(action=kind, profile=profile):
                    self.assertIn(profile, PROFILES_WITH_ACTION_AUTHORITY)

    def test_autonomous_reason_precedence_is_unchanged(self) -> None:
        """Cost is still reported before failure under autonomous, so the
        rescoping did not change what an autonomous run tells the operator."""
        with tempfile.TemporaryDirectory(prefix="aria-420-s2-prec-") as tmp:
            base = Path(tmp) / "aria-tools"
            with unittest.mock.patch(
                "aria_kernel.cost_budget.current_state", return_value="tripped",
            ), unittest.mock.patch(
                "aria_kernel.circuit_breaker.current_state", return_value="tripped",
            ):
                self.assertEqual(
                    _cycle_preflight(base_dir=base, profile_snapshot="autonomous"),
                    ("blocked", "cost_breaker_tripped"),
                )

    def test_standard_is_not_gated_by_the_cost_breaker(self) -> None:
        """The rescope covers the FAILURE breaker only. Widening cost needs the
        B0 producer analysis tracked separately; gating standard against a
        counter nothing increments would block cycles for no reason."""
        with tempfile.TemporaryDirectory(prefix="aria-420-s2-cost-") as tmp:
            base = Path(tmp) / "aria-tools"
            with unittest.mock.patch(
                "aria_kernel.cost_budget.current_state", return_value="tripped",
            ), unittest.mock.patch(
                "aria_kernel.circuit_breaker.current_state", return_value="ok",
            ):
                self.assertEqual(
                    _cycle_preflight(base_dir=base, profile_snapshot="standard"),
                    ("ok", None),
                )


if __name__ == "__main__":
    unittest.main()
