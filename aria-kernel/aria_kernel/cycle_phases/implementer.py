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
    # E2/F1 — the successful end of the IMPLEMENTATION PHASE: the agent
    # applied the diff, validated, opened the PR, and the outcome row
    # landed. MERGED belongs to the merge-authority chain (operator-gated)
    # and is reconciled later; a poll that only accepted MERGED/REJECTED
    # timed out on every success.
    "IMPLEMENTATION_RECORDED",
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

    Concrete variants:

    * ``NoOpV9ImplementationRunner`` — default; refuses cleanly.
    * ``AutonomousV9ImplementationRunner`` — the real implementation
      pipeline.

    Profile dispatch happens at the orchestrator entry (V3.1-E sets up
    the profile_gate before the runner fires); which of the two the
    profile gets is DERIVED from ``runtime_profile.ACTION_PERMISSIONS``
    by :func:`select_v9_implementation_runner`.
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

      1. mint_signing_key(cycle_id) — per-cycle ed25519 keypair +
         git_config commit signing wired (V3.1-B-3 closes C-7).
      2. mint_installation_token(cycle_id) — 5-min TTL scoped GH
         installation token (V9.0-C Mode A / Mode B shim).
      3. issue_implementation_envelope(plan_id, ...) — submits the
         agent invocation request with base64-encoded delimiters
         (V3.1-B-2 prompt).
      4. _poll_for_implementation_state(plan_id, deadline) —
         exponential backoff up to implementer_poll_seconds (default
         1800s). Distinct from challenger_timeout (V3.1-B-9 closes
         H-13).
      5. record_implementation_outcome — verify_commit_signature
         against the per-cycle public-key fingerprint before
         accepting the row (V3.1-B-3 closes C-7).
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
        converged_plan: dict,
        cross_review_summary: dict,
        profile: str,
        implementer_poll_seconds: float,
    ) -> V9ImplementationResult:
        # Lazy imports preserve cold-start hermetic discipline.
        from ..bridge_exceptions import BridgeContractViolation
        from ..cross_review_bridge import issue_implementation_envelope
        from ..gh_token_factory import (
            mint_installation_token,
            mint_signing_key,
            revoke_installation_token,
            revoke_signing_key,
        )
        from ..plan_convergence import fold_plan_state
        from ..tool_registry import GovernanceError, append_tools_governance
        import json as _json
        import time as _time

        signing_key = None
        installation_lease = None
        try:
            signing_key = mint_signing_key(
                cycle_id=cycle_id, workspace_root=workspace_root,
            )
            installation_lease = mint_installation_token(
                cycle_id=cycle_id, workspace_root=workspace_root,
            )
            # Plan ARIA-V3.1-B — issue the implementation envelope.
            # The envelope ships with base64-encoded delimiter
            # payloads (cross_review_bridge._implementation_suggested_prompt
            # V3.1-B-2 rewrite).
            try:
                envelope = issue_implementation_envelope(
                    plan_id=plan_id,
                    converged_plan_revision_id=str(
                        converged_plan.get("revision_id")
                        or converged_plan.get("plan_id") or plan_id
                    ),
                    converged_plan_text=_json.dumps(
                        converged_plan, sort_keys=True, indent=2,
                    ),
                    cross_review_revision_id=str(
                        cross_review_summary.get("revision_id") or "cr-unknown"
                    ),
                    cross_review_summary_text=_json.dumps(
                        cross_review_summary, sort_keys=True, indent=2,
                    ),
                    must_satisfy=list(converged_plan.get("must_satisfy") or []),
                    evidence_refs=list(converged_plan.get("evidence_refs") or []),
                    allowed_scope=list(converged_plan.get("allowed_scope") or []),
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

            # Plan ARIA-V3.1-B-9 — poll loop with exponential backoff.
            # Distinct from challenger_timeout. Max polling interval
            # 30s so the kernel doesn't waste cycles on a slow agent.
            deadline = _time.monotonic() + implementer_poll_seconds
            poll_interval = 1.0
            max_interval = 30.0
            terminal_state: TerminalState = "IMPLEMENTATION_TIMEOUT"
            pr_url: str | None = None
            rejection_class: str | None = None
            while _time.monotonic() < deadline:
                try:
                    state = fold_plan_state(plan_id, base_dir=base_dir)
                except (KeyError, ValueError, GovernanceError):
                    state = None
                if isinstance(state, dict):
                    s = str(state.get("state", "")).upper()
                    if s == "IMPLEMENTATION_MERGED":
                        terminal_state = "IMPLEMENTATION_MERGED"
                        pr_url = state.get("pr_url") if isinstance(state, dict) else None
                        break
                    if s == "IMPLEMENTATION_RECORDED":
                        terminal_state = "IMPLEMENTATION_RECORDED"
                        impl_block = state.get("implementation") if isinstance(state, dict) else None
                        if isinstance(impl_block, dict):
                            pr_url = impl_block.get("pr_url")
                        break
                    if s == "IMPLEMENTATION_REJECTED":
                        terminal_state = "IMPLEMENTATION_REJECTED"
                        rejection_class = str(state.get("rejection_class") or "unknown")
                        break
                _time.sleep(poll_interval)
                poll_interval = min(poll_interval * 1.5, max_interval)

            # Plan ARIA-V3.1-B-1 — signal-typed signal for specialist_review.
            if terminal_state == "IMPLEMENTATION_MERGED":
                signal: SpecialistReviewSignal = "review_merged_pr"
            elif terminal_state == "IMPLEMENTATION_RECORDED":
                # PR is open and recorded; the specialist reviews the diff.
                signal = "review_merged_pr"
            elif terminal_state == "IMPLEMENTATION_REJECTED":
                signal = "review_rejected_pr"
            elif terminal_state == "IMPLEMENTATION_TIMEOUT":
                signal = "review_converged_plan"
            else:
                signal = "review_converged_plan"

            return V9ImplementationResult(
                terminal_state=terminal_state,
                pr_url=pr_url,
                rejection_class=rejection_class,
                specialist_review_signal=signal,
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
