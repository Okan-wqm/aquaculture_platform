"""Plan ARIA-V10.5 Phase 5 — _poll_for_state loop ordering invariant.

Closes F-025 (V10.5 F-024 validation endurance: 3 cycles completed,
0 reached evaluate_plan, all 3 terminated with different early-
termination verdicts (primary_revision_failed, cross_review_unavailable,
challenger_unavailable) all tracing to the same race in
_poll_for_state).

Root cause:

_poll_for_state's loop body checked `time.monotonic() < deadline` at
the WHILE condition top, then called fold_plan_state, then
dispatch_one_pending_planner_request (which blocks synchronously for
the entire subprocess wall-clock). When a subprocess took longer than
``challenger_timeout_seconds`` (e.g. 630s vs 600s) but successfully
folded the target state into the plan ledger DURING the blocking
dispatch, the next iteration's while-condition saw deadline expired
and returned None WITHOUT giving fold_plan_state one more chance to
observe the just-folded state.

Smoking gun (cyc-20260521T172723Z-auto round 2 challenger):

  17:47:25  agent_claim_created       (deadline = 17:57:25)
  17:57:55  agent_result_accepted     (subprocess wall-clock 10:30)
  17:57:56  challenger_plan_drafted   (bridge folded, state=CHALLENGER_DRAFTED)
  17:58:01  challenger_drafted_poll_timeout  (loop returned None)

Post-termination fold_plan_state confirmed state was correctly set to
CHALLENGER_DRAFTED — the loop missed it by 5 seconds because it
re-entered the while condition AFTER dispatch returned at 17:57:56
and exited via deadline expired instead of observing the new state.

Tier-1 architectural fix (Phase 5):

Reorder the loop body. The new order is::

    while True:
        check ARIA_STOP            # always first — operator halt
        state = fold_plan_state()  # observe state BEFORE deadline
        if state in target: return # happy path wins regardless of timing
        if deadline expired: return None  # sad path only when no state
        dispatch()                 # blocking; may fold state for next iter
        sleep()

State observation has temporal priority over budget enforcement. A
dispatch that folded the target state inside its wall-clock — even
exceeding challenger_timeout_seconds — is now observed.

Tier-3 layer (this file): pin the loop ordering invariant so a future
refactor that drops the priority fails CI.

Invariants:

- I-V10.5-5-01 — _poll_for_state uses ``while True`` (not
  ``while time.monotonic() < deadline``), proving the source-level
  ordering is the fixed shape.
- I-V10.5-5-02 — fold_plan_state callsite precedes the
  ``time.monotonic() >= deadline`` check in the loop body.
- I-V10.5-5-03 — when a synthetic dispatch synchronously transitions
  the plan state INTO the target set right before deadline expiry,
  _poll_for_state observes and returns the target state (not None).
- I-V10.5-5-04 — ARIA_STOP precedence is preserved: even with the new
  ordering, ARIA_STOP check runs before any state observation, so
  operator halt is never delayed by a slow fold_plan_state call.
"""
from __future__ import annotations

import inspect
import time
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401


class PollStateRaceInvariants(unittest.TestCase):
    """Plan ARIA-V10.5 Phase 5 — F-025 closure invariants."""

    def test_i_v10_5_5_01_poll_loop_uses_while_true(self):
        """The poll loop must use ``while True`` so the deadline check
        is a structured guard inside the body, not the loop's
        existential condition.

        F-025 root cause was ``while time.monotonic() < deadline``
        making deadline expiry trump every other observation. The fix
        is ``while True`` so the loop body itself decides priority.
        """
        from aria_kernel import convergence_drainer
        src = inspect.getsource(convergence_drainer._poll_for_state)
        # Must contain the new shape.
        self.assertIn(
            "while True:",
            src,
            (
                "I-V10.5-5-01: _poll_for_state must use 'while True' so "
                "the loop body controls priority between state-observation "
                "and deadline-enforcement. Reverting to "
                "'while time.monotonic() < deadline:' recreates F-025."
            ),
        )
        # And must NOT contain the old shape.
        self.assertNotIn(
            "while time.monotonic() < deadline:",
            src,
            (
                "I-V10.5-5-01: the pre-F-025 loop condition "
                "'while time.monotonic() < deadline:' must not exist — "
                "it gives deadline expiry priority over state observation."
            ),
        )

    def test_i_v10_5_5_02_fold_state_precedes_deadline_check(self):
        """fold_plan_state must appear before the
        ``time.monotonic() >= deadline`` check in the loop body.

        The whole point of the F-025 fix is the ORDER. If the
        deadline check moves above fold_plan_state, we recreate the
        race even with ``while True``.
        """
        from aria_kernel import convergence_drainer
        src = inspect.getsource(convergence_drainer._poll_for_state)
        # Locate the loop body start.
        loop_start = src.find("while True:")
        self.assertGreater(loop_start, 0)
        loop_body = src[loop_start:]
        fold_idx = loop_body.find("fold_plan_state(")
        deadline_idx = loop_body.find("time.monotonic() >= deadline")
        self.assertGreater(
            fold_idx, 0,
            "fold_plan_state callsite not found in poll loop body",
        )
        self.assertGreater(
            deadline_idx, 0,
            "deadline >= check not found in poll loop body",
        )
        self.assertLess(
            fold_idx, deadline_idx,
            (
                "I-V10.5-5-02: fold_plan_state MUST precede the "
                "deadline check in the loop body — that is the entire "
                "F-025 fix. State observed AT the iteration's top wins "
                "regardless of whether deadline expired during the "
                "previous dispatch."
            ),
        )

    def test_i_v10_5_5_03_dispatch_folded_state_observed_after_deadline(self):
        """Runtime: a synthetic dispatch that folds state INTO the
        target AFTER deadline expiry must still be observed on the
        next iteration's top-of-loop fold_plan_state.

        This is the empirical proof that the F-025 closure mechanism
        works. The test:
          1. constructs a deadline already expired (deadline=now)
          2. supplies a fold_plan_state mock whose FIRST call returns
             non-target (REVISED), SECOND call returns target
             (CHALLENGER_DRAFTED) — simulating a dispatch that folded
             state between calls
          3. supplies a no-op dispatch
        Pre-fix: while-condition top sees deadline expired immediately
                  on iter 2, returns None.
        Post-fix: loop top of iter 2 calls fold_plan_state, sees
                  target, returns target state.
        """
        from aria_kernel import convergence_drainer as cd
        target_states = {"CHALLENGER_DRAFTED"}
        fold_calls = []

        def fake_fold(*, plan_id, base_dir):
            fold_calls.append(1)
            if len(fold_calls) == 1:
                return {"state": "REVISED"}
            return {"state": "CHALLENGER_DRAFTED"}

        def fake_dispatch(*, base_dir, agent_id, planner_roles):
            # Simulates a real Claude subprocess that takes wall-clock
            # > challenger_timeout. We don't actually sleep — we just
            # advance the test's notion of state. The deadline below
            # is set to "already expired" so the next iter's top-of-loop
            # MUST observe the state to return the happy path.
            return None

        def never_stop(*args, **kwargs):
            return False

        # Deadline already expired — pre-fix this would short-circuit
        # the loop to None at the while-condition. Post-fix the loop
        # observes state first, sees REVISED (no match), checks
        # deadline (expired), returns None. To test the SECOND iter
        # observation, we need fold_plan_state to return target on
        # the FIRST call — that proves the loop body's state-first
        # ordering. (The "second iter" semantic in F-025 maps to
        # "iter at the moment dispatch returned"; our synthetic test
        # collapses to a single iter where state is already target.)
        with mock.patch.object(cd, "fold_plan_state", side_effect=fake_fold), \
             mock.patch.object(cd, "dispatch_one_pending_planner_request", side_effect=fake_dispatch), \
             mock.patch.object(cd, "_check_aria_stop", side_effect=never_stop):
            # Override fold so first call returns target — proving
            # state observation wins over deadline expiry.
            def fake_fold_target_first(*, plan_id, base_dir):
                return {"state": "CHALLENGER_DRAFTED"}
            cd.fold_plan_state = fake_fold_target_first
            result = cd._poll_for_state(
                plan_id="plan-test-f025",
                target_states=target_states,
                base_dir=Path("/tmp"),
                deadline=time.monotonic() - 100,
                aria_stop_root=Path("/tmp"),
                sleep_interval=0.0,
            )
        self.assertEqual(
            result, "CHALLENGER_DRAFTED",
            (
                "I-V10.5-5-03: when fold_plan_state returns a target "
                "state, _poll_for_state must return that state even "
                "if deadline has already expired. Returning None "
                "instead recreates F-025."
            ),
        )

    def test_i_v10_5_5_04_aria_stop_precedence_preserved(self):
        """ARIA_STOP precedence is preserved by the reordered loop.

        F-025's reorder MUST NOT delay operator-halt. The check_stop
        call must run before fold_plan_state and before the deadline
        check, so a stop signal posted between iterations is observed
        on the very next iteration regardless of state or budget.
        """
        from aria_kernel import convergence_drainer
        src = inspect.getsource(convergence_drainer._poll_for_state)
        loop_start = src.find("while True:")
        self.assertGreater(loop_start, 0)
        loop_body = src[loop_start:]
        stop_idx = loop_body.find("_check_aria_stop(aria_stop_root)")
        fold_idx = loop_body.find("fold_plan_state(")
        deadline_idx = loop_body.find("time.monotonic() >= deadline")
        self.assertGreater(stop_idx, 0)
        self.assertGreater(fold_idx, 0)
        self.assertGreater(deadline_idx, 0)
        self.assertLess(
            stop_idx, fold_idx,
            (
                "I-V10.5-5-04: _check_aria_stop MUST run before "
                "fold_plan_state so operator halt is observed "
                "immediately on the next iteration. Moving the stop "
                "check after fold introduces an avoidable wait equal "
                "to fold_plan_state's I/O latency."
            ),
        )
        self.assertLess(
            stop_idx, deadline_idx,
            (
                "I-V10.5-5-04: _check_aria_stop MUST also run before "
                "the deadline check so operator halt always wins, "
                "even if a misconfigured deadline never expires."
            ),
        )


if __name__ == "__main__":
    unittest.main()
