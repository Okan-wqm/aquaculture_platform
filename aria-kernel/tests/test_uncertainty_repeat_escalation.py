"""A repeated advisory is not advice, it is an unread alarm.

`memory/uncertainties.jsonl` held nine identical
`pressure_candidate_tools_unreachable` rows while the failure they described
re-scheduled unrunnable work every cycle — zero escalation, because nothing
read the ledger back. Same class as the claim reaper and the registry
compiler: the mechanism (recording) existed, the consumer did not.

These pin the reader: the same (kind, subject) at the threshold or beyond
becomes an operator-facing pressure; below it, silence; distinct subjects
count separately; and the escalation self-extinguishes through ordinary
decay because it is a normal pressure.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.pressure import (
    SOURCE_WEIGHTS,
    UNCERTAINTY_REPEAT_THRESHOLD,
    _uncertainty_repeat_pressures,
    append_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _write_rows(root: Path, rows: list[dict[str, object]]) -> None:
    # Through the module's own declared-surface writer: the ledger layer
    # refuses hand-written files (unknown surface / missing hash chain), and
    # the reader under test goes through the same layer.
    (root / "memory").mkdir(parents=True, exist_ok=True)
    for row in rows:
        append_jsonl(root / "memory" / "uncertainties.jsonl", dict(row))


def _row(kind: str, pressure_id: str | None = None) -> dict[str, object]:
    row: dict[str, object] = {"schema_version": 1, "kind": kind, "recorded_at": "2026-08-10T00:00:00Z"}
    if pressure_id:
        row["pressure_id"] = pressure_id
    return row


class UncertaintyRepeatEscalationTest(unittest.TestCase):
    def _escalations(self, rows: list[dict[str, object]]) -> list[dict[str, object]]:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _write_rows(root, rows)
            return _uncertainty_repeat_pressures(
                root, weights=dict(SOURCE_WEIGHTS), cycle_id="cyc-t",
            )

    def test_the_live_shape_escalates(self) -> None:
        # Nine identical rows — the exact production state that produced
        # zero escalation.
        rows = [_row("pressure_candidate_tools_unreachable", "pressure:x:rep")] * 9

        out = self._escalations(rows)

        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "REPETITION")
        self.assertIn("pressure_candidate_tools_unreachable", str(out[0]["reason"]))
        self.assertEqual(out[0]["candidate_tools"], [])

    def test_below_the_threshold_stays_silent(self) -> None:
        rows = [_row("some_kind", "p1")] * (UNCERTAINTY_REPEAT_THRESHOLD - 1)

        self.assertEqual(self._escalations(rows), [])

    def test_distinct_subjects_count_separately(self) -> None:
        rows = (
            [_row("k", "subject-a")] * UNCERTAINTY_REPEAT_THRESHOLD
            + [_row("k", "subject-b")] * (UNCERTAINTY_REPEAT_THRESHOLD - 1)
        )

        out = self._escalations(rows)

        self.assertEqual(len(out), 1)
        self.assertIn("subject-a", str(out[0]["reason"]))

    def test_a_subjectless_kind_groups_by_kind_alone(self) -> None:
        # Erring toward escalation: a row with no identifying field must not
        # vanish from the count.
        rows = [_row("bare_kind")] * UNCERTAINTY_REPEAT_THRESHOLD

        out = self._escalations(rows)

        self.assertEqual(len(out), 1)

    def test_an_empty_or_missing_ledger_is_silence_not_an_error(self) -> None:
        self.assertEqual(self._escalations([]), [])

    def test_run_pressure_actually_calls_the_reader(self) -> None:
        # The producer being called is the entire point — a reader nobody
        # invokes is the defect this module documents, one level down.
        import ast
        import inspect
        import textwrap

        from aria_kernel import pressure as pressure_mod

        tree = ast.parse(textwrap.dedent(inspect.getsource(pressure_mod.run_pressure)))
        called = any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_uncertainty_repeat_pressures"
            for node in ast.walk(tree)
        )
        self.assertTrue(called, "run_pressure must invoke the uncertainty reader")


if __name__ == "__main__":
    unittest.main()
