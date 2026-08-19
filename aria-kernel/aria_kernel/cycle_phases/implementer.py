"""Plan ARIA-V3.1-0 — V9ImplementationRunner Protocol (V3.1-B consumes).

V9 closes the value gap "CONVERGED plans never become real code".
v3.1-B wires the implementation phase between CONVERGED and
specialist_review:

  CONVERGED → V9 implementation phase → specialist_review (signal-typed
  consumption) → review_runner → auto_merge_runner.

V3.1-B installs three concrete variants behind this Protocol:

* ``NoOpV9ImplementationRunner`` — every profile WITHOUT ``pr_create``
  authority (observe / standard / frozen); returns
  `V9ImplementationResult(terminal_state="IMPLEMENTATION_REQUEST_REFUSED",
  specialist_review_signal="review_converged_plan")` so the orchestrator
  proceeds to specialist_review of the CONVERGED PLAN.
* ``AutonomousV9ImplementationRunner`` — every profile WITH ``pr_create``
  authority (strict / autonomous); mints the signing key + scoped
  installation token + issues the implementation envelope + verifies
  signature + records via
  `plan_convergence.record_implementation_outcome`. try/finally
  cleans the keypair + revokes the installation token regardless of
  outcome (closes C-11, H-4).

ORPHAN-HIGH-728 — ``StrictV9ImplementationRunner`` WAS the third variant
and is DELETED, not deprecated. It refused implementation under
``strict`` with ``policy_strict_no_implementation`` while
``runtime_profile`` defines strict as "full implementation pipeline
(claim → planned → committed → validated → PR)" and grants it
``pr_create``/``pr_open``. Two contradictory definitions of one profile
is not a variant, it is drift: the class encoded a policy the SSoT never
held, so no producer could ever satisfy it and no operator could reach
the pipeline the profile advertises. Its rejection_class was never a
member of ``implementation_rejections.VALID_IMPLEMENTATION_REJECTION_CLASSES``
either — the refusal it emitted could not even be recorded as an
implementation outcome, which is the strongest available evidence that
it was a dead branch rather than a governed refusal.

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

    Concrete variants:

    * ``NoOpV9ImplementationRunner`` — default; refuses cleanly.
    * ``AutonomousV9ImplementationRunner`` — the real implementation
      pipeline.

    Profile dispatch happens at the orchestrator entry (V3.1-E sets up
    the profile_gate before the runner fires); which of the two the
    profile gets is DERIVED from ``runtime_profile.ACTION_PERMISSIONS``
    by :func:`select_v9_implementation_runner`.


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


class AutonomousV9ImplementationRunner:
    """Plan ARIA-V3.1-B — the IMPLEMENTING variant (closes the
    final value gap "CONVERGED plans never become real code").

    ORPHAN-HIGH-728 — named for the profile that first held it, selected
    now by AUTHORITY: any profile carrying ``pr_create`` in
    ``runtime_profile.ACTION_PERMISSIONS`` gets this runner, because
    ``pr_manager.open_pr_for_action`` is the gate the last step of this
    pipeline actually hits. ``strict`` therefore runs it too; the merge
    step is a different authority (``pr_merge``, autonomous-only) and is
    not reached from here at all.

    Pipeline:
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


# ORPHAN-HIGH-728 — the action authority that DECIDES which runner a
# profile gets. `pr_create` and not `change_committed`, because the
# implementation pipeline's terminal step is `pr_manager.open_pr_for_action`,
# which calls `enforce_profile_for_action("pr_create")`: a profile that
# cannot pass that gate cannot finish an implementation no matter how much
# of the pipeline it is handed, and a profile that CAN pass it must not be
# handed a runner that refuses before trying.
IMPLEMENTATION_ACTION_KIND: str = "pr_create"


def select_v9_implementation_runner(*, profile: str) -> V9ImplementationRunner:
    """Runner selection DERIVED from ``runtime_profile.ACTION_PERMISSIONS``.

    ORPHAN-HIGH-728 — this factory used to be a hand-written `if
    profile == ...` switch, i.e. a SECOND copy of the profile→authority
    mapping sitting beside the table the kernel actually enforces. The
    copy drifted, as copies do: the table grants ``pr_create`` to
    {strict, autonomous}, while the switch gave ``strict`` a runner that
    refused implementation outright and ``standard`` — the profile the
    nightly lane ran under — a NoOp. The observable cost was that ARIA
    could converge a plan every night and mint zero diffs, with no gate
    anywhere reporting a refusal, because from the switch's point of
    view nothing had gone wrong.

    Reading the table makes the drift impossible rather than merely
    detectable: granting a profile ``pr_create`` in ``ACTION_PERMISSIONS``
    now enrolls it in implementation automatically, and revoking it
    demotes the profile to NoOp on the same edit — the same
    derive-don't-enumerate discipline ``PROFILES_WITH_ACTION_AUTHORITY``
    already uses one module over.

    Lazy import: ``cycle_phases`` submodules keep a bare top-level import
    surface so ``autonomy_orchestrator``'s cold start stays hermetic
    (I-V31-0-01 / I-V31-0-05).
    """
    from ..runtime_profile import ACTION_PERMISSIONS

    if profile in ACTION_PERMISSIONS[IMPLEMENTATION_ACTION_KIND]:
        return AutonomousV9ImplementationRunner()
    return NoOpV9ImplementationRunner()


__all__ = [
    "IMPLEMENTATION_ACTION_KIND",
    "AutonomousV9ImplementationRunner",
    "NoOpV9ImplementationRunner",
    "SpecialistReviewSignal",
    "TerminalState",
    "V9ImplementationResult",
    "V9ImplementationRunner",
    "select_v9_implementation_runner",
]
