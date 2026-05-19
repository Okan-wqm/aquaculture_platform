"""Plan ARIA-V3.1-0 — V9ImplementationRunner Protocol (V3.1-B consumes).

V9 closes the value gap "CONVERGED plans never become real code".
v3.1-B wires the implementation phase between CONVERGED and
specialist_review:

  CONVERGED → V9 implementation phase → specialist_review (signal-typed
  consumption) → review_runner → auto_merge_runner.

V3.1-B installs three concrete variants behind this Protocol:

* ``NoOpV9ImplementationRunner`` — profile=observe/standard/frozen;
  emits `implementation_phase_skipped` governance event + returns
  `V9ImplementationResult(terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
  specialist_review_signal="review_converged_plan")` so the orchestrator
  proceeds to specialist_review of the CONVERGED PLAN.
* ``StrictV9ImplementationRunner`` — profile=strict; refuses with
  `policy_strict_no_implementation` so the operator-side review still
  fires on the CONVERGED plan.
* ``AutonomousV9ImplementationRunner`` — profile=autonomous; mints the
  signing key + scoped installation token + issues the implementation
  envelope + polls for outcome + verifies signature + records via
  `plan_convergence.record_implementation_outcome`. try/finally
  cleans the keypair + revokes the installation token regardless of
  outcome (closes C-11, H-4).

V3.1-0 ships ONLY the Protocol + NoOp variant. The three real variants
ship in V3.1-B.

Tier-1 anchor: signal-typed return forces the orchestrator to handle
every terminal state — adding a new terminal becomes a Literal-type
error at every callsite (closes C-3).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:  # pragma: no cover
    pass


# Plan ARIA-V3.1-B — terminal state Literal. Adding a new terminal
# requires updating every match arm (impossible to forget under
# `--strict` mypy / pyright).
TerminalState = Literal[
    "IMPLEMENTATION_MERGED",
    "IMPLEMENTATION_REJECTED",
    "IMPLEMENTATION_TIMEOUT",
    "IMPLEMENTATION_REQUEST_REFUSED",
]

SpecialistReviewSignal = Literal[
    "review_converged_plan",   # impl didn't happen → review plan
    "review_rejected_pr",      # impl happened but failed → review diff
    "review_merged_pr",        # impl merged → review post-merge
    "skip",                    # impl phase already rejected; skip specialist
]


@dataclass(frozen=True)
class V9ImplementationResult:
    """V3.1-B signal-typed return.

    The orchestrator dispatches the next phase (specialist_review)
    using ``specialist_review_signal``, NOT by inspecting
    ``terminal_state`` heuristically. This makes the wiring explicit
    + statically checkable (closes C-3).
    """

    terminal_state: TerminalState
    pr_url: str | None
    rejection_class: str | None
    specialist_review_signal: SpecialistReviewSignal


class V9ImplementationRunner(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for V9 impl phase.

    Concrete variants (V3.1-B):

    * ``NoOpV9ImplementationRunner`` — default; refuses cleanly.
    * ``StrictV9ImplementationRunner`` — strict profile; refuses with
      policy event.
    * ``AutonomousV9ImplementationRunner`` — autonomous profile; the
      real implementation pipeline.

    Profile dispatch happens at the orchestrator entry (V3.1-E sets up
    the profile_gate before the runner fires).
    """

    def run(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        converged_plan: dict,
        cross_review_summary: dict,
        profile: str,
        implementer_poll_seconds: float,
    ) -> V9ImplementationResult:
        ...


class NoOpV9ImplementationRunner:
    """Plan ARIA-V3.1-0 — default. Refuses implementation cleanly so
    the orchestrator's V8 pre-implementation behavior is preserved
    exactly when injection is absent."""

    def run(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        converged_plan: dict,
        cross_review_summary: dict,
        profile: str,
        implementer_poll_seconds: float,
    ) -> V9ImplementationResult:
        return V9ImplementationResult(
            terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
            pr_url=None,
            rejection_class="no_op_v9_runner",
            specialist_review_signal="review_converged_plan",
        )


__all__ = [
    "NoOpV9ImplementationRunner",
    "SpecialistReviewSignal",
    "TerminalState",
    "V9ImplementationResult",
    "V9ImplementationRunner",
]
