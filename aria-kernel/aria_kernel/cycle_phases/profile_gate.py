"""Plan ARIA-V3.1-E — ProfileGate: the per-cycle preflight seam.

The orchestrator evaluates its ``profile_gate`` at the top of every cycle
iteration, before ``cycle_runner`` fires. The default is
``PreflightProfileGate``, which OWNS the per-cycle preflight (formerly
``autonomy_orchestrator._cycle_preflight``, and before ORPHAN-CRITICAL-420 S2
``_autonomous_preflight``): the cost breaker and the cross-host lease for
``autonomous``, and the failure breaker for every profile holding action
authority. One verdict type, ``ProfileGateVerdict``, carries its answer; the
orchestrator's private ``PreflightVerdict`` that an adapter used to translate
from is gone (ARIA-MEDIUM-455).

The run-level V9.0-C ``verify_preflight`` (autonomous fail-fast, strict
soft-warn) is NOT this gate: it runs once per orchestrator invocation, inline,
before the cycle loop.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ProfileGateVerdict:
    """Per-cycle preflight verdict.

    Fields:

    * ``permitted`` — True ⇒ cycle MAY enter; False ⇒ orchestrator
      MUST record the refusal and break out of the cycle loop.
    * ``exit_reason`` — when permitted=False, the canonical exit_reason
      code (``cost_breaker_tripped``, ``failure_breaker_tripped``,
      ``autonomous_host_lease_blocked``, ``policy_refused``).
    * ``reasons`` — operator-facing lines, joined as ``; `` into the
      refusal row's ``preflight_detail``. ``PreflightProfileGate`` puts the
      refusing GovernanceError's message here for ``policy_refused`` (it
      names the offending key), and nothing for the self-describing reason
      codes.
    """

    permitted: bool
    exit_reason: str | None = None
    reasons: tuple[str, ...] = field(default_factory=tuple)


class ProfileGate(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for the per-cycle preflight.

    Called at the TOP of each cycle iteration (BEFORE `cycle_runner`
    fires) with the run's profile, which is the orchestrator's ``profile``
    kwarg (the single source of truth; V3.1-E removed the in-body
    `get_profile` read). Returns a `ProfileGateVerdict`.
    """

    def evaluate(
        self,
        *,
        profile: str,
        base_dir: Path,
        workspace_root: Path | None,
    ) -> ProfileGateVerdict:
        ...


class PreflightProfileGate:
    """The default gate: Plan ARIA-V3 §B2 — cost + failure + lease preflight.

    ORPHAN-CRITICAL-420 S2 — the old ``_autonomous_preflight`` short-circuited
    OK unless the profile was ``autonomous``, on the stated rationale that
    "strict/standard/observe/frozen have their own gates". They do not.
    `strict` holds pr_open authority and `standard` holds change_committed
    authority, and neither consulted the failure breaker anywhere — so a
    tripped breaker stopped nothing on the profile the scheduled lane
    actually runs.

    The checks have three DIFFERENT scopes, which is why they cannot share
    one profile test:

      * failure breaker — every profile in PROFILES_WITH_ACTION_AUTHORITY.
        It exists to stop the system from acting after repeated rejections,
        so it must cover everything that can act. observe/frozen are exempt
        by construction (they hold no authority), which also preserves the
        operator's ability to run a read-only diagnostic cycle while tripped.
      * cost breaker — autonomous only, unchanged. Cost accrues through the
        autonomous agent-invocation lane; extending it needs the B0 producer
        and window analysis that ORPHAN-HIGH-466 tracks, and widening the
        scope without that would gate profiles against a counter nothing
        currently increments.
      * host lease — autonomous only, unchanged, and correctly so: it is a
        cross-host mutual exclusion for the autonomous daemon. A standard
        operator-driven cycle has no daemon to race.

    Autonomous evaluation ORDER is preserved exactly (cost, failure, lease)
    so the reason code an autonomous run reports does not change.

    Reason codes (``exit_reason`` values):
      * ``cost_breaker_tripped`` — B0 cost circuit breaker tripped
      * ``failure_breaker_tripped`` — B2 failure circuit breaker tripped
      * ``autonomous_host_lease_blocked`` — §2n cross-host lease held
        by a different host
      * ``policy_refused`` — RC-5. The genesis policy itself is invalid, so no
        breaker verdict can be computed. Named for the class rather than for
        one cause: ``circuit_breaker_policy`` refuses BOTH a renamed key
        (``threshold_24h``) and a ``failure_window_hours`` below the derived
        floor, and calling the reason ``policy_migration_required`` — as the
        plan specified — would mislabel the second as a migration when it is
        a range violation. The specific GovernanceError message is carried in
        ``reasons`` and lands in the governance row, so nothing is lost by
        having one code; it is carried verbatim, not re-worded, so the
        message the operator reads is the message the code raised.

    Every import is lazy: the cycle_phases package must not load the breaker,
    lease and profile modules at import time (the cold-start surface pinned
    by I-V31-0-01/05).
    """

    def evaluate(
        self,
        *,
        profile: str,
        base_dir: Path,
        workspace_root: Path | None,
    ) -> ProfileGateVerdict:
        is_autonomous = profile == "autonomous"
        # Lazy imports — keep run_autonomy_orchestrator importable when
        # the new B2 modules are absent (e.g. cold downgrade scenarios).
        if is_autonomous:
            try:
                from ..cost_budget import current_state as _cost_state
                if _cost_state(base_dir) == "tripped":
                    return ProfileGateVerdict(permitted=False, exit_reason="cost_breaker_tripped")
            except ImportError:
                pass
        # current_state() is safe to gate on: evaluate_breaker returns
        # BREAKER_STATE_TRIPPED for dropped/unreadable evidence as well as for
        # a genuine threshold breach, so damaged evidence blocks rather than
        # reading as "ok". Operators separate the two causes with
        # `aria-kernel breaker status`, which prints the verdict reason.
        from ..runtime_profile import PROFILES_WITH_ACTION_AUTHORITY

        if profile in PROFILES_WITH_ACTION_AUTHORITY:
            from ..tool_registry import GovernanceError as _PolicyError

            try:
                from ..circuit_breaker import current_state as _failure_state
                if _failure_state(base_dir) == "tripped":
                    return ProfileGateVerdict(permitted=False, exit_reason="failure_breaker_tripped")
            except ImportError:
                pass
            except _PolicyError as exc:
                # RC-5. This guard used to catch ImportError ONLY, while the
                # call it wraps reads the genesis policy: `current_state` ->
                # evaluate_breaker -> circuit_breaker_policy, which raises
                # GovernanceError by design when an override carries a renamed
                # key. So an operator with an untracked
                # aria-config/genesis_policy.json got a traceback out of
                # run_autonomy_orchestrator, on a path whose whole purpose is
                # to exit cleanly with a reason code.
                #
                # RC-4 widened the trigger rather than leaving it latent: a
                # failure_window_hours below the derived floor now raises here
                # too. That is why the two land in one commit — shipping RC-4
                # alone would have turned a documented misconfiguration into a
                # crash.
                #
                # A misconfiguration is an operator-actionable BLOCKED cycle:
                # not a crash, and not a swallowed exception that runs the
                # breaker on defaults the operator never chose.
                return ProfileGateVerdict(
                    permitted=False, exit_reason="policy_refused", reasons=(str(exc),),
                )
        if not is_autonomous:
            return ProfileGateVerdict(permitted=True)
        try:
            from ..autonomous_host_lease import acquire_lease
            from ..tool_registry import GovernanceError as _GE
            try:
                acquire_lease(base_dir=base_dir)
            except _GE as exc:
                if "autonomous_host_lease_blocked" in str(exc):
                    return ProfileGateVerdict(permitted=False, exit_reason="autonomous_host_lease_blocked")
                raise
        except ImportError:
            pass
        return ProfileGateVerdict(permitted=True)


class NoOpProfileGate:
    """An explicit opt-out that always permits the cycle.

    Injecting it DISARMS the per-cycle cost and failure breakers and the
    host lease. It exists for tests that drive the cycle loop without
    breaker state; production callers leave ``profile_gate`` unset and get
    ``PreflightProfileGate``.
    """

    def evaluate(
        self,
        *,
        profile: str,
        base_dir: Path,
        workspace_root: Path | None,
    ) -> ProfileGateVerdict:
        return ProfileGateVerdict(permitted=True)


__all__ = [
    "NoOpProfileGate",
    "PreflightProfileGate",
    "ProfileGate",
    "ProfileGateVerdict",
]
