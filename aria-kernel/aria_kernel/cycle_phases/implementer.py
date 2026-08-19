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
* ``AutonomousV9ImplementationRunner`` — profile=autonomous; stages the
  CONVERGED plan for PR (ORPHAN-CRITICAL-727), mints the signing key +
  scoped installation token, issues the implementation envelope, and
  RETURNS. try/finally cleans the keypair + revokes the installation
  token regardless of outcome (closes C-11, H-4).

K6 (ORPHAN-CRITICAL-727) removed the synchronous poll that used to sit
after the mint. Two independent reasons, either sufficient:

  * the executor lane claims the envelope in a LATER workflow run, so
    nothing the poll waited for could arrive inside the cycle that
    minted it — the same fact CL-1 acted on when it deleted the
    convergence-drainer polls;
  * the poll called ``fold_plan_state(plan_id, base_dir=...)``
    POSITIONALLY against a keyword-only function, so every real
    invocation raised ``TypeError`` — not caught by its
    ``except (KeyError, ValueError, GovernanceError)`` arm — and the
    phase died at the first iteration. The tests were green because
    they patched ``fold_plan_state`` with a mock, and a mock accepts a
    positional call the real function refuses.

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
    # K6 (ORPHAN-CRITICAL-727) — the honest end of a mint-and-return phase:
    # the plan is staged, the envelope is on the queue, and the executor lane
    # delivers the implementation in a later run. It is not MERGED, not
    # RECORDED, not REJECTED, and calling it TIMEOUT (what the dead poll
    # returned) told the operator a deadline had passed when nothing had
    # even been claimed yet.
    "IMPLEMENTATION_DISPATCHED",
    # E2/F1 — the successful end of the IMPLEMENTATION PHASE: the agent
    # applied the diff, validated, opened the PR, and the outcome row
    # landed. MERGED belongs to the merge-authority chain (operator-gated)
    # and is reconciled later; a poll that only accepted MERGED/REJECTED
    # timed out on every success.
    "IMPLEMENTATION_RECORDED",
    "IMPLEMENTATION_REJECTED",
    # K6 (ORPHAN-CRITICAL-727) — ``IMPLEMENTATION_TIMEOUT`` is gone with the
    # poll that was its only producer. "We waited and nothing arrived" is no
    # longer a state this phase can be in, because the phase no longer waits:
    # an envelope that the executor has not yet claimed is DISPATCHED, and a
    # deadline belongs to the lease that governs the claim, not to a cycle
    # that has already handed the work over.
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

    ORPHAN-CRITICAL-728 — ``converged_plan`` was an input and is gone. Its
    only production producer was
    ``ConvergenceResult.converged_plan = eval_result.get("plan_content", {})``
    and ``plan_convergence.evaluate_plan`` returns no ``plan_content`` key, so
    every autonomous run received ``{}``. The body now comes from the plan
    ledger, keyed by ``plan_id``, hash-verified against the revision that
    converged — which is the only reading of "the CONVERGED plan" that a
    caller cannot get wrong.
    """

    def run(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        cross_review_summary: dict,
        profile: str,
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
        cross_review_summary: dict,
        profile: str,
    ) -> V9ImplementationResult:
        return V9ImplementationResult(
            terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
            pr_url=None,
            rejection_class="no_op_v9_runner",
            specialist_review_signal="review_converged_plan",
        )


class StrictV9ImplementationRunner:
    """Plan ARIA-V3.1-B — strict-profile variant. Refuses with
    `policy_strict_no_implementation` so the operator-side specialist
    review still fires on the CONVERGED plan (review_converged_plan
    signal). Strict is the safe dry-run mode; the V9 implementation
    phase requires the autonomous profile per V9.0-C contract.
    """

    def run(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        cross_review_summary: dict,
        profile: str,
    ) -> V9ImplementationResult:
        return V9ImplementationResult(
            terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
            pr_url=None,
            rejection_class="policy_strict_no_implementation",
            specialist_review_signal="review_converged_plan",
        )


class AutonomousV9ImplementationRunner:
    """Plan ARIA-V3.1-B — autonomous-profile variant (closes the
    final value gap "CONVERGED plans never become real code").

    Pipeline (K6 / ORPHAN-CRITICAL-727):

      1. mint_signing_key(cycle_id) — per-cycle ed25519 keypair +
         git_config commit signing wired (V3.1-B-3 closes C-7). First,
         so the workspace's commit identity is configured before any
         later step runs git in it.
      2. mint_installation_token(cycle_id) — 5-min TTL scoped GH
         installation token (V9.0-C Mode A / Mode B shim).
      3. ``apply_engine.stage_converged_plan_for_pr`` — records the
         proposal (machine-approved against the CONVERGED content hash),
         opens the change chain, mints the branch name and runs the
         BASELINE validation. Without this step the envelope told the
         agent to run `apply gate` / `pr create` with ids nobody had
         minted, and every CONVERGED plan died at the last command.
      4. issue_implementation_envelope(plan_id, ..., proposal_id=,
         change_id=, branch=) — the mint IS the CONVERGED ->
         IMPLEMENTATION_REQUESTED transition, and it now carries the
         staged ids as structured envelope fields.
      5. RETURN ``IMPLEMENTATION_DISPATCHED``. The executor lane claims
         the envelope in a later run; see the module docstring for why
         waiting here could never have observed the result.
      6. try/finally cleanup — revoke_signing_key + revoke_installation_token
         regardless of outcome (V3.1-B-7 closes C-11 + H-4).

    Exception order (V3.1-B-5 closes C-10): BridgeContractViolation
    catch arm PRECEDES GovernanceError so state-machine violations
    surface to the cycle loop, not silently consumed by the wider
    GovernanceError handler.
    """

    def run(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        cross_review_summary: dict,
        profile: str,
    ) -> V9ImplementationResult:
        # Lazy imports preserve cold-start hermetic discipline.
        from ..apply_engine import stage_converged_plan_for_pr
        from ..bridge_exceptions import BridgeContractViolation
        from ..cross_review_bridge import issue_implementation_envelope
        from ..gh_token_factory import (
            mint_installation_token,
            mint_signing_key,
            revoke_installation_token,
            revoke_signing_key,
        )
        from ..tool_registry import GovernanceError, append_tools_governance
        import json as _json

        signing_key = None
        installation_lease = None
        try:
            signing_key = mint_signing_key(
                cycle_id=cycle_id, workspace_root=workspace_root,
            )
            installation_lease = mint_installation_token(
                cycle_id=cycle_id, workspace_root=workspace_root,
            )
            # K6 (ORPHAN-CRITICAL-727) — staging BEFORE the mint, because the
            # envelope carries the staged ids and the mint is the state
            # transition out of CONVERGED: staging afterwards would leave a
            # plan in IMPLEMENTATION_REQUESTED whose agent has no ids to use,
            # and the transition is not reversible.
            try:
                staged = stage_converged_plan_for_pr(
                    plan_id=plan_id,
                    workspace_root=workspace_root,
                    base_dir=base_dir,
                )
            except GovernanceError as exc:
                append_tools_governance(
                    base_dir, "implementation_staging_governance_error",
                    {
                        "plan_id": plan_id,
                        "cycle_id": cycle_id,
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:1000],
                    },
                )
                return V9ImplementationResult(
                    terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
                    pr_url=None,
                    rejection_class="staging_governance_error",
                    specialist_review_signal="review_converged_plan",
                )

            # Plan ARIA-V3.1-B — issue the implementation envelope.
            # The envelope ships with base64-encoded delimiter
            # payloads (cross_review_bridge._implementation_suggested_prompt
            # V3.1-B-2 rewrite).
            try:
                # ORPHAN-CRITICAL-728 — the plan's own content is no longer
                # passed here. `must_satisfy` and `allowed_scope` are not
                # plan-content fields, so `converged_plan.get(...)` handed the
                # mint two empty lists and it refused its own envelope; and
                # `converged_plan` itself arrives as `{}` from the drainer,
                # because `evaluate_plan` has no `plan_content` key to read.
                # The bridge reads the hash-verified body from the plan ledger
                # and derives all of it.
                issue_implementation_envelope(
                    plan_id=plan_id,
                    cross_review_revision_id=str(
                        cross_review_summary.get("revision_id") or "cr-unknown"
                    ),
                    cross_review_summary_text=_json.dumps(
                        cross_review_summary, sort_keys=True, indent=2,
                    ),
                    proposal_id=str(staged["proposal_id"]),
                    change_id=str(staged["change_id"]),
                    branch=str(staged["branch"]),
                    base_sha=str(staged["base_sha"]),
                    base_dir=base_dir,
                )
            except BridgeContractViolation as exc:
                # Plan ARIA-V3.1-B-5 closes C-10: BridgeContractViolation
                # MUST surface to the orchestrator (state-machine
                # invariant). The catch arm is FIRST so this exception
                # never gets swallowed by the wider GovernanceError
                # handler below.
                append_tools_governance(
                    base_dir, "implementation_envelope_bridge_violation",
                    {
                        "plan_id": plan_id,
                        "cycle_id": cycle_id,
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:1000],
                    },
                )
                raise
            except GovernanceError as exc:
                append_tools_governance(
                    base_dir, "implementation_envelope_governance_error",
                    {
                        "plan_id": plan_id,
                        "cycle_id": cycle_id,
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:1000],
                    },
                )
                return V9ImplementationResult(
                    terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
                    pr_url=None,
                    rejection_class="envelope_governance_error",
                    specialist_review_signal="review_converged_plan",
                )

            # K6 — mint and return. The specialist reviews the CONVERGED plan
            # in this cycle because the plan is the only artifact that exists
            # yet; the diff and the PR are reviewed on the PR itself, by the
            # own-PR CI lane and the merge gates, once the executor delivers.
            append_tools_governance(
                base_dir, "implementation_dispatched",
                {
                    "plan_id": plan_id,
                    "cycle_id": cycle_id,
                    "proposal_id": staged["proposal_id"],
                    "change_id": staged["change_id"],
                    "branch": staged["branch"],
                    "baseline_ref": staged["baseline_ref"],
                },
            )
            return V9ImplementationResult(
                terminal_state="IMPLEMENTATION_DISPATCHED",
                pr_url=None,
                rejection_class=None,
                specialist_review_signal="review_converged_plan",
            )
        finally:
            # Plan ARIA-V3.1-B-7 (closes C-11 + H-4) — cleanup happens
            # regardless of outcome. Per-cycle keypair + installation
            # token cannot outlive the cycle wall-clock.
            if signing_key is not None:
                try:
                    revoke_signing_key(
                        cycle_id=cycle_id, workspace_root=workspace_root,
                    )
                except Exception:
                    # Best-effort — startup orphan reaper catches
                    # what try/finally misses (V3.1-P-6 prune).
                    pass
            if installation_lease is not None:
                try:
                    revoke_installation_token(lease=installation_lease)
                except Exception:
                    pass


def select_v9_implementation_runner(*, profile: str) -> V9ImplementationRunner:
    """Plan ARIA-V3.1-B — profile-derived runner factory.

    Mirrors select_auto_merge_runner / select_convergence_runner
    pattern. The orchestrator's CLI wire installs this factory's
    return value as the v9_implementation_runner kwarg per cycle.
    """
    if profile == "autonomous":
        return AutonomousV9ImplementationRunner()
    if profile == "strict":
        return StrictV9ImplementationRunner()
    # observe / standard / frozen → NoOp (V8 backward-compat).
    return NoOpV9ImplementationRunner()


__all__ = [
    "AutonomousV9ImplementationRunner",
    "NoOpV9ImplementationRunner",
    "SpecialistReviewSignal",
    "StrictV9ImplementationRunner",
    "TerminalState",
    "V9ImplementationResult",
    "V9ImplementationRunner",
    "select_v9_implementation_runner",
]
