"""Plan ARIA-V10.5 Phase 4 — convergence_drainer ↔ plan_convergence
max_rounds single source of truth.

Closes F-024 (V10.5 endurance cycle 1: 3 P+C+CR rounds + 2 revisions
fired clean, but the kernel ledger had zero plan_evaluated events and
plan stayed in CROSS_REVIEWED state. Root cause: convergence_drainer's
``run_convergence_drainer`` bounded its loop with ``max_rounds`` (the
operator-imposed cap) while ``plan_convergence.evaluate_plan`` used its
own ``MAX_CROSS_REVIEW_ROUNDS=5`` default — the two caps drifted, the
kernel always thought there were more rounds available, and the
drainer's terminal round returned NEXT_ROUND_REQUIRED with
``event_appended=False``. Drainer fell through to the line-926
fallthrough verdict ``max_rounds`` without firing a plan_evaluated
event in the kernel ledger — verdict_provenance, terminal-state
derivation, and implementation_requested never emitted).

Tier-1 architectural fix (Phase 4):

``convergence_drainer.run_convergence_drainer`` now passes its own
``max_rounds`` into ``evaluate_plan(max_rounds=max_rounds)``. The
kernel becomes aware of the drainer's loop bound — when round_n ==
max_rounds AND blockers exist, ``_evaluate_cross_review_state``
correctly returns ``terminal_state=HUMAN_REQUIRED`` with reason
``max_rounds_reached``, the ``plan_evaluated`` event fires, and the
drainer's in-loop terminal-state branch derives the arbiter verdict +
emits verdict_provenance.

Tier-3 layer (this file): make the parameter forwarding DETECTABLE so
a future refactor that drops the keyword fails CI before reaching
production.

Invariants:

- I-V10.5-4-01 — convergence_drainer evaluate_plan call includes
  ``max_rounds=max_rounds`` kwarg.
- I-V10.5-4-02 — kernel ``_evaluate_cross_review_state`` returns
  HUMAN_REQUIRED with reason ``max_rounds_reached`` when round_number
  == max_rounds AND blockers exist.
- I-V10.5-4-03 — kernel returns NEXT_ROUND_REQUIRED (no max_rounds
  reason) when round_number < max_rounds with the same blockers, so
  the fix does NOT collapse non-terminal rounds into HUMAN_REQUIRED.
- I-V10.5-4-04 — ``plan_convergence.evaluate_plan`` exposes a
  keyword-only ``max_rounds`` parameter (the drainer's forwarding
  target).
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401


class DrainerKernelMaxRoundsSsotInvariants(unittest.TestCase):
    """Plan ARIA-V10.5 Phase 4 — F-024 closure invariants."""

    def test_i_v10_5_4_01_drainer_forwards_max_rounds(self):
        """convergence_drainer.run_convergence_drainer must pass its
        max_rounds into the kernel evaluate_plan call.

        F-024 root cause was the drainer calling evaluate_plan WITHOUT
        the max_rounds kwarg, so the kernel used its own default
        MAX_CROSS_REVIEW_ROUNDS=5 and never observed the drainer's
        actual cap. The structural fix forwards the drainer's value
        so kernel + drainer share a single 'last round' boundary.
        """
        from aria_kernel import convergence_drainer
        src = inspect.getsource(convergence_drainer)
        # The fix landed as: evaluate_plan(plan_id=..., round_number=...,
        # base_dir=base_dir, max_rounds=max_rounds)
        self.assertIn(
            "max_rounds=max_rounds,",
            src,
            (
                "I-V10.5-4-01: convergence_drainer must forward its "
                "max_rounds into plan_convergence.evaluate_plan. "
                "Missing the kwarg recreates F-024 — kernel uses its "
                "MAX_CROSS_REVIEW_ROUNDS=5 default while drainer caps "
                "earlier, kernel returns NEXT_ROUND_REQUIRED at the "
                "drainer's terminal round, drainer falls through to "
                "the line-926 verdict path with zero plan_evaluated "
                "events emitted."
            ),
        )
        # Ensure the kwarg lives near the evaluate_plan callsite, not
        # somewhere unrelated. Anchor: the evaluate_plan call must
        # contain max_rounds=max_rounds within its argument list.
        idx = src.find("eval_result = evaluate_plan(")
        self.assertGreater(
            idx, 0,
            "evaluate_plan callsite missing from convergence_drainer",
        )
        # The closing paren of the call is at most ~600 chars away
        # (room for the kwargs + the V10.5 Phase 4 explanatory
        # comment). Search that window for the kwarg.
        window = src[idx: idx + 800]
        self.assertIn(
            "max_rounds=max_rounds",
            window,
            (
                "I-V10.5-4-01: max_rounds kwarg must be on the "
                "evaluate_plan call in the drainer's main round loop, "
                "not a different callsite."
            ),
        )

    def test_i_v10_5_4_02_kernel_emits_human_required_at_max_rounds(self):
        """Pure-state assertion: when round_number == max_rounds AND
        blockers exist, the kernel returns HUMAN_REQUIRED with
        reason ``max_rounds_reached``.

        This is the empirical proof that forwarding max_rounds is the
        actual mechanism behind the F-024 closure. Pre-fix the kernel
        observed max_rounds=5 while drainer capped at 3 — round 3
        with blockers returned NEXT_ROUND_REQUIRED (no event). Post-fix
        the kernel observes max_rounds=3 — round 3 with blockers
        returns HUMAN_REQUIRED with max_rounds_reached, which the
        drainer reads as terminal and emits verdict_provenance.
        """
        from aria_kernel import plan_convergence as pc
        # Build a minimal CROSS_REVIEWED state with a material risk on
        # round 3. _evaluate_cross_review_state is a pure function of
        # state + round + max_rounds, so this isolates the parameter
        # parity behavior without the full state-machine driver.
        synthetic_state = {
            "cross_reviews": {
                3: {
                    "tasks": {
                        "task-1": {
                            "review_direction": "primary_to_challenger",
                            "status": "ANSWERED",
                        },
                        "task-2": {
                            "review_direction": "challenger_to_primary",
                            "status": "ANSWERED",
                        },
                    },
                },
            },
            "cross_review_risks_by_round": {
                3: [
                    {
                        "risk_id": "risk-f024-test",
                        "severity": "critical",
                        "description": "synthetic material risk",
                    },
                ],
            },
            "resolved_review_risk_ids": [],
        }
        decision = pc._evaluate_cross_review_state(
            synthetic_state, round_number=3, max_rounds=3,
        )
        self.assertEqual(
            decision["terminal_state"], "HUMAN_REQUIRED",
            (
                "I-V10.5-4-02: at round_number == max_rounds with "
                "material blockers, kernel must return HUMAN_REQUIRED "
                "so the drainer can emit verdict_provenance and the "
                "operator sees a structured terminal state."
            ),
        )
        self.assertIn(
            "max_rounds_reached", decision["reason_codes"],
            (
                "I-V10.5-4-02: HUMAN_REQUIRED at the last round must "
                "carry the max_rounds_reached reason code so "
                "_derive_arbiter_verdict maps it to the 'max_rounds' "
                "verdict branch (per the V5.1 mapping table)."
            ),
        )
        self.assertIn(
            "material_cross_review_risks_present",
            decision["reason_codes"],
            (
                "I-V10.5-4-02: blocker preservation — the original "
                "material risk reason must travel with max_rounds_reached "
                "so the operator can triage WHICH blocker capped the "
                "cycle."
            ),
        )

    def test_i_v10_5_4_03_kernel_keeps_next_round_required_below_cap(self):
        """Negative regression: at round_number < max_rounds with the
        same blockers, kernel must STILL return NEXT_ROUND_REQUIRED.

        The F-024 fix forwards max_rounds — it must not collapse
        non-terminal rounds into HUMAN_REQUIRED. This test pins that
        the bound is strict (round_number >= max_rounds, not >).
        """
        from aria_kernel import plan_convergence as pc
        synthetic_state = {
            "cross_reviews": {
                2: {
                    "tasks": {
                        "task-1": {
                            "review_direction": "primary_to_challenger",
                            "status": "ANSWERED",
                        },
                        "task-2": {
                            "review_direction": "challenger_to_primary",
                            "status": "ANSWERED",
                        },
                    },
                },
            },
            "cross_review_risks_by_round": {
                2: [
                    {
                        "risk_id": "risk-f024-pre-cap",
                        "severity": "high",
                        "description": "synthetic material risk pre-cap",
                    },
                ],
            },
            "resolved_review_risk_ids": [],
        }
        decision = pc._evaluate_cross_review_state(
            synthetic_state, round_number=2, max_rounds=3,
        )
        self.assertEqual(
            decision["terminal_state"], "NEXT_ROUND_REQUIRED",
            (
                "I-V10.5-4-03: round_number < max_rounds with blockers "
                "must remain NEXT_ROUND_REQUIRED so the drainer "
                "iterates to the next round. Collapsing this into "
                "HUMAN_REQUIRED would abort cycles prematurely."
            ),
        )
        self.assertNotIn(
            "max_rounds_reached", decision["reason_codes"],
            (
                "I-V10.5-4-03: max_rounds_reached is reserved for the "
                "terminal round; appearing on non-terminal rounds "
                "would mis-attribute the cap."
            ),
        )

    def test_i_v10_5_4_04_evaluate_plan_accepts_max_rounds_kwarg(self):
        """The forwarding target must structurally exist — evaluate_plan
        must accept a keyword-only ``max_rounds`` parameter.

        If a future kernel refactor removes the kwarg or changes its
        type, the drainer's forwarding silently breaks (TypeError at
        runtime, or — worse — the kwarg gets quietly ignored if a
        **kwargs sink is added). This invariant pins the signature.
        """
        from aria_kernel import plan_convergence as pc
        sig = inspect.signature(pc.evaluate_plan)
        self.assertIn(
            "max_rounds", sig.parameters,
            (
                "I-V10.5-4-04: plan_convergence.evaluate_plan must "
                "expose a max_rounds parameter for the drainer to "
                "forward into. Removing it breaks the F-024 closure."
            ),
        )
        param = sig.parameters["max_rounds"]
        self.assertEqual(
            param.kind, inspect.Parameter.KEYWORD_ONLY,
            (
                "I-V10.5-4-04: max_rounds must be keyword-only so the "
                "drainer's call cannot accidentally pass it "
                "positionally and corrupt the other kwargs."
            ),
        )
        self.assertEqual(
            param.default, pc.MAX_CROSS_REVIEW_ROUNDS,
            (
                "I-V10.5-4-04: max_rounds default must remain "
                "MAX_CROSS_REVIEW_ROUNDS so direct kernel callers "
                "(force_plan_human_required, CLI, tests) preserve "
                "the V8 default contract."
            ),
        )


if __name__ == "__main__":
    unittest.main()
