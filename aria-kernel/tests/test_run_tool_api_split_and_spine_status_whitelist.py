"""Plan 024 v3 §B-7 + §H-6 — the run status run_tool callers judge by.

§B-7: run_tool returns {**decision, "envelope": <run>, "health_decision":
decision}; `aria-kernel tool run` exits by the run's status. §H-6: the spine
orchestrator classifies a run by its status and fails loud on an unknown one.

ARIA-MEDIUM-516: "the run's status" is the status record_run STORED. run_tool
used to return the envelope it built before record_run validated a copy and
downgraded it (scope_violation, evidence_error, integrity_failed), so the CLI
exited 0 and the refresh counted the run fresh on a status the store never
held; the refresh's whitelist also admitted "pass"/"completed", which no run
can carry. These tests pin both vocabularies to tool_health.RUN_STATUSES by
behaviour (the run_tool shape itself: test_tool_runner_default_input.py).

Tests:
1. _TOOL_RUN_EXIT_CODES is keyed by exactly RUN_STATUSES.
2. _TOOL_RUN_EXIT_CODES status -> exit code mapping is correct.
3. The refresh counts a recorded ``ok`` run fresh and every other
   RUN_STATUSES value failed; a cached row is reused only when ``ok``.
4. A status outside RUN_STATUSES is a GovernanceError at the refresh.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cli import _TOOL_RUN_EXIT_CODES
from aria_kernel.spine_orchestrator import _is_fresh, refresh_spine_adapters
from aria_kernel.tool_health import RUN_STATUSES
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.spine_fixture import register_spine_adapters


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


class SpineOrchestratorStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tools = ensure_tools_dir(Path(tmp.name) / "aria-tools")
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        register_spine_adapters(self.tools, ("security-boundary-adapter",))

    def _refresh_with_recorded_status(self, status: str) -> dict:
        row = {
            "tool_id": "security-boundary-adapter", "run_id": f"r-{status}", "status": status,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "repo_snapshot": {"repo_state_id": "repo-state:x"},
        }
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot",
                   return_value={"repo_state_id": "repo-state:x"}), \
             patch("aria_kernel.spine_orchestrator.run_tool",
                   return_value={"envelope": row, "health_decision": {}}):
            return refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
                adapter_ids=("security-boundary-adapter",),
            )

    def test_recorded_ok_is_fresh_and_every_other_run_status_is_failed(self) -> None:
        for status in RUN_STATUSES:
            with self.subTest(status=status):
                state = self._refresh_with_recorded_status(status)["adapter_states"][0]
                self.assertEqual(state["status"], status)
                self.assertEqual(state["source"], "fresh" if status == "ok" else "failed")

    def test_status_outside_the_run_vocabulary_is_fail_loud(self) -> None:
        for status in ("pass", "completed", "failed"):
            with self.subTest(status=status):
                with self.assertRaisesRegex(GovernanceError, "spine_orchestrator_unknown_run_status"):
                    self._refresh_with_recorded_status(status)

    def test_only_an_ok_cached_row_is_fresh(self) -> None:
        now = datetime.now(timezone.utc)
        for status in (*RUN_STATUSES, "pass", "completed"):
            with self.subTest(status=status):
                row = {"status": status, "recorded_at": now.isoformat(),
                       "repo_snapshot": {"repo_state_id": "repo-state:x"}}
                self.assertEqual(
                    _is_fresh(run_row=row, target_repo_state_id="repo-state:x",
                              freshness_max_age_seconds=600, now=now),
                    status == "ok",
                )


if __name__ == "__main__":
    unittest.main()
