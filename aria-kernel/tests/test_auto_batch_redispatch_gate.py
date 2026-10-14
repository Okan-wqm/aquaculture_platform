"""ARIA-MEDIUM-459 — auto_batch_dispatch re-dispatches only a pressure whose work is gone.

The candidacy gate in ``worker_dispatch.auto_batch_dispatch`` used a
hand-written "still has work" set ``{pending, prepared, picked_up,
submitted, verified, completed}`` that had drifted from the §G.2 reducer
in ``_latest_assignment_states``. An assignment the state machine had
already ruled on — ``stale``, ``human_required``, ``submit_rejected``,
``verification_failed`` (where ``max_retries_exceeded`` leaves it) or
``multiple_active_claims_corruption`` — read as "no work", so the same
pressure was dispatched again with a fresh per-assignment retry budget.

The gate now names the complement instead: only the legacy dead seeds
``cancelled`` / ``expired`` (``REDISPATCHABLE_ASSIGNMENT_STATES``) free a
pressure, so a state the reducer learns later blocks by default.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.ledger import load_jsonl
from aria_kernel.worker_dispatch import auto_batch_dispatch
from aria_kernel.workspace import WorkspacePaths
from tests._helpers.declared_fixtures import append_declared_fixture, init_test_tools_root


def _stub_paths(tmp: Path) -> WorkspacePaths:
    memory = tmp / "aria-memory"
    state = tmp / "aria-state"
    return WorkspacePaths(
        repo_root=tmp / "repo",
        workspace_root=tmp / "repo",
        memory_dir=memory,
        state_dir=state,
        cycle_dir=state / "cycles",
        feedback_index=state / "integrity_index.json",
        identity_file=state / "identity.json",
        lock_file=state / "lock",
        ledgers={
            "pressure": memory / "pressure.jsonl",
            "pressure_state": memory / "pressure_state.jsonl",
            "unknowns": memory / "unknowns.jsonl",
            "missed_signals": memory / "missed_signals.jsonl",
            "external_feedback": memory / "external_feedback.jsonl",
        },
    )


class AutoBatchRedispatchGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a10-6-"))
        self.tools_root = init_test_tools_root(self.tmp / "aria-tools")
        self.paths = _stub_paths(self.tmp)
        self.paths.repo_root.mkdir(parents=True, exist_ok=True)
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self) -> None:
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fresh_tools_root(self) -> None:
        # Ledgers must not leak between subTests.
        shutil.rmtree(self.tools_root, ignore_errors=True)
        self.tools_root = init_test_tools_root(self.tmp / "aria-tools")

    def _seed_decision(self, pressure_event_id: str) -> None:
        append_declared_fixture(
            self.tools_root / "triage" / "decisions.jsonl",
            {
                "schema_version": 1,
                "pressure_event_id": pressure_event_id,
                "triage_tier": "auto_fix_safe",
                "target_agent": "aria-worker",
            },
            expected_surface="triage_decisions",
        )

    def _seed_request(self, *, assignment_id: str, pressure_event_id: str, state: str = "pending") -> None:
        append_declared_fixture(
            self.tools_root / "dispatch" / "requests.jsonl",
            {
                "schema_version": 1,
                "assignment_id": assignment_id,
                "pressure_event_id": pressure_event_id,
                "target_agent": "aria-worker",
                "triage_tier": "auto_fix_safe",
                "worktree_path": str(self.tmp / "worktrees" / assignment_id),
                "base_sha": "deadbeef",
                "required_tests": [],
                "expected_trailer": "Closes-Pressure: " + pressure_event_id,
                "state": state,
                "created_at": "2026-05-10T00:00:00Z",
            },
            expected_surface="dispatch_requests",
        )

    def _seed(self, filename: str, surface: str, row: dict[str, Any]) -> None:
        append_declared_fixture(
            self.tools_root / "dispatch" / filename,
            {"schema_version": 1, "recorded_at": "2026-05-11T13:00:00Z", **row},
            expected_surface=surface,
        )

    def test_states_the_reducer_ruled_on_block_redispatch(self) -> None:
        cases: list[tuple[str, list[tuple[str, str, dict[str, Any]]]]] = [
            ("stale", [("claims.jsonl", "dispatch_claims",
                        {"assignment_id": "A-1", "claim_id": "C-1", "event": "stale"})]),
            ("human_required", [("claims.jsonl", "dispatch_claims",
                                 {"assignment_id": "A-1", "claim_id": "C-1", "event": "human_required"})]),
            ("submit_rejected", [("worker-results.jsonl", "dispatch_worker_results",
                                  {"assignment_id": "A-1", "state": "rejected"})]),
            ("verification_failed", [("verification-results.jsonl", "dispatch_verification_results",
                                      {"assignment_id": "A-1", "status": "failed"})]),
            ("verified", [("verification-results.jsonl", "dispatch_verification_results",
                           {"assignment_id": "A-1", "status": "passed"})]),
            ("multiple_active_claims_corruption", [
                ("claims.jsonl", "dispatch_claims",
                 {"assignment_id": "A-1", "claim_id": "C-1", "event": "claimed"}),
                ("claims.jsonl", "dispatch_claims",
                 {"assignment_id": "A-1", "claim_id": "C-2", "event": "claimed",
                  "recorded_at": "2026-05-11T13:01:00Z"}),
            ]),
        ]
        for state, seeds in cases:
            with self.subTest(state=state):
                self._fresh_tools_root()
                self._seed_decision("P-TERM")
                self._seed_request(assignment_id="A-1", pressure_event_id="P-TERM")
                for filename, surface, row in seeds:
                    self._seed(filename, surface, row)
                result = auto_batch_dispatch(self.paths, tools_root=self.tools_root)
                self.assertEqual(result["candidate_count"], 0)
                self.assertEqual(result["results"], [])
                requests = load_jsonl(self.tools_root / "dispatch" / "requests.jsonl")
                self.assertEqual([r.get("assignment_id") for r in requests], ["A-1"])

    def test_only_dead_seeds_and_absent_work_free_a_pressure(self) -> None:
        from aria_kernel.worker_dispatch import REDISPATCHABLE_ASSIGNMENT_STATES

        self.assertEqual(REDISPATCHABLE_ASSIGNMENT_STATES, frozenset({"cancelled", "expired"}))
        for dead in sorted(REDISPATCHABLE_ASSIGNMENT_STATES):
            with self.subTest(state=dead):
                self._fresh_tools_root()
                self._seed_decision("P-DEAD")
                self._seed_request(assignment_id="A-3", pressure_event_id="P-DEAD", state=dead)
                result = auto_batch_dispatch(self.paths, tools_root=self.tools_root)
                self.assertEqual(result["candidate_count"], 1)
        with self.subTest(state="no assignment"):
            # create_dispatch_request then fails ("pressure not found": no
            # pressure ledger is seeded), which is recorded as an error result
            # AFTER candidacy — the candidacy decision is what is under test.
            self._fresh_tools_root()
            self._seed_decision("P-FRESH")
            fresh = auto_batch_dispatch(self.paths, tools_root=self.tools_root)
            self.assertEqual(fresh["candidate_count"], 1)
            self.assertEqual(fresh["results"][0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
