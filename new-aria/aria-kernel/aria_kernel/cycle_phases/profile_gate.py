"""Plan ARIA-V3.1-0 — ProfileGate Protocol (V3.1-E consumes).

V3.1-E hardens the profile + preflight + budget SSoT:

* CLI `--profile` flows through `set_profile(operator_approval_ref=...)`
  so every CLI override emits a `runtime_profile_changed` audit row
  (closes C-2 SOC2 gap).
* `run_autonomy_orchestrator(profile=...)` becomes a required kwarg;
  legacy `get_profile(base_dir=root)` call removed from orchestrator
  body (closes H-9 + H-15 partial).
* Under `profile == "autonomous"`, the V9.0-C preflight fires
  fail-fast (raises GovernanceError on any failure_class). Under
  strict, preflight soft-warns. Under standard/observe/frozen,
  preflight is skipped.

V3.1-0 ships ONLY the Protocol + NoOp variant. The real ProfileGate
implementation lands in V3.1-E and reuses the existing
`_cycle_preflight` helper (`autonomy_orchestrator._cycle_preflight`;
renamed from `_autonomous_preflight` by ORPHAN-CRITICAL-420 S2 when the
failure-breaker check stopped being autonomous-only). Deliberately cited
without a line number — the previous `:196` locator was stale.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:  # pragma: no cover
    pass


@dataclass(frozen=True)
class ProfileGateVerdict:
    """V3.1-E preflight verdict.

    Fields:

    * ``permitted`` — True ⇒ cycle MAY enter; False ⇒ orchestrator
      MUST break out of the cycle loop + emit `autonomy_orchestrator_refused`.
    * ``exit_reason`` — when permitted=False, the canonical exit_reason
      code (e.g. ``cost_breaker_tripped``, ``failure_breaker_tripped``,
      ``autonomous_host_lease_blocked``, ``autonomous_profile_preconditions_not_met``).
    * ``failure_classes`` — V9.0-C preflight failure_class list (empty
      when permitted).
    * ``reasons`` — human-readable lines (joined as `; ` in the
      governance event).
    """

    permitted: bool
    exit_reason: str | None = None
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


class ProfileGate(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for profile + preflight.

    Called at the TOP of each cycle iteration (BEFORE
    `cycle_runner` fires). Two responsibilities:

    1. Resolve the active profile via the operator-supplied kwarg
       (V3.1-E removes `get_profile(base_dir=root)` from the
       orchestrator body — single source of truth is the kwarg).
    2. Enforce preflight gates per profile (autonomous=fail-fast;
       strict=soft-warn; others=skip).

    Returns `ProfileGateVerdict` typed result.
    """

    def evaluate(
        self,
        *,
        profile: str,
        base_dir: Path,
        workspace_root: Path | None,
    ) -> ProfileGateVerdict:
        ...


class NoOpProfileGate:
    """Plan ARIA-V3.1-0 — default. Returns `permitted=True` regardless
    of profile so the orchestrator's V8 behavior (preflight is
    handled inline via `_cycle_preflight`) is preserved exactly
    when injection is absent.

    V3.1-E replaces the inline `_cycle_preflight` call with a
    `ProfileGate.evaluate(...)` invocation; the NoOp keeps current
    semantics during the v3.1-0 scaffolding commit.
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
    "ProfileGate",
    "ProfileGateVerdict",
]
