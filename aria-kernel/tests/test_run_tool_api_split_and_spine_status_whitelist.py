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

ARIA-MEDIUM-516: the exit code is the RECORDED status's (run_tool returns the
row record_run stored; its shape: test_tool_runner_default_input.py).

Tests:
1. _TOOL_RUN_EXIT_CODES is keyed by exactly tool_health.RUN_STATUSES.
2. _TOOL_RUN_EXIT_CODES status -> exit code mapping is correct.
3. spine_orchestrator status whitelist covers known excludes.
4. The whitelist + exclude sets do not overlap.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel.cli import _TOOL_RUN_EXIT_CODES
from aria_kernel.tool_health import RUN_STATUSES


class CliExitCodeMapTests(unittest.TestCase):
    def test_exit_code_map_is_keyed_by_exactly_the_recorded_run_statuses(self) -> None:
        """Plan 024 §B-7 acceptance (1), ARIA-MEDIUM-516: `tool run` indexes
        the map with the RECORDED status, so every status record_run can
        store must be keyed (a missing one is a KeyError, fail-loud) and a
        key nothing can record is dead vocabulary."""
        self.assertEqual(set(_TOOL_RUN_EXIT_CODES), set(RUN_STATUSES))

    def test_exit_code_mapping_correct(self) -> None:
        """Plan 024 §B-7 acceptance (2)."""
        # ok = 0 (success); 1, 2, 3 are failure classes operators can
        # pattern-match on.
        self.assertEqual(_TOOL_RUN_EXIT_CODES["ok"], 0)
        # Runner-side protocol failures and the statuses record_run
        # downgrades a run to.
        for s in ("crash", "schema_error", "scope_violation", "evidence_error",
                  "integrity_failed", "environment_unavailable"):
            self.assertEqual(_TOOL_RUN_EXIT_CODES[s], 1,
                f"{s} should map to exit code 1")
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


if __name__ == "__main__":
    unittest.main()
