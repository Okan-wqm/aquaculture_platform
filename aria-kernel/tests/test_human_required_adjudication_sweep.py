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
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.cycle import run_enterprise_cycle  # noqa: E402
from aria_kernel.human_required import record_human_required  # noqa: E402
from aria_kernel.human_required_adjudication import (  # noqa: E402
    sweep_human_required_adjudications,
)
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402

from tests._helpers.production_shaped import cycle_workspace  # noqa: E402


def _adjudication_rows(tools: Path) -> list[dict]:
    path = tools / "human-required" / "adjudications.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class AdjudicationSweepIsWired(unittest.TestCase):
    """RC-7 rewrote this class, and the reason is the point.

    Both tests here used to be BLIND, while their own docstrings claimed they
    were not. The first asserted ``hasattr(cycle, "sweep_...")`` plus symbol
    identity — an import, not a call — under a docstring promising it "fails on
    any refactor that drops it". The second asserted only that SOME dict literal
    in ``cycle.py`` carries the key, which a constant satisfies.

    Proven blind by mutation (ORPHAN-HIGH-499): replacing the call at
    ``cycle.py`` with a literal, keeping the import, left all six tests in this
    file green AND the entire kernel suite byte-identical. Zero delta.

    They now patch where ``cycle`` LOOKED THE NAME UP and run a real cycle, so
    deleting the call fails them. Same shape as the already-correct
    ``test_pr_open_perimeter_callsite.py::test_open_pr_invokes_the_pre_pr_open_gate``
    — the right pattern existed in this repo and this file simply did not use it.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-adj-wired-")
        self._fixture = cycle_workspace(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run_cycle(self) -> None:
        run_enterprise_cycle(
            workspace_root=self._fixture.workspace_root,
            cycle_id="cycle-adjudication-wired",
            base_dir=self._fixture.tools_dir,
        )

    def test_a_real_cycle_invokes_the_panel_sweep(self) -> None:
        """The property whose absence WAS the bug, asserted by invocation."""
        with patch("aria_kernel.cycle.sweep_human_required_adjudications") as sweep:
            sweep.return_value = {
                "status": "ok",
                "escalations_seen": 0,
                "opened": [],
                "folded": [],
                "resolved": [],
                "skipped": [],
            }
            self._run_cycle()

        sweep.assert_called_once()

    def test_the_sweep_receives_the_cycle_tools_dir(self) -> None:
        """Called is not enough: called against the cycle's own ledger.

        A sweep pointed at some other ``base_dir`` would run, return ok, and
        act on nothing — green, and as dead as no call at all.
        """
        with patch("aria_kernel.cycle.sweep_human_required_adjudications") as sweep:
            sweep.return_value = {
                "status": "ok",
                "escalations_seen": 0,
                "opened": [],
                "folded": [],
                "resolved": [],
                "skipped": [],
            }
            self._run_cycle()

        passed = sweep.call_args.kwargs.get("base_dir")
        self.assertIsNotNone(passed, msg="the sweep was called without a base_dir")
        self.assertEqual(Path(str(passed)).resolve(), self._fixture.tools_dir.resolve())

    def test_the_cycle_summary_reports_the_phase(self) -> None:
        """An adjudication nobody can see is a decision nobody can audit.

        RC-1 replaced this test's evidence, and the replacement is why the
        old one had to go. It scanned `cycle.py` for a dict LITERAL carrying
        the key `human_required_adjudication` — a source-text proxy for an
        operator-visible surface. The collapse made the state dict a
        PROJECTION of the phase table (`state_key` on each row), so the
        literal is gone while the surface is intact, and the test failed on a
        change that improved exactly the thing it was guarding. A proxy that
        fires on a refactor and stays quiet on a deletion is worse than no
        test.

        It now runs a cycle and reads the output. Both halves matter: the
        payload under its own key, and the outcome row that says whether the
        phase ran, skipped or failed — the second is new surface the
        pre-collapse cycle could not report at all.
        """
        state = run_enterprise_cycle(
            workspace_root=self._fixture.workspace_root,
            cycle_id="cycle-adjudication-surface",
            base_dir=self._fixture.tools_dir,
        )
        self.assertIn(
            "human_required_adjudication", state,
            msg="the cycle summary no longer reports the adjudication phase",
        )
        outcome = state.get("phases", {}).get("human_required_adjudication")
        self.assertIsNotNone(
            outcome,
            msg="the phase outcome ledger does not mention the adjudication phase",
        )
        self.assertEqual(
            outcome.get("outcome"), "ran",
            msg=f"the adjudication phase did not run on a default cycle: {outcome}",
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
