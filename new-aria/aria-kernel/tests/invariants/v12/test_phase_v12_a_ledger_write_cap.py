"""Plan 032 Faz 032a — the ledger line budget binds at WRITE time.

Invariants:
  I-V12-LEDGER-01  a row that would exceed LEDGER_ROW_MAX_BYTES is refused
                   before it touches the chain; the file is byte-identical
                   after the refusal and a row under the cap still appends.
  I-V12-LEDGER-02  every reader that enforces a line cap enforces THE
                   writer's cap — one constant, imported, never copied.
  I-V12-LEDGER-03  the fixture-refresh phase records a limit refusal as one
                   tool's blocked refresh and keeps the cycle alive.

Measured 2026-09-02 (run 33608801135): one oversized fixture-runs.jsonl row
failed the cycle phase AND the publish, and every retry re-wrote it, so the
store was unpublishable for three nights. The write-side cap itself landed with
ARIA-HIGH-034 (`ledger.LEDGER_ROW_MAX_BYTES` / `LedgerRowTooLargeError`); these
invariants pin it and the phase-level handling from Plan 032 Faz 032a.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import fixture_runner, ledger, state_snapshot
from aria_kernel.ledger import (
    LEDGER_ROW_MAX_BYTES,
    LedgerRowTooLargeError,
    append_declared_jsonl,
    load_declared_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir


class LedgerWriteCap(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.path = self.tools / "raw-findings.jsonl"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _append(self, payload_bytes: int) -> dict:
        return append_declared_jsonl(
            self.path,
            {"cycle_id": "cyc-cap", "payload": "x" * payload_bytes},
            expected_surface="raw_findings",
        )

    def test_I_V12_LEDGER_01_oversized_row_is_refused_before_the_chain(self) -> None:
        self._append(16)
        before = self.path.read_bytes()

        with self.assertRaises(LedgerRowTooLargeError) as ctx:
            self._append(LEDGER_ROW_MAX_BYTES)

        self.assertIn("ledger_row_too_large", str(ctx.exception))
        self.assertEqual(self.path.read_bytes(), before, "a refused row must leave no bytes behind")
        # The chain is still a valid chain and still accepts a normal row.
        after = self._append(32)
        rows = load_declared_jsonl(self.path, expected_surface="raw_findings")
        self.assertEqual([row["ledger_hash"] for row in rows][-1], after["ledger_hash"])
        self.assertEqual(len(rows), 2)

    def test_I_V12_LEDGER_01_a_row_just_under_the_cap_appends(self) -> None:
        # Leave room for the stamped fields + hashes the writer adds.
        self._append(LEDGER_ROW_MAX_BYTES - 4096)
        line = self.path.read_bytes().splitlines()[-1]
        self.assertLessEqual(len(line) + 1, LEDGER_ROW_MAX_BYTES)
        self.assertEqual(json.loads(line)["cycle_id"], "cyc-cap")

    def test_I_V12_LEDGER_02_readers_share_the_writers_constant(self) -> None:
        self.assertIs(state_snapshot.SNAPSHOT_MAX_LEDGER_LINE_BYTES, LEDGER_ROW_MAX_BYTES)
        self.assertIs(fixture_runner.FIXTURE_RUN_LEDGER_MAX_LINE_BYTES, LEDGER_ROW_MAX_BYTES)
        self.assertEqual(LEDGER_ROW_MAX_BYTES, 1024 * 1024)
        self.assertIn("LedgerRowTooLargeError", ledger.__all__)
        self.assertIn("LEDGER_ROW_MAX_BYTES", ledger.__all__)


class FixtureRefreshSurvivesTheCap(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_LEDGER_03_a_limit_refusal_is_one_blocked_tool_not_a_dead_cycle(self) -> None:
        from types import SimpleNamespace

        from aria_kernel import cycle

        # The phase reads exactly three context fields; a namespace carrying
        # them is the honest fixture (the full PhaseContext needs a bound
        # workspace the phase never touches).
        context = SimpleNamespace(
            cycle_id="cyc-v12",
            workspace_root=Path(self._tmp.name),
            base_dir=self.tools,
        )
        tools = [{"tool_id": "adapter-a", "fixture_set": "fixtures/a"}]

        def refuse(*_args, **_kwargs):
            raise LedgerRowTooLargeError("ledger_row_too_large:test:bytes=2:max=1")

        with mock.patch.object(cycle, "list_tools", return_value=tools), mock.patch.object(
            fixture_runner, "refresh_fixture_suite", side_effect=refuse,
        ):
            result = cycle._phase_fixture_refresh(context)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["blocked_count"], 1)
        self.assertEqual(result["tools"][0]["status"], "blocked")
        self.assertIn("ledger_row_too_large", result["tools"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
