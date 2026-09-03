"""Plan 024 §H-7 — JSONL corrupt-row visibility tests.

Pre-fix handoff_ledger.py:338-341 + finding.py:157-161 silently
skipped corrupt JSON rows on JSONDecodeError. Audit + integrity-
chain depend on every row being seen-or-flagged; silent skip hid
broken state from operators.

Architectural fix: a SEPARATE diagnostic sink at
``aria-tools/diagnostics/ledger-corruption.jsonl`` captures every
corruption observation. governance.jsonl recursion risk is closed
because the diagnostic sink is a different file — even if
governance.jsonl itself is corrupt, the corruption event lands in
the diagnostic sink without any append_tools_governance →
read_jsonl → LedgerIntegrityError chain reaching back into the
corrupt source.

Critical readers (handoff_ledger, finding) default to STRICT —
GovernanceError raised on first corruption. Tolerant mode is an
explicit opt-in for operator recovery scenarios.

Tests:
1. Clean handoff ledger → strict mode passes; sink stays empty.
2. Corrupt handoff row + strict mode → GovernanceError raised AND
   diagnostic sink row appended.
3. Corrupt handoff row + tolerant mode → corruption row in sink,
   list_handoffs returns valid rows only.
4. handoff_ledger invalid on_corruption mode → reject.
5. finding._refresh_index ignores corrupt derived finding docs and
   builds index only from canonical finding-events.jsonl.
6. emit_ledger_corruption_diagnostic without base_dir falls back to
   stderr without raising.
7. emit_ledger_corruption_diagnostic to a perm-denied sink falls
   back to stderr without raising.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from aria_kernel.diagnostics import (
    LEDGER_CORRUPTION_SINK_DIRNAME,
    LEDGER_CORRUPTION_SINK_FILENAME,
    emit_ledger_corruption_diagnostic,
)
from aria_kernel.handoff_ledger import HANDOFFS_FILENAME, list_handoffs
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _sink_path(tools_dir: Path) -> Path:
    return tools_dir / LEDGER_CORRUPTION_SINK_DIRNAME / LEDGER_CORRUPTION_SINK_FILENAME


class HandoffLedgerStrictModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_clean_ledger_strict_mode_passes(self) -> None:
        """Plan 024 §H-7 acceptance (1)."""
        path = self.tools / HANDOFFS_FILENAME
        path.write_text(
            '{"session_id": "S1", "trigger": "operator"}\n',
            encoding="utf-8",
        )
        rows = list_handoffs(base_dir=self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session_id"], "S1")
        self.assertFalse(_sink_path(self.tools).exists())

    def test_corrupt_row_strict_mode_raises_and_emits_diagnostic(self) -> None:
        """Plan 024 §H-7 acceptance (2)."""
        path = self.tools / HANDOFFS_FILENAME
        path.write_text(
            '{"session_id": "S1", "trigger": "operator"}\n'
            '{ NOT VALID JSON }\n',
            encoding="utf-8",
        )
        with self.assertRaises(GovernanceError) as ctx:
            list_handoffs(base_dir=self.tools)
        self.assertIn("ledger_row_corrupt_strict_mode", str(ctx.exception))
        # Error message carries the line number so operator can locate
        # the bad row immediately.
        self.assertIn(":2:", str(ctx.exception))
        # Diagnostic sink populated even though strict mode raised.
        sink = load_jsonl(_sink_path(self.tools))
        self.assertEqual(len(sink), 1)
        self.assertEqual(sink[0]["kind"], "ledger_row_corrupt")
        self.assertEqual(sink[0]["line_no"], 2)
        self.assertIn("NOT VALID JSON", sink[0]["raw_excerpt"])

    def test_corrupt_row_tolerant_mode_returns_valid_rows(self) -> None:
        """Plan 024 §H-7 acceptance (3)."""
        path = self.tools / HANDOFFS_FILENAME
        path.write_text(
            '{"session_id": "S1", "trigger": "operator"}\n'
            '{ NOT VALID JSON }\n'
            '{"session_id": "S2", "trigger": "auto"}\n',
            encoding="utf-8",
        )
        rows = list_handoffs(base_dir=self.tools, on_corruption="tolerant")
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["session_id"] for r in rows}, {"S1", "S2"})
        sink = load_jsonl(_sink_path(self.tools))
        self.assertEqual(len(sink), 1)
        self.assertEqual(sink[0]["kind"], "ledger_row_corrupt")

    def test_invalid_on_corruption_mode_rejected(self) -> None:
        """Plan 024 §H-7 acceptance (4)."""
        with self.assertRaises(GovernanceError) as ctx:
            list_handoffs(base_dir=self.tools, on_corruption="ignore-everything")
        self.assertIn("list_handoffs_invalid_on_corruption_mode", str(ctx.exception))


class FindingIndexRebuildCorruptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.findings_dir = self.repo / "aria-findings"
        self.findings_dir.mkdir()
        self.tools = ensure_tools_dir(self.repo / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_corrupt_finding_doc_emits_diagnostic_and_continues(self) -> None:
        """Finding index rebuild ignores corrupt derived docs and replays
        canonical finding-events.jsonl as the only authority."""
        from aria_kernel.finding import _events_path, _refresh_index
        from aria_kernel.ledger import append_declared_jsonl
        valid = self.findings_dir / "F-001.json"
        valid.write_text(
            '{"finding_id": "F-001", "severity": "LOW", "status": "OPEN", '
            '"claim_summary": "ok", "claim_type": "duplication", '
            '"evidence_chain_id": "chain_x", "created_at": "2026-05-09T00:00:00Z"}',
            encoding="utf-8",
        )
        append_declared_jsonl(
            _events_path(self.repo),
            {
                "event": "finding_emitted",
                "event_id": "finding:F-001:emitted",
                "finding_id": "F-001",
                "record": json.loads(valid.read_text(encoding="utf-8")),
            },
            expected_surface="repo_finding_events",
        )
        corrupt = self.findings_dir / "F-002.json"
        corrupt.write_text("{ MALFORMED JSON", encoding="utf-8")
        index = _refresh_index(self.repo)
        ids = {r["finding_id"] for r in index["findings"]}
        self.assertEqual(ids, {"F-001"})
        self.assertFalse(_sink_path(self.tools).exists())


class DiagnosticSinkFallbackTests(unittest.TestCase):
    def test_no_base_dir_falls_back_to_stderr(self) -> None:
        """Plan 024 §H-7 acceptance (6)."""
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            emit_ledger_corruption_diagnostic(
                {"kind": "ledger_row_corrupt", "ledger": "/x", "line_no": 1,
                 "error": "x", "raw_excerpt": "x"},
                base_dir=None,
            )
        self.assertIn("ledger_corruption_diagnostic_emit_fallback", err.getvalue())
        self.assertIn("no_base_dir", err.getvalue())

    def test_perm_denied_sink_falls_back_to_stderr(self) -> None:
        """Plan 024 §H-7 acceptance (7): when sink dir is not writeable,
        fall back to stderr without raising. The protective effect is
        already captured by the caller; observability degrades only."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Write a regular file at the place where the sink dir
            # should be — diagnostics.py mkdir(exist_ok=True) will
            # raise FileExistsError when the path is a file not dir.
            (base / LEDGER_CORRUPTION_SINK_DIRNAME).write_text("not-a-dir",
                encoding="utf-8")
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                emit_ledger_corruption_diagnostic(
                    {"kind": "ledger_row_corrupt", "ledger": "/x",
                     "line_no": 1, "error": "x", "raw_excerpt": "x"},
                    base_dir=base,
                )
            self.assertIn("ledger_corruption_diagnostic_emit_fallback",
                          err.getvalue())
            self.assertIn("sink_write_failed", err.getvalue())


if __name__ == "__main__":
    unittest.main()
