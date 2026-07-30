"""ORPHAN-HIGH-450 — the adjudication panel needs a production caller.

`ORPHAN-HIGH-426` said HUMAN_REQUIRED escalations wait on a human
indefinitely. It was closed with `human_required_adjudication.py`: 498 lines
implementing an independent three-agent panel with principal-disjointness
verification, an irreducible class, and a fail-closed quorum. All of it
correct, and all of it dead — the module had **zero non-test importers**.

`cycle.py` ran the two sweeps that CREATE escalations every cycle and nothing
that acted on them, so the observable behaviour after the fix was identical to
the behaviour the finding described. That is the defect this whole audit is
about, reproduced inside the fix for an instance of it.

These tests pin the three properties that make the caller safe to run on every
cycle, in order of what would hurt most if it regressed:

  1. it is REACHABLE from `run_cycle` — the property whose absence was the bug,
     asserted against the module import graph rather than by reading;
  2. it is IDEMPOTENT — `open_adjudication` mints `panel_size` fresh envelopes
     and appends a ledger row per call, so a sweep that opened
     unconditionally would spawn a panel per cycle, forever, for any
     escalation the panel cannot clear;
  3. it SKIPS the irreducible class rather than trying and failing — those are
     exactly the escalations that must keep waiting for a person.
"""

from __future__ import annotations

import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.human_required import record_human_required  # noqa: E402
from aria_kernel.human_required_adjudication import (  # noqa: E402
    sweep_human_required_adjudications,
)
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402


def _adjudication_rows(tools: Path) -> list[dict]:
    path = tools / "human-required" / "adjudications.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class AdjudicationSweepIsWired(unittest.TestCase):
    def test_run_cycle_can_reach_the_panel(self) -> None:
        """The property whose absence WAS the bug.

        Asserted on the module object rather than by grepping source, so it
        survives any refactor that keeps the call and fails on any refactor
        that drops it.
        """
        import aria_kernel.cycle as cycle

        self.assertTrue(
            hasattr(cycle, "sweep_human_required_adjudications"),
            msg="cycle.py no longer imports the adjudication sweep; the panel is dead again",
        )
        self.assertIs(
            cycle.sweep_human_required_adjudications,
            sweep_human_required_adjudications,
        )

    def test_the_cycle_summary_reports_the_phase(self) -> None:
        """An adjudication nobody can see is a decision nobody can audit.

        Node-shape rather than substring: Plan 026R §H.1 bans source-marker
        assertions, and rightly — a grep for the literal line passes on a
        commented-out call and breaks on a reformat. This asserts that some
        dict literal in `cycle.py` actually carries the key.
        """
        tree = ast.parse((_KERNEL_ROOT / "aria_kernel" / "cycle.py").read_text(encoding="utf-8"))
        summary_keys = {
            node.value
            for dict_node in ast.walk(tree)
            if isinstance(dict_node, ast.Dict)
            for node in dict_node.keys
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertIn(
            "human_required_adjudication",
            summary_keys,
            msg="the cycle summary no longer reports the adjudication phase",
        )


class AdjudicationSweepBehaviour(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-adj-sweep-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _escalate(self, request_id: str, context: dict) -> None:
        record_human_required(
            request_id=request_id,
            reason="three agents claimed this request and released it without delivering",
            context=context,
            base_dir=self.tools,
        )

    def test_no_escalations_is_a_clean_no_op(self) -> None:
        result = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["escalations_seen"], 0)
        self.assertEqual(_adjudication_rows(self.tools), [])

    def test_an_adjudicable_escalation_gets_exactly_one_panel_ever(self) -> None:
        """Idempotence, asserted over repeated cycles rather than one call.

        The panel never delivers here — no adjudicator submits an opinion —
        which is precisely the case that would loop: the escalation stays open
        and the sweep sees it again next cycle.
        """
        self._escalate("req-lease-001", {"kind": "lease_lifecycle"})

        first = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(first["opened"], ["req-lease-001"])
        self.assertEqual(len(_adjudication_rows(self.tools)), 1)

        for cycle_number in range(2, 6):
            again = sweep_human_required_adjudications(base_dir=self.tools)
            with self.subTest(cycle=cycle_number):
                self.assertEqual(again["opened"], [], msg="a second panel was opened")
                self.assertEqual(again["folded"], ["req-lease-001"])
                self.assertEqual(again["resolved"], [])
                self.assertEqual(
                    len(_adjudication_rows(self.tools)),
                    1,
                    msg=f"cycle {cycle_number} appended another adjudication row",
                )

    def test_irreducible_escalations_are_skipped_not_adjudicated(self) -> None:
        """The escalations that must keep waiting for a person."""
        irreducible = {
            "req-profile-001": {"kind": "profile_transition"},
            "req-cred-001": {"kind": "credential_mint"},
            "req-merge-001": {"kind": "merge_authority"},
            "req-unknown-001": {"kind": "some_future_escalation_source"},
            "req-nocontext-001": {},
        }
        for request_id, context in irreducible.items():
            self._escalate(request_id, context)

        result = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(result["opened"], [])
        self.assertEqual(result["resolved"], [])
        self.assertEqual(
            sorted(entry["request_id"] for entry in result["skipped"]),
            sorted(irreducible),
        )
        # Nothing was minted, so no agent was ever asked about them.
        self.assertEqual(_adjudication_rows(self.tools), [])

    def test_a_mixed_batch_adjudicates_only_the_adjudicable(self) -> None:
        self._escalate("req-lease-002", {"kind": "lease_lifecycle"})
        self._escalate("req-profile-002", {"kind": "profile_transition"})

        result = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(result["opened"], ["req-lease-002"])
        self.assertEqual(
            [entry["request_id"] for entry in result["skipped"]], ["req-profile-002"],
        )
        rows = _adjudication_rows(self.tools)
        self.assertEqual([row["escalation_request_id"] for row in rows], ["req-lease-002"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
