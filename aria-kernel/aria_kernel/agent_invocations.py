from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .bridge_exceptions import BridgeContractViolation
from .file_lock import with_exclusive_lock
from .ledger import _append_jsonl_unlocked, append_jsonl, load_jsonl
from .runtime_profile import enforce_profile_for_action
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


ROLES = {
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "gap_finding",
    "implementation",
    "verification",
    "gap_closure",
    "maintenance_utility",
    # Plan 016 adds two roles routed through the strict v1 envelope.
    "implementation_review",
    # Plan 016 Faz C4 judge roles (envelope wraps existing
    # feedback_store.generate_ai_consensus + plan_convergence logic).
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    "change_intelligence",
    "goldset_curation",
    # Plan ARIA-V6 §2c V6.1 Phase 6.1 — Gate C Lane-A specialist
    # dispatch role. ~60 Lane-A domain experts (auth-security-expert,
    # farm-expert, edge-expert, etc.) consume this role envelope per
    # cycle when orchestrator's specialist_review_runner mints requests.
    # ci_executor extension claims these envelopes + spawns Claude
    # Code subprocesses; transform_specialist_output converts markdown
    # responses to ARIA findings schema.
    "specialist_domain_review",
}
STATUSES = {"completed", "rejected", "partial"}

# Plan 016 lease defaults (30 minute lease, 30 minute heartbeat extension,
# 2 requeues then HUMAN_REQUIRED).
DEFAULT_LEASE_SECONDS = 1800
DEFAULT_HEARTBEAT_EXTEND_SECONDS = 1800
DEFAULT_MAX_REQUEUES = 2
LEASE_TOKEN_BYTES = 24

# Derived states for a request when the queue layer is queried via
# derive_request_state(). The legacy `state` field on requests.jsonl rows
# stays "pending" / "completed" / etc; this enumeration is the Plan 016
# 10-state lifecycle as observed from the claims + results ledgers.
DERIVED_STATES = (
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "SUBMITTED",
    "ACCEPTED",
    "REJECTED",
    "STALE",
    "REQUEUED",
    "HUMAN_REQUIRED",
    "CANCELLED",
    # Plan 026R §C.5 — bridge-aware acceptance states.
    "ACCEPTED_PENDING_BRIDGE",
    "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL",
)


def create_agent_invocation_request(
    *,
    target_agent: str,
    role: str,
    suggested_prompt: str,
    must_satisfy: list[dict[str, Any]] | None = None,
    allowed_scope: list[str] | None = None,
    evidence_refs: list[str] | None = None,
    legacy_strict_fields_optional: bool = False,
    convergence_id: str | None = None,
    pressure_event_id: str | None = None,
    round_number: int | None = None,
    expected_output_path: str | None = None,
    base_dir: str | Path | None = None,
    finding_id: str | None = None,
    tool_id: str | None = None,
    run_id: str | None = None,
    judgment_group_id: str | None = None,
    enforce_context_budget: bool = False,
    context_repo_root: str | Path | None = None,
    context_window_tokens_override: int | None = None,
    role_cap_override: dict[str, float] | None = None,
    plan_revision_hash: str | None = None,
    # Plan ARIA-V3.1-B2 — V9 cycle + plan-source provenance threading.
    # Additive optional fields (no schema_version bump needed; legacy
    # readers ignore unknown keys, new readers see None for old rows).
    # The V3.1-A pressure_source_type flows from CyclePlanEnvelope.metadata
    # through the orchestrator into every agent invocation; cycle_id
    # binds the request to its originating autonomy cycle for V10.4
    # cost-attribution + V10.3-B endurance audit.
    cycle_id: str | None = None,
    pressure_source_type: str | None = None,
) -> dict[str, Any]:
    # Plan ARIA-V5 §3c v2 (B1 fix) — ``plan_revision_hash`` binds the
    # envelope to a specific plan revision so I-V5.1-03 can assert
    # primary + challenger envelopes share the same plan_revision_hash
    # AND convergence_id. Pre-V5 the envelope carried convergence_id
    # alone — primary↔challenger could refer to different revisions of
    # the same plan and the cross-review collusion check at
    # plan_convergence.py:473 would not catch it. The field is
    # optional (None = "not applicable") so legacy callers continue
    # to work; convergent_planning_bridge.py forwards a value on the
    # convergent-plan flow.
    if role not in ROLES:
        raise GovernanceError(f"unknown invocation role: {role}")
    if not target_agent.strip():
        raise GovernanceError("target_agent is required")
    if not suggested_prompt.strip():
        raise GovernanceError("suggested_prompt is required")
    # Plan 024 §B-2 — strict fields enforcement at write-side. The legacy
    # request schema lacked must_satisfy / allowed_scope, so a request
    # written without them entered the queue, was claimed via the strict
    # path, and the strict path's _strict_request_view (line ~964) silently
    # defaulted both to []. evidence_validator.py:291 only enforced
    # allowed_scope when non-empty, so a judge response with
    # satisfaction_matrix=[] passed consensus uncontested. Closing the
    # read-side default alone is not enough — the write-side must persist
    # the fields so future reads carry the same fail-closed contract.
    if not legacy_strict_fields_optional:
        missing = []
        if not must_satisfy:
            missing.append("must_satisfy")
        if not allowed_scope:
            missing.append("allowed_scope")
        if missing:
            raise GovernanceError(
                f"create_agent_invocation_request_strict_fields_required: "
                f"{missing} (set legacy_strict_fields_optional=True to opt out "
                f"with explicit operator approval)"
            )
    if evidence_refs is not None:
        if not isinstance(evidence_refs, list):
            raise GovernanceError(
                "create_agent_invocation_request_evidence_refs_must_be_list"
            )
        for ref in evidence_refs:
            if not isinstance(ref, str) or not ref.strip():
                raise GovernanceError(
                    "create_agent_invocation_request_evidence_refs_must_be_list_of_strings"
                )
    # Plan 020 Phase 2.B — opt-in context budget gate.
    # Default off (backward-compat for every existing caller). When True,
    # the gate audits request + agent .md + knowledge bookmark tokens
    # against the role-class cap (judges 0.35 / planners 0.55 / executors
    # 0.45 / emergency 0.65 / default 0.40) and raises GovernanceError on
    # cap aimed. Audit row goes to aria-tools/context-audits.jsonl
    # regardless of enforcement (read-only audit + write-ledger=True path).
    if enforce_context_budget:
        # Local import keeps the module-level import graph free of a
        # cycle: context_budget_gate imports runtime_profile which is fine,
        # but importing context_budget_gate at module level here would
        # bake in a hard dependency on the entire token-estimation path
        # for every legacy caller (each create_agent_invocation_request
        # call would pull tiktoken probing). Lazy import keeps the cost
        # to opt-in callers.
        from .context_budget_gate import enforce_context_budget as _enforce_ctx
        _enforce_ctx(
            request={"suggested_prompt": suggested_prompt, "must_satisfy": []},
            target_agent=target_agent,
            role=role,
            base_dir=base_dir,
            repo_root=context_repo_root,
            context_window_tokens_override=context_window_tokens_override,
            role_cap_override=role_cap_override,
        )
    root = ensure_tools_dir(base_dir)
    request_id = _request_id(target_agent, role, suggested_prompt, convergence_id, round_number)
    expected = expected_output_path or _default_expected_output_path(root, request_id, convergence_id, round_number, role)
    row: dict[str, Any] = {
        "$schema": "aria/agent-invocation-request/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": convergence_id,
        "pressure_event_id": pressure_event_id,
        "round_number": round_number,
        "role": role,
        "target_agent": target_agent,
        "suggested_prompt": suggested_prompt,
        "expected_output_path": expected,
        "state": "pending",
        "created_at": utc_now(),
        # Plan 024 §B-2 — persist strict fields on the request row so the
        # strict path reader sees actual matrices instead of empty defaults.
        # When the operator opts out via legacy_strict_fields_optional=True
        # the fields land as empty lists and the read-side reject still
        # fires on claim_request (request_state_legacy_unmigrated).
        "must_satisfy": list(must_satisfy or []),
        "allowed_scope": list(allowed_scope or []),
        "evidence_refs": list(evidence_refs or []),
        # Plan ARIA-V5 §3c v2 (B1 fix) — plan_revision_hash binds the
        # envelope to a specific plan revision so I-V5.1-03 can assert
        # primary + challenger envelopes share the hash for the same
        # convergence round. Defaults to None for non-convergent
        # callers (the request_state_legacy_unmigrated reject still
        # fires for legacy fields, not for this new optional field).
        "plan_revision_hash": plan_revision_hash,
        # Plan ARIA-V3.1-B2 — additive provenance fields. cycle_id
        # binds the request to its originating autonomy cycle;
        # pressure_source_type carries the V9.4 pressure ranking
        # source (operator_feedback / failing_ci / orphan_finding /
        # f_finding / git_diff) from CyclePlanEnvelope.metadata.
        # Legacy rows return None on read — no upcaster needed.
        "cycle_id": cycle_id,
        "pressure_source_type": pressure_source_type,
    }
    # Plan 024 §B-2 — when the caller opted out of strict enforcement,
    # emit a governance event capturing target_agent + role + missing
    # fields so the operator audit trail records every legacy creation.
    if legacy_strict_fields_optional and (not must_satisfy or not allowed_scope):
        append_tools_governance(
            root,
            "legacy_request_creation_without_strict_fields",
            {
                "request_id": request_id,
                "target_agent": target_agent,
                "role": role,
                "missing": [
                    name
                    for name, value in (
                        ("must_satisfy", must_satisfy),
                        ("allowed_scope", allowed_scope),
                    )
                    if not value
                ],
            },
        )
    # Plan 016 Faz C5/C6 — judgment_bridge.record_judge_verdict_from_response
    # requires tool_id, run_id, finding_id on the request when role is one
    # of JUDGE_ROLES. Persist them at request-creation time so the bridge
    # is a one-way translator over a complete envelope rather than a
    # caller-side patch-up.
    if finding_id is not None:
        row["finding_id"] = finding_id
    if tool_id is not None:
        row["tool_id"] = tool_id
    if run_id is not None:
        row["run_id"] = run_id
    if judgment_group_id is not None:
        row["judgment_group_id"] = judgment_group_id
    return append_jsonl(root / "agent-invocations" / "requests.jsonl", row)


def _submit_legacy_invocation_result_internal(
    *,
    request_id: str,
    output_path: str | Path,
    status: str = "completed",
    by: str | None = None,
    rejection_reason: str | None = None,
    base_dir: str | Path | None = None,
    operator_migration_approval_ref: str | None = None,
) -> dict[str, Any]:
    """Plan 024 §B-1 — INTERNAL migration helper. NOT a public submission
    surface.

    Submission MUST go through ``submit_claim_result`` (the lease-bound
    strict path) via the ``agent submit-result`` CLI. The legacy
    ``agent-invocations submit-result`` subparser was removed in Plan 024
    §B-1; this helper survives only so that ad-hoc operator-approved
    migration scripts can still write a backward-compatible legacy result
    row when the caller carries an ``operator_migration_approval_ref``.

    Every invocation emits a ``legacy_submit_path_invoked`` governance
    event with ``{request_id, operator_migration_approval_ref,
    caller_module}`` so audit trails capture who used the legacy helper.
    """
    # Plan 024 §B-1 — operator-approval gate. The bare CLI surface is gone
    # and the only legitimate caller now is a migration script that has
    # already received human sign-off; the kwarg captures that sign-off
    # in the governance ledger.
    if not operator_migration_approval_ref or not str(operator_migration_approval_ref).strip():
        raise GovernanceError(
            "legacy_submit_path_requires_operator_migration_approval"
        )
    if status not in STATUSES:
        raise GovernanceError("status must be completed, rejected, or partial")
    if status != "completed" and not (rejection_reason or "").strip():
        raise GovernanceError("rejection_reason is required unless status is completed")
    root = ensure_tools_dir(base_dir)
    # Plan 024 §B-1 — emit governance event before writing the legacy row
    # so the audit event lands even when the row write itself rejects on
    # path mismatch. caller_module is best-effort introspection; the
    # frame can be missing under some optimised interpreters.
    import inspect
    caller_module = "<unknown>"
    try:
        frame = inspect.currentframe()
        if frame is not None and frame.f_back is not None:
            caller_module = frame.f_back.f_globals.get("__name__", "<unknown>")
    except Exception:
        caller_module = "<unknown>"
    append_tools_governance(
        root,
        "legacy_submit_path_invoked",
        {
            "request_id": request_id,
            "operator_migration_approval_ref": operator_migration_approval_ref,
            "caller_module": caller_module,
        },
    )
    request = _find_request(root, request_id)
    expected = _resolve_for_compare(request.get("expected_output_path"))
    actual = _resolve_for_compare(output_path)
    if expected != actual:
        event = append_tools_governance(
            root,
            "agent_invocation_path_mismatch",
            {"request_id": request_id, "expected_output_path": str(expected), "output_path": str(actual)},
        )
        return {"schema_version": 1, "status": "rejected", "reason": "agent_invocation_path_mismatch", "governance_event_id": event.get("event_id")}
    path = Path(output_path)
    if not path.exists():
        raise GovernanceError(f"output_path does not exist: {output_path}")
    row = {
        "$schema": "aria/agent-invocation-result/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": request.get("convergence_id"),
        "pressure_event_id": request.get("pressure_event_id"),
        "round_number": request.get("round_number"),
        "role": request.get("role"),
        "target_agent": request.get("target_agent"),
        "output_path": path.resolve().as_posix(),
        "content_hash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
        "status": status,
        "by": by,
        "rejection_reason": rejection_reason,
        "submitted_at": utc_now(),
    }
    return append_jsonl(root / "agent-invocations" / "results.jsonl", row)


def is_legacy_decided_request(
    *,
    request_id: str,
    base_dir: str | Path | None = None,
) -> bool:
    """Plan 024 §B-1 — observability helper.

    Returns True when the request's terminal state was decided by a legacy
    result row (a row written via the pre-Plan-016
    ``submit_agent_invocation_result`` path that lacks a ``claim_id``
    binding). Pure read; never raises on a missing request — returns
    False when no terminal result row exists for the request_id.
    """
    root = ensure_tools_dir(base_dir)
    results = load_jsonl(root / "agent-invocations" / "results.jsonl")
    request_results = _result_rows_for(results, request_id)
    if not request_results:
        return False
    # Latest row decides; legacy = no claim_id field. The strict path
    # (submit_claim_result) always writes claim_id; the legacy helper
    # never does.
    return request_results[-1].get("claim_id") is None


def list_agent_invocation_requests(
    *,
    base_dir: str | Path | None = None,
    state: str | None = None,
    convergence_id: str | None = None,
    target_agent: str | None = None,
    request_id: str | None = None,
    role: str | None = None,
) -> list[dict[str, Any]]:
    """List agent-invocation requests with optional filters.

    Plan 026R §B.4 — derived-state-aware filtering. Pre-§B.4 the
    ``state`` filter compared ``row.get("state")`` directly against
    the persisted ``state`` field on the request row. That field is
    the LEGACY initial-write state (always ``"pending"`` per
    ``create_agent_invocation_request:206``) and never updated
    in-place when the request transitions (claimed, requeued, stale,
    accepted, rejected, human_required) — those transitions are
    derived from claims.jsonl + results.jsonl + bridge ledgers.

    So pre-§B.4 ``state="claimed"`` returned ZERO matches (no row's
    persisted state was ever "claimed") and ``state="pending"``
    returned the FULL request ledger (every row's persisted state
    was always "pending"). ci_executor + worker queries that filtered
    by state silently degraded to "no work" or "all work" depending
    on the value.

    Post-§B.4 the ``state`` filter routes through
    ``derive_request_state(request_id, base_dir)`` which IS the SSoT
    for derived state (PENDING / REQUEUED / CLAIMED / SUBMITTED /
    ACCEPTED / REJECTED / STALE / HUMAN_REQUIRED / CANCELLED /
    ACCEPTED_PENDING_BRIDGE etc.). The derived state is cached per
    request_id within the call so a single list() invocation pays
    the derive cost at most once per row even when other filters
    overlap.

    Case normalisation: ``derive_request_state`` returns uppercase
    state names (``"CLAIMED"``). Caller-supplied ``state`` is
    normalised to uppercase for comparison so historical lowercase
    ``state="claimed"`` invocations keep working.
    """
    rows = load_jsonl(ensure_tools_dir(base_dir) / "agent-invocations" / "requests.jsonl")
    if state is not None:
        # Plan 026R §B.4 — per-call derived-state cache. A single list()
        # call may iterate many rows; only derive each request_id's
        # current state once.
        normalised = state.upper()
        derive_cache: dict[str, str] = {}

        def _derive(rid: str) -> str:
            if rid not in derive_cache:
                derive_cache[rid] = derive_request_state(
                    request_id=rid, base_dir=base_dir,
                )
            return derive_cache[rid]

        rows = [
            row for row in rows
            if _derive(str(row.get("request_id"))) == normalised
        ]
    if convergence_id is not None:
        rows = [row for row in rows if row.get("convergence_id") == convergence_id]
    if target_agent is not None:
        rows = [row for row in rows if row.get("target_agent") == target_agent]
    if request_id is not None:
        rows = [row for row in rows if row.get("request_id") == request_id]
    if role is not None:
        rows = [row for row in rows if row.get("role") == role]
    return rows


def _find_request(root: Path, request_id: str) -> dict[str, Any]:
    for row in reversed(load_jsonl(root / "agent-invocations" / "requests.jsonl")):
        if row.get("request_id") == request_id:
            return row
    raise GovernanceError(f"agent invocation request not found: {request_id}")


def _request_id(target_agent: str, role: str, prompt: str, convergence_id: str | None, round_number: int | None) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in target_agent.lower()).strip("-")[:32] or "agent"
    digest = hashlib.sha256(f"{target_agent}|{role}|{prompt}|{convergence_id}|{round_number}|{utc_now()}".encode("utf-8")).hexdigest()[:8]
    return f"AIR-{slug}-{digest}"


def _default_expected_output_path(root: Path, request_id: str, convergence_id: str | None, round_number: int | None, role: str) -> str:
    group = convergence_id or "general"
    round_part = f"round-{round_number}" if round_number is not None else "round-na"
    return (root / "agent-invocations" / "outputs" / group / f"{round_part}-{role}-{request_id}.md").resolve().as_posix()


def _resolve_for_compare(path: str | Path | None) -> Path:
    if path is None:
        raise GovernanceError("output path is required")
    return Path(path).expanduser().resolve()


# ---------------------------------------------------------------------------
# Plan 016 Faz C2 — lease / heartbeat / requeue primitives.
# ---------------------------------------------------------------------------
#
# Why these live alongside the legacy create / submit functions instead of in
# a fresh module: the request ledger (requests.jsonl) is the single source of
# truth for which requests exist. The lease primitives compose on top of that
# ledger by writing to a sibling claims.jsonl, never modifying the request
# rows in place. Keeping them in one module keeps the reader's mental model
# bounded — every concept that touches agent invocations is reachable from
# this file.


def _claims_path(root: Path) -> Path:
    return root / "agent-invocations" / "claims.jsonl"


def _utc_now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _hash_lease_token(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _claim_id(request_id: str, agent_id: str, claimed_at: datetime) -> str:
    digest = hashlib.sha256(
        f"{request_id}|{agent_id}|{claimed_at.isoformat()}".encode("utf-8")
    ).hexdigest()[:16]
    return f"claim_{digest}"


def _request_event_count(rows: list[dict[str, Any]], request_id: str, kind: str) -> int:
    return sum(1 for row in rows if row.get("request_id") == request_id and row.get("event") == kind)


def _result_rows_for(rows: list[dict[str, Any]], request_id: str) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("request_id") == request_id]


def _claim_rows_for(rows: list[dict[str, Any]], request_id: str) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("request_id") == request_id]


_EVENT_TS_FIELDS = ("claimed_at", "heartbeat_at", "released_at", "stale_at", "at")


def _event_ts(row: dict[str, Any]) -> datetime:
    for key in _EVENT_TS_FIELDS:
        ts = _parse_iso(row.get(key))
        if ts is not None:
            return ts
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _latest_claim_row(rows: list[dict[str, Any]], request_id: str) -> dict[str, Any] | None:
    """Return the last event row for the latest claim_id of a request.

    Multiple claims can exist for one request (after requeue cycles); we want
    the most recent activity across all claims. Append order in the ledger
    is authoritative, but we still cross-check against the recorded
    timestamp so out-of-order writes (test fixtures, manual edits) cannot
    silently flip state.
    """
    candidates = [row for row in rows if row.get("request_id") == request_id]
    if not candidates:
        return None
    # Pick the row with the largest event timestamp; ties break on append order.
    best_idx = -1
    best_ts = datetime.fromtimestamp(0, tz=timezone.utc)
    for idx, row in enumerate(candidates):
        ts = _event_ts(row)
        if ts >= best_ts:
            best_ts = ts
            best_idx = idx
    return candidates[best_idx] if best_idx >= 0 else None


def derive_request_state(
    *,
    request_id: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> str:
    """Derive the Plan 016 lifecycle state from request + claims + results ledgers.

    Pure function over append-only ledgers, so two callers always see the
    same state given the same files. Returns one of `DERIVED_STATES`.
    """
    root = ensure_tools_dir(base_dir)
    requests = load_jsonl(root / "agent-invocations" / "requests.jsonl")
    request = next((row for row in requests if row.get("request_id") == request_id), None)
    if request is None:
        raise GovernanceError(f"unknown request_id: {request_id}")
    if request.get("state") == "cancelled":
        return "CANCELLED"
    results = load_jsonl(root / "agent-invocations" / "results.jsonl")
    claims = load_jsonl(_claims_path(root))

    # Results dominate (terminal states first). The status vocabulary is
    # the union of legacy aria/agent-invocation-result/v1 ("completed",
    # "rejected", "partial") and Plan 016 aria/agent-claim-result/v1
    # ("accepted", "rejected"). Both map onto the same derived states.
    request_results = _result_rows_for(results, request_id)
    if request_results:
        last = request_results[-1]
        status = last.get("status")
        if status == "rejected":
            return "REJECTED"
        if status in ("completed", "accepted"):
            # Plan 026R §C.5 — bridge-status-aware acceptance.
            # If the accepted row is for a BRIDGE_REQUIRED role and the
            # bridge has NOT succeeded yet, the request is in
            # ACCEPTED_PENDING_BRIDGE (non-terminal — F.1 orchestrator
            # drains pending bridges). A permanent_fail terminal lifts
            # to ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL.
            from .bridge_status_ledger import derive_bridge_state
            bridge_state = derive_bridge_state(
                base_dir=root, result_row=last,
            )
            bridge_label = bridge_state["state"]
            if bridge_label == "permanent_fail":
                return "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL"
            if bridge_label in ("pending", "pending_retry"):
                return "ACCEPTED_PENDING_BRIDGE"
            # ``ok`` or ``not_required`` → standard ACCEPTED.
            return "ACCEPTED"
        if status == "partial":
            return "SUBMITTED"

    # If a HUMAN_REQUIRED event was emitted, that is sticky.
    if any(row.get("event") == "human_required" and row.get("request_id") == request_id for row in claims):
        return "HUMAN_REQUIRED"

    # Otherwise inspect the latest claim's state.
    latest = _latest_claim_row(claims, request_id)
    if latest is None:
        return "PENDING"
    event = latest.get("event")
    if event == "released":
        # Released without result -> requeue counter consulted.
        requeues = _request_event_count(claims, request_id, "requeued")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED" if requeues > 0 else "PENDING"
    if event == "stale":
        return "STALE"
    if event == "claimed":
        # Lease expiration?
        expires = _parse_iso(latest.get("lease_expires_at"))
        ts = now or _utc_now_dt()
        if expires is not None and expires < ts:
            return "STALE"
        # Heartbeat seen?
        if any(
            row.get("event") == "heartbeat"
            and row.get("claim_id") == latest.get("claim_id")
            for row in claims
        ):
            return "RUNNING"
        return "CLAIMED"
    if event == "heartbeat":
        expires = _parse_iso(latest.get("lease_expires_at"))
        ts = now or _utc_now_dt()
        if expires is not None and expires < ts:
            return "STALE"
        return "RUNNING"
    if event == "requeued":
        requeues = _request_event_count(claims, request_id, "requeued")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED"
    if event == "human_required":
        return "HUMAN_REQUIRED"
    return "PENDING"


def next_pending_request(
    *,
    role: str | None = None,
    target_agent: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return the oldest pending request matching the optional role/target.

    Pending = derived state PENDING or REQUEUED (those are eligible for a
    fresh claim). HUMAN_REQUIRED, CANCELLED, and terminal states are skipped.
    """
    root = ensure_tools_dir(base_dir)
    requests = load_jsonl(root / "agent-invocations" / "requests.jsonl")
    for request in requests:
        if role and request.get("role") != role:
            continue
        if target_agent and request.get("target_agent") != target_agent:
            continue
        state = derive_request_state(request_id=request["request_id"], base_dir=root)
        if state in {"PENDING", "REQUEUED"}:
            return request
    return None


def claim_request(
    *,
    request_id: str,
    agent_id: str,
    base_dir: str | Path | None = None,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> dict[str, Any]:
    """Issue a lease for a pending request. Returns claim metadata + RAW lease token.

    The raw token is returned to the caller exactly once (so the worker can
    present it on heartbeat / submit-result). Only its sha256 hash is
    persisted to the claims ledger — the raw token is never logged.
    """
    if lease_seconds <= 0:
        raise GovernanceError("lease_seconds must be positive")
    if not agent_id or not agent_id.strip():
        raise GovernanceError("agent_id is required")
    # Plan 020 Phase 1.B — runtime profile dispatch gate.
    # Why: claim_request is the entry point of the agent execution pipeline;
    # gating it here prevents observe/frozen profiles from leasing work that
    # the profile bans from being submitted later.
    enforce_profile_for_action("agent_claim", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    # Plan 024 §H-1 — atomic state-read → check → append under an
    # OS-level exclusive lock on claims.jsonl. Pre-fix two concurrent
    # workers could both pass the PENDING/REQUEUED state check at line
    # 595 and both append a "claimed" row at line 624 — the "who owns
    # the lease" answer became append-order rather than mutual-
    # exclusion. The lock + CAS recheck guarantee that exactly one
    # worker wins the race; the loser sees the same
    # claim_request_state_not_claimable error a serial caller would.
    claims_path = _claims_path(root)
    with with_exclusive_lock(claims_path):
        state = derive_request_state(request_id=request_id, base_dir=root)
        if state not in {"PENDING", "REQUEUED"}:
            raise GovernanceError(
                f"cannot claim request {request_id} in state {state} (must be PENDING or REQUEUED)"
            )
        # Plan 024 §B-2 — claim-time strict-field check. Pre-fix the request
        # could be claimed even when must_satisfy + allowed_scope were
        # missing on the row; the bypass surfaced only at submit time when
        # _strict_request_view defaulted both to []. Surfacing the gap here
        # forces operator backfill BEFORE work is leased.
        request_for_check = _find_request(root, request_id)
        _strict_request_view(request_for_check)
        # Plan 024 §H-1 — defense-in-depth CAS recheck. After the lock
        # fires the state is re-derived; if it changed (e.g. another
        # worker released or stale-marked the request between our read
        # and the lock acquisition) the claim raises
        # claim_request_state_changed_during_lock so the caller sees a
        # specific drift signal instead of a stale state belief.
        rechecked = derive_request_state(request_id=request_id, base_dir=root)
        if rechecked != state:
            raise GovernanceError(
                f"claim_request_state_changed_during_lock: "
                f"{state} → {rechecked}"
            )
        now = _utc_now_dt()
        expires = now + timedelta(seconds=lease_seconds)
        lease_token = secrets.token_hex(LEASE_TOKEN_BYTES)
        cid = _claim_id(request_id, agent_id, now)
        row = {
            "schema_version": 1,
            "event": "claimed",
            "claim_id": cid,
            "request_id": request_id,
            "agent_id": agent_id,
            "lease_token_hash": _hash_lease_token(lease_token),
            "lease_seconds": lease_seconds,
            "claimed_at": _iso(now),
            "lease_expires_at": _iso(expires),
        }
        # Plan 026R §A.1 — caller already holds with_exclusive_lock(claims_path)
        # at line 604; use the unlocked helper to avoid POSIX flock re-acquisition.
        persisted_claim_row = _append_jsonl_unlocked(claims_path, row)
        # Plan 026R §B.3 — fuse the request envelope into the return value
        # inside the same lock window. Pre-§B.3 the caller had to do a
        # separate ``agent-invocations list --request-id`` fetch after
        # claim, which opened a race window: between claim-success and
        # list-fetch, a reaper or release could mutate the request and
        # the caller's downstream work would operate on stale envelope
        # fields. ``request_for_check`` is already loaded above (line
        # 615) under the same lock, so the fusion is free.
        claim_ledger_hash_value = str(persisted_claim_row.get("ledger_hash"))
        # The request row's own ledger_hash is the integrity anchor for
        # §B.5 metadata-tamper detection. Load the request row directly
        # so we return the on-disk hash, not a derived value.
        request_rows = load_jsonl(
            root / "agent-invocations" / "requests.jsonl"
        )
        envelope_row = next(
            (r for r in reversed(request_rows) if r.get("request_id") == request_id),
            None,
        )
        request_ledger_hash_value = (
            str(envelope_row.get("ledger_hash")) if envelope_row else ""
        )
    append_tools_governance(
        root,
        "agent_claim_created",
        {
            "claim_id": cid,
            "request_id": request_id,
            "agent_id": agent_id,
            "lease_expires_at": _iso(expires),
        },
    )
    # Plan 026R §B.3 — fused return. Persisted claim row stays minimal
    # (see ``row`` above — no envelope fields written into claims.jsonl);
    # only the IN-MEMORY return value carries the envelope so the caller
    # can act on the request without a second fetch. Ledger-hash anchors
    # (``claim_ledger_hash`` + ``request_ledger_hash``) feed §B.5's
    # metadata-tamper detection.
    envelope = request_for_check or {}
    # Plan ARIA-V8.12 — extend the fused return with the additional
    # envelope fields ci_executor needs to render a complete agent
    # prompt. Pre-V8.12 fusion (Plan 026R §B.3) only carried 5 fields
    # (expected_output_path, role, must_satisfy, allowed_scope,
    # evidence_refs) which forced ci_executor to read `suggested_prompt`
    # and `target_agent` from the claim row — but those fields are
    # NOT persisted on the claim row (claims.jsonl carries only claim
    # metadata, not envelope fields). The empty suggested_prompt
    # cascaded into an empty `<untrusted_*>` body in the prompt file,
    # and the cross-reviewer agent refused with `evidence_underspecified`.
    return {
        **row,
        "lease_token": lease_token,
        # Envelope metadata (V8.12 extended set — all fields ci_executor's
        # `_build_prompt_payload` renders into the agent prompt):
        "expected_output_path": envelope.get("expected_output_path"),
        "role": envelope.get("role"),
        "target_agent": envelope.get("target_agent"),
        "convergence_id": envelope.get("convergence_id"),
        "suggested_prompt": envelope.get("suggested_prompt"),
        "must_satisfy": envelope.get("must_satisfy", []),
        "allowed_scope": envelope.get("allowed_scope", []),
        "forbidden_scope": envelope.get("forbidden_scope", []),
        "evidence_refs": envelope.get("evidence_refs", []),
        "impact_graph_refs": envelope.get("impact_graph_refs", []),
        "validation_commands": envelope.get("validation_commands", []),
        "plan_revision_hash": envelope.get("plan_revision_hash"),
        # Ledger-hash anchors (2 fields per plan §B.3 + §B.5):
        "claim_ledger_hash": claim_ledger_hash_value,
        "request_ledger_hash": request_ledger_hash_value,
    }


def heartbeat_claim(
    *,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    base_dir: str | Path | None = None,
    extend_seconds: int = DEFAULT_HEARTBEAT_EXTEND_SECONDS,
) -> dict[str, Any]:
    """Extend a lease by `extend_seconds`. Validates lease_token + agent_id."""
    root = ensure_tools_dir(base_dir)
    claims = load_jsonl(_claims_path(root))
    claim_event = next(
        (row for row in claims if row.get("claim_id") == claim_id and row.get("event") == "claimed"),
        None,
    )
    if claim_event is None:
        raise GovernanceError(f"claim {claim_id} not found")
    if claim_event.get("agent_id") != agent_id:
        raise GovernanceError(
            f"claim {claim_id} owned by {claim_event.get('agent_id')!r}, not {agent_id!r}"
        )
    if claim_event.get("lease_token_hash") != _hash_lease_token(lease_token):
        raise GovernanceError(f"claim {claim_id} lease_token mismatch")
    # Reject heartbeat if the request was already released or marked human_required.
    later_events = [
        row for row in claims
        if row.get("claim_id") == claim_id and row.get("event") in {"released", "stale", "human_required"}
    ]
    if later_events:
        raise GovernanceError(
            f"claim {claim_id} already terminal ({later_events[-1].get('event')})"
        )
    # Plan 023 v3 §A-4 — explicit lease-expiry time check. Pre-fix the
    # heartbeat path checked terminal events ONLY (released / stale /
    # human_required), not lease_expires_at vs the wall clock. An
    # expired lease whose reaper sweep hadn't fired yet still accepted
    # heartbeat (and submit, fixed in submit_claim_result below). The
    # reaper provides eventual consistency; this is the real-time gate.
    now = _utc_now_dt()
    # Plan 024 §H-3 — _latest_lease_expiry now raises on parse failure
    # / missing field / no claim row, so the previous `is not None`
    # guard is no longer needed. The function either returns a
    # datetime (compared below) or surfaces a structured GovernanceError
    # the caller does not need to translate.
    latest_expires = _latest_lease_expiry(claims, claim_id)
    if latest_expires < now:
        raise GovernanceError(
            f"lease_expired: claim_id={claim_id!r} lease_expires_at="
            f"{_iso(latest_expires)} is past current time {_iso(now)}; "
            f"the reaper sweep has not landed yet but the lease cannot "
            f"be extended after expiry"
        )
    expires = now + timedelta(seconds=extend_seconds)
    row = {
        "schema_version": 1,
        "event": "heartbeat",
        "claim_id": claim_id,
        "request_id": claim_event["request_id"],
        "agent_id": agent_id,
        "heartbeat_at": _iso(now),
        "lease_expires_at": _iso(expires),
    }
    append_jsonl(_claims_path(root), row)
    return row


def _latest_lease_expiry(claims: list[dict[str, Any]], claim_id: str) -> Any:
    """Plan 023 v3 §A-4 — return the latest lease_expires_at across the
    claim's original `claimed` row + all `heartbeat` rows. Plan 024 v3
    §H-3 — fail-CLOSED on parse failure / missing field.

    Heartbeat extends the lease; the latest extension is the binding
    one. Pre-Plan-024 the function silently returned None on parse
    failures + caller chains compared `latest is not None and latest
    < now` — None pass-through fail-OPEN. Post-fix the function
    raises GovernanceError so submit_claim_result + heartbeat_claim
    can never accept a claim whose lease_expires_at is unreadable
    or absent.
    """
    parse_failures: list[tuple[str, str]] = []  # (kind, raw)
    parsed: list[datetime] = []
    saw_claim_row = False
    for row in claims:
        if row.get("claim_id") != claim_id:
            continue
        if row.get("event") not in {"claimed", "heartbeat"}:
            continue
        saw_claim_row = True
        ev = row.get("lease_expires_at")
        if not isinstance(ev, str) or not ev.strip():
            parse_failures.append(("missing", str(ev)))
            continue
        try:
            parsed.append(datetime.fromisoformat(ev.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            parse_failures.append(("unparseable", ev))
            continue
    if parsed:
        return max(parsed)
    # No parsed expiry; either every row had unparseable / missing
    # expiry OR there was no claim row at all. Distinguish so the
    # caller surfaces the precise failure mode in its error code.
    if not saw_claim_row:
        raise GovernanceError(f"lease_not_found: claim_id={claim_id!r}")
    raise GovernanceError(
        f"lease_expires_at_unparseable_or_missing: claim_id={claim_id!r} "
        f"failures={[k for k, _ in parse_failures]!r}"
    )


def release_claim(
    *,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Operator- or worker-initiated release; the request becomes REQUEUED if
    not yet at the cap.

    Plan 026R §B.1 — REAL CI BUG fix. Pre-§B.1 ``release_claim`` accepted
    only ``(claim_id, agent_id, reason)`` so anyone who knew the
    claim_id + agent_id pair could release the claim — a real
    authorisation gap because the lease_token is the proof-of-claim
    issued by ``claim_request``. ``submit_claim_result`` and
    ``heartbeat_claim`` ALREADY require + hash-verify the lease_token
    (lines 681, 868); ``release_claim`` was the lone outlier. The
    ``ci_executor._release_claim`` subprocess argv already passes
    ``--lease-token-from-env`` but the CLI parser did not register
    the flag, so today's CI release path FAILS at argparse before
    even reaching this function — the asymmetry has been latent.

    The lease_token is hashed via ``_hash_lease_token`` and compared
    against the claim row's ``lease_token_hash`` field (same pattern
    as ``heartbeat_claim:681`` and ``submit_claim_result:868``).
    Mismatch raises ``GovernanceError``.
    """
    if not reason or not reason.strip():
        raise GovernanceError("release reason is required")
    if not lease_token or not lease_token.strip():
        raise GovernanceError("lease_token is required for release_claim")
    root = ensure_tools_dir(base_dir)
    claims = load_jsonl(_claims_path(root))
    claim_event = next(
        (row for row in claims if row.get("claim_id") == claim_id and row.get("event") == "claimed"),
        None,
    )
    if claim_event is None:
        raise GovernanceError(f"claim {claim_id} not found")
    if claim_event.get("agent_id") != agent_id:
        raise GovernanceError(
            f"claim {claim_id} owned by {claim_event.get('agent_id')!r}, not {agent_id!r}"
        )
    if claim_event.get("lease_token_hash") != _hash_lease_token(lease_token):
        raise GovernanceError(
            f"release_claim_lease_token_mismatch: claim {claim_id} "
            f"lease_token does not match (mirrors heartbeat / submit "
            f"contract)"
        )
    now = _utc_now_dt()
    request_id = claim_event["request_id"]
    row = {
        "schema_version": 1,
        "event": "released",
        "claim_id": claim_id,
        "request_id": request_id,
        "agent_id": agent_id,
        "reason": reason,
        "released_at": _iso(now),
    }
    append_jsonl(_claims_path(root), row)
    requeue_count = _request_event_count(claims, request_id, "requeued") + 1
    requeue_event_kind = "requeued" if requeue_count <= DEFAULT_MAX_REQUEUES else "human_required"
    append_jsonl(
        _claims_path(root),
        {
            "schema_version": 1,
            "event": requeue_event_kind,
            "claim_id": claim_id,
            "request_id": request_id,
            "at": _iso(now),
            "requeue_count": requeue_count,
            "reason": reason,
        },
    )
    append_tools_governance(
        root,
        f"agent_{requeue_event_kind}",
        {"claim_id": claim_id, "request_id": request_id, "requeue_count": requeue_count, "reason": reason},
    )
    return row


def submit_claim_result(
    *,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    output_path: str | Path,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    lock_timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Validate and persist an agent's submitted result against its leased claim.

    Why: Plan 016 §Agent contract requires every ACCEPTED state to follow
    a kernel-side validation chain — schema -> matrix -> evidence refs.
    Without this, a claim can never reach ACCEPTED; the lease lifecycle
    has no terminal success path. This function ties agent_contract.
    validate_response and evidence_validator.validate_agent_response_
    evidence to the claims ledger.

    Returns: {"status": "accepted"|"rejected", "reasons": [...], "row": <persisted result row>}
    """
    from .agent_contract import enforce_separation_of_duties, envelope_hash, validate_response  # local to avoid import cycle on cold start
    from .evidence_validator import validate_agent_response_evidence

    if not lease_token or not lease_token.strip():
        raise GovernanceError("lease_token is required")
    output = Path(output_path)
    if not output.exists() or not output.is_file():
        raise GovernanceError(f"output_path does not exist: {output_path}")

    root = ensure_tools_dir(base_dir)
    claims = load_jsonl(_claims_path(root))
    claim_event = next(
        (row for row in claims if row.get("claim_id") == claim_id and row.get("event") == "claimed"),
        None,
    )
    if claim_event is None:
        raise GovernanceError(f"claim {claim_id} not found")
    if claim_event.get("agent_id") != agent_id:
        raise GovernanceError(
            f"claim {claim_id} owned by {claim_event.get('agent_id')!r}, not {agent_id!r}"
        )
    if claim_event.get("lease_token_hash") != _hash_lease_token(lease_token):
        raise GovernanceError(f"claim {claim_id} lease_token mismatch")
    terminal = [
        row for row in claims
        if row.get("claim_id") == claim_id and row.get("event") in {"released", "stale", "human_required"}
    ]
    if terminal:
        raise GovernanceError(
            f"claim {claim_id} already terminal ({terminal[-1].get('event')})"
        )
    # Plan 023 v3 §A-4 — same explicit lease-expiry check on submit.
    # Pre-fix submit_claim_result accepted past-expiry leases (no
    # reaper sweep yet) and produced an ACCEPTED row even though the
    # claim should have been rejected as expired.
    now_for_lease = _utc_now_dt()
    # Plan 024 §H-3 — fail-closed expiry resolution; see helper docstring.
    latest_expires_for_submit = _latest_lease_expiry(claims, claim_id)
    if latest_expires_for_submit < now_for_lease:
        raise GovernanceError(
            f"lease_expired: claim_id={claim_id!r} lease_expires_at="
            f"{_iso(latest_expires_for_submit)} is past current time "
            f"{_iso(now_for_lease)}; the reaper sweep has not landed "
            f"yet but the submission cannot be accepted after expiry"
        )

    request_id = claim_event["request_id"]
    request = _find_request(root, request_id)
    results_path = root / "agent-invocations" / "results.jsonl"

    # Plan 025 §A.1 — read+parse envelope BEFORE the idempotency check.
    # Why HERE: the idempotency check is now lock-bound + envelope-hash
    # dedup. Computing the hash requires a parsed envelope; the parse
    # MUST happen before the lock so the lock window stays minimal and
    # the unreadable-envelope path keeps its non-idempotent rejection
    # (no row to compare against; no hash means no drift detect possible
    # — rejecting unconditionally is the only correct behaviour, and the
    # rejection persistence still goes inside the lock below for
    # results.jsonl mutual-exclusion).
    envelope_unreadable_error: str | None = None
    envelope: dict[str, Any] | None = None
    try:
        envelope = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        envelope_unreadable_error = str(exc)

    if envelope is not None:
        submitted_hash = envelope_hash(envelope)
    else:
        # Sentinel hash for envelope_unreadable rows. Real envelope hashes
        # are "sha256:" + 64 hex chars; ":envelope_unreadable" is not a
        # valid hex digest, so collisions with real hashes are
        # structurally impossible. The sentinel keeps the
        # envelope_evidence_hash field non-null on every persisted row,
        # which keeps the legacy-row drift gate (§A.1) from misfiring on
        # rejections written by this same code path.
        submitted_hash = "sha256:envelope_unreadable"

    # Plan 025 §A.1 — lock-bound results.jsonl idempotency + drift gate.
    # Mirror of claim_request §H-1 pattern (line 604). All branches that
    # mutate results.jsonl (idempotent return, drift raise, legacy-drift
    # raise, every _persist_rejection, the final accepted append) live
    # INSIDE the lock so concurrent workers cannot both pass the
    # existing-row check and both append.
    # `lock_timeout_seconds` is forwarded explicitly so callers (and
    # tests for lock-contention behaviour) can override the helper's
    # default without monkey-patching module attributes — None means
    # "use the helper's default".
    lock_kwargs: dict[str, Any] = {}
    if lock_timeout_seconds is not None:
        lock_kwargs["timeout_seconds"] = lock_timeout_seconds
    with with_exclusive_lock(results_path, **lock_kwargs):
        results_for_claim = [
            row for row in load_jsonl(results_path)
            if row.get("claim_id") == claim_id
        ]
        if results_for_claim:
            existing = results_for_claim[-1]
            existing_hash = existing.get("envelope_evidence_hash")
            if existing_hash is None:
                # Plan 025 §A.1 — legacy row written before envelope_evidence_hash
                # was introduced. Drift undecidable: we cannot prove the
                # incoming envelope matches what was originally accepted.
                # Fail-closed; operator runs the backfill migration.
                append_tools_governance(
                    root,
                    "agent_result_legacy_row_drift_undecidable",
                    {
                        "claim_id": claim_id,
                        "submitted_hash": submitted_hash,
                    },
                )
                raise GovernanceError(
                    f"submit_claim_result_legacy_row_drift_undecidable: "
                    f"claim_id={claim_id} run migration "
                    f"plan-025-A1-backfill-envelope-hash"
                )
            if existing_hash == submitted_hash:
                # Plan 025 §A.1 — byte-identical envelope replay (same
                # canonical-JSON hash). This is the legitimate idempotent
                # path: a worker retrying after a network blip submits
                # the same envelope; we return the existing row.
                # NB: lookup filter `row.get("claim_id") == claim_id`
                # remains within 500 chars before
                # submit_claim_result_already_persisted (file_lock test
                # source-scan invariant).
                append_tools_governance(
                    root,
                    "agent_result_idempotent_replay",
                    {
                        "claim_id": claim_id,
                        "submitted_hash": submitted_hash,
                    },
                )
                return {
                    "status": "idempotent",
                    "reasons": [
                        f"submit_claim_result_already_persisted: claim_id={claim_id} "
                        f"existing_status={existing.get('status')!r}"
                    ],
                    "row": existing,
                    "idempotent": True,
                }
            # Plan 025 §A.1 — same claim_id, different envelope hash.
            # This is the drift case the previous "any existing row =>
            # idempotent" check silently swallowed. Fail-closed; operator
            # decides whether the second envelope reflects a legitimate
            # contract change (which would be a new claim, not a
            # duplicate) or an attacker / replay attempting to overwrite
            # an accepted result.
            append_tools_governance(
                root,
                "agent_result_duplicate_with_drift",
                {
                    "claim_id": claim_id,
                    "existing_hash": existing_hash,
                    "submitted_hash": submitted_hash,
                },
            )
            raise GovernanceError(
                f"submit_claim_result_duplicate_with_drift: "
                f"claim_id={claim_id} existing_hash={existing_hash} "
                f"submitted_hash={submitted_hash}"
            )

        # No existing row → proceed with validation + persist. All
        # _persist_rejection callsites and the final accepted append
        # stay inside the lock.
        if envelope_unreadable_error is not None:
            return _persist_rejection(
                root=root,
                claim_id=claim_id,
                request_id=request_id,
                agent_id=agent_id,
                output_path=output,
                reasons=[f"envelope_unreadable: {envelope_unreadable_error}"],
                envelope_evidence_hash=submitted_hash,
            )

        reasons: list[str] = []
        try:
            # Plan 023 v3 §A-5 — bind envelope claim_id / agent_id to the
            # leased identity. submit_claim_result's `claim_id` and
            # `agent_id` parameters are the leased identity (already
            # validated against claim_event above); pass them as lease
            # so validate_response rejects any envelope whose claim_id or
            # agent_id differs.
            validate_response(
                envelope,
                request=_strict_request_view(request),
                lease={"claim_id": claim_id, "agent_id": agent_id},
            )
        except GovernanceError as exc:
            reasons.append(f"response_schema: {exc}")
        try:
            enforce_separation_of_duties(
                request=_strict_request_view(request), submitter_agent_id=agent_id
            )
        except GovernanceError as exc:
            reasons.append(f"separation_of_duties: {exc}")
        revalidation = validate_agent_response_evidence(
            response=envelope,
            workspace_root=workspace_root,
            request=_strict_request_view(request),
        )
        if not revalidation["valid"]:
            reasons.extend(f"evidence: {error}" for error in revalidation["errors"])

        if reasons:
            return _persist_rejection(
                root=root,
                claim_id=claim_id,
                request_id=request_id,
                agent_id=agent_id,
                output_path=output,
                reasons=reasons,
                envelope_evidence_hash=submitted_hash,
            )

        # Plan 020 Phase 7.B — agent compliance gate.
        # Why HERE (after validate_response succeeds, before result accepted):
        # validate_response checks the schema + matrix + evidence references.
        # Compliance grades whether the agent followed the response CONTRACT
        # (must_satisfy completeness, evidence schema validity, output path
        # match, banned-phrase in body, response order, refusal envelope).
        # Compliance failure converts an otherwise-acceptable response into a
        # REJECTED result with rejection_reason='compliance_rejected'. The
        # 10-state lifecycle stays intact (rejection_reason annotates the
        # existing REJECTED state; no 11th state added).
        from .agent_compliance import (
            COMPLIANCE_REJECTION_REASON,
            record_compliance_grade,
        )
        compliance = record_compliance_grade(
            claim_id=claim_id,
            request=request,
            response=envelope,
            response_path=output,
            workspace_root=Path(workspace_root).resolve() if workspace_root else None,
            base_dir=base_dir,
        )
        if compliance.get("rejection"):
            return _persist_rejection(
                root=root,
                claim_id=claim_id,
                request_id=request_id,
                agent_id=agent_id,
                output_path=output,
                reasons=[
                    f"compliance: {COMPLIANCE_REJECTION_REASON} "
                    f"(hard_fail={compliance.get('hard_fail_count', 0)}, "
                    f"soft_fail={compliance.get('soft_fail_count', 0)})"
                ],
                envelope_evidence_hash=submitted_hash,
            )

        # Accepted path.
        output_hash = "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest()
        # Plan 026R §C.2 — write BOTH ``output_hash`` (modern submit
        # path field name) AND ``content_hash`` (legacy
        # submit_agent_invocation_result field name at line 290).
        # Cross-review (§C.4) and convergent-planning consumers query
        # by ``content_hash``; pre-§C.2 the modern accepted-row didn't
        # write that field so the lookup permanently returned None,
        # silently bypassing the convergence pair check.
        # Plan 026R §C.5 — ``bridge_status`` field reflects the role
        # at WRITE time. The result row in results.jsonl is IMMUTABLE;
        # subsequent state lives in agent-result-bridge-status.jsonl.
        from .bridge_status_ledger import bridge_status_for_role
        envelope_role = envelope.get("role")
        row = {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "claim_id": claim_id,
            "request_id": request_id,
            "agent_id": agent_id,
            "role": envelope_role,
            "status": "accepted",
            "output_path": output.resolve().as_posix(),
            "output_hash": output_hash,
            "content_hash": output_hash,  # §C.2 alias
            "envelope_evidence_hash": submitted_hash,
            "bridge_status": bridge_status_for_role(envelope_role),  # §C.5
            "checked_evidence_count": len(revalidation["checked_refs"]),
            "submitted_at": utc_now(),
        }
        # Plan 026R §A.1 — caller already holds with_exclusive_lock(results_path)
        # at line 936; use the unlocked helper to avoid POSIX flock re-acquisition.
        persisted = _append_jsonl_unlocked(results_path, row)
        append_tools_governance(
            root,
            "agent_result_accepted",
            {
                "claim_id": claim_id,
                "request_id": request_id,
                "agent_id": agent_id,
                "output_hash": output_hash,
                "envelope_evidence_hash": submitted_hash,
            },
        )

    # Plan 016 Faz C5/C6 bridge: route the accepted envelope to the
    # consensus engine (judge roles) or the supporting payload store
    # (Goldset / Change-Intelligence). Bridge errors are recorded as
    # governance events but do NOT undo the accept — the response itself
    # passed every gate; downstream wiring shortfalls become operator
    # tracked actions, not silent re-rejections. Bridges run OUTSIDE the
    # results.jsonl lock — they don't mutate that ledger.
    bridged = {"judge_feedback": None, "supporting_payload": None, "bridge_errors": []}
    try:
        from .judgment_bridge import persist_supporting_payload, record_judge_verdict_from_response

        try:
            bridged["judge_feedback"] = record_judge_verdict_from_response(
                request=request, response=envelope, base_dir=base_dir
            )
        except GovernanceError as exc:
            bridged["bridge_errors"].append(f"judge_bridge: {exc}")
            append_tools_governance(
                root,
                "agent_bridge_warning",
                {"claim_id": claim_id, "request_id": request_id, "kind": "judge_bridge", "error": str(exc)},
            )
        try:
            bridged["supporting_payload"] = persist_supporting_payload(
                request=request, response=envelope, base_dir=base_dir
            )
        except GovernanceError as exc:
            bridged["bridge_errors"].append(f"supporting_bridge: {exc}")
            append_tools_governance(
                root,
                "agent_bridge_warning",
                {"claim_id": claim_id, "request_id": request_id, "kind": "supporting_bridge", "error": str(exc)},
            )
        # Plan 026R §C.1 — planner-role auto-bridge. Pre-§C.1 planner
        # roles (primary_plan / challenger_plan / cross_review) fell
        # through every bridge silently; convergent-planning state
        # never saw the accepted submission. record_plan_result
        # dispatches by role to the correct plan_convergence mutation
        # (record_revision / submit_challenger_plan / record_cross_review).
        # Returns None for non-planner roles so judge / supporting
        # paths above stay unaffected.
        try:
            from .plan_convergence_bridge import record_plan_result
            bridged["plan_convergence"] = record_plan_result(
                role=envelope.get("role"),
                request=request,
                response=envelope,
                base_dir=base_dir,
            )
        except BridgeContractViolation:
            # Plan ARIA-V8 v2 §4 Phase 8.2 (B-V2-03) — typed contract
            # violation surfaces operator-visibly. Do NOT swallow into
            # agent_bridge_warning. Pre-V8 the wrapper swallowed every
            # GovernanceError subclass into a warning + accepted the
            # envelope; V8 makes the structural-contract violation a
            # hard fail that propagates to the caller (convergence
            # drainer / consumer) so the operator sees the contract
            # breach in real time.
            raise
        except GovernanceError as exc:
            bridged["bridge_errors"].append(f"plan_convergence_bridge: {exc}")
            append_tools_governance(
                root,
                "agent_bridge_warning",
                {"claim_id": claim_id, "request_id": request_id, "kind": "plan_convergence_bridge", "error": str(exc)},
            )
    except ImportError as exc:  # pragma: no cover — judgment_bridge is in tree
        bridged["bridge_errors"].append(f"bridge_import: {exc}")

    # Plan 026R §C.5 — record the bridge outcome on the append-only
    # ``agent-result-bridge-status.jsonl`` ledger. Result row in
    # results.jsonl stays IMMUTABLE (no patch); transitions land here.
    from .bridge_status_ledger import (
        BRIDGE_REQUIRED_ROLES,
        append_bridge_status,
    )
    envelope_role = envelope.get("role")
    result_row_ledger_hash = str(persisted.get("ledger_hash") or "")
    if envelope_role not in BRIDGE_REQUIRED_ROLES:
        # Non-required roles get a ``not_required`` transition row
        # immediately so derive_bridge_state never trips the crash-
        # recovery rule on them.
        append_bridge_status(
            base_dir=root,
            result_row_ledger_hash=result_row_ledger_hash,
            envelope_evidence_hash=submitted_hash,
            role=envelope_role,
            transition="not_required",
            attempt_number=0,
        )
    elif bridged["bridge_errors"]:
        # Bridge failed — record a ``pending_retry`` transition with
        # attempt_number=1 (first attempt). F.1 orchestrator drains
        # pending bridges on subsequent cycles.
        append_bridge_status(
            base_dir=root,
            result_row_ledger_hash=result_row_ledger_hash,
            envelope_evidence_hash=submitted_hash,
            role=envelope_role,
            transition="pending_retry",
            attempt_number=1,
            error_detail="; ".join(bridged["bridge_errors"])[:500],
        )
    else:
        # Bridge succeeded — record ``ok`` transition.
        append_bridge_status(
            base_dir=root,
            result_row_ledger_hash=result_row_ledger_hash,
            envelope_evidence_hash=submitted_hash,
            role=envelope_role,
            transition="ok",
            attempt_number=1,
        )

    return {"status": "accepted", "reasons": [], "row": persisted, "bridged": bridged}


def _persist_rejection(
    *,
    root: Path,
    claim_id: str,
    request_id: str,
    agent_id: str,
    output_path: Path,
    reasons: list[str],
    envelope_evidence_hash: str,
) -> dict[str, Any]:
    # Plan 025 §A.1 — envelope_evidence_hash is REQUIRED (no default).
    # Missing the field is a TypeError at the call site (tier-1
    # structural enforcement). Every persisted result row — accepted
    # or rejected — carries the hash so the §A.1 idempotency gate can
    # decide drift vs. byte-identical replay vs. legacy-undecidable on
    # the next submit attempt.
    # Plan 026R §C.2 — write BOTH ``output_hash`` and ``content_hash``
    # on rejection rows too so cross-review / convergence consumers
    # resolve the hash regardless of acceptance status. Compute from
    # the on-disk output file when it exists; null when the output
    # path is empty / unreadable (e.g. envelope_unreadable rejections
    # at line 1138).
    rejection_output_hash: str | None = None
    try:
        if output_path.exists() and output_path.is_file():
            rejection_output_hash = (
                "sha256:"
                + hashlib.sha256(output_path.read_bytes()).hexdigest()
            )
    except OSError:
        rejection_output_hash = None
    row = {
        "$schema": "aria/agent-claim-result/v1",
        "schema_version": 1,
        "claim_id": claim_id,
        "request_id": request_id,
        "agent_id": agent_id,
        "status": "rejected",
        "output_path": output_path.resolve().as_posix(),
        "output_hash": rejection_output_hash,
        "content_hash": rejection_output_hash,  # §C.2 alias
        "rejection_reasons": reasons,
        "envelope_evidence_hash": envelope_evidence_hash,
        "submitted_at": utc_now(),
    }
    # Plan 026R §A.1 — _persist_rejection is invoked from submit_claim_result
    # while the caller holds with_exclusive_lock(results_path); use the
    # unlocked helper to avoid POSIX flock re-acquisition (the call sites
    # at lines 1014, 1054, 1087 are all inside the lock).
    persisted = _append_jsonl_unlocked(root / "agent-invocations" / "results.jsonl", row)
    append_tools_governance(
        root,
        "agent_result_rejected",
        {
            "claim_id": claim_id,
            "request_id": request_id,
            "agent_id": agent_id,
            "rejection_reasons_count": len(reasons),
            "envelope_evidence_hash": envelope_evidence_hash,
        },
    )
    return {"status": "rejected", "reasons": reasons, "row": persisted}


def _strict_request_view(legacy_request: dict[str, Any]) -> dict[str, Any]:
    """Adapt a legacy `aria/agent-invocation-request/v1` row into the strict v1 view used by validators.

    Plan 024 §B-2 — fail-closed conversion. A legacy row without
    must_satisfy or allowed_scope cannot be claimed via the strict path
    because the strict-path validators (validate_response,
    validate_agent_response_evidence) silently accept empty matrices,
    which defeats the satisfaction-matrix + scope-bound evidence
    contracts. When this conversion lands on a row missing either
    field, the caller (claim_request / submit_claim_result) sees a
    GovernanceError instead of an empty-matrix bypass.

    Pre-Plan-024 legacy rows that were created via the legacy CLI (or
    via the operator escape hatch in
    create_agent_invocation_request) lack the strict fields. They are
    unclaimable until backfilled via the
    backfill-legacy-request-strict-fields.py migration script (Plan
    024 §B-2 migration deliverable). Operators can run claim_request
    against them and observe the explicit
    `legacy_request_view_missing_required_strict_fields` rejection
    until the backfill lands.
    """
    view = dict(legacy_request)
    missing = [
        field
        for field in ("must_satisfy", "allowed_scope")
        if not view.get(field)
    ]
    if missing:
        raise GovernanceError(
            f"legacy_request_view_missing_required_strict_fields: {missing}"
        )
    # evidence_refs may legitimately be empty (some judgment domains do
    # not require pre-attached evidence; the satisfaction matrix is the
    # primary trust anchor). expected_output_path defaults to '' to
    # preserve legacy compatibility for the path-mismatch check.
    view.setdefault("evidence_refs", [])
    view.setdefault("expected_output_path", view.get("expected_output_path") or "")
    return view


def reap_stale_claims(
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Find expired (stale) claims and emit stale + requeue/human_required events.

    Returns three lists keyed `stale`, `requeued`, `human_required`. Idempotent
    when called repeatedly: a claim already marked stale is not reprocessed.
    """
    root = ensure_tools_dir(base_dir)
    ts = now or _utc_now_dt()
    claims = load_jsonl(_claims_path(root))
    # Identify claims still in flight (claimed/heartbeat without later released/stale/human_required).
    by_claim: dict[str, list[dict[str, Any]]] = {}
    for row in claims:
        cid = row.get("claim_id")
        if not cid:
            continue
        by_claim.setdefault(cid, []).append(row)
    reaped: dict[str, list[dict[str, Any]]] = {"stale": [], "requeued": [], "human_required": []}
    for cid, events in by_claim.items():
        if any(e.get("event") in {"released", "stale", "human_required"} for e in events):
            continue
        latest = events[-1]
        expires = _parse_iso(latest.get("lease_expires_at"))
        if expires is None or expires >= ts:
            continue
        request_id = latest.get("request_id")
        agent_id = latest.get("agent_id")
        stale_row = {
            "schema_version": 1,
            "event": "stale",
            "claim_id": cid,
            "request_id": request_id,
            "agent_id": agent_id,
            "stale_at": _iso(ts),
            "lease_expires_at": latest.get("lease_expires_at"),
        }
        append_jsonl(_claims_path(root), stale_row)
        reaped["stale"].append(stale_row)
        # Reload once to keep _request_event_count accurate after each append.
        claims_after = load_jsonl(_claims_path(root))
        requeue_count = _request_event_count(claims_after, request_id, "requeued") + 1
        kind = "requeued" if requeue_count <= DEFAULT_MAX_REQUEUES else "human_required"
        followup = {
            "schema_version": 1,
            "event": kind,
            "claim_id": cid,
            "request_id": request_id,
            "at": _iso(ts),
            "requeue_count": requeue_count,
            "reason": "lease_expired",
        }
        append_jsonl(_claims_path(root), followup)
        reaped[kind].append(followup)
        append_tools_governance(
            root,
            f"agent_claim_{kind}",
            {"claim_id": cid, "request_id": request_id, "requeue_count": requeue_count, "reason": "lease_expired"},
        )
    return reaped
