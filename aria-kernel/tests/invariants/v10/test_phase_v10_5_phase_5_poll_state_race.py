"""Plan ARIA-V10.5 Phase 5 → CL-1 (ORPHAN-CRITICAL-725) — F-025's race
class is now STRUCTURALLY impossible, and these invariants say so.

The original defect (kept here because the history is the evidence):
``_poll_for_state`` enforced its deadline at the WHILE condition, so a
dispatch whose subprocess folded the target state INTO the ledger during
its own wall-clock (e.g. 630s against a 600s budget) was discarded five
seconds later by an expired deadline. Three endurance cycles died that
way with three different verdicts and one shared root.

Phase 5 fixed the ORDER inside the loop. CL-1 removed the loop: the
cycle lane no longer waits for anything, because the envelopes it mints
are delivered by a LATER executor run. Each cycle folds the plan state
ONCE, advances one derived step, and returns. A deadline can no longer
beat a state observation because there is no deadline in the observation
path at all.

Successor invariants (a refactor that reintroduces waiting fails here):

- I-V10.5-5-01 — the drainer exposes no polling primitive.
- I-V10.5-5-02 — no wall-clock budget arithmetic gates state
  observation anywhere in the module (no monotonic-vs-deadline compare).
- I-V10.5-5-03 — the step observes state via fold_plan_state and returns
  without sleeping, even when the caller passes a long timeout.
- I-V10.5-5-04 — ARIA_STOP precedence is preserved: the stop check runs
  before any state-derived action in the step.
"""
from __future__ import annotations

import inspect
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401


class PollStateRaceInvariants(unittest.TestCase):
    """CL-1 successors to the F-025 closure invariants."""

    def test_i_v10_5_5_01_no_polling_primitive_exists(self):
        from aria_kernel import convergence_drainer

        self.assertFalse(
            hasattr(convergence_drainer, "_poll_for_state"),
            "I-V10.5-5-01: a polling primitive in the cycle lane can only "
            "wait for work the executor lane delivers in a later run — the "
            "structural loss F-025 was one symptom of.",
        )

    def test_i_v10_5_5_02_no_deadline_arithmetic_gates_observation(self):
        from aria_kernel import convergence_drainer

        src = inspect.getsource(convergence_drainer)
        self.assertNotIn("time.sleep", src)
        self.assertIsNone(
            re.search(r"time\.monotonic\(\)\s*[<>]=?\s*deadline", src),
            "I-V10.5-5-02: state observation must never be gated by a "
            "wall-clock budget comparison; that ordering IS F-025.",
        )

    def test_i_v10_5_5_03_step_observes_state_and_returns_without_waiting(self):
        from aria_kernel import convergence_drainer as cd

        observed: list[str] = []
        real_fold = cd.fold_plan_state

        def counting_fold(*, plan_id, base_dir):
            observed.append(plan_id)
            return real_fold(plan_id=plan_id, base_dir=base_dir)

        # WALL-CLOCK is the honest instrument here. A blanket time.sleep
        # patch cannot distinguish the step waiting (the defect) from the
        # OS waiting on a git subprocess for target_sha (unavoidable and
        # bounded) — it caught the latter and lied. Source-level "no
        # sleeps in the module" is pinned by I-V10.5-5-02; this pin asks
        # the question that one cannot: does a 3600s budget translate
        # into a long run?
        started = time.monotonic()

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            workspace = Path(tmp) / "workspace"
            (workspace / ".claude" / "agents").mkdir(parents=True)
            with mock.patch.object(cd, "fold_plan_state", counting_fold):
                result = cd.run_convergence_drainer(
                    cycle_id="cyc-i-v10-5-5-03",
                    base_dir=tools,
                    workspace_root=workspace,
                    plan_id="plan-i-v10-5-5-03",
                    plan_seed={
                        "schema_version": 1,
                        "title": "T",
                        "summary": "S",
                        "affected_surfaces": [
                            {"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]},
                        ],
                        "key_changes": ["x"],
                        "validation_commands": [
                            {"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"},
                        ],
                        "evidence_refs": ["docs/aria/SPEC.md"],
                    },
                    must_satisfy=[{
                        "id": "MS-1", "kind": "obligation",
                        "description": "d", "source": "t",
                    }],
                    evidence_refs=["docs/aria/SPEC.md"],
                    allowed_scope=["aria-kernel/**"],
                    # A long timeout must not translate into a long run.
                    challenger_timeout_seconds=3600.0,
                )
        elapsed = time.monotonic() - started
        self.assertTrue(observed, "the step never observed plan state")
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        self.assertLess(
            elapsed, 30.0,
            "I-V10.5-5-03: a 3600s challenger budget must not translate "
            f"into a long run — the step took {elapsed:.1f}s, which means "
            "something is waiting for work the executor lane delivers.",
        )

    def test_i_v10_5_5_04_aria_stop_precedence_preserved(self):
        from aria_kernel import convergence_drainer

        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        stop_idx = src.find("_check_aria_stop(root)")
        dispatch_idx = src.find("if plan_state in TERMINAL_STATES")
        self.assertGreater(stop_idx, 0, "ARIA_STOP check missing from the step")
        self.assertGreater(dispatch_idx, 0, "step dispatch not found")
        self.assertLess(
            stop_idx, dispatch_idx,
            "I-V10.5-5-04: operator halt must be observed before the step "
            "takes any state-derived action.",
        )


if __name__ == "__main__":
    unittest.main()
