"""A counter that reads zero for months is not "no data", it is a question.

`judged_judges` and `labelled_tool_count` sat at zero while three separate
defects starved their producer chains — a wedged claim queue, a hash binding
that compared two different objects, an empty tool registry — and every one
was found by a human noticing the zero. The zero itself never said anything,
because "no data yet" and "the feed is severed" render identically.

This watch makes the machine notice: a watched signal that is zero across a
FULL window of completed cycles is reported as starved, with the producer
chain a reader would walk. Fewer cycles than the window is insufficient
history, not an alarm — a brand-new store must not open with three
starvation flags.
"""
from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import patch

from aria_kernel import reflection as reflection_mod
from aria_kernel.reflection import (
    SIGNAL_WINDOW_CYCLES,
    _compute_dataflow_health,
    _render_dataflow_health_section,
)


def _cycle_row(judged: int = 0, labelled: int = 0, synced: int = 0) -> dict[str, Any]:
    return {
        "status": "completed",
        "judge_calibration": {"judged_judges": judged},
        "goldset_proposal": {"labelled_tool_count": labelled},
        "tool_manifest_sync": {"synced_tool_ids": ["t"] * synced},
    }


def _health(rows: list[dict[str, Any]]) -> dict[str, Any]:
    with patch("aria_kernel.ledger.load_declared_jsonl", return_value=rows):
        from pathlib import Path

        return _compute_dataflow_health(Path("/nonexistent-tools-root"))


class SignalStarvationTest(unittest.TestCase):
    def test_a_full_window_of_zeros_is_starved(self) -> None:
        health = _health([_cycle_row()] * SIGNAL_WINDOW_CYCLES)

        self.assertIn("judged_judges", health["starved"])
        self.assertIn("labelled_tool_count", health["starved"])

    def test_insufficient_history_is_not_an_alarm(self) -> None:
        health = _health([_cycle_row()] * (SIGNAL_WINDOW_CYCLES - 1))

        self.assertEqual(health["starved"], [])

    def test_a_single_nonzero_clears_the_signal(self) -> None:
        rows = [_cycle_row()] * (SIGNAL_WINDOW_CYCLES - 1) + [_cycle_row(judged=2)]

        health = _health(rows)

        self.assertNotIn("judged_judges", health["starved"])
        self.assertIn("labelled_tool_count", health["starved"])

    def test_incomplete_cycles_do_not_count_toward_the_window(self) -> None:
        rows = [{**_cycle_row(), "status": "failed"}] * 10 + [_cycle_row()] * 2

        health = _health(rows)

        self.assertEqual(health["window_cycles"], 2)
        self.assertEqual(health["starved"], [])

    def test_the_report_names_the_producer_chain(self) -> None:
        section = _render_dataflow_health_section({
            "dataflow_health": _health([_cycle_row()] * SIGNAL_WINDOW_CYCLES),
        })
        rendered = "\n".join(section)

        self.assertIn("SIGNAL STARVED", rendered)
        self.assertIn("judge fan-out", rendered)

    def test_silence_when_nothing_is_starved(self) -> None:
        # An empty heading every day teaches the reader to skip the heading.
        self.assertEqual(
            _render_dataflow_health_section({"dataflow_health": {"starved": []}}), [],
        )
        self.assertEqual(_render_dataflow_health_section({}), [])

    def test_the_report_writer_actually_calls_the_renderer(self) -> None:
        import inspect

        assembly = inspect.getsource(reflection_mod._write_daily_report)

        self.assertIn("_render_dataflow_health_section", assembly)

    def test_reflection_carries_the_section(self) -> None:
        import ast
        import inspect
        import textwrap

        tree = ast.parse(textwrap.dedent(inspect.getsource(reflection_mod.run_reflection)))
        keys = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertIn("dataflow_health", keys)


if __name__ == "__main__":
    unittest.main()
