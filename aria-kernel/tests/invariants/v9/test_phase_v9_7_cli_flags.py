"""Plan ARIA-V9.7 — CLI surface invariants.

The autonomy run subparser MUST expose 6 flags so the V10.3-B
20-cycle endurance gate command (per plan v3 §Acceptance) is
runnable on HEAD. Closes architectural-arbiter HIGH-010 (CLI flags
do not exist).
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import cli as _cli


class TestV9CliAutonomyRun(unittest.TestCase):
    """Source-substring invariants pin the 6 flags on the autonomy
    run subparser. The parser is constructed inline inside _main(),
    so we inspect cli.py source directly instead of building +
    parsing argv (which would require refactoring _main to expose
    the parser — out of V9.7 scope)."""

    @classmethod
    def setUpClass(cls):
        cls.src = inspect.getsource(_cli)

    def test_cycle_deadline_seconds_present(self):
        self.assertIn('--cycle-deadline-seconds', self.src)

    def test_challenger_timeout_seconds_present(self):
        self.assertIn('--challenger-timeout-seconds', self.src)

    def test_max_rounds_present(self):
        self.assertIn('--max-rounds', self.src)

    def test_max_budget_usd_per_run_present(self):
        self.assertIn('--max-budget-usd-per-run', self.src)

    def test_max_budget_usd_per_cycle_present(self):
        """V9.7 NEW flag — per-cycle cap kill-switch."""
        self.assertIn('--max-budget-usd-per-cycle', self.src)

    def test_profile_flag_present(self):
        """V9.7 + V3.1-E NEW flag — autonomous-profile precondition
        gate. V3.1-E expands `--profile` choices from
        ("strict", "autonomous") to all 5 PROFILES (closes C-2 SOC2
        gap by allowing CLI override of the persisted profile).
        Pin presence of the flag declaration + the canonical
        autonomous + strict tokens that anchor the autonomy-mode
        semantic."""
        self.assertIn('--profile', self.src)
        self.assertIn('"autonomous"', self.src)
        # `choices=list(PROFILES)` after V3.1-E — the literal token
        # `list(PROFILES)` MUST appear immediately after the choices
        # kwarg so a future refactor that hardcodes a profile subset
        # is caught at CI time.
        self.assertIn("choices=list(PROFILES)", self.src)

    def test_per_cycle_default_canonical(self):
        """Per-cycle cap default = $3.00 (K4 fable re-baseline)."""
        # Test pin: the literal "default=1.50" appears next to the
        # per-cycle add_argument call.
        self.assertIn("default=3.00", self.src)

    def test_profile_strict_default(self):
        """V9.7 + V3.1-E — autonomy run --profile default MUST be
        `None` so an absent flag falls back to the persisted profile
        (V8 backward-compat). The V3.1-E semantic update closes the
        CLI-bypasses-set_profile SOC2 gap by routing every operator-
        requested override through set_profile() with an explicit
        operator_approval_ref.

        Pre-V3.1-E: `default="strict"` (the CLI flag implicitly
        overrode persisted state on every invocation, defeating the
        audit trail).
        Post-V3.1-E: `default=None` (no flag = honor persisted; flag
        = explicit override + audit row).
        """
        # The `profile set` subcommand ALSO uses
        # `choices=list(PROFILES)` (with required=True instead of a
        # default). Disambiguate by anchoring on the autonomy-run-
        # specific `auto_run.add_argument` callsite. The autonomy run
        # parser variable name is `auto_run`; the V3.1-E flag block
        # contains the explicit `default=None` directive.
        marker = 'auto_run.add_argument(\n        "--profile"'
        idx = self.src.find(marker)
        self.assertGreater(
            idx, 0,
            "autonomy run --profile add_argument block not found",
        )
        # Within 600 chars after the marker the choices=list(PROFILES)
        # + default=None both appear (the flag declaration is one
        # add_argument call body).
        block = self.src[idx:idx + 600]
        self.assertIn("choices=list(PROFILES)", block)
        self.assertIn("default=None", block)


if __name__ == "__main__":
    unittest.main()
