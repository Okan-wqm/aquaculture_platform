"""A propagate-phase escape must still leave the cycle sealed.

WHY this test exists: every nightly cycle from 2026-08-21 to 2026-09-04 died
when a `propagate` phase raised PhaseDeadlineExceeded. The exception left
run_cycle between the `started` row and any terminal row, so cycles.jsonl held
an unterminated cycle; `integrity verify` failed on cycle_lifecycle, the whole
store was captured as quarantine evidence instead of published to aria/state,
and the night's discovery output was discarded. The refusal must survive (the
exception still propagates) while the ledger stays verifiable.

Invariants:
  I-SEAL-01  a propagate phase that raises leaves exactly one terminal row and
             re-raises the original exception.
  I-SEAL-02  sealing is idempotent and never overwrites a terminal row the
             cycle's own abort path already wrote.
  I-SEAL-03  a cycle_id this driver never started is not sealed (no terminal
             row without a started row).
  I-SEAL-04  a failure inside the sealer never replaces the original exception.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import cycle as C
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def _context(tools: Path, cycle_id: str) -> C.PhaseContext:
    return C.PhaseContext(
        cycle_id=cycle_id, workspace_root=tools, base_dir=tools, workspace=None, plan_id=None,
        shadow_only=False, defer_reflection=False, snapshot_mode="committed", profile="standard",
        cycle_started_at=datetime.now(timezone.utc), started_monotonic=0.0, results={}, outcomes={},
    )


def _rows(tools: Path, cycle_id: str) -> list[dict]:
    path = tools / "cycles.jsonl"
    if not path.exists():
        return []
    return [r for r in load_declared_jsonl(path, expected_surface="cycles") if r.get("cycle_id") == cycle_id]


class SealOnEscape(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _start(self, cycle_id: str) -> None:
        append_declared_jsonl(self.tools / "cycles.jsonl", C._started_cycle_row(cycle_id=cycle_id), expected_surface="cycles")

    def test_I_SEAL_01_propagate_escape_seals_and_reraises(self) -> None:
        cycle_id = "cyc-seal-01"
        self._start(cycle_id)
        ctx = _context(self.tools, cycle_id)
        boom = C.PhaseDeadlineExceeded("phase wall clock exhausted")

        # Exercise the REAL driver branch against the real phase table: the
        # `tools` phase is on_error="propagate", and the deadline SIGALRM
        # raises from inside _run_phase_with_deadline exactly like this.
        tools_phase = next(x for x in C.CYCLE_PHASES if x.name == "tools" and x.on_error == "propagate")
        with mock.patch.object(C, "CYCLE_PHASES", (tools_phase,)):
            with mock.patch.object(C, "_run_phase_with_deadline", side_effect=boom):
                with self.assertRaises(C.PhaseDeadlineExceeded) as caught:
                    C._run_phase_stage("tools", ctx)
        self.assertIs(caught.exception, boom, "the original exception must survive sealing")
        rows = _rows(self.tools, cycle_id)
        terminal = [r for r in rows if r.get("event") in C._TERMINAL_CYCLE_EVENTS]
        self.assertEqual(len(terminal), 1, rows)
        self.assertEqual(terminal[0]["event"], "failed")
        self.assertEqual(terminal[0]["status"], "failed")

    def test_I_SEAL_02_idempotent_and_respects_existing_terminal(self) -> None:
        cycle_id = "cyc-seal-02"
        self._start(cycle_id)
        ctx = _context(self.tools, cycle_id)
        C._seal_cycle_on_escape(ctx, phase="tools", exc=RuntimeError("x"))
        C._seal_cycle_on_escape(ctx, phase="tools", exc=RuntimeError("x"))
        self.assertEqual(len([r for r in _rows(self.tools, cycle_id) if r.get("event") in C._TERMINAL_CYCLE_EVENTS]), 1)
        # a cycle the abort path already sealed keeps ITS terminal row
        other = "cyc-seal-02b"
        self._start(other)
        append_declared_jsonl(self.tools / "cycles.jsonl", C._aborted_event(other), expected_surface="cycles")
        C._seal_cycle_on_escape(_context(self.tools, other), phase="tools", exc=RuntimeError("x"))
        terminal = [r for r in _rows(self.tools, other) if r.get("event") in C._TERMINAL_CYCLE_EVENTS]
        self.assertEqual([r["event"] for r in terminal], ["aborted"])

    def test_I_SEAL_03_never_seals_a_cycle_it_did_not_start(self) -> None:
        ctx = _context(self.tools, "cyc-never-started")
        C._seal_cycle_on_escape(ctx, phase="tools", exc=RuntimeError("x"))
        self.assertEqual(_rows(self.tools, "cyc-never-started"), [])
        # and with an empty ledger file absent entirely
        empty = ensure_tools_dir(Path(self._tmp.name) / "tools2")
        C._seal_cycle_on_escape(_context(empty, "cyc-x"), phase="tools", exc=RuntimeError("x"))
        self.assertFalse((empty / "cycles.jsonl").exists() and _rows(empty, "cyc-x"))

    def test_I_SEAL_04_sealer_failure_is_swallowed(self) -> None:
        cycle_id = "cyc-seal-04"
        self._start(cycle_id)
        ctx = _context(self.tools, cycle_id)
        with mock.patch.object(C, "append_declared_jsonl", side_effect=OSError("disk gone")):
            C._seal_cycle_on_escape(ctx, phase="tools", exc=RuntimeError("original"))  # must not raise


class LifecycleIntegrity(unittest.TestCase):
    def test_I_SEAL_01_sealed_cycle_passes_lifecycle_verification(self) -> None:
        """The point of sealing: the store verifies, so it publishes instead of quarantining."""
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            cycle_id = "cyc-seal-verify"
            append_declared_jsonl(tools / "cycles.jsonl", C._started_cycle_row(cycle_id=cycle_id), expected_surface="cycles")
            snapshot = C._cycle_lifecycle_snapshot(tools)
            self.assertFalse(snapshot.get("valid"), "an unterminated cycle must fail lifecycle verification")
            C._seal_cycle_on_escape(_context(tools, cycle_id), phase="tools", exc=C.PhaseDeadlineExceeded("boom"))
            healed = C._cycle_lifecycle_snapshot(tools)
            self.assertTrue(healed.get("valid"), healed)
            self.assertEqual(healed.get("incomplete_count", 0), 0, healed)


if __name__ == "__main__":
    unittest.main()
