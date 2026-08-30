"""E25-a (ORPHAN-710) — the rhythm gate: finish before discovering more.

Operator directive: ARIA must not mint itself more work than it finishes —
unfinished work continues BEFORE new discovery. The gate is a cycle
precondition over the SAME open-backlog counter the emptiness guard reads,
attached to the two work-minting phases; an unmet precondition is a
recorded skip naming ``backlog_below_cap`` (X3's sıfır-vs-yok discipline),
never a silent absence.

Deliberate-breakage pins:
- the closed precondition set admits the gate + its writes-composite;
- watchdog_sweep and experiment_author are gated; experiment_night
  (running EXISTING work) and discovery (comprehension) are NOT;
- under the cap behavior is bit-identical to pre-E25; at the cap the
  gated phases refuse;
- the counter counts IN_PROGRESS as backlog;
- the policy block is mergeable configuration.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cycle import (
    BACKLOG_BELOW_CAP,
    CYCLE_PHASES,
    CYCLE_PRECONDITIONS,
    WRITES_PERMITTED,
    WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP,
    build_phase_context,
)
from aria_kernel.cycle_guard import _open_finding_count
from aria_kernel.genesis_policy import POLICY_KEYS, RHYTHM_DEFAULTS, rhythm_policy
from aria_kernel.tool_registry import ensure_tools_dir


def _phase(name: str):
    for phase in CYCLE_PHASES:
        if phase.name == name:
            return phase
    raise AssertionError(f"phase {name!r} missing")


def _write_index(repo_root: Path, statuses: list[str]) -> None:
    index = repo_root / "aria-findings" / "_index.json"
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(
        json.dumps({"findings": [{"finding_id": f"F-{i}", "status": s} for i, s in enumerate(statuses)]}),
        encoding="utf-8",
    )


class ClosedSetPins(unittest.TestCase):
    def test_gate_and_composite_are_admitted_members(self) -> None:
        self.assertIn(BACKLOG_BELOW_CAP, CYCLE_PRECONDITIONS)
        self.assertIn(WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP, CYCLE_PRECONDITIONS)
        self.assertEqual(BACKLOG_BELOW_CAP.name, "backlog_below_cap")
        self.assertEqual(
            WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP.name,
            "writes_permitted+backlog_below_cap",
        )

    def test_the_two_minting_phases_are_gated_and_two_neighbors_are_not(self) -> None:
        self.assertIs(_phase("watchdog_sweep").precondition, BACKLOG_BELOW_CAP)
        self.assertIs(
            _phase("experiment_author").precondition,
            WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP,
        )
        # Running EXISTING bench work is resume-work, not new-work.
        self.assertIs(_phase("experiment_night").precondition, WRITES_PERMITTED)
        # Comprehension is never paused: the rest of the cycle propagates
        # on discovery's payload, and pausing understanding is not what
        # the rhythm rule means (plan deviation, disclosed).
        self.assertEqual(_phase("discovery").precondition.name, "always")


class GateBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-e25-")
        self.repo = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.repo / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _context(self):
        return build_phase_context(
            cycle_id="cyc-e25-test",
            workspace_root=self.repo,
            base_dir=self.tools,
        )

    def test_under_the_cap_the_gate_is_open(self) -> None:
        _write_index(self.repo, ["OPEN"] * 3)
        self.assertTrue(BACKLOG_BELOW_CAP.satisfied_by(self._context()))

    def test_at_the_cap_the_gate_refuses(self) -> None:
        cap = int(RHYTHM_DEFAULTS["backlog_cap"])
        _write_index(self.repo, ["OPEN"] * cap)
        self.assertFalse(BACKLOG_BELOW_CAP.satisfied_by(self._context()))

    def test_in_progress_counts_as_backlog(self) -> None:
        _write_index(self.repo, ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"])
        self.assertEqual(_open_finding_count(self.repo), 2)

    def test_missing_index_means_empty_backlog(self) -> None:
        self.assertTrue(BACKLOG_BELOW_CAP.satisfied_by(self._context()))

    def test_composite_demands_both(self) -> None:
        _write_index(self.repo, ["OPEN"])
        context = self._context()
        self.assertTrue(WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP.satisfied_by(context))
        shadow = build_phase_context(
            cycle_id="cyc-e25-test", workspace_root=self.repo,
            base_dir=self.tools, shadow_only=True,
        )
        self.assertFalse(WRITES_PERMITTED_AND_BACKLOG_BELOW_CAP.satisfied_by(shadow))


class RhythmPolicyTests(unittest.TestCase):
    def test_defaults_and_mergeability(self) -> None:
        self.assertIn("rhythm", POLICY_KEYS)
        self.assertEqual(rhythm_policy()["backlog_cap"], 25)


if __name__ == "__main__":
    unittest.main()
