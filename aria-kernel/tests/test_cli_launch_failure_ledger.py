"""ORPHAN-HIGH-780 — an argparse death must not vanish from the ledger.

The 08-19 → 08-21 gap in `tools/cycles.jsonl` on aria/state contains two
ORPHAN-754 nights that died at `unrecognized arguments` BEFORE any cycle
row existed: they consumed calendar time while staying invisible to the
30-attempt burn-in denominator. `cli.main` now records a
`cycle_launch_failed` governance event in the ARIA_TOOLS_DIR-bound store
before re-raising the exit.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main
from aria_kernel.tool_registry import ensure_tools_dir


class LaunchFailureLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._repo = Path(tempfile.mkdtemp(prefix="aria-launch-failure-"))
        self.tools = self._repo / "aria-tools"
        ensure_tools_dir(self.tools)
        self._prev_binding = os.environ.get("ARIA_TOOLS_DIR")
        os.environ["ARIA_TOOLS_DIR"] = str(self.tools)

    def tearDown(self) -> None:
        if self._prev_binding is None:
            os.environ.pop("ARIA_TOOLS_DIR", None)
        else:
            os.environ["ARIA_TOOLS_DIR"] = self._prev_binding
        shutil.rmtree(self._repo, ignore_errors=True)

    def _launch_failure_rows(self) -> list[dict]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("kind") == "cycle_launch_failed"]

    def test_argparse_death_records_launch_failure_then_exits_two(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            main(["autonomy", "run", "--implementer-poll-seconds", "120"])
        self.assertEqual(ctx.exception.code, 2)
        rows = self._launch_failure_rows()
        self.assertEqual(len(rows), 1, "exactly one launch-failure row per dead launch")
        details = rows[0]["details"]
        self.assertEqual(details["argv"], ["autonomy", "run", "--implementer-poll-seconds", "120"])
        self.assertEqual(details["exit_code"], 2)

    def test_unbound_environment_records_nothing_and_still_exits_two(self) -> None:
        os.environ.pop("ARIA_TOOLS_DIR", None)
        with self.assertRaises(SystemExit) as ctx:
            main(["state", "publish"])
        self.assertEqual(ctx.exception.code, 2)
        # No store to be honest to: the operator shell stays unrecorded and
        # the failure surface is stderr, not a ledger the kernel never had.
        # (The tools_root_bootstrapped row from setUp predates this call.)
        self.assertEqual(self._launch_failure_rows(), [])

    def test_unwritable_recording_never_masks_the_original_death(self) -> None:
        # A dead tools root makes the governance append itself fail; the
        # post-mortem recorder must swallow its own failure and still
        # re-raise argparse's exit 2.
        os.environ["ARIA_TOOLS_DIR"] = str(self._repo / "missing-root" / "tools")
        with self.assertRaises(SystemExit) as ctx:
            main(["autonomy", "run", "--dead-flag", "1"])
        self.assertEqual(ctx.exception.code, 2)

    def test_clean_parse_records_no_launch_failure(self) -> None:
        # `--help` exits 0 through the SystemExit path in main(); only
        # exit code 2 (usage error) is a caller/callee disagreement.
        with self.assertRaises(SystemExit) as ctx:
            main(["--help"])
        self.assertEqual(ctx.exception.code, 0)
        self.assertEqual(self._launch_failure_rows(), [])


if __name__ == "__main__":
    unittest.main()
