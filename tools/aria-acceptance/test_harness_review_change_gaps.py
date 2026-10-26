#!/usr/bin/env python3
"""WP-D4 conformance gap R12 — the room report must not lose its cost block on a failed round.

The audit (build/D4/conformance.md, probes P3 and P3b) found `review_change`
copying `change.get("cost_budget")` into `report["cost_budget"]` on every round
that returned, so a LATER round that failed (status other than completed) wrote
`None` over the spend an earlier round had reported, and a first cycle that
exited non-zero left no `cost_budget` key at all. A failed run is still a
change_review run, and what it spent is what the block is for.

The contract pinned here, with the kernel's own derivation untouched:

  * a block a round really reported stays in the report when a later round
    fails, whether the cycle returned a failed status or exited non-zero;
  * a run that never had a block says why, in the same place: `cost_budget` is
    present and neither `None` nor a block that looks real. It carries no
    `daily_usd` / `monthly_usd`, because an attribution that could not be read
    must not invent a spend of zero.

Red at the audited HEAD on assertions: the failed-status shapes (a block lost,
`None`) and the shapes with no block (key missing, or `None`). The shape where a
later cycle exits non-zero after a good round already holds at HEAD (the loop
breaks before it assigns), so it is a subtest of the first test that stays
green and fails if a fix regresses it.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest import mock

_HARNESS = Path(__file__).with_name("harness.py")
BLOCK = {"monetary_admission": "metered", "daily_usd": 3.2, "monthly_usd": 3.2,
         "caps": {"daily": 5.0, "monthly": 100.0, "per_run": 0.5}}
EXITS_NON_ZERO = ("exit", 1, "boom")
FAILED_STATUS = {"status": "failed", "failed_phases": ["change_intelligence"]}


def _completed_with_block() -> dict[str, Any]:
    return {"status": "completed", "change_intelligence": {
        "subject_ref": "change:a..b", "change_intelligence_requests_minted": 1,
        "subject_open_requests": ["REQ-1"], "cost_budget": BLOCK}}


def _load_harness() -> Any:
    spec = importlib.util.spec_from_file_location("aria_acceptance_harness_gaps_under_test", _HARNESS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _review(script: list[Any]) -> dict[str, Any]:
    """Run `review_change` with the cycle's answers scripted, one per cycle; the drain always succeeds.

    An answer is the cycle's JSON state (exit 0) or ``("exit", code, stderr)``.
    """
    harness = _load_harness()
    answers = iter(script)

    def fake_run(argv: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if "--drain" in argv:
            return subprocess.CompletedProcess(argv, 0, "", "")
        answer = next(answers)
        if isinstance(answer, tuple):
            return subprocess.CompletedProcess(argv, answer[1], "", answer[2])
        return subprocess.CompletedProcess(argv, 0, json.dumps(answer), "")

    with tempfile.TemporaryDirectory(prefix="aria-room-cost-gaps-") as tmp:
        root = Path(tmp)
        with mock.patch.object(harness.subprocess, "run", side_effect=fake_run):
            return harness.review_change(
                change_base="a" * 40, change_head="b" * 40, store=root / "store",
                workspace_root=root / "tree", rounds=2,
            )


class RoomReportCostOnAFailedRoundTests(unittest.TestCase):
    def test_a_failed_last_round_keeps_the_last_real_cost_block(self) -> None:
        for name, failure in (("the cycle returns a failed status", FAILED_STATUS),
                              ("the cycle exits non-zero", EXITS_NON_ZERO)):
            with self.subTest(failure=name):
                report = _review([_completed_with_block(), failure])

                self.assertFalse(report["settled"], "a run whose last round failed is not settled")
                self.assertEqual(report.get("cost_budget"), BLOCK,
                                 "the spend the first round reported was lost when the last round failed")

    def test_a_run_that_never_had_a_block_names_why_instead_of_reporting_none(self) -> None:
        for name, failure in (("the first cycle returns a failed status", FAILED_STATUS),
                              ("the first cycle exits non-zero", EXITS_NON_ZERO)):
            with self.subTest(failure=name):
                report = _review([failure])

                self.assertIn("cost_budget", report, "the report is silent about the cost of a failed run")
                value = report["cost_budget"]
                self.assertIsNotNone(value, "cost_budget is None: nothing says why the attribution is missing")
                if isinstance(value, Mapping):
                    self.assertTrue(any(value.values()), "an empty block names nothing")
                    self.assertFalse({"daily_usd", "monthly_usd"} & set(value),
                                     "an attribution that could not be read must not carry a spend")
                else:
                    self.assertIsInstance(value, str)
                    self.assertTrue(value.strip(), "an empty string names nothing")


if __name__ == "__main__":
    unittest.main()
