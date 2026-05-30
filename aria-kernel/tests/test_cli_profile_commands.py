"""Plan ARIA-V3.1 §B3.1-MED-004 — CLI entry-point coverage for profile subcommands.

Pre-V3.1 the kernel had unit tests for ``runtime_profile.{get_profile,
set_profile,list_profile_history}`` at the module-function level, but
NO test exercising the CLI entry path
(``aria-kernel profile get|set|history``). Plan ARIA-V3 shipped a
shadow-import defect (4 nested re-imports of ``get_profile`` inside
``_main`` shadowed the module-level binding for the entire function
body) that silently broke 3 CLI endpoints with ``UnboundLocalError`` —
the operator only saw the failure when invoking the CLI from a fresh
runtime in Plan ARIA-V3.1's fresh-run analysis.

These tests invoke ``cli.main([...])`` directly (the same entry path
``python3 -m aria_kernel`` uses), against a temp tools-dir, so the
shadow-import bug class can never silently regress.

I-V3.1-01..03 cases:

  * I-V3.1-01 — ``profile get`` returns the active profile as JSON
  * I-V3.1-02 — ``profile set`` transitions the active profile +
    requires an operator_approval_ref
  * I-V3.1-03 — ``profile history`` returns the JSONL history rows
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _run_cli(argv: list[str]) -> tuple[int, str]:
    """Plan ARIA-V3.1 §B3.1-MED-004 — invoke the CLI entry path
    in-process (same path ``python3 -m aria_kernel`` uses) and
    capture stdout. Returns (returncode, stdout).
    """
    from aria_kernel.cli import main

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(argv)
    return rc, buf.getvalue()


class CliProfileCommands(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v31-cli-profile-"))
        self.tools = self.tmp / "aria-tools"
        self.tools.mkdir(parents=True)
        # Plan 026R §A.1 — ensure_tools_dir runs identity bootstrap
        # on first write. We let the CLI do that lazily.

    # I-V3.1-01 — profile get.
    def test_i_v3_1_01_profile_get_returns_active_profile_via_cli(self) -> None:
        rc, out = _run_cli(
            ["--tools-dir", str(self.tools), "profile", "get"]
        )
        self.assertEqual(rc, 0)
        payload = json.loads(out)
        self.assertIn("active_profile", payload)
        # First call on a fresh tools-dir returns DEFAULT_PROFILE.
        from aria_kernel.runtime_profile import DEFAULT_PROFILE
        self.assertEqual(payload["active_profile"], DEFAULT_PROFILE)

    # I-V3.1-02 — profile set.
    def test_i_v3_1_02_profile_set_updates_state_via_cli(self) -> None:
        rc, out = _run_cli([
            "--tools-dir", str(self.tools),
            "profile", "set",
            "--profile", "strict",
            "--operator-approval-ref", "test-v3.1-02-canary",
        ])
        self.assertEqual(rc, 0)
        payload = json.loads(out)
        self.assertEqual(payload["active_profile"], "strict")
        # Round-trip: get returns the new state.
        rc2, out2 = _run_cli(
            ["--tools-dir", str(self.tools), "profile", "get"]
        )
        self.assertEqual(rc2, 0)
        self.assertEqual(json.loads(out2)["active_profile"], "strict")

    # I-V3.1-03 — profile history.
    def test_i_v3_1_03_profile_history_returns_history_via_cli(self) -> None:
        # Plan ARIA-V3.1 fixture — set the profile twice so history
        # has ≥2 entries; then assert history command returns both.
        for label, ref in [
            ("strict", "test-v3.1-03-step1"),
            ("standard", "test-v3.1-03-step2"),
        ]:
            rc, _ = _run_cli([
                "--tools-dir", str(self.tools),
                "profile", "set",
                "--profile", label,
                "--operator-approval-ref", ref,
            ])
            self.assertEqual(rc, 0)
        rc, out = _run_cli(
            ["--tools-dir", str(self.tools), "profile", "history"]
        )
        self.assertEqual(rc, 0)
        history = json.loads(out)
        self.assertIsInstance(history, list)
        self.assertGreaterEqual(len(history), 2)
        # Most-recent-first OR most-recent-last depending on
        # implementation; verify both refs appear in the list.
        refs = {row.get("operator_approval_ref") for row in history}
        self.assertIn("test-v3.1-03-step1", refs)
        self.assertIn("test-v3.1-03-step2", refs)

    # I-V3.1-02b — profile set rejects empty operator_approval_ref.
    def test_i_v3_1_02b_profile_set_rejects_empty_approval_ref(self) -> None:
        # The kernel set_profile raises GovernanceError on empty
        # approval ref (V2 contract preserved). The CLI surface
        # propagates the exception; we assert non-zero exit.
        with self.assertRaises(Exception):
            _run_cli([
                "--tools-dir", str(self.tools),
                "profile", "set",
                "--profile", "strict",
                "--operator-approval-ref", "",
            ])


if __name__ == "__main__":
    unittest.main()
