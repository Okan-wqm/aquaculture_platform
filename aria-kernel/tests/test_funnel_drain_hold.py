"""WP-J review — an unreadable drain ledger holds the funnel by name.

``_tonight_allowance`` called ``measure_drain_capacity`` bare, outside any
guard, while every derivation read around it is guarded ("a derivation
field never breaks the hold"). A drain-ledger read failure therefore
skipped the ENTIRE funnel routing silently: the exception escaped
``route_judgment_sample``, the phase's ``record_and_continue`` swallowed it
as one error row, and the night got neither routing nor the one
``judgment_funnel_budget_held`` governance row the hold law promises — a
full hold nobody named.

The law here: a broken drain read produces the SAME one-row hold as a dead
drain, under its own name (``drain_unreadable``), never an exception and
never a silent skip.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.judgment_funnel import route_judgment_sample
from aria_kernel.tool_registry import ensure_tools_dir


def _sample() -> dict:
    return {
        "sample_id": "S1", "cycle_id": "cyc-1",
        "items": [
            {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1",
             "rule": "rule-x", "severity": "MEDIUM"},
        ],
    }


def _policy() -> dict:
    return {"funnel_enabled": True, "funnel_nightly_envelope": 10}


def _governance_rows(base_dir: Path) -> list[dict]:
    path = base_dir / "governance.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class AnUnreadableDrainHoldsByName(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpj-drain-")
        self.base = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _corrupt_results_ledger(self) -> None:
        # The drain measurement's own input organ, corrupted the way a real
        # torn write corrupts it: a strict-reader violation that raises.
        results = self.base / "agent-invocations" / "results.jsonl"
        results.parent.mkdir(parents=True, exist_ok=True)
        results.write_text("this is not json\n", encoding="utf-8")

    def test_a_corrupt_drain_ledger_holds_every_item_by_name(self) -> None:
        self._corrupt_results_ledger()
        result = route_judgment_sample(
            sample=_sample(), base_dir=self.base,
            repo_root=None, target_sha=None, policy=_policy(),
        )
        self.assertTrue(result["active"], result)
        self.assertEqual(result["routed"], [], result)
        self.assertEqual(
            [entry["reason"] for entry in result["held"]],
            ["drain_unreadable"],
            "a broken drain read must hold under its own name, not the "
            "generic envelope exhaustion and not an exception",
        )

    def test_the_hold_is_one_named_governance_row(self) -> None:
        self._corrupt_results_ledger()
        route_judgment_sample(
            sample=_sample(), base_dir=self.base,
            repo_root=None, target_sha=None, policy=_policy(),
        )
        rows = [
            row for row in _governance_rows(self.base)
            if row.get("kind") == "judgment_funnel_budget_held"
        ]
        self.assertEqual(len(rows), 1, rows)
        details = rows[0].get("details") or {}
        self.assertEqual(details.get("reason"), "drain_unreadable")
        self.assertTrue((details.get("derivation") or {}).get("drain_unreadable"))


if __name__ == "__main__":
    unittest.main()
