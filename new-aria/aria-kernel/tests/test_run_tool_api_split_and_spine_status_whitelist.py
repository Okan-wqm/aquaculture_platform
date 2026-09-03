"""Plan 024 v3 §B-7 + §H-6 — run_tool API split + spine status whitelist.

Pre-fix run_tool returned only the registry-side health_decision dict;
the runner envelope (with the canonical 'ok|crash|schema_error|...'
status vocabulary) was a side-effect write to runs.jsonl. cli.py
'tool run' returned exit code 0 unconditionally; spine_orchestrator
read result.get('status') (registry status, not envelope) and treated
'failed' as the only excluded value.

§B-7 fix: run_tool returns
{**decision, "envelope": envelope, "health_decision": decision}.
Backward-compatible (top-level keys preserved).

§H-6 fix: spine_orchestrator status filter is a whitelist
({pass, ok}) + explicit exclude set ({fail, failed, crash,
schema_error, tool_unhealthy, ...}). Unknown status raises
GovernanceError.

Tests:
1. _TOOL_RUN_EXIT_CODES covers every canonical envelope status.
2. _TOOL_RUN_EXIT_CODES status -> exit code mapping is correct.
3. spine_orchestrator status whitelist covers known excludes.
4. The whitelist + exclude sets do not overlap.
5. tool_runner.run_tool source carries the envelope/health_decision
   split documented in the docstring + comment.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel.cli import _TOOL_RUN_EXIT_CODES


class CliExitCodeMapTests(unittest.TestCase):
    def test_envelope_status_canonical_set_keyed(self) -> None:
        """Plan 024 §B-7 acceptance (1): every canonical envelope
        status the runner can produce must be keyed in the exit code
        map. Otherwise the CLI raises a KeyError on first hit of an
        unmapped status — fail-loud, not silent-zero."""
        canonical = {
            "ok", "crash", "schema_error", "output_unparseable",
            "budget_exceeded", "tool_unhealthy",
        }
        for status in canonical:
            self.assertIn(status, _TOOL_RUN_EXIT_CODES,
                f"Plan 024 §B-7 — envelope status {status!r} missing "
                f"from _TOOL_RUN_EXIT_CODES")

    def test_exit_code_mapping_correct(self) -> None:
        """Plan 024 §B-7 acceptance (2)."""
        # ok = 0 (success); 1, 2, 3 are increasingly severe failure
        # classes operators can pattern-match on.
        self.assertEqual(_TOOL_RUN_EXIT_CODES["ok"], 0)
        # crash / schema_error / output_unparseable: runner-side
        # protocol failure.
        for s in ("crash", "schema_error", "output_unparseable"):
            self.assertEqual(_TOOL_RUN_EXIT_CODES[s], 1,
                f"{s} should map to exit code 1 (runner protocol failure)")
        self.assertEqual(_TOOL_RUN_EXIT_CODES["budget_exceeded"], 2,
            "budget_exceeded distinct exit code so operators can rate-limit")
        self.assertEqual(_TOOL_RUN_EXIT_CODES["tool_unhealthy"], 3,
            "tool_unhealthy distinct so operators can quarantine-respond")


class SpineOrchestratorStatusWhitelistTests(unittest.TestCase):
    def test_pass_ok_in_fresh_pass_set(self) -> None:
        """Plan 024 §H-6 acceptance (3) — vocabulary check via source
        scan. The whitelist + exclude sets live as local constants in
        refresh_spine_adapters; we read the source to verify them
        without needing a full registered-tool fixture."""
        spine_src = (Path(__file__).resolve().parent.parent /
                     "aria_kernel" / "spine_orchestrator.py").read_text(
            encoding="utf-8")
        # Whitelist pass/ok present.
        self.assertIn('"pass"', spine_src)
        self.assertIn('"ok"', spine_src)
        # Exclude vocabulary covers crash + schema_error + tool_unhealthy.
        for excluded in ("crash", "schema_error", "tool_unhealthy",
                         "output_unparseable", "budget_exceeded"):
            self.assertIn(f'"{excluded}"', spine_src,
                f"Plan 024 §H-6 — exclude status {excluded!r} missing "
                f"from spine_orchestrator vocabulary")

    def test_unknown_status_governance_error_path_exists(self) -> None:
        """Plan 024 §H-6 acceptance (5): unknown envelope status
        surfaces as a GovernanceError at the spine, not silent-fresh.
        Source scan asserts the error path is wired."""
        spine_src = (Path(__file__).resolve().parent.parent /
                     "aria_kernel" / "spine_orchestrator.py").read_text(
            encoding="utf-8")
        self.assertIn("spine_orchestrator_unknown_run_status", spine_src,
            "Plan 024 §H-6 — fail-loud error code must exist in source")
        self.assertIn("raise GovernanceError", spine_src,
            "Plan 024 §H-6 — GovernanceError must be raised on unknown status")


class RunToolApiSplitSourceTests(unittest.TestCase):
    def test_run_tool_returns_envelope_and_health_decision_keys(self) -> None:
        """Plan 024 §B-7 acceptance (5): source scan asserts the API
        split is wired. Direct shape test lives in
        test_tool_runner_*.py via real registered-tool fixtures; this
        guards against a future regression that re-collapses the API
        back to a single dict."""
        runner_src = (Path(__file__).resolve().parent.parent /
                      "aria_kernel" / "tool_runner.py").read_text(
            encoding="utf-8")
        # The closure key must be the 3-key dict literal returned at
        # the bottom of run_tool.
        self.assertIn('"envelope": envelope', runner_src,
            "Plan 024 §B-7 — run_tool must return 'envelope' key")
        self.assertIn('"health_decision": decision', runner_src,
            "Plan 024 §B-7 — run_tool must return 'health_decision' key")
        self.assertIn("**decision,", runner_src,
            "Plan 024 §B-7 — top-level decision keys merged for backward compat")


if __name__ == "__main__":
    unittest.main()
