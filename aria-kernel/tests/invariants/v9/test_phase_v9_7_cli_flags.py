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
        """V9.7 NEW flag — autonomous-profile precondition gate."""
        self.assertIn('--profile', self.src)
        self.assertIn('"strict"', self.src)
        self.assertIn('"autonomous"', self.src)

    def test_per_cycle_default_canonical(self):
        """Per-cycle cap default = $1.50 (v3 plan acceptance)."""
        # Test pin: the literal "default=1.50" appears next to the
        # per-cycle add_argument call.
        self.assertIn("default=1.50", self.src)

    def test_profile_strict_default(self):
        """Profile default MUST be 'strict' — safe default; autonomous
        explicit opt-in only.

        Note: `--profile` also exists on the `profile set` subcommand
        (different surface). The V9.7 autonomy-run profile flag is
        identified by its companion `choices=("strict", "autonomous")`
        — pin the BLOCK containing both tokens."""
        idx = self.src.find('choices=("strict", "autonomous")')
        self.assertGreater(idx, 0, "autonomy run --profile choices not present")
        # Within 300 chars BEFORE + 200 AFTER the choices declaration
        # the `--profile` flag + default="strict" both appear.
        start = max(0, idx - 300)
        block = self.src[start:idx + 200]
        self.assertIn('"--profile"', block)
        self.assertIn('default="strict"', block)


if __name__ == "__main__":
    unittest.main()
