"""JJ-2b (ORPHAN-HIGH-732) — SHADOW → ACTIVE is panel-approved with a
24-hour operator VETO window.

WHY THIS EXISTS
  ``promotion.promote_tool`` recognised exactly two authorities: a signed
  operator approval ref, or the V6.4 auto-promote token (disabled by policy
  default). Both leave a human on the critical path — the first by
  construction, the second because only the operator flips the policy. The
  operator directive of 2026-08-18 inverts the default: the independent
  agent panel (the Y7/Y8 machinery in ``human_required_adjudication``)
  APPROVES, and the operator keeps a VETO he does not have to exercise.
  Silence for 24 hours is consent; a veto inside the window kills the
  promotion outright.

  Consent-by-silence is only safe because the veto is CHEAP and LOUD: the
  pending row is a governance event on the ledger the operator already
  reads, and the CLI verb (`tool veto-promotion`) needs no ceremony.

THE KERNEL-SCOPE EXCEPTION IS NOT NEGOTIABLE
  An adapter whose declared scope touches ``aria-kernel/**`` reads ARIA's
  own control plane. Promoting it is ARIA widening its own authority, which
  is the same irreducible class ``human_required_adjudication`` refuses to
  let a panel clear (profile transitions, credentials, governance
  overrides). Such a tool can never obtain a panel token — the refusal is
  at MINT time, where the scope is readable, rather than at consume time
  where a caller could route around it.

STATE IS LEDGER-DERIVED, NEVER ASSERTED
  There is no pending-promotion file. The registry row cannot hold the
  state either: ``_phase_tool_manifest_sync`` re-registers every manifest
  each cycle and ``register_tool`` REPLACES the row, so a field parked
  there would be silently erased and the 24h clock would restart forever.
  The three events below are appended to ``governance.jsonl`` — the audit
  ledger tool lifecycle already writes to — and the live state is folded
  from them, so the audit trail and the state can never disagree.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .adapter_calibration import _derive_workspace_key
from .governance_reader import read_governance_rows
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    get_tool,
    utc_now,
)


# 24 hours: the operator directive's own number. Long enough that a person
# who checks once a day cannot miss a promotion, short enough that the
# night-to-night cadence still advances without him.
VETO_WINDOW_HOURS: int = 24

PENDING_KIND: str = "adapter_promotion_pending_veto"
VETOED_KIND: str = "adapter_promotion_vetoed"
ACTIVATED_KIND: str = "adapter_promotion_veto_window_elapsed"
EXPIRED_KIND: str = "adapter_promotion_pending_expired"

# Control-plane paths the exception is about. A tool is kernel-scoped when
# its declared scope would let it READ any of these — decided by the same
# five-tier glob evaluator the sandbox uses at runtime
# (``tool_health.find_scope_violations``), never by matching the glob TEXT.
# The pre-fix predicate was ``text.startswith("aria-kernel")``, which is
# False for ``**``, ``**/*.py``, ``./**`` and ``{apps,aria-kernel}/**`` —
# every one of which grants kernel reads. An exception a caller can step
# around by spelling its scope differently is not an exception.
KERNEL_PROBE_PATHS: tuple[str, ...] = (
    "aria-kernel/aria_kernel/cycle.py",
    "aria-kernel/tests/test_cycle.py",
    "aria-kernel/pyproject.toml",
)

PENDING_STATUS: str = "PENDING_OPERATOR_VETO"

# JJ-2b + the reviewer's #8 — an armed window does not stay armed forever.
# ``settle_pending_promotions`` re-checks readiness every cycle and simply
# retried on failure, with no upper bound: a promotion refused for weeks on
# a regressed adapter would activate silently the day readiness returned, on
# a panel decision and a veto window that both elapsed long ago. A week of
# failed re-checks past the deadline is not a transient — the panel's
# picture of the adapter is stale, and a stale approval must expire rather
# than wait. Re-asking is the decision-questioning lane's deliberate act
# (the same rule promotion_panel's one-question-per-adapter sweep follows),
# never an automatic re-arm on the old panel's authority.
PENDING_EXPIRY_WINDOWS: int = 7
PENDING_MAX_AGE_HOURS: int = VETO_WINDOW_HOURS * PENDING_EXPIRY_WINDOWS


class PanelApprovalIneligibleError(GovernanceError):
    """The panel path cannot vouch for this promotion (yet, or ever).

    Mirrors ``adapter_calibration.AutoPromoteIneligibleError``: ineligibility
    is the governance working, so it is raised with the reason rather than
    swallowed into a silent no-op.
    """


def _governance_path(root: Path) -> Path:
    return root / "governance.jsonl"


def tool_scope_touches_kernel(tool: dict[str, Any]) -> bool:
    """True when the tool's scope would let it read ANY control-plane path.

    Reads BOTH ``declared_scope`` (what the tool says it examines) and
    ``allowed_read_globs`` (what the sandbox will actually let it read):
    a tool that declares a narrow scope but is allowed to read the kernel
    is kernel-scoped in the only sense that matters at runtime.

    The verdict comes from ``tool_health.find_scope_violations`` — the
    evaluator that decides the same question for every real run — so the
    exception cannot be defeated by scope SPELLING. ANY reachable probe is
    enough (not all of them): ``aria-kernel/aria_kernel/**/*.py`` reaches
    the kernel source and nothing else, and that is already ARIA reading its
    own control plane. A tool with no allow list at all is permissive by the
    evaluator's legacy tier, so it reads as kernel-scoped and stays with the
    operator — fail-closed is the only safe direction for this gate.
    """
    from .tool_health import find_scope_violations

    probe = {
        "allowed_read_globs": (
            list(tool.get("declared_scope") or [])
            + list(tool.get("allowed_read_globs") or [])
        ),
        "forbidden_read_globs": list(tool.get("forbidden_read_globs") or []),
    }
    violations = find_scope_violations(probe, list(KERNEL_PROBE_PATHS))
    return len(violations) < len(KERNEL_PROBE_PATHS)


def _parse_ts(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def pending_promotion(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """The live pending promotion for a tool, folded from the ledger.

    A pending row is live until a VETO, an ACTIVATION or an EXPIRY event
    appears AFTER it. Folding forward (rather than reading the last row of
    any kind) is what makes a re-armed promotion after a veto behave
    correctly: the veto kills the pending row it followed, not every future
    one.
    """
    root = ensure_tools_dir(base_dir)
    live: dict[str, Any] | None = None
    for row in read_governance_rows(_governance_path(root), base_dir=root):
        kind = row.get("kind")
        if kind not in (PENDING_KIND, VETOED_KIND, ACTIVATED_KIND, EXPIRED_KIND):
            continue
        details = row.get("details") or {}
        if str(details.get("tool_id") or "") != tool_id:
            continue
        if kind == PENDING_KIND:
            live = {**details, "recorded_at": row.get("ts")}
        else:
            live = None
    return live


def resolve_panel_approval(
    *,
    tool_id: str,
    panel_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Kernel-computed proof that a panel approved THIS tool's promotion.

    The pre-fix gate accepted any non-empty string as "panel approval", so
    ``promote_tool(tool_id, "ACTIVE", panel_approval_ref="anything")`` armed
    a veto window and a later cycle activated the adapter — on a workspace
    with no ``human-required/`` directory at all. The ref is a claim about
    an adjudication that either happened or did not; the kernel now reads
    the record instead of the caller's word for it.

    Shared with the genesis lane by construction (i1): the checks are
    ``human_required.resolve_panel_adjudication_proof``, one resolver, so a
    clause added for one authority cannot be missing from the other.
    ``context.tool_id`` must match, so a real panel approval for adapter A
    cannot be replayed to promote adapter B.
    """
    from .human_required import resolve_panel_adjudication_proof
    from .promotion_panel import PROMOTION_CONTEXT_KIND

    return resolve_panel_adjudication_proof(
        adjudication_ref=str(panel_approval_ref or ""),
        expected_kind=PROMOTION_CONTEXT_KIND,
        context_match={"tool_id": tool_id},
        error_prefix="tool_promotion_panel",
        base_dir=base_dir,
    )


def record_pending_promotion(
    *,
    tool_id: str,
    panel_approval_ref: str,
    reason: str,
    readiness: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Arm the veto window. Idempotent on a live pending row.

    Idempotency is the load-bearing part: this runs from a cycle phase, and
    a fresh pending row each cycle would reset the deadline every night —
    the promotion would be permanently 24 hours away and the lane would look
    alive while never activating anything.

    The panel ref is RESOLVED before anything is armed: an armed window is
    already an authority (silence activates it), so it may only ever rest on
    an adjudication record that exists, was resolved by the panel, for this
    tool, and in which the panel said YES. That last clause is the one a
    refusal satisfies otherwise: a rejected promotion closes its record the
    same way an approved one does.
    """
    root = ensure_tools_dir(base_dir)
    proof = resolve_panel_approval(
        tool_id=tool_id, panel_approval_ref=panel_approval_ref, base_dir=root,
    )
    existing = pending_promotion(tool_id=tool_id, base_dir=root)
    if existing is not None:
        return {**existing, "status": PENDING_STATUS, "armed": False}
    deadline = datetime.now(timezone.utc) + timedelta(hours=VETO_WINDOW_HOURS)
    details = {
        "tool_id": tool_id,
        "target_status": "ACTIVE",
        "panel_approval_ref": panel_approval_ref,
        "panel_adjudication_resolved_at": proof.get("resolved_at"),
        "reason": reason,
        "veto_deadline": deadline.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "veto_window_hours": VETO_WINDOW_HOURS,
        "armed_at": utc_now(),
        # The readiness picture the panel approved against. Re-checked at
        # settle time; carried here so a veto decision can be audited
        # against what was true when the window opened.
        "readiness_blockers_at_arm": list(readiness.get("blocked_by") or []),
        "precision_at_arm": readiness.get("precision"),
        "anchor_judged_at_arm": readiness.get("anchor_judged_count"),
    }
    append_tools_governance(root, PENDING_KIND, details)
    return {**details, "status": PENDING_STATUS, "armed": True}


def _pending_expiry(pending: dict[str, Any]) -> datetime | None:
    """When an armed-but-unsettled promotion stops being an authority.

    None when the deadline is unreadable — a pending row nobody can date is
    refused at token mint anyway, and expiring it on a parse failure would
    turn an unreadable field into a silent state change.
    """
    deadline = _parse_ts(pending.get("veto_deadline"))
    if deadline is None:
        return None
    return deadline + timedelta(hours=PENDING_MAX_AGE_HOURS)


def veto_promotion(
    *,
    tool_id: str,
    reason: str,
    operator_ref: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The operator's one required move — and only if he disagrees."""
    if not str(reason or "").strip():
        raise GovernanceError("veto reason is required")
    root = ensure_tools_dir(base_dir)
    pending = pending_promotion(tool_id=tool_id, base_dir=root)
    if pending is None:
        raise GovernanceError(
            f"no_pending_promotion_to_veto: tool_id={tool_id!r}"
        )
    details = {
        "tool_id": tool_id,
        "reason": reason,
        "operator_ref": operator_ref,
        "panel_approval_ref": pending.get("panel_approval_ref"),
        "veto_deadline": pending.get("veto_deadline"),
        "vetoed_at": utc_now(),
    }
    append_tools_governance(root, VETOED_KIND, details)
    return {"status": "VETOED", **details}


def compute_panel_approval_token(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> str:
    """Mint the third promotion authority, or refuse with the reason.

    Every gate that makes panel approval legitimate is checked HERE, at
    mint time, because this is the only place the tool, the panel ref and
    the clock are all in scope. A caller holding a token has, by
    construction, a kernel-scope-free tool with a REAL panel APPROVAL — not
    merely a real adjudication — and an expired, un-vetoed veto window.

    The panel ref is re-resolved here and not trusted from the pending row:
    this function's own docstring promises every legitimacy gate is checked
    at mint time, and "the record still says the panel APPROVED this" is one
    of them. An adjudication withdrawn, re-opened or re-folded into a
    refusal after arming must not activate anything.
    """
    root = ensure_tools_dir(base_dir)
    tool = get_tool(tool_id, root)
    if tool_scope_touches_kernel(tool):
        raise PanelApprovalIneligibleError(
            f"kernel_scope_promotion_requires_operator: tool_id={tool_id!r} "
            f"declares scope inside aria-kernel/**; an agent panel may not "
            f"widen ARIA's authority over its own control plane"
        )
    pending = pending_promotion(tool_id=tool_id, base_dir=root)
    if pending is None:
        raise PanelApprovalIneligibleError(
            f"no_pending_promotion: tool_id={tool_id!r}"
        )
    try:
        proof = resolve_panel_approval(
            tool_id=tool_id,
            panel_approval_ref=str(pending.get("panel_approval_ref") or ""),
            base_dir=root,
        )
    except PanelApprovalIneligibleError:
        raise
    except GovernanceError as exc:
        # Ineligibility is this module's vocabulary (mirrors promotion.py
        # mapping AutoPromoteIneligibleError): settle_pending_promotions
        # records a refusal per tool instead of the whole cycle phase dying
        # on one adapter's unprovable panel ref.
        raise PanelApprovalIneligibleError(str(exc)) from exc
    deadline = _parse_ts(pending.get("veto_deadline"))
    if deadline is None:
        raise PanelApprovalIneligibleError(
            f"pending_promotion_deadline_unreadable: tool_id={tool_id!r}"
        )
    moment = now or datetime.now(timezone.utc)
    if moment < deadline:
        raise PanelApprovalIneligibleError(
            f"veto_window_open: tool_id={tool_id!r} until "
            f"{pending.get('veto_deadline')}"
        )
    payload = json.dumps({
        "tool_id": tool_id,
        "panel_approval_ref": pending.get("panel_approval_ref"),
        "panel_adjudication_resolved_at": proof.get("resolved_at"),
        "armed_at": pending.get("armed_at"),
        "veto_deadline": pending.get("veto_deadline"),
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    # i1 — ONE workspace-key derivation for both promotion tokens. The copy
    # that used to live here was byte-identical to the auto-promote lane's;
    # two copies of a security primitive are two things to fix when
    # consume-time verification lands.
    return hmac.new(_derive_workspace_key(root), payload, hashlib.sha256).hexdigest()


def settle_pending_promotions(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Activate every promotion whose veto window elapsed un-vetoed.

    Runs from the cycle phase that already sweeps tool lifecycle/registry
    state (``_phase_tool_manifest_sync``) rather than from a phase of its
    own: the window is a property of the registry's lifecycle, and a
    separate phase would be a second place to forget.

    Readiness is RE-EVALUATED here, not trusted from arm time. Twenty-four
    hours is long enough for the adapter to crash, drift out of its
    freshness window, or collect a critical false positive; activating on a
    day-old picture would make the veto window a hole in the gate rather
    than a check on it.
    """
    from .tool_registry import list_tools

    root = ensure_tools_dir(base_dir)
    activated: list[str] = []
    still_pending: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    expired: list[dict[str, Any]] = []
    moment = datetime.now(timezone.utc)
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("status") != "SHADOW":
            continue
        pending = pending_promotion(tool_id=tool_id, base_dir=root)
        if pending is None:
            continue
        expiry = _pending_expiry(pending)
        if expiry is not None and moment > expiry:
            append_tools_governance(root, EXPIRED_KIND, {
                "tool_id": tool_id,
                "panel_approval_ref": pending.get("panel_approval_ref"),
                "veto_deadline": pending.get("veto_deadline"),
                "expired_at": utc_now(),
                "max_age_hours": PENDING_MAX_AGE_HOURS,
                "cycle_id": cycle_id,
            })
            expired.append({
                "tool_id": tool_id, "veto_deadline": pending.get("veto_deadline"),
            })
            continue
        try:
            token = compute_panel_approval_token(tool_id=tool_id, base_dir=root)
        except PanelApprovalIneligibleError as exc:
            if str(exc).startswith("veto_window_open"):
                still_pending.append({
                    "tool_id": tool_id, "veto_deadline": pending.get("veto_deadline"),
                })
            else:
                refused.append({"tool_id": tool_id, "reason": str(exc)[:200]})
            continue
        try:
            _activate_panel_approved(
                tool_id=tool_id, pending=pending, token=token,
                cycle_id=cycle_id, root=root,
            )
            activated.append(tool_id)
        except GovernanceError as exc:
            refused.append({"tool_id": tool_id, "reason": str(exc)[:200]})
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "activated": activated,
        "still_pending": still_pending,
        "refused": refused,
        "expired": expired,
    }


def _activate_panel_approved(
    *,
    tool_id: str,
    pending: dict[str, Any],
    token: str,
    cycle_id: str | None,
    root: Path,
) -> dict[str, Any]:
    from .readiness import adapter_active_readiness
    from .tool_registry import transition_tool

    readiness = adapter_active_readiness(tool_id, base_dir=root)
    if not readiness["active_ready"]:
        raise GovernanceError(
            "panel_promotion_readiness_regressed: "
            + ", ".join(readiness["blocked_by"])
        )
    result = transition_tool(
        tool_id,
        "ACTIVE",
        reason=(
            f"panel_approved promotion, veto window elapsed "
            f"(panel={pending.get('panel_approval_ref')}, cycle {cycle_id})"
        ),
        base_dir=root,
        operator_approval=False,
        panel_approval_token=token,
        precision=1.0 if readiness["zero_finding_lane"] else readiness["precision"],
        critical_false_positives=readiness["critical_false_positives"],
        evidence_chains_valid=True,
    )
    append_tools_governance(root, ACTIVATED_KIND, {
        "tool_id": tool_id,
        "panel_approval_ref": pending.get("panel_approval_ref"),
        "veto_deadline": pending.get("veto_deadline"),
        "cycle_id": cycle_id,
    })
    return result


__all__ = [
    "ACTIVATED_KIND",
    "EXPIRED_KIND",
    "KERNEL_PROBE_PATHS",
    "PENDING_KIND",
    "PENDING_MAX_AGE_HOURS",
    "PENDING_STATUS",
    "VETOED_KIND",
    "VETO_WINDOW_HOURS",
    "PanelApprovalIneligibleError",
    "compute_panel_approval_token",
    "pending_promotion",
    "record_pending_promotion",
    "resolve_panel_approval",
    "settle_pending_promotions",
    "tool_scope_touches_kernel",
    "veto_promotion",
]
