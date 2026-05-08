"""Plan 020 Phase 1 — runtime profile (4-mode safety boundary, scoped no-write).

WHY this module exists
----------------------
ARIA's prior layout had no operator-controlled gate between "we observe the
repo" and "we mutate the ledger / open PRs / claim agents". Plan 020 formalises
the gate as a 4-mode runtime profile. The profile is the single SAFETY BOUNDARY
that decides whether dispatch sites + ledger writers are allowed to fire.

Profiles
--------
- observe (read-only + observation-class writes only):
    finding/debt/observation emit, context_audits, handoffs, surface_validations,
    instinct_candidates(PROPOSED). NO agent claim, NO change_committed/validated,
    NO PR open, NO tool runs.
- standard (default):
    full Plan 020 surface writes + agent claim + change planned/committed +
    change validated. PR open requires strict (operator gesture).
- strict:
    full implementation pipeline (claim → planned → committed → validated → PR).
- frozen (Plan 020 SCOPED no-write — incident response):
    every PLAN_020_WRITE_SURFACES write blocked, every action blocked.
    Legacy mutators (finding emit, debt emit, change_planned, human_required,
    review_record, agent_release/requeue/reap_stale, low-level
    append_tools_governance) are NOT covered — Plan 021 hardening scope. The
    plan-020 frozen invariant is intentionally narrow; making it global without
    a coordinated legacy-writer refactor would break observation-class flows
    that incident response itself depends on.

Non-bypassable invariants — fire in EVERY profile (saf validator level,
DECOUPLED from the profile gate; profile cannot disable them):
- L1 banned-phrase scanner (tools/gates/banned-phrase.ts) — pure validator.
- L2 Closes-trailer validator (tools/gates/commit-msg-validator.ts) — pure
  validator (husky-side).
- L3 suppression scanner (`apply scan-diff` for // @ts-ignore, as any, .skip,
  empty catch) — pure validator.
- auth/tenant adapter spine baseline READ — read-only; the underlying
  tool_runner.run_tool that PRODUCES baselines is profile-gated, but reading
  the latest run row is observation-class and not gated by the profile.

Control-plane exception
-----------------------
set_profile() bypasses enforce_profile_for_write() so an operator can always
THAW a frozen surface. Without this exception, frozen would be a one-way kill
switch with no recovery path. set_profile DEMANDS operator_approval_ref on
every transition (not just unfreezing) — every change is auditable through the
runtime-profile-history.jsonl ledger + runtime_profile_changed governance event.

Wiring (Phase 1.B dispatch site integration)
--------------------------------------------
`enforce_profile_for_action` is wired at the TOP of:
- agent_invocations.claim_request (action_kind='agent_claim')
- change_ledger.emit_change_committed (action_kind='change_committed')
- change_ledger.emit_change_validated (action_kind='change_validated')
- pr_manager.open_pr_for_action (action_kind='pr_open')

`enforce_profile_for_write` is wired at the TOP of tool_runner.run_tool
(surface_kind='tool_runs') as the single chokepoint for every adapter / spine
orchestrator invocation. Plan 020 Phase 2-13 add their own enforce calls when
they introduce new ledger surfaces.

Read-path init/write protection
-------------------------------
get_profile + list_profile_history use ensure_tools_dir_readonly so frozen
read commands cannot silently break the no-write invariant by triggering
ensure_tools_dir's identity-file bootstrap. set_profile is the only writer in
this module and the documented control-plane exception.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    tools_dir,
    utc_now,
)

# Ordered tuple of valid profiles (used for membership + CLI choices).
PROFILES: tuple[str, ...] = ("observe", "standard", "strict", "frozen")
DEFAULT_PROFILE: str = "standard"

PROFILE_STATE_FILENAME = "runtime-profile.json"
PROFILE_HISTORY_FILENAME = "runtime-profile-history.jsonl"

# ---------------------------------------------------------------------
# Action permission table.
#   action_kind → frozenset of profiles that PERMIT the action.
# A profile NOT in the permitted set raises GovernanceError('profile_violation').
#
# Why standard permits change_validated:
#   Plan v3.3 §Phase 1.A says "standard: validated explicit operator command
#   gerektirir" — the binary gate is open under standard, the
#   "explicit operator command" semantic is enforced at the orchestrator
#   layer (auto-pipeline does not fire validated under standard, but a CLI
#   `aria-kernel change validate-chain` invocation is permitted).
#
# Why pr_open is strict-only:
#   PR open is the strict pipeline tail; operators that want to commit but
#   not auto-PR should remain on standard (commit gate open, PR gate closed).
ACTION_PERMISSIONS: dict[str, frozenset[str]] = {
    "agent_claim": frozenset({"standard", "strict"}),
    "change_committed": frozenset({"standard", "strict"}),
    "change_validated": frozenset({"standard", "strict"}),
    "pr_open": frozenset({"strict"}),
}

# ---------------------------------------------------------------------
# Plan 020 protected write surfaces.
#   frozen blocks EVERY surface in this set; standard|strict permit all.
#   observe permits only OBSERVE_PERMITTED_SURFACES (a strict subset of the
#   union of legacy + Plan 020 surfaces).
#
# Surfaces NOT in this set (legacy mutators: finding/debt/observation emit,
# human_required, review_record, change_planned, agent_release/requeue/
# reap_stale_claims, append_tools_governance low-level) are PLAN 021 SCOPE —
# Plan 020's frozen invariant intentionally does not cover them.
PLAN_020_WRITE_SURFACES: frozenset[str] = frozenset({
    "context_audits",          # Phase 2
    "handoffs",                # Phase 3
    "agent_evals",             # Phase 6
    "agent_compliance",        # Phase 7
    "validation_matrix",       # Phase 8 — writer surface, no dedicated file
    "surface_validations",     # Phase 11
    "instinct_candidates",     # Phase 12 (PROPOSED-only under observe)
    "cost_telemetry",          # Phase 13
    "change_ledger_committed", # Phase 1.B (defense-in-depth for change_ledger)
    "change_ledger_validated", # Phase 1.B (defense-in-depth)
    "tool_runs",               # Phase 4 + Phase 10 chokepoint via run_tool
    "agent_claim",             # Phase 1.B (defense-in-depth for claim_request)
    "pr_open",                 # Phase 1.B (defense-in-depth for open_pr)
    "spine_orchestrator",      # Phase 4 dedicated invocation
})

# Observe-mode allowlist (Plan v3.3 §Phase 1.B observe table).
# A surface NOT in this set is BLOCKED under observe.
# 'finding'/'debt'/'observation' are listed for documentation/forward
# compatibility (Plan 021 will route legacy emit through this gate too); for
# Plan 020 those surfaces never reach enforce_profile_for_write.
OBSERVE_PERMITTED_SURFACES: frozenset[str] = frozenset({
    "finding",
    "debt",
    "observation",
    "context_audits",
    "handoffs",
    "surface_validations",
    "instinct_candidates",
})

# Union of every surface_kind the validator recognises. A surface_kind that
# is neither plan-020-protected nor observe-permitted is rejected as
# "unknown surface" — a typo in a caller raises a loud error rather than
# silently passing.
KNOWN_WRITE_SURFACES: frozenset[str] = PLAN_020_WRITE_SURFACES | OBSERVE_PERMITTED_SURFACES


def _profile_state_file(base_dir: str | Path | None = None) -> Path:
    return tools_dir(base_dir) / PROFILE_STATE_FILENAME


def _profile_history_file(base_dir: str | Path | None = None) -> Path:
    return tools_dir(base_dir) / PROFILE_HISTORY_FILENAME


def get_profile(*, base_dir: str | Path | None = None) -> str:
    """Read the current active profile.

    Frozen-aware: routes through ensure_tools_dir_readonly so a fresh sandbox
    under `frozen` does not silently break the no-write invariant by
    triggering the tools_root_bootstrapped governance event.

    Returns DEFAULT_PROFILE ('standard') when:
    - tools dir does not exist or is not bound (ensure_tools_dir_readonly None),
    - state file is absent,
    - state file is malformed,
    - persisted profile name is unknown.

    The fallback is intentionally permissive — you cannot reach `frozen`
    without first calling set_profile, which calls ensure_tools_dir and
    creates the state file. So "no state file" implies "never set", which
    means default `standard`.
    """
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return DEFAULT_PROFILE
    state_file = root / PROFILE_STATE_FILENAME
    if not state_file.exists():
        return DEFAULT_PROFILE
    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return DEFAULT_PROFILE
    profile = str(payload.get("active_profile") or DEFAULT_PROFILE)
    if profile not in PROFILES:
        return DEFAULT_PROFILE
    return profile


def set_profile(
    profile: str,
    *,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
    set_by: str = "operator",
) -> dict[str, Any]:
    """Transition the active runtime profile (control-plane operation).

    Bypasses enforce_profile_for_write so an operator can always THAW a
    frozen surface — without this exception, `frozen` would be a one-way
    kill switch with no recovery path.

    operator_approval_ref is REQUIRED for EVERY transition (not just
    unfreezing): observe → standard, standard → strict, strict → frozen,
    frozen → standard, etc. Audit-friendly: each change is traceable
    through runtime-profile-history.jsonl + the runtime_profile_changed
    governance event.

    Writes:
    - aria-tools/runtime-profile.json (atomic write of state).
    - aria-tools/runtime-profile-history.jsonl (append-only history row).
    - aria-tools/governance.jsonl (runtime_profile_changed event).
    """
    if profile not in PROFILES:
        raise GovernanceError(
            f"unknown profile: {profile!r} (must be one of {PROFILES})"
        )
    if not (operator_approval_ref or "").strip():
        raise GovernanceError("runtime_profile_change_requires_approval")
    # Control-plane writer path: do NOT route through enforce_profile_for_write.
    root = ensure_tools_dir(base_dir)
    previous_profile = get_profile(base_dir=root)
    state = {
        "active_profile": profile,
        "previous_profile": previous_profile,
        "set_at": utc_now(),
        "set_by": set_by,
        "operator_approval_ref": operator_approval_ref,
    }
    state_file = root / PROFILE_STATE_FILENAME
    tmp = state_file.with_name(f".{state_file.name}.tmp")
    tmp.write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(state_file)
    history_row = {
        "$schema": "aria/runtime-profile-history/v1",
        "schema_version": 1,
        **state,
    }
    append_jsonl(_profile_history_file(root), history_row)
    append_tools_governance(
        root,
        "runtime_profile_changed",
        {
            "previous_profile": previous_profile,
            "active_profile": profile,
            "operator_approval_ref": operator_approval_ref,
            "set_by": set_by,
        },
    )
    return state


def list_profile_history(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Return the append-only profile transition history (oldest → newest).

    Frozen-aware read path (ensure_tools_dir_readonly). Returns [] when no
    history file exists.
    """
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    history_file = root / PROFILE_HISTORY_FILENAME
    if not history_file.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in history_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def enforce_profile_for_action(
    action_kind: str,
    *,
    base_dir: str | Path | None = None,
) -> str:
    """Reject action_kind if active profile does not permit it.

    Wired at the TOP of dispatch sites:
    - agent_invocations.claim_request          → 'agent_claim'
    - change_ledger.emit_change_committed      → 'change_committed'
    - change_ledger.emit_change_validated      → 'change_validated'
    - pr_manager.open_pr_for_action            → 'pr_open'

    Returns the active profile name on success.

    Raises GovernanceError('profile_violation: ...') on rejection.
    Raises GovernanceError on unknown action_kind (typo guard).
    """
    permitted = ACTION_PERMISSIONS.get(action_kind)
    if permitted is None:
        raise GovernanceError(f"unknown profile action_kind: {action_kind!r}")
    profile = get_profile(base_dir=base_dir)
    if profile not in permitted:
        raise GovernanceError(
            f"profile_violation: action {action_kind!r} blocked under profile "
            f"{profile!r} (permitted: {sorted(permitted)})"
        )
    return profile


def enforce_profile_for_write(
    surface_kind: str,
    *,
    base_dir: str | Path | None = None,
) -> str:
    """Reject ledger write to surface_kind if active profile does not permit it.

    Plan 020 SCOPED:
    - frozen blocks every surface in PLAN_020_WRITE_SURFACES (no-write
      invariant for the 14-surface scope).
    - observe blocks any surface NOT in OBSERVE_PERMITTED_SURFACES.
    - standard|strict permit all known surfaces.

    Surfaces NOT in either set raise GovernanceError as a typo guard. Legacy
    writers that have not yet been routed through this gate (Plan 021 scope)
    do not call enforce_profile_for_write at all — their frozen-guard
    hardening is a separate plan.

    Returns the active profile name on success.

    Raises GovernanceError('profile_violation: ...') on rejection.
    Raises GovernanceError on unknown surface_kind (typo guard).
    """
    if surface_kind not in KNOWN_WRITE_SURFACES:
        raise GovernanceError(
            f"unknown profile write surface_kind: {surface_kind!r}"
        )
    profile = get_profile(base_dir=base_dir)
    if profile == "frozen":
        # Plan 020 frozen scope: every PLAN_020_WRITE_SURFACES write blocked.
        # Surfaces in OBSERVE_PERMITTED_SURFACES that are NOT also in
        # PLAN_020_WRITE_SURFACES (finding/debt/observation) fall through —
        # they are Plan 021 scope, not enforced here.
        if surface_kind in PLAN_020_WRITE_SURFACES:
            raise GovernanceError(
                f"profile_violation: surface {surface_kind!r} blocked under "
                f"frozen profile (Plan 020 scope)"
            )
    elif profile == "observe":
        if surface_kind not in OBSERVE_PERMITTED_SURFACES:
            raise GovernanceError(
                f"profile_violation: surface {surface_kind!r} blocked under "
                f"observe profile (allowlist: {sorted(OBSERVE_PERMITTED_SURFACES)})"
            )
    # standard|strict: permit all known surfaces.
    return profile


__all__ = [
    "PROFILES",
    "DEFAULT_PROFILE",
    "ACTION_PERMISSIONS",
    "PLAN_020_WRITE_SURFACES",
    "OBSERVE_PERMITTED_SURFACES",
    "KNOWN_WRITE_SURFACES",
    "PROFILE_STATE_FILENAME",
    "PROFILE_HISTORY_FILENAME",
    "get_profile",
    "set_profile",
    "list_profile_history",
    "enforce_profile_for_action",
    "enforce_profile_for_write",
]
