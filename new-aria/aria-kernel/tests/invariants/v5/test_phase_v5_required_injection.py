"""Plan ARIA-V5 — required-kwarg signature invariants (I-V5-01 / I-V5-02).

Mirrors Plan ARIA-V3 ``test_phase_a1_a2_required_injection.py`` for
the V5 convergence + review runner kwargs. Tier-1 "Make Impossible"
discipline: ``run_autonomy_orchestrator`` MUST refuse to bind
without ``convergence_runner`` (C1 / V5.1) and ``review_runner``
(C2 / V5.2). Annotation MUST NOT be Optional / `| None`, otherwise
the type system would permit silent skip of the gate at runtime.

Why this invariant matters (operator anchor, Plan ARIA-V5 §1):
  "agentlar plan yapıyor … planları sureklı en bastan revıew
   ederek ıkı agent bırbırıne atarak valıde sekılde sonlanrmalı"

A Tier-2 "optional with None default" would let a future caller
silently bypass the convergence gate — exactly the class of bug
V3 §A1 closed for ``auto_merge_runner`` (commit a1+a2 history).
V5 mirrors that precedent.

C1 (V5.1 landing) — I-V5-01 (convergence_runner).
C2 (V5.2 landing) — I-V5-02 (review_runner) — added below.
"""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV5RequiredInjection(unittest.TestCase):
    """Plan ARIA-V5 — Tier-1 required-kwarg signature gate."""

    def test_i_v5_01_convergence_runner_has_no_default(self) -> None:
        """Plan ARIA-V5 §3a v2 — ``convergence_runner`` must be a
        keyword-only parameter with NO default value.

        Why no default: a default of ``None`` (Tier-2 pattern) would
        let a future caller silently skip the Gate A convergence
        check. The V3 §A1 precedent (``auto_merge_runner``) closed
        this class of bug by making the kwarg REQUIRED. V5 mirrors
        verbatim.
        """
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn(
            "convergence_runner",
            sig.parameters,
            msg=(
                "Plan ARIA-V5 §3a v2 — run_autonomy_orchestrator MUST "
                "accept convergence_runner kwarg. V5.1 Phase 5.1 "
                "(commit C1) wires the Gate A pre-worker convergence "
                "drainer through this kwarg."
            ),
        )
        param = sig.parameters["convergence_runner"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "Plan ARIA-V5 §3a v2 — convergence_runner MUST have "
                "NO default (Tier-1 'Make impossible'). A None default "
                "would let a future caller silently skip the "
                "convergence gate, breaking the operator vision that "
                "every plan must be reviewed continuously by primary↔"
                "challenger before worker dispatch. Found default: "
                f"{param.default!r}"
            ),
        )
        self.assertEqual(
            param.kind,
            inspect.Parameter.KEYWORD_ONLY,
            msg=(
                "convergence_runner must be keyword-only for clarity "
                "at callsites (mirrors V3 §A1 auto_merge_runner)."
            ),
        )

    def test_i_v5_01_convergence_runner_annotation_is_not_optional(
        self,
    ) -> None:
        """Plan ARIA-V5 §3a v2 — annotation must not permit None.

        A ``Callable | None`` or ``Optional[Callable]`` annotation
        would let the type system silently accept None at runtime,
        undoing the Tier-1 guarantee. The annotation MUST be a
        non-Optional reference to ``ConvergenceRunner``.
        """
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        param = sig.parameters["convergence_runner"]
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(
                forbidden,
                annotation_str,
                msg=(
                    f"Plan ARIA-V5 §3a v2 — convergence_runner "
                    f"annotation must not be Optional. Found "
                    f"{forbidden!r} in {annotation_str!r}. The Tier-1 "
                    f"guarantee is structural: signature inspection + "
                    f"annotation check together make it impossible to "
                    f"silently skip the convergence gate."
                ),
            )

    # I-V5-02 — review_runner REQUIRED kwarg (V5.2 C2).
    def test_i_v5_02_review_runner_has_no_default(self) -> None:
        """Plan ARIA-V5 §3a v2 — ``review_runner`` must be a
        keyword-only parameter with NO default value.

        Mirrors I-V5-01 for the Gate B post-implementation review
        runner. A Tier-2 ``None`` default would let a future caller
        silently skip the adversarial review gate, breaking the
        operator vision that every implementation must be re-
        verified by independent judges before auto-merge.
        """
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn(
            "review_runner",
            sig.parameters,
            msg=(
                "Plan ARIA-V5 §3a v2 — run_autonomy_orchestrator MUST "
                "accept review_runner kwarg. V5.2 Phase 5.2 (commit "
                "C2) wires the Gate B post-impl adversarial review "
                "drainer through this kwarg."
            ),
        )
        param = sig.parameters["review_runner"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "Plan ARIA-V5 §3a v2 — review_runner MUST have NO "
                "default (Tier-1 'Make impossible'). A None default "
                "would let a future caller silently skip the post-"
                "implementation review gate. Found default: "
                f"{param.default!r}"
            ),
        )
        self.assertEqual(
            param.kind,
            inspect.Parameter.KEYWORD_ONLY,
            msg=(
                "review_runner must be keyword-only for clarity "
                "at callsites (mirrors V5.1 convergence_runner + "
                "V3 §A1 auto_merge_runner)."
            ),
        )

    def test_i_v5_02_review_runner_annotation_is_not_optional(
        self,
    ) -> None:
        """Plan ARIA-V5 §3a v2 — review_runner annotation not Optional."""
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        param = sig.parameters["review_runner"]
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(
                forbidden,
                annotation_str,
                msg=(
                    f"Plan ARIA-V5 §3a v2 — review_runner annotation "
                    f"must not be Optional. Found {forbidden!r} in "
                    f"{annotation_str!r}."
                ),
            )


if __name__ == "__main__":
    unittest.main()
