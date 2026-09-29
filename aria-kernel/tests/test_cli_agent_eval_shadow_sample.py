"""Plan 023 v3 §D-1 — shadow-sample CLI parser entry.

Pre-Plan-023 agent_eval.sample_shadow_raw_findings() was Python-only;
operators could only invoke via REPL. The CLI agent-eval subparser
had no shadow-sample subcommand.

Plan 023 v3 §D-1 fix: `aria-kernel agent-eval shadow-sample [--threshold N]`
parser entry wired to the existing function. JSON output to stdout.

Tests verify the parser binding and dispatch — the function itself
is already covered by sampler tests in test_sampler_skips_quarantined_runs.py.
"""
from __future__ import annotations

import io
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from aria_kernel.cli import main as cli_main
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir


class CliShadowSampleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d1-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        # sample_shadow_raw_findings writes governance events; needs
        # strict profile.
        set_profile(
            "strict",
            operator_approval_ref="test:plan-023-d1",
            base_dir=self.tools,
            set_by="operator",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_cli(self, argv: list[str]) -> tuple[int, str]:
        captured = io.StringIO()
        saved = sys.argv
        sys.argv = ["aria-kernel"] + argv
        try:
            with redirect_stdout(captured):
                try:
                    code = cli_main()
                except SystemExit as e:
                    code = int(e.code or 0)
        finally:
            sys.argv = saved
        return code, captured.getvalue()

    def test_shadow_sample_subparser_dispatches(self) -> None:
        """Plan 023 v3 §D-1: the shadow-sample subparser exists and
        dispatches to sample_shadow_raw_findings. Empty runs.jsonl
        means the call returns an empty samples list — the parser
        wiring is what we're pinning."""
        exit_code, stdout = self._run_cli([
            "--tools-dir", str(self.tools),
            "agent-eval", "shadow-sample",
        ])
        self.assertEqual(exit_code, 0, f"stdout: {stdout!r}")
        # Output should be JSON; empty samples but well-formed.
        import json
        result = json.loads(stdout)
        self.assertIn("samples", result)
        self.assertEqual(result["samples"], [])
        self.assertIn("escalation_count", result)
        self.assertIn("threshold_24h", result)

    def test_shadow_sample_with_threshold_override(self) -> None:
        exit_code, stdout = self._run_cli([
            "--tools-dir", str(self.tools),
            "agent-eval", "shadow-sample",
            "--threshold", "10",
        ])
        self.assertEqual(exit_code, 0)
        import json
        result = json.loads(stdout)
        self.assertEqual(result["threshold_24h"], 10)


if __name__ == "__main__":
    unittest.main()
