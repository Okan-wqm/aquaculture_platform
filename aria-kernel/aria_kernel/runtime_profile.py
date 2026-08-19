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
    change validated. PR open requires strict.
- strict:
    full implementation pipeline (claim → planned → committed → validated → PR).
    Strict is an OPERATOR GRANT. A scheduled lane may resolve itself into
    strict only when an operator has already raised the scheduler ceiling
    to it; see "Scheduler ceiling" below.
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

Scheduler ceiling (ORPHAN-HIGH-728 / ADR-033 §Alternative-A / ADR-041 §2)
------------------------------------------------------------------------
An unattended lane decides its own profile every night from evidence
(`autonomy_unlock`). Evidence can say "the repository has earned more
authority"; it cannot say "an operator granted it". Those are different
sentences, and a machine that reads the first as the second grants itself
the gesture the ADRs reserve for a human.

`scheduler_profile_ceiling` is that gesture, written into THIS control
plane (the same `runtime-profile.json` state file, the same history
ledger, the same governance event) rather than into a second switch:

- default ``standard`` — a store that has never been touched by an
  operator keeps the nightly lane exactly where ADR-041's step-2
  observation window needs it.
- an operator raises it with
  ``aria-kernel profile set --profile <p> --scheduler-ceiling strict
  --operator-approval-ref <ref>``.
- a scheduled lane resolves ``bound_profile_to_ceiling(ladder_verdict,
  ceiling)`` — it may choose WITHIN the grant and never above it.
- `set_profile` REFUSES a non-operator setter (`set_by != "operator"`)
  that tries to persist a profile above the ceiling, or to raise the
  ceiling itself. The ceiling is the one value in this file a machine can
  only ever read or lower.

Containment is by SUBSET of `ACTION_PERMISSIONS`, not by a hand-written
rank: "within the ceiling" means "permits no action the ceiling does not",
so a new action kind or a new profile enrols in the bound automatically.

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

from .ledger import append_declared_jsonl, rewrite_declared_json
from .state_manifest import observe_permitted_profile_surfaces, profile_surfaces
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    tools_dir,
    utc_now,
)

# Ordered tuple of valid profiles (used for membership + CLI choices).
# Plan ARIA-V3 §B2 — ``autonomous`` profile added explicitly. Current
# mainline authority derives no live auto-ack lane. Default stays
# ``standard``; operator MUST set
# via ``aria-kernel profile set --profile autonomous --operator-approval-ref <ref>``.
PROFILES: tuple[str, ...] = (
    "observe", "standard", "strict", "frozen", "autonomous",
)
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
#   ORPHAN-HIGH-728 — for SCHEDULED lanes that sentence is enforced, not
#   advised: the nightly resolver bounds its own verdict by the
#   operator-recorded `scheduler_profile_ceiling` (default standard), so
#   reaching this cell on a schedule takes an operator gesture first.
# Plan ARIA-V3 §B2 — ``autonomous`` listed EXPLICITLY on every action
# kind it permits (no inherit-from-strict semantics — closes
# test-runner missing-test-#6 invariant gap). Tier-1: a future
# refactor that drops ``autonomous`` from any cell must update this
# table directly; the action_permissions test asserts the table is
# the SSoT.
#
# autonomous permits:
#   - agent_claim       — must claim its target before mutating
#   - change_committed  — auto-commit allowed under L3 + classifier-pass
#   - change_validated  — auto-validate chain allowed
#   - pr_open           — auto-PR-open allowed under L3 + breaker-ok
#   - pr_merge          — auto-merge execution allowed only under L3; this is
#                         an action authority, not a ledger write surface.
#   - plan_stage        — stage a CONVERGED plan (machine approval + change
#                         chain + baseline validation)
#   - apply_gate        — promote a staged apply action to ready_for_pr
ACTION_PERMISSIONS: dict[str, frozenset[str]] = {
    "agent_claim": frozenset({"standard", "strict", "autonomous"}),
    "change_committed": frozenset({"standard", "strict", "autonomous"}),
    "change_validated": frozenset({"standard", "strict", "autonomous"}),
    "pr_create": frozenset({"strict", "autonomous"}),
    "pr_open": frozenset({"strict", "autonomous"}),
    "pr_merge": frozenset({"autonomous"}),
    # ORPHAN-CRITICAL-728 — the two governed actions the convergence-to-PR
    # producer added. `plan_stage` mints a machine approval and opens a
    # change chain; `apply_gate` promotes an apply action to `ready_for_pr`,
    # which is the state `pr_open` requires. Both were reachable from the
    # implementer's Bash allowlist under EVERY profile and with the failure
    # breaker tripped, because a cell in this table is what enrols an action
    # in profile gating and in `PROFILES_WITH_ACTION_AUTHORITY` below.
    #
    # Same set as pr_create/pr_open: they are steps of the same pipeline, and
    # a profile that may not open a PR has no business minting the approval
    # or the gate ref that a PR open consumes.
    "plan_stage": frozenset({"strict", "autonomous"}),
    "apply_gate": frozenset({"strict", "autonomous"}),
}

# ORPHAN-CRITICAL-420 S2 — the set of profiles that hold ANY governed
# action authority, derived from the table above rather than written out.
#
# Safety controls that exist to stop the system from acting (the B2 failure
# circuit breaker today) must gate every profile that can act. Hardcoding
# `profile == "autonomous"` at each such gate was the defect: `strict` holds
# pr_open + pr_create authority and `standard` holds change_committed, so both
# could keep taking actions with the breaker tripped.
#
# Derived, not enumerated, so the correct behaviour is the zero-effort default:
# granting a profile a new cell in ACTION_PERMISSIONS automatically enrolls it
# in breaker gating, and a profile that holds no authority is automatically
# exempt. A literal frozenset here would silently rot the first time the table
# changed — which is precisely how the original gate came to be wrong.
#
# observe/frozen appear in no cell and so are excluded BY CONSTRUCTION, which
# is the behaviour we want for a different reason: they cannot mutate anything,
# and blocking them would deny an operator the read-only cycle they need to
# diagnose the very breaker that is tripped.
PROFILES_WITH_ACTION_AUTHORITY: frozenset[str] = frozenset().union(
    *ACTION_PERMISSIONS.values()
)

# ---------------------------------------------------------------------
# ORPHAN-HIGH-728 — the SCHEDULER CEILING: the operator gesture a machine
# can read and lower but never raise.
#
# `strict` is what ADR-033 calls an operator decision and what ADR-041's
# activation ceremony spends a week of observation reaching. A nightly lane
# that resolves its own profile from acceptance evidence is answering a
# different question ("has the repo earned it") than the one those documents
# ask ("did a human grant it"), and letting the first answer stand in for the
# second is how a machine ends up holding an authority nobody handed it.
#
# The ceiling lives in the EXISTING control plane — same state file, same
# history ledger, same governance event as the active profile — because a
# second store would be a second answer to "how much may ARIA do", and the
# operator would have to keep them agreeing by hand.
SCHEDULER_CEILING_STATE_KEY: str = "scheduler_profile_ceiling"

# Default `standard`: a store no operator has touched keeps every scheduled
# lane where ADR-041 step 2 needs it — producing, observable, unable to open
# a pull request on its own initiative.
DEFAULT_SCHEDULER_PROFILE_CEILING: str = "standard"

# The most authority a MACHINE VERDICT may ever PROPOSE for a scheduled lane,
# before the ceiling bounds it further. `autonomous` is excluded here and not
# merely absent from the workflow: the merge-capable profile must be
# unreachable from an unattended lane by construction, and this constant is
# where that is written once instead of in every scheduler.
SCHEDULER_MAX_PROPOSABLE_PROFILE: str = "strict"

# `set_by` value that marks a HUMAN control-plane gesture. Any other setter
# is a machine as far as the ceiling is concerned.
OPERATOR_SET_BY: str = "operator"


def permitted_actions(profile: str) -> frozenset[str]:
    """Every governed action kind ``profile`` permits — DERIVED.

    The inverse view of ACTION_PERMISSIONS, computed rather than stored, so
    a new action kind enrols every profile that holds it without a second
    edit anywhere.
    """
    return frozenset(
        action_kind
        for action_kind, permitted in ACTION_PERMISSIONS.items()
        if profile in permitted
    )


def profile_within_ceiling(profile: str, ceiling: str) -> bool:
    """Does ``profile`` stay inside the authority ``ceiling`` grants?

    Containment is SUBSET of permitted actions, not a rank comparison. A
    rank would be a second, hand-maintained ordering of the profiles — the
    exact duplication class this module keeps deleting — and it would give a
    confident answer for two profiles whose authorities do not actually
    nest. Subset answers the only question a ceiling asks: does this profile
    permit anything the ceiling does not?
    """
    return permitted_actions(profile) <= permitted_actions(ceiling)


def bound_profile_to_ceiling(profile: str, ceiling: str) -> str:
    """``profile`` when it fits inside ``ceiling``, otherwise ``ceiling``.

    This is the `min(ceiling, verdict)` a scheduled lane runs: a ladder may
    choose WITHIN an operator's grant and can never widen it. Total by
    construction — there is no pair of profiles for which it has no answer,
    and the fallback direction is always downward.
    """
    return profile if profile_within_ceiling(profile, ceiling) else ceiling

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
_NON_FILE_PROFILE_SURFACES: frozenset[str] = frozenset({
    # Action authority surfaces that are not a direct file path in the
    # manifest but remain first-class profile gates.
    "pr_open",
    "pr_merge",
    "spine_orchestrator",
    "tool_lifecycle",
    "governance",
})

PLAN_020_WRITE_SURFACES: frozenset[str] = (
    profile_surfaces() | _NON_FILE_PROFILE_SURFACES
)


# Plan 026R §A.4 — diagnostic-class write surfaces that bypass the
# frozen no-write enforcement BY ARCHITECTURAL DESIGN.
#
# These surfaces exist to RECORD operational failures during incident
# response: ``ledger_corruption_diagnostic`` (Plan 024 §H-7) writes to
# ``aria-tools/diagnostics/ledger-corruption.jsonl`` whenever a ledger
# read encounters a corrupt row; ``diagnostic_sink_fallback`` is the
# stderr fallback path when the diagnostic sink itself cannot be
# written. Blocking either under frozen profile would silently destroy
# the observability frozen-mode is specifically designed to preserve.
#
# Membership is the SSoT — only surfaces declared here may bypass
# frozen enforcement. New diagnostic writers MUST be added here AND
# their owning module MUST emit through the recursion-safe sink path
# (``diagnostics.emit_ledger_corruption_diagnostic`` is the canonical
# example).
DIAGNOSTIC_ALLOWLIST: frozenset[str] = frozenset({
    "ledger_corruption_diagnostic",
    "diagnostic_sink_fallback",
})

# Observe-mode allowlist (Plan v3.3 §Phase 1.B + §A.4 update).
# A surface NOT in this set is BLOCKED under observe.
#
# §A.4 NOTE: ``tool_governance`` is added so observe-mode flows that
# record observation-class governance events (handoff snapshot persist,
# instinct candidate record, surface validator audit log) keep working.
# Governance events are observation-class — they RECORD what happened,
# they do NOT enact change — so they belong in the observe permission
# set even though the underlying surface_kind is now gated for frozen.
OBSERVE_PERMITTED_SURFACES: frozenset[str] = observe_permitted_profile_surfaces()

# Union of every surface_kind the validator recognises. A surface_kind that
# is neither plan-020-protected nor observe-permitted nor on the
# DIAGNOSTIC_ALLOWLIST is rejected as "unknown surface" — a typo in a
# caller raises a loud error rather than silently passing.
KNOWN_WRITE_SURFACES: frozenset[str] = (
    PLAN_020_WRITE_SURFACES | OBSERVE_PERMITTED_SURFACES | DIAGNOSTIC_ALLOWLIST
)


def _profile_state_file(base_dir: str | Path | None = None) -> Path:
    return tools_dir(base_dir) / PROFILE_STATE_FILENAME


def _profile_history_file(base_dir: str | Path | None = None) -> Path:
    return tools_dir(base_dir) / PROFILE_HISTORY_FILENAME


FROZEN_PROFILE: str = "frozen"


def _read_profile_state(
    base_dir: str | Path | None = None,
) -> tuple[dict[str, Any] | None, Path | None, dict[str, Any] | None]:
    """The ONE parser for ``runtime-profile.json``.

    Returns ``(payload, state_file, diagnostic)``. ``payload`` is None on the
    documented bootstrap paths (tools dir not bound, state file absent) AND
    on a read/parse failure — the two are told apart by ``diagnostic``, which
    is non-None only for the latter.

    ORPHAN-HIGH-728 — extracted when the state file gained a second governed
    field (`scheduler_profile_ceiling`). Two readers of one file is how the
    active profile and its ceiling would come to disagree about what the file
    says; one reader makes that impossible rather than unlikely.

    Read-only by construction: `ensure_tools_dir_readonly`, so a frozen
    kernel can answer both questions without bootstrapping anything.
    """
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return None, None, None
    state_file = root / PROFILE_STATE_FILENAME
    if not state_file.exists():
        return None, state_file, None
    try:
        raw = state_file.read_text(encoding="utf-8")
    except OSError as exc:
        return None, state_file, {
            "kind": "runtime_profile_read_failure",
            "path": str(state_file),
            "error": str(exc),
        }
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, state_file, {
            "kind": "runtime_profile_parse_failure",
            "path": str(state_file),
            "error": str(exc),
        }
    if not isinstance(payload, dict):
        return None, state_file, {
            "kind": "runtime_profile_parse_failure",
            "path": str(state_file),
            "error": f"state file is {type(payload).__name__}, expected object",
        }
    return payload, state_file, None


def get_profile_with_diagnostic(
    *,
    base_dir: str | Path | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """Plan 024 §B-4 — fail-closed profile resolution with diagnostic.

    Returns (profile_name, diagnostic) where diagnostic is non-None when
    the resolution had to fall back to FROZEN_PROFILE. Pure read; never
    emits governance events itself (the write-boundary callers consume
    the diagnostic and emit at the boundary, preserving the read-only
    invariant of the file at line 174-176 docstring).

    Resolution semantics:
    - tools dir absent / not bound → ('standard', None) — documented
      bootstrap path; you cannot reach frozen without set_profile, so
      "no state file" implies "never set" which means default standard.
    - state file absent → ('standard', None) — same bootstrap path.
    - OSError reading state file → ('frozen', read_failure diagnostic)
      — fail-closed; an operator deploying with intent 'frozen' must
      not silently flip to 'standard' just because the file is
      unreadable.
    - JSONDecodeError → ('frozen', parse_failure diagnostic) — same.
    - active_profile not in PROFILES → ('frozen',
      unknown_active_profile diagnostic) — typo or schema drift
      should fail-loud, not silently degrade to standard.
    - Valid profile → (profile_name, None).
    """
    payload, state_file, diagnostic = _read_profile_state(base_dir)
    if diagnostic is not None:
        return FROZEN_PROFILE, diagnostic
    if payload is None:
        return DEFAULT_PROFILE, None
    active = payload.get("active_profile")
    if not isinstance(active, str) or active not in PROFILES:
        return FROZEN_PROFILE, {
            "kind": "runtime_profile_unknown_active_profile",
            "path": str(state_file),
            "active_profile": active,
        }
    return active, None


def get_scheduler_profile_ceiling_with_diagnostic(
    *,
    base_dir: str | Path | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """ORPHAN-HIGH-728 — the operator-recorded ceiling, plus why if defaulted.

    Fail-CLOSED in the direction that matters: every failure mode returns
    ``DEFAULT_SCHEDULER_PROFILE_CEILING``, the LOWEST grant a scheduled lane
    gets, so an unreadable or hand-mangled state file can only ever narrow a
    machine's authority. The diagnostic is returned rather than emitted
    because this is a read path a frozen kernel must be able to take without
    writing (the same reason `get_profile` routes through
    `ensure_tools_dir_readonly`).

    A ceiling that is ABSENT is not a fault — it is every store that predates
    this field, and `standard` is the honest reading of "no operator has
    granted a scheduled lane anything".
    """
    payload, state_file, diagnostic = _read_profile_state(base_dir)
    if diagnostic is not None:
        return DEFAULT_SCHEDULER_PROFILE_CEILING, diagnostic
    if payload is None:
        return DEFAULT_SCHEDULER_PROFILE_CEILING, None
    raw = payload.get(SCHEDULER_CEILING_STATE_KEY)
    if raw is None:
        return DEFAULT_SCHEDULER_PROFILE_CEILING, None
    if not isinstance(raw, str) or raw not in PROFILES:
        return DEFAULT_SCHEDULER_PROFILE_CEILING, {
            "kind": "scheduler_profile_ceiling_unknown",
            "path": str(state_file),
            "scheduler_profile_ceiling": raw,
        }
    return raw, None


def get_scheduler_profile_ceiling(*, base_dir: str | Path | None = None) -> str:
    """The operator-recorded ceiling a scheduled lane must resolve within."""
    ceiling, _diagnostic = get_scheduler_profile_ceiling_with_diagnostic(
        base_dir=base_dir,
    )
    return ceiling


def get_profile(*, base_dir: str | Path | None = None) -> str:
    """Read the current active profile.

    Plan 024 §B-4 — fail-closed delegation. Pre-fix this function
    silently returned DEFAULT_PROFILE ('standard') on read/parse/
    unknown-name failures, which let an operator deploying intent
    'frozen' silently flip to write-enabled. Now corruption /
    unknown-name paths return FROZEN_PROFILE; the diagnostic is
    discarded here (callers wanting governance emission use
    get_profile_with_diagnostic + enforce_profile_for_action).

    Frozen-aware: routes through ensure_tools_dir_readonly so a fresh
    sandbox under frozen does not silently break the no-write
    invariant by triggering tools_root_bootstrapped governance.

    Returns DEFAULT_PROFILE ('standard') only when:
    - tools dir does not exist or is not bound, OR
    - state file is absent (bootstrap path).
    Returns FROZEN_PROFILE ('frozen') when:
    - state file is unreadable (OSError),
    - state file is malformed (JSONDecodeError),
    - persisted profile name is unknown.
    """
    profile, _diagnostic = get_profile_with_diagnostic(base_dir=base_dir)
    return profile


def set_profile(
    profile: str,
    *,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
    set_by: str = OPERATOR_SET_BY,
    scheduler_ceiling: str | None = None,
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

    ORPHAN-HIGH-728 — ``scheduler_ceiling`` is the OPERATOR GRANT an
    unattended lane resolves within. Two rules make it one:

    - ``None`` CARRIES THE CURRENT VALUE FORWARD. Every ordinary profile
      transition — including the one a nightly lane records for its own run —
      leaves the ceiling exactly as the operator left it. Silently resetting
      it to the default on each transition would let a machine erase a grant
      by doing its normal work.
    - a setter that is not the operator (``set_by != OPERATOR_SET_BY``) may
      LOWER the ceiling and may not raise it, and may not persist an active
      profile that reaches past it: `aria-kernel autonomy run --profile
      strict` cannot mint its own strict authority, whoever runs it, until an
      operator has recorded the ceiling with `profile set`.

    What that guard IS and IS NOT, stated plainly because an authority claim
    that oversells itself is worse than none. ``set_by`` is a self-declared
    string in the same trust domain as the caller, so this does not stop a
    process that lies about being an operator — no in-process check could.
    What it stops is DRIFT: the scheduled lane's own code path declares
    itself (`cli.py` passes ``"autonomy-cli"``), so it is bounded by default,
    and every future machine caller that declares itself honestly is bounded
    without anyone remembering to add it anywhere. Escaping the bound
    requires editing a callsite to misdeclare who is asking, which is a
    reviewable act rather than an accident.

    Writes:
    - aria-tools/runtime-profile.json (atomic write of state).
    - aria-tools/runtime-profile-history.jsonl (append-only history row).
    - aria-tools/governance.jsonl (runtime_profile_changed event).
    """
    if profile not in PROFILES:
        raise GovernanceError(
            f"unknown profile: {profile!r} (must be one of {PROFILES})"
        )
    if scheduler_ceiling is not None and scheduler_ceiling not in PROFILES:
        raise GovernanceError(
            f"unknown scheduler ceiling: {scheduler_ceiling!r} "
            f"(must be one of {PROFILES})"
        )
    if not (operator_approval_ref or "").strip():
        raise GovernanceError("runtime_profile_change_requires_approval")
    # Control-plane writer path: do NOT route through enforce_profile_for_write.
    root = ensure_tools_dir(base_dir)
    previous_profile = get_profile(base_dir=root)
    previous_ceiling = get_scheduler_profile_ceiling(base_dir=root)
    is_operator = set_by == OPERATOR_SET_BY
    if scheduler_ceiling is None:
        active_ceiling = previous_ceiling
    else:
        if not is_operator and not profile_within_ceiling(
            scheduler_ceiling, previous_ceiling,
        ):
            raise GovernanceError(
                "scheduler_ceiling_raise_requires_operator: "
                f"set_by={set_by!r} tried to raise the ceiling from "
                f"{previous_ceiling!r} to {scheduler_ceiling!r}; only an "
                "operator gesture (`aria-kernel profile set "
                "--scheduler-ceiling`) may widen it"
            )
        active_ceiling = scheduler_ceiling
    if not is_operator and not profile_within_ceiling(profile, active_ceiling):
        raise GovernanceError(
            "profile_exceeds_scheduler_ceiling: "
            f"set_by={set_by!r} requested profile {profile!r}, which permits "
            f"{sorted(permitted_actions(profile) - permitted_actions(active_ceiling))} "
            f"beyond the operator-recorded ceiling {active_ceiling!r}"
        )
    state = {
        "active_profile": profile,
        "previous_profile": previous_profile,
        SCHEDULER_CEILING_STATE_KEY: active_ceiling,
        "previous_scheduler_profile_ceiling": previous_ceiling,
        "set_at": utc_now(),
        "set_by": set_by,
        "operator_approval_ref": operator_approval_ref,
    }
    state_file = root / PROFILE_STATE_FILENAME
    rewrite_declared_json(
        state_file,
        state,
        expected_surface="runtime_profile_state",
        bypass_profile_gate=True,
    )
    history_row = {
        "$schema": "aria/runtime-profile-history/v1",
        "schema_version": 1,
        **state,
    }
    append_declared_jsonl(
        _profile_history_file(root),
        history_row,
        expected_surface="runtime_profile_history",
        bypass_profile_gate=True,
    )
    # Plan 026R §A.4 — control-plane exception: set_profile is the ONE
    # path that may emit a governance event under any profile (the
    # operator MUST be able to THAW a frozen kernel, which itself
    # records via runtime_profile_changed). bypass_profile_gate=True
    # documents the exception explicitly per the §A.4 SSoT.
    append_tools_governance(
        root,
        "runtime_profile_changed",
        {
            "previous_profile": previous_profile,
            "active_profile": profile,
            "previous_scheduler_profile_ceiling": previous_ceiling,
            SCHEDULER_CEILING_STATE_KEY: active_ceiling,
            "operator_approval_ref": operator_approval_ref,
            "set_by": set_by,
        },
        bypass_profile_gate=True,
    )
    return state


def list_profile_history(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Return the append-only profile transition history (oldest → newest).

    Frozen-aware read path (ensure_tools_dir_readonly). Returns [] when no
    history file exists.

    Plan 026R §A.3 forward-fix (caught by reviewer-A.3): this is the 11th
    JSONL ledger reader in the kernel, missed by the original §A.3 sweep
    because the file-level allowlist entry for ``runtime_profile.py`` was
    written for the SINGLE-ROW state-file parser at lines 215-222. The
    ledger here is a multi-row append-only audit trail of profile
    transitions — silent-skip on a corrupt history row would understate
    the audit count operator dashboards depend on. Strict-by-default via
    ``read_strict_jsonl``.
    """
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    history_file = root / PROFILE_HISTORY_FILENAME
    from .strict_jsonl_reader import read_strict_jsonl
    return list(read_strict_jsonl(history_file, base_dir=root))


def _emit_runtime_profile_diagnostic(
    diagnostic: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> None:
    """Plan 024 §B-4 — best-effort governance event emission from the
    write boundary. The diagnostic surfaces from get_profile_with_-
    diagnostic when the read-side has fallen back to FROZEN_PROFILE
    due to read failure / parse failure / unknown active_profile.

    Best-effort: if append_tools_governance itself raises (e.g. tools
    dir cannot be bootstrapped under the frozen fallback we just
    triggered), the failure is swallowed — the protective effect of
    returning FROZEN_PROFILE is what matters; the audit event is the
    secondary observability surface.
    """
    try:
        root = ensure_tools_dir(base_dir)
        # Plan 026R §A.4 — diagnostic emit IS the control-plane
        # observability surface for corrupt-profile detection; the
        # frozen/observe write gate would silently destroy the very
        # event the operator audit trail needs. bypass_profile_gate
        # documents this as an architectural exception (mirrors
        # set_profile's own bypass).
        append_tools_governance(
            root, diagnostic["kind"], diagnostic,
            bypass_profile_gate=True,
        )
    except Exception:
        pass


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

    Plan 024 §B-4 — when get_profile falls back to FROZEN_PROFILE due
    to corrupt / unknown state file, the diagnostic is best-effort
    emitted as a governance event so the operator audit trail
    captures why the gate is now refusing. The rejection itself is
    deterministic; the event is observability.

    Returns the active profile name on success.

    Raises GovernanceError('profile_violation: ...') on rejection.
    Raises GovernanceError on unknown action_kind (typo guard).
    """
    permitted = ACTION_PERMISSIONS.get(action_kind)
    if permitted is None:
        raise GovernanceError(f"unknown profile action_kind: {action_kind!r}")
    profile, diagnostic = get_profile_with_diagnostic(base_dir=base_dir)
    if diagnostic is not None:
        _emit_runtime_profile_diagnostic(diagnostic, base_dir=base_dir)
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
    # Plan 026R §A.4 — DIAGNOSTIC_ALLOWLIST surfaces (corruption sink +
    # stderr fallback) bypass every profile check by architectural
    # design. They are the SSoT for "writes incident-response needs
    # even under frozen". Returning early avoids any state-file read
    # that could itself fail and lose the diagnostic.
    if surface_kind in DIAGNOSTIC_ALLOWLIST:
        return get_profile(base_dir=base_dir)
    # Plan 024 §B-4 — emit best-effort diagnostic at this write
    # boundary too, so corrupt-profile audit trail captures both
    # action and write paths.
    profile, diagnostic = get_profile_with_diagnostic(base_dir=base_dir)
    if diagnostic is not None:
        _emit_runtime_profile_diagnostic(diagnostic, base_dir=base_dir)
    if profile == "frozen":
        # Plan 020 frozen scope (extended by §A.4 to 22 surfaces, was 14):
        # every PLAN_020_WRITE_SURFACES write blocked. Surfaces in
        # OBSERVE_PERMITTED_SURFACES that are NOT also in
        # PLAN_020_WRITE_SURFACES fall through — they are observation-
        # class and not blocked by frozen.
        if surface_kind in PLAN_020_WRITE_SURFACES:
            raise GovernanceError(
                f"profile_violation: surface {surface_kind!r} blocked under "
                f"frozen profile (Plan 020/026R scope)"
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
    "DEFAULT_SCHEDULER_PROFILE_CEILING",
    "FROZEN_PROFILE",
    "OPERATOR_SET_BY",
    "SCHEDULER_CEILING_STATE_KEY",
    "SCHEDULER_MAX_PROPOSABLE_PROFILE",
    "ACTION_PERMISSIONS",
    "PROFILES_WITH_ACTION_AUTHORITY",
    "permitted_actions",
    "profile_within_ceiling",
    "bound_profile_to_ceiling",
    "get_scheduler_profile_ceiling",
    "get_scheduler_profile_ceiling_with_diagnostic",
    "PLAN_020_WRITE_SURFACES",
    "OBSERVE_PERMITTED_SURFACES",
    "DIAGNOSTIC_ALLOWLIST",
    "KNOWN_WRITE_SURFACES",
    "PROFILE_STATE_FILENAME",
    "PROFILE_HISTORY_FILENAME",
    "get_profile",
    "get_profile_with_diagnostic",
    "set_profile",
    "list_profile_history",
    "enforce_profile_for_action",
    "enforce_profile_for_write",
]
