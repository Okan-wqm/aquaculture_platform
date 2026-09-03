"""Plan 025 §A.2 — shared governance.jsonl reader tests.

Pins the contract of the single shared helper that replaces 4
governance.jsonl callsites (handoff_ledger._last_validation +
architecture_spine_gate._latest_baseline_for_plan +
_consecutive_regression_count + list_spine_events). Mirrors
Plan 024 §H-7 list_handoffs strict-default + diagnostic-sink
contract.

Cases (9):
1. clean strict — 3 valid rows, no diagnostic emitted.
2. corrupt strict — raises GovernanceError, diagnostic emitted.
3. corrupt tolerant — yields valid rows + diagnostic emitted.
4. invalid mode — raises at function entry, no iteration.
5. reverse iteration — preserves original line numbers.
6. nonexistent path — empty iterator, no exception.
7. blank lines — skipped without counter increments.
8. AST invariant — no governance.jsonl reader has private
   ``except json.JSONDecodeError`` (only the helper does).
9. emit failure — helper does not swallow the diagnostic
   sink's exceptions (sink owns its own stderr fallback).
"""
from __future__ import annotations

import ast
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import governance_reader
from aria_kernel.governance_reader import read_governance_rows
from aria_kernel.tool_registry import GovernanceError


SINK_REL = Path("diagnostics") / "ledger-corruption.jsonl"


def _seed_governance(rows: list[str]) -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-govread-"))
    base = tmp / "aria-tools"
    base.mkdir()
    gov = base / "governance.jsonl"
    gov.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
    return base, gov


class CleanStrictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            json.dumps({"kind": "row_b", "n": 2}),
            json.dumps({"kind": "row_c", "n": 3}),
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_clean_strict_passes(self) -> None:
        rows = list(read_governance_rows(self.gov, base_dir=self.base))
        self.assertEqual(len(rows), 3)
        self.assertEqual([r["kind"] for r in rows], ["row_a", "row_b", "row_c"])
        # No diagnostic emitted on a clean ledger.
        sink = self.base / SINK_REL
        self.assertFalse(sink.exists())


class CorruptStrictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            "this-is-not-json",
            json.dumps({"kind": "row_c", "n": 3}),
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_corrupt_strict_raises_and_emits_diagnostic(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            list(read_governance_rows(self.gov, base_dir=self.base))
        self.assertIn("governance_row_corrupt_strict_mode", str(ctx.exception))
        sink = self.base / SINK_REL
        self.assertTrue(sink.exists())
        sink_rows = [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(sink_rows), 1)
        self.assertEqual(sink_rows[0]["kind"], "ledger_row_corrupt")
        self.assertEqual(sink_rows[0]["line_no"], 2)
        self.assertEqual(sink_rows[0]["raw_excerpt"], "this-is-not-json")


class CorruptTolerantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            "this-is-not-json",
            json.dumps({"kind": "row_c", "n": 3}),
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_tolerant_skips_and_emits_diagnostic(self) -> None:
        rows = list(read_governance_rows(
            self.gov, on_corruption="tolerant", base_dir=self.base,
        ))
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["kind"] for r in rows], ["row_a", "row_c"])
        sink = self.base / SINK_REL
        self.assertTrue(sink.exists())
        sink_rows = [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(sink_rows), 1)
        self.assertEqual(sink_rows[0]["kind"], "ledger_row_corrupt")
        self.assertEqual(sink_rows[0]["line_no"], 2)


class InvalidModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_invalid_mode_raises_at_entry(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            # Function entry must raise BEFORE any rows are iterated.
            # Wrap in list() to force generator startup.
            list(read_governance_rows(
                self.gov, on_corruption="lenient", base_dir=self.base,
            ))
        self.assertIn("invalid_on_corruption_mode", str(ctx.exception))


class ReverseIterationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            json.dumps({"kind": "row_b", "n": 2}),
            json.dumps({"kind": "row_c", "n": 3}),
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_reverse_iteration_preserves_line_numbers(self) -> None:
        # Forward order: row_a, row_b, row_c. Reverse: row_c, row_b, row_a.
        rows = list(read_governance_rows(
            self.gov, reverse=True, base_dir=self.base,
        ))
        self.assertEqual([r["kind"] for r in rows], ["row_c", "row_b", "row_a"])

        # Now seed a corrupt row at forward line 2 and verify the
        # diagnostic line_no is the FORWARD line number, not the
        # reverse-iteration position.
        shutil.rmtree(self.base.parent, ignore_errors=True)
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            "corrupt-row-here",
            json.dumps({"kind": "row_c", "n": 3}),
        ])
        rows = list(read_governance_rows(
            self.gov,
            on_corruption="tolerant",
            reverse=True,
            base_dir=self.base,
        ))
        self.assertEqual([r["kind"] for r in rows], ["row_c", "row_a"])
        sink = self.base / SINK_REL
        sink_rows = [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(sink_rows), 1)
        # Original forward line number, NOT reverse position.
        self.assertEqual(sink_rows[0]["line_no"], 2)


class NonexistentPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="aria-govread-empty-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.base, ignore_errors=True)

    def test_nonexistent_path_returns_empty_iterator(self) -> None:
        missing = self.base / "does-not-exist.jsonl"
        rows = list(read_governance_rows(missing, base_dir=self.base))
        self.assertEqual(rows, [])
        # No diagnostic written — the path simply does not exist.
        sink = self.base / SINK_REL
        self.assertFalse(sink.exists())


class BlankLinesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            "",
            json.dumps({"kind": "row_a", "n": 1}),
            "",
            "",
            json.dumps({"kind": "row_b", "n": 2}),
            "",
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_blank_lines_skipped_silently(self) -> None:
        rows = list(read_governance_rows(self.gov, base_dir=self.base))
        self.assertEqual([r["kind"] for r in rows], ["row_a", "row_b"])
        sink = self.base / SINK_REL
        self.assertFalse(sink.exists())


class AstInvariantTests(unittest.TestCase):
    """Catch future regressions where someone copies the silent-skip
    pattern back into a governance.jsonl reader."""

    SOURCE_FILES = (
        Path(__file__).parent.parent / "aria_kernel" / "handoff_ledger.py",
        Path(__file__).parent.parent / "aria_kernel" / "architecture_spine_gate.py",
    )

    def _function_has_governance_decode_handler(
        self, node: ast.FunctionDef
    ) -> bool:
        """True iff this function body contains BOTH a governance.jsonl
        constant string AND an ``except json.JSONDecodeError`` handler."""
        dump = ast.dump(node)
        if "'governance.jsonl'" not in dump and '"governance.jsonl"' not in dump:
            return False
        for sub in ast.walk(node):
            if isinstance(sub, ast.ExceptHandler) and sub.type is not None:
                if "JSONDecodeError" in ast.dump(sub.type):
                    return True
        return False

    def test_no_governance_callsite_has_private_decode_handler(self) -> None:
        offenders: list[str] = []
        for path in self.SOURCE_FILES:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if self._function_has_governance_decode_handler(node):
                        offenders.append(f"{path.name}::{node.name}")
        self.assertEqual(
            offenders,
            [],
            "governance.jsonl reader must use shared "
            "read_governance_rows helper; private "
            "JSONDecodeError handler is BANNED",
        )


class EmitFailureNotSwallowedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base, self.gov = _seed_governance([
            json.dumps({"kind": "row_a", "n": 1}),
            "this-is-not-json",
        ])

    def tearDown(self) -> None:
        shutil.rmtree(self.base.parent, ignore_errors=True)

    def test_helper_does_not_swallow_diagnostic_emit_failures(self) -> None:
        boom = IOError("simulated sink write failure")
        with mock.patch.object(
            governance_reader,
            "emit_ledger_corruption_diagnostic",
            side_effect=boom,
        ):
            with self.assertRaises(IOError) as ctx:
                # tolerant mode: would normally just skip + continue,
                # but if the sink emit raises the helper must propagate
                # NOT swallow.
                list(read_governance_rows(
                    self.gov, on_corruption="tolerant", base_dir=self.base,
                ))
            self.assertIn("simulated sink write failure", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
