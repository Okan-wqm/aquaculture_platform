"""Tests for Plan 025 §C — cycle.validation_matrix closed-loop wiring.

Pre-fix the validation_matrix extended phase emitted an informational
notice ("invoke the matrix CLI outside the cycle"); the cycle never
actually invoked enforce_validation_matrix even though the kernel
primitive existed. Post-fix the phase iterates committed change_ids
inside the cycle window, invokes the gate per change, and aggregates
per-id results. Cycle status propagation downgrades to ``failed`` if
any change_id's gate fails.

Target: aria_kernel.cycle._run_validation_matrix_phase (the helper the
extended-phase block dispatches into).
"""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cycle import (
    _run_pr_lifecycle_phase,
    _run_validation_matrix_phase,
    build_phase_context,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class ValidationMatrixPhaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-vm-phase-"))
        self.tools_root = ensure_tools_dir(self.tmp / "aria-tools")
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        # Plan 020 Phase 0 — ARIA_WORKSPACE_BASE override so workspace
        # creation lands in tmp instead of read-only /root/.aria.
        self._env = patch.dict(os.environ, {
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
        })
        self._env.start()

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_committed_change(self, *, change_id: str, recorded_at: datetime) -> None:
        # Direct ledger write to bypass emit_change_committed's
        # contract checks (which require a planned row first); we
        # only need a row with change_id + recorded_at to test the
        # window discovery + gate dispatch.
        committed_path = self.tools_root / "change-ledger" / "committed.jsonl"
        committed_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/change-committed/v1",
            "schema_version": 1,
            "change_id": change_id,
            "commit_sha": "deadbeef",
            "actual_affected_files": ["aria-kernel/test.py"],
            "recorded_at": recorded_at.isoformat().replace("+00:00", "Z"),
        }
        append_declared_fixture(
            committed_path,
            row,
            expected_surface="change_committed",
        )

    def _seed_validated_chain(self, *, change_id: str) -> None:
        # Same direct-write strategy for validated.jsonl so
        # get_change_chain returns a chain with validation_run_refs.
        validated_path = self.tools_root / "change-ledger" / "validated.jsonl"
        validated_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/change-validated/v1",
            "schema_version": 1,
            "change_id": change_id,
            "validation_run_refs": [],
            "recorded_at": datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            ),
        }
        append_declared_fixture(
            validated_path,
            row,
            expected_surface="change_validated",
        )

    def test_no_committed_changes_in_window_returns_no_op(self) -> None:
        # No seed; validation_matrix phase returns no_op.
        cycle_started_at = datetime.now(timezone.utc)
        context = build_phase_context(
            cycle_id="cyc-vm-1",
            workspace_root=self.tmp,
            base_dir=self.tools_root,
            cycle_started_at=cycle_started_at,
        )
        result = {'validation_matrix': _run_validation_matrix_phase(context)}
        self.assertEqual(result["validation_matrix"]["status"], "no_op")
        self.assertEqual(result["validation_matrix"]["total"], 0)
        self.assertEqual(result["validation_matrix"]["change_ids"], [])

    def test_committed_change_in_window_invokes_gate_pass(self) -> None:
        # Seed a change inside the window; mocked gate passes.
        cycle_started_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        in_window = datetime.now(timezone.utc)
        self._seed_committed_change(change_id="ch-A", recorded_at=in_window)
        self._seed_validated_chain(change_id="ch-A")
        with patch(
            "aria_kernel.validation_matrix_gate.enforce_validation_matrix"
        ) as mock_gate:
            mock_gate.return_value = {
                "passed": True, "blocked": False, "risk_types": [],
            }
            context = build_phase_context(
                cycle_id="cyc-vm-2",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=cycle_started_at,
            )
            result = {'validation_matrix': _run_validation_matrix_phase(context)}
        self.assertEqual(mock_gate.call_count, 1)
        kwargs = mock_gate.call_args.kwargs
        self.assertEqual(kwargs["change_id"], "ch-A")
        self.assertEqual(result["validation_matrix"]["status"], "ok")
        self.assertEqual(result["validation_matrix"]["total"], 1)
        self.assertEqual(result["validation_matrix"]["ok"], 1)
        self.assertEqual(result["validation_matrix"]["change_ids"][0]["passed"], True)

    def test_committed_change_outside_window_skipped(self) -> None:
        # Seed a change BEFORE cycle_started_at — must NOT be in window.
        pre_window = datetime.now(timezone.utc) - timedelta(hours=1)
        self._seed_committed_change(change_id="ch-OLD", recorded_at=pre_window)
        cycle_started_at = datetime.now(timezone.utc)  # after the seed
        with patch(
            "aria_kernel.validation_matrix_gate.enforce_validation_matrix"
        ) as mock_gate:
            context = build_phase_context(
                cycle_id="cyc-vm-3",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=cycle_started_at,
            )
            result = {'validation_matrix': _run_validation_matrix_phase(context)}
        # Window discovery filtered the row out; no gate invocation.
        self.assertEqual(mock_gate.call_count, 0)
        self.assertEqual(result["validation_matrix"]["status"], "no_op")
        self.assertEqual(result["validation_matrix"]["total"], 0)

    def test_failed_gate_status_fail_with_per_change_error(self) -> None:
        # Mocked gate raises GovernanceError → caught per change_id;
        # status="fail" + per_change carries the error string.
        cycle_started_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        in_window = datetime.now(timezone.utc)
        self._seed_committed_change(change_id="ch-FAIL", recorded_at=in_window)
        self._seed_validated_chain(change_id="ch-FAIL")
        with patch(
            "aria_kernel.validation_matrix_gate.enforce_validation_matrix"
        ) as mock_gate:
            mock_gate.side_effect = GovernanceError(
                "blocked: missing required tests for risk_types=['db']"
            )
            context = build_phase_context(
                cycle_id="cyc-vm-4",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=cycle_started_at,
            )
            result = {'validation_matrix': _run_validation_matrix_phase(context)}
        self.assertEqual(result["validation_matrix"]["status"], "fail")
        self.assertEqual(result["validation_matrix"]["fail"], 1)
        per_change = result["validation_matrix"]["change_ids"][0]
        self.assertEqual(per_change["passed"], False)
        self.assertIn("blocked", per_change["error"])


if __name__ == "__main__":
    unittest.main()
