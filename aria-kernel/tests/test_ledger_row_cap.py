"""ARIA-HIGH-034 — the append primitive owns the ledger row-size cap.

Cycle 33608801135 (2026-09-02) sealed a 1 463 495-byte row into
``fixture-runs.jsonl`` and died four hours later in ``Publish ARIA state``
with ``snapshot_surface_line_too_large`` — the cap lived only on the READ
side, and an append-only, hash-chained ledger cannot shed a row once it is
sealed. These tests pin the write side: a row that the snapshot reader
would refuse is refused by ``append_jsonl`` first, leaving the file, the
chain and the index untouched; the reader's limit is the primitive's
constant, not a second number that can drift.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aria_kernel import ledger, state_snapshot  # noqa: E402
from aria_kernel.ledger import (  # noqa: E402
    LEDGER_ROW_MAX_BYTES,
    LedgerRowTooLargeError,
    append_jsonl,
    read_jsonl,
)


def _padding_for(total_line_bytes: int, path: Path) -> str:
    """A ``note`` payload sized so the WRITTEN line lands on ``total_line_bytes``.

    Computed against a probe row through the same stamping + chain fields
    the primitive adds, so the assertion is on the exact bytes on disk.
    """
    probe = ledger._stamped_for_surface(path, {"note": ""})
    probe = dict(probe)
    probe["previous_ledger_hash"] = None
    probe["ledger_hash"] = ledger._record_hash(probe, None)
    overhead = len((json.dumps(probe, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
    return "x" * (total_line_bytes - overhead)


class LedgerRowCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "scratch.jsonl"

    def test_read_side_cap_is_the_primitive_constant(self) -> None:
        # One number. The snapshot builder must not carry its own.
        self.assertIs(state_snapshot.SNAPSHOT_MAX_LEDGER_LINE_BYTES, LEDGER_ROW_MAX_BYTES)
        self.assertEqual(LEDGER_ROW_MAX_BYTES, 1024 * 1024)

    def test_row_at_the_cap_is_accepted(self) -> None:
        note = _padding_for(LEDGER_ROW_MAX_BYTES, self.path)
        append_jsonl(self.path, {"note": note}, test_fixture=True)
        raw = self.path.read_bytes()
        self.assertEqual(len(raw), LEDGER_ROW_MAX_BYTES)
        self.assertEqual(read_jsonl(self.path)[0]["note"], note)

    def test_row_one_byte_over_is_refused_and_nothing_is_written(self) -> None:
        append_jsonl(self.path, {"seed": 1}, test_fixture=True)
        before = self.path.read_bytes()
        note = _padding_for(LEDGER_ROW_MAX_BYTES + 1, self.path)
        with self.assertRaises(LedgerRowTooLargeError) as caught:
            append_jsonl(self.path, {"note": note}, test_fixture=True)
        message = str(caught.exception)
        self.assertIn("ledger_row_too_large:", message)
        self.assertIn(f"cap={LEDGER_ROW_MAX_BYTES}", message)
        self.assertIn("spill_oversized_inline", message)
        # The refusal happened before the fd was opened: bytes and chain
        # tail are exactly what the previous append left.
        self.assertEqual(self.path.read_bytes(), before)
        rows = read_jsonl(self.path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["seed"], 1)

    def test_refused_row_does_not_break_the_chain_for_the_next_writer(self) -> None:
        append_jsonl(self.path, {"seed": 1}, test_fixture=True)
        with self.assertRaises(LedgerRowTooLargeError):
            append_jsonl(
                self.path,
                {"note": _padding_for(LEDGER_ROW_MAX_BYTES * 2, self.path)},
                test_fixture=True,
            )
        appended = append_jsonl(self.path, {"seed": 2}, test_fixture=True)
        rows = read_jsonl(self.path)
        self.assertEqual([row["seed"] for row in rows], [1, 2])
        self.assertEqual(appended["previous_ledger_hash"], rows[0]["ledger_hash"])


if __name__ == "__main__":
    unittest.main()
