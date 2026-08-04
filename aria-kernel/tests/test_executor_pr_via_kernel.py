"""Wave 0 §0.7 — executor-lane PR opening goes through the kernel CLI.

The real PRs in the executor lane were opened by the agent subprocess
running raw ``gh pr create`` (an ALLOWED_BASH_COMMANDS row), which
bypassed pr_manager entirely: GATE_PRE_PR_OPEN, the failure-breaker
producer, and the change-id anchor all sat on a path no production PR
travelled. These tests pin the cutover mechanics:

  1. the kernel CLI row admits exactly `python3 -m aria_kernel pr create`
     — not the rest of the kernel CLI (operator surface, not implementer
     surface);
  2. with ARIA_EXECUTOR_PR_VIA_KERNEL=1 (the executor lane's setting)
     raw ``gh pr create`` is an allowlist MISS — the kernel path is the
     only reachable one;
  3. without the flag the legacy row still matches — the staged
     transition the program plan tracks (flag + legacy row are deleted
     together after one green scheduled run);
  4. ``gh pr merge`` stays denied in BOTH states — the cutover must not
     loosen the merge-authority boundary.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from aria_kernel.implementation_safety import (
    ALLOWED_BASH_COMMANDS,
    BashAllowlistMiss,
    BashDenylistHit,
    LEGACY_GH_PR_CREATE_PATTERN,
    executor_pr_via_kernel,
    verify_bash_command_allowed,
)

KERNEL_PR_CREATE = [
    "python3", "-m", "aria_kernel", "pr", "create",
    "--proposal-id", "prop-1", "--change-id", "chg-1", "--no-dry-run",
]
LEGACY_GH_PR_CREATE = [
    "gh", "pr", "create", "--base", "main",
    "--head", "aria-impl-abc123", "--title", "[ARIA-AUTO]x",
]


class ExecutorPrViaKernelTests(unittest.TestCase):
    def test_the_legacy_row_left_the_allowlist(self) -> None:
        """The transition pattern must not ALSO live in the closed set.

        If it did, the flag would gate a copy while the original kept
        matching — the cutover would be a no-op that reads as done.
        """
        joined = " ".join(LEGACY_GH_PR_CREATE)
        for pattern in ALLOWED_BASH_COMMANDS:
            self.assertIsNone(
                pattern.match(joined),
                f"ALLOWED_BASH_COMMANDS still admits raw gh pr create via "
                f"{pattern.pattern!r}",
            )
        self.assertIsNotNone(LEGACY_GH_PR_CREATE_PATTERN.match(joined))

    def test_kernel_pr_create_is_allowed_in_both_states(self) -> None:
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                with mock.patch.dict("os.environ", flag, clear=False):
                    verify_bash_command_allowed(KERNEL_PR_CREATE)

    def test_only_the_pr_create_subcommand_is_admitted(self) -> None:
        for argv in (
            ["python3", "-m", "aria_kernel", "autonomy", "run"],
            ["python3", "-m", "aria_kernel", "integrity", "verify"],
            ["python3", "-m", "aria_kernel"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(BashAllowlistMiss):
                    verify_bash_command_allowed(argv)

    def test_flag_on_refuses_raw_gh_pr_create(self) -> None:
        with mock.patch.dict("os.environ", {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}, clear=False):
            self.assertTrue(executor_pr_via_kernel())
            with self.assertRaises(BashAllowlistMiss):
                verify_bash_command_allowed(LEGACY_GH_PR_CREATE)

    def test_flag_off_keeps_the_transition_path_open(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("ARIA_EXECUTOR_PR_VIA_KERNEL", None)
            self.assertFalse(executor_pr_via_kernel())
            verify_bash_command_allowed(LEGACY_GH_PR_CREATE)

    def test_gh_pr_merge_stays_denied_in_both_states(self) -> None:
        for flag in ({}, {"ARIA_EXECUTOR_PR_VIA_KERNEL": "1"}):
            with self.subTest(env=flag):
                with mock.patch.dict("os.environ", flag, clear=False):
                    with self.assertRaises(BashDenylistHit):
                        verify_bash_command_allowed(["gh", "pr", "merge", "42"])


if __name__ == "__main__":
    unittest.main()
