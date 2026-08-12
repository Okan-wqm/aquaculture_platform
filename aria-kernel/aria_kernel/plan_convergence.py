from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .agent_priors import reviewer_names
from .implementation_rejections import VALID_IMPLEMENTATION_REJECTION_CLASSES
from .ledger import append_declared_jsonl, load_declared_jsonl, verify_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-(CRITICAL|HIGH|MEDIUM|LOW)-[0-9]{3,}$")
EVENT_TYPES = {
    "plan_started",
    "challenger_plan_drafted",
    "critic_tasks_requested",
    "critique_recorded",
    "cross_review_tasks_requested",
    "cross_review_recorded",
    "stale_tasks_reaped",
    "revision_recorded",
    "plan_evaluated",
    "plan_abandoned",
    "lock_reaped",
    # Plan ARIA-V9.0-B — implementation-phase event types. Adding a
    # new event type beyond this set is a one-way door (every row in
    # events.jsonl is now signed by content_hash; renaming a kind
    # invalidates audit history). The v3 plan's 5 phases:
    #
    #   CONVERGED  (V8 P+C+CR terminal)
    #     -- implementation_requested -->        IMPLEMENTATION_REQUESTED
    #     -- implementation_started -->          IMPLEMENTATION_IN_FLIGHT
    #     -- implementation_outcome_recorded --> IMPLEMENTATION_RECORDED
    #     -- implementation_merged -->           IMPLEMENTATION_MERGED   (terminal)
    #     -- implementation_rejected -->         IMPLEMENTATION_REJECTED (terminal)
    #
    # Per-event-type validators below check payload shape; state
    # preconditions (impossible-state reachability) live in
    # _apply_event, where the reducer raises GovernanceError if the
    # current state.state does not match the single legal predecessor
    # for the event_type. Closes architectural-arbiter CRIT-003.
    "implementation_requested",
    "implementation_started",
    "implementation_outcome_recorded",
    "implementation_merged",
    "implementation_rejected",
    # Plan-coverage gate (ORPHAN-HIGH-310 class: convergence measures
    # agreement, not coverage — two planners can share a blind spot).
    # coverage_computed is an ANNOTATION event: it never changes
    # state["state"], it fills state["coverage_by_round"][N] with the
    # deterministic impact-closure verdict and folds its synthetic
    # coverage_gap risks into cross_review_risks_by_round[N]. The
    # payload shape is a one-way door like every event here.
    "coverage_computed",
}
TERMINAL_STATES = {
    "CONVERGED",
    "HUMAN_REQUIRED",
    "ABANDONED",
    # Plan ARIA-V9.0-B — V9 implementation-phase terminal states. The
    # V8 model treats CONVERGED as terminal; V9 extends past CONVERGED
    # through the implementation phase and terminates at one of these
    # two states (merged on green CI, rejected on red CI or
    # implementation refusal). CONVERGED REMAINS in TERMINAL_STATES
    # so existing V8 invariants (active-plan filters, _derive_state
    # early-return) keep their semantics; V9's
    # ``request_implementation`` re-opens a CONVERGED plan by writing
    # an ``implementation_requested`` event whose reducer ignores
    # TERMINAL_STATES (the V9 transition graph permits exactly one
    # legal escape from CONVERGED: into IMPLEMENTATION_REQUESTED).
    "IMPLEMENTATION_MERGED",
    "IMPLEMENTATION_REJECTED",
}
ANSWERED_STATES = {"ANSWERED", "TIMEOUT_ABORTED"}
MAX_CROSS_REVIEW_ROUNDS = 5
REQUIRED_CROSS_REVIEW_DIRECTIONS = {"primary_to_challenger", "challenger_to_primary"}
KNOWN_SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW"}
# WHY: the canonical plan_content required-field set was duplicated as a
# literal in tools/aria-poc/ci_executor.py (fail-fast gate) and drifted
# silently when fields were added. WHAT: this is the SINGLE SOURCE OF
# TRUTH for the fields _validate_plan_content requires; the order is
# load-bearing — the missing-field error message joins them in this order.
PLAN_CONTENT_REQUIRED = (
    "schema_version",
    "title",
    "summary",
    "affected_surfaces",
    "key_changes",
    "validation_commands",
    "evidence_refs",
)
# WHY: the cross-review risk field names were inline tuples inside
# _validate_cross_review_risk, with no shared definition. WHAT: this is the
# SSoT for the full cross-review risk field set. The validator slices it
# (risk_id is checked first, then the 4 string fields, then the 2 list
# fields) — the structure differs per field TYPE, so this tuple names the
# fields but the validator keeps its type-specific check order.
CROSS_REVIEW_RISK_REQUIRED = (
    "risk_id",
    "risk_category",
    "severity",
    "summary",
    "recommendation",
    "affected_files",
    "evidence_refs",
)
# WHY: the V8 cross-review severity vocabulary ("blocking"/"material"/
# "nice_to_have") was an inline set literal merged with KNOWN_SEVERITIES.
# WHAT: this is the SSoT for the cross-review-specific severity values,
# kept SEPARATE from KNOWN_SEVERITIES (the finding-severity vocabulary) so
# the two vocabularies can evolve independently; the accept-set unions both.
RISK_SEVERITY_VALUES = frozenset({"blocking", "material", "nice_to_have"})
# Plan-coverage verdict vocabulary. "gaps" blocks convergence via the
# round loop; "environment_unable" escalates straight to HUMAN_REQUIRED
# (the environment will not heal round-over-round); the two covered
# verdicts pass the gate. The gate applies only to plans whose
# plan_started content declares schema_version >= 2 — every historical
# plan and fixture is v1, so replay semantics are untouched.
COVERAGE_VERDICTS = frozenset({"covered", "covered_with_waivers", "gaps", "environment_unable"})
MAX_PLAN_BYTES = 1_000_000
MAX_AFFECTED_PATHS = 200
MAX_RISKS = 100
MAX_TASKS_PER_ROUND = 50
LOCK_STALE_SECONDS = 300


def start_plan(
    *,
    plan_id: str,
    plan_content: dict[str, Any],
    initial_revision_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    _validate_id(initial_revision_id, "initial_revision_id")
    _validate_plan_content(plan_content)
    payload = {
        "plan_content": plan_content,
        "content_hash": content_hash(plan_content),
        "initial_revision_id": initial_revision_id,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="start",
        canonical_payload=plan_content,
        event_type="plan_started",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _validate_start(state),
    )


def request_critics(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="request-critics",
        canonical_payload=request,
        event_type="critic_tasks_requested",
        payload=_normalize_critic_request(request),
        base_dir=base_dir,
        validator=_validate_critic_request,
    )


def submit_challenger_plan(
    *,
    plan_id: str,
    challenger: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="submit-challenger-plan",
        canonical_payload=challenger,
        event_type="challenger_plan_drafted",
        payload=_normalize_challenger_plan(challenger),
        base_dir=base_dir,
        validator=_validate_challenger_plan,
    )


def request_cross_review(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="request-cross-review",
        canonical_payload=request,
        event_type="cross_review_tasks_requested",
        payload=_normalize_cross_review_request(request),
        base_dir=base_dir,
        validator=_validate_cross_review_request,
    )


def request_cross_review_retry(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    payload = _normalize_cross_review_request(request)
    if not payload.get("replaces_task_ids"):
        raise GovernanceError("cross-review retry requires replaces_task_ids")
    return _mutate(
        plan_id=plan_id,
        command_name="request-cross-review-retry",
        canonical_payload=request,
        event_type="cross_review_tasks_requested",
        payload=payload,
        base_dir=base_dir,
        validator=_validate_cross_review_retry,
    )


def record_cross_review(
    *,
    plan_id: str,
    review: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    root = ensure_tools_dir(base_dir)
    payload = _normalize_cross_review(review)
    mismatch = _cross_review_hash_mismatch(root, payload)
    if mismatch:
        event = _append_rejection(root, "cross_review_content_hash_mismatch", {"plan_id": plan_id, **mismatch})
        return {"schema_version": 1, "plan_id": plan_id, "event_appended": False, "status": "rejected", "governance_event_id": event.get("event_id"), "reason": "cross_review_content_hash_mismatch"}
    return _mutate(
        plan_id=plan_id,
        command_name="record-cross-review",
        canonical_payload=review,
        event_type="cross_review_recorded",
        payload=payload,
        base_dir=root,
        validator=lambda state, normalized: _validate_cross_review_record(state, normalized, workspace_root),
    )


def record_critique(
    *,
    plan_id: str,
    critique: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="record-critique",
        canonical_payload=critique,
        event_type="critique_recorded",
        payload=_normalize_critique(critique),
        base_dir=base_dir,
        validator=lambda state, payload: _validate_critique(state, payload, workspace_root),
    )


def submit_cross_review_v8(
    *,
    plan_id: str,
    review: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V8.2 — single-step V8 P+C+CR cross-review state transition.

    The V8 P+C+CR architecture mints ONE aria-cross-reviewer envelope
    per round that bidirectionally compares primary↔challenger plans.
    The legacy 3-event kernel flow requires:

        CHALLENGER_DRAFTED
            ── request_cross_review(tasks=[per direction]) ──>
        CROSS_REVIEW_REQUESTED
            ── record_cross_review(per task) × 2 ──>
        CROSS_REVIEWED

    Until V8.2 the drainer minted only the envelope; the bridge had no
    way to take the agent's single response through both transitions,
    so every cross_review submission landed `cannot record cross-review
    from state CHALLENGER_DRAFTED`. V8.2 wraps the 3 events into one
    atomic kernel call:

      1. Read latest_revision + current_round from plan state.
      2. Synthesize deterministic task_packet_hash per
         REQUIRED_CROSS_REVIEW_DIRECTIONS (both directions).
      3. Call request_cross_review with both synthetic tasks
         (CHALLENGER_DRAFTED → CROSS_REVIEW_REQUESTED).
      4. Call record_cross_review per direction with the agent's
         risks shared across both directions
         (CROSS_REVIEW_REQUESTED → CROSS_REVIEWED after both ANSWERED).

    The agent does NOT need to know about task_packet_hash or
    direction — it produces verdict + risks. The kernel-side function
    here owns the metadata synthesis (Tier-1: V8 simplification lives
    in the kernel boundary, not in the agent prompt).

    Args:
        plan_id: target plan id (in CHALLENGER_DRAFTED state)
        review: dict with at minimum `reviewer_agent` + `risks`.
            Optional `verdict` is recorded as governance hint.
        workspace_root: passed through to record_cross_review for
            reviewer_names() validation.
        base_dir: aria-tools root override.

    Returns:
        The final record_cross_review event (state CROSS_REVIEWED).

    Raises:
        GovernanceError if state ≠ CHALLENGER_DRAFTED, or if review
        is malformed.
    """
    _validate_id(plan_id, "plan_id")
    if not isinstance(review, dict):
        raise GovernanceError("V8 cross-review must be a JSON object")

    root = ensure_tools_dir(base_dir)
    state = fold_plan_state(plan_id=plan_id, base_dir=root)
    _require_state(state, {"CHALLENGER_DRAFTED"}, "submit V8 cross-review")

    reviewer_agent = _require_non_empty(
        review.get("reviewer_agent") or "aria-cross-reviewer",
        "reviewer_agent",
    )
    risks = review.get("risks", [])
    if not isinstance(risks, list):
        raise GovernanceError("V8 cross-review risks must be a list")

    # Z3-K2 (ORPHAN-HIGH-629) — direction attribution. The V8 agent submits
    # ONE envelope for both directions, and this function used to copy the
    # SAME risk list + one review_content_hash into both direction records:
    # "who judged whom right" was unknowable, which starved the duel-rating
    # layer of its signal. Each risk row MAY now carry
    # `applies_to_direction` ∈ REQUIRED_CROSS_REVIEW_DIRECTIONS ∪ {"both"};
    # a row without it means "both" — every legacy envelope reads back
    # bit-identically. An unknown value is refused loudly rather than
    # silently pooled, because a silently pooled row would recreate the
    # defect this field exists to close.
    for risk in risks:
        if not isinstance(risk, dict):
            continue
        row_direction = risk.get("applies_to_direction", "both")
        if row_direction not in (*REQUIRED_CROSS_REVIEW_DIRECTIONS, "both"):
            raise GovernanceError(
                f"cross-review risk applies_to_direction is invalid: "
                f"{row_direction!r}"
            )

    latest_rev = state.get("latest_revision") or {}
    target_revision_id = latest_rev.get("revision_id")
    target_hash = latest_rev.get("content_hash")
    if not target_revision_id or not target_hash:
        raise GovernanceError(
            f"V8 cross-review requires CHALLENGER_DRAFTED state with "
            f"complete latest_revision metadata; got "
            f"revision_id={target_revision_id!r} content_hash={target_hash!r}"
        )

    # Round-number: V8 cycle is the next round after the latest. Use
    # current_round if known, otherwise infer from cross_reviews count + 1.
    round_number = state.get("current_round")
    if not isinstance(round_number, int) or round_number <= 0:
        round_number = max(1, len(state.get("cross_reviews") or {}) + 1)

    # Z3-K2 — deterministic PER-DIRECTION content hash over the risks that
    # apply to that direction. One hash for both directions was half of the
    # "direction is fake" defect: identical hashes made the two records
    # indistinguishable to any reader.
    def _direction_risks(direction: str) -> list[dict[str, Any]]:
        return [
            risk
            for risk in risks
            if not isinstance(risk, dict)
            or risk.get("applies_to_direction", "both") in ("both", direction)
        ]

    def _direction_hash(direction: str) -> str:
        return "sha256:" + hashlib.sha256(
            _canonical_json({
                "risks": _direction_risks(direction),
                "reviewer_agent": reviewer_agent,
                "review_direction": direction,
            }).encode("utf-8")
        ).hexdigest()

    # Z3-K2 — per-direction verdicts. The envelope may carry `verdicts`
    # ({direction: verdict}) for a reviewer that judges the two sides
    # differently; the scalar `verdict` remains the both-directions
    # fallback. Without this, submit_cross_review_v8 never forwarded ANY
    # verdict into the direction records — K1 taught the normalizer to
    # keep the field while this producer kept dropping it.
    verdicts = review.get("verdicts")
    if verdicts is not None:
        if not isinstance(verdicts, dict) or not set(verdicts).issubset(
            REQUIRED_CROSS_REVIEW_DIRECTIONS
        ):
            raise GovernanceError(
                "cross-review verdicts must map review directions to verdicts"
            )

    def _direction_verdict(direction: str) -> Any:
        if isinstance(verdicts, dict) and direction in verdicts:
            return verdicts[direction]
        return review.get("verdict")

    sla_deadline = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()

    # Synthesize one task per required cross-review direction.
    # Direction list is sorted deterministically for reproducibility.
    directions = sorted(REQUIRED_CROSS_REVIEW_DIRECTIONS)
    tasks: list[dict[str, Any]] = []
    for direction in directions:
        packet_seed = f"{plan_id}|{target_revision_id}|{target_hash}|round={round_number}|dir={direction}"
        packet_hash = "sha256:" + hashlib.sha256(packet_seed.encode("utf-8")).hexdigest()
        direction_short = "p2c" if direction == "primary_to_challenger" else "c2p"
        tasks.append({
            "task_id": f"v8-cr-{round_number}-{direction_short}-{target_revision_id[-8:]}",
            "task_packet_hash": packet_hash,
            # `_validate_task` (legacy critic task contract) reads
            # `target_agent`; `_validate_cross_review_task` (V8 cross-
            # review path) reads `reviewer_agent`. Carry both so the
            # task dict is accepted by either validator path.
            "target_agent": reviewer_agent,
            "reviewer_agent": reviewer_agent,
            "target_revision_id": target_revision_id,
            "target_plan_content_hash": target_hash,
            "review_direction": direction,
            "sla_deadline": sla_deadline,
            "status_after": "PENDING",
        })

    # Phase 1 — request_cross_review transitions CHALLENGER_DRAFTED
    # → CROSS_REVIEW_REQUESTED + persists both tasks.
    request_cross_review(
        plan_id=plan_id,
        request={
            "round_number": round_number,
            "target_revision_id": target_revision_id,
            "target_plan_content_hash": target_hash,
            "tasks": tasks,
        },
        base_dir=root,
    )

    # Phase 2 — record_cross_review per task. After both directions
    # answer, the state machine resolves to CROSS_REVIEWED.
    last_event: dict[str, Any] = {}
    for task in tasks:
        task_direction = task["review_direction"]
        last_event = record_cross_review(
            plan_id=plan_id,
            review={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": target_revision_id,
                "target_plan_content_hash": target_hash,
                "reviewer_agent": reviewer_agent,
                "review_direction": task_direction,
                "review_content_hash": _direction_hash(task_direction),
                "verdict": _direction_verdict(task_direction),
                "status_after": "ANSWERED",
                # Z3-K2 — each direction record carries ONLY the risks that
                # apply to it (rows without applies_to_direction apply to
                # both, preserving every legacy envelope byte-for-byte).
                "risks": _direction_risks(task_direction),
                # agent_invocation_request_id intentionally omitted —
                # V8 bypasses the per-task content-hash mismatch check
                # because the agent submitted ONE envelope covering both
                # directions; the legacy mismatch check was scoped to
                # per-task envelopes.
            },
            workspace_root=workspace_root,
            base_dir=root,
        )

    return last_event


def reap_stale_tasks(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_state(state, {"CRITIQUE_REQUESTED", "CROSS_REVIEW_REQUESTED"}, "reap stale tasks")
        now = datetime.now(timezone.utc)
        reaped = []
        round_data = state["rounds"].get(round_number) or state["cross_reviews"].get(round_number, {})
        for task in round_data.get("tasks", {}).values():
            if task.get("status") != "PENDING":
                continue
            deadline = _parse_iso_datetime(str(task.get("sla_deadline") or ""))
            if deadline is not None and deadline <= now:
                reaped.append(str(task["task_id"]))
        if not reaped:
            return {
                "schema_version": 1,
                "plan_id": plan_id,
                "event_appended": False,
                "status": state["state"],
                "reaped_task_ids": [],
            }
        payload = {"round_number": round_number, "reaped_task_ids": sorted(reaped)}
        event = _append_event(
            root=root,
            plan_id=plan_id,
            event_type="stale_tasks_reaped",
            payload=payload,
            idempotency_key=_idempotency_key(plan_id, "reap-stale-tasks", payload),
        )
        return _event_result(event, idempotent=False)


def record_revision(
    *,
    plan_id: str,
    revision: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="record-revision",
        canonical_payload=revision,
        event_type="revision_recorded",
        payload=_normalize_revision(revision),
        base_dir=base_dir,
        validator=_validate_revision,
    )


def record_coverage(
    *,
    plan_id: str,
    coverage: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record the deterministic impact-closure verdict for the current round.

    The coverage payload is produced by ``plan_coverage.compute_plan_coverage``
    (machine truth — the plan-coverage witness), never by a planner agent.
    Recording is idempotent on the canonical payload; a recompute against a
    new revision carries a new ``target_plan_content_hash`` and therefore
    lands as a new event. Stale coverage (hash not matching the latest
    revision) is refused before the event is appended — same discipline as
    the cross-review hash-mismatch rejection.
    """
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="record-coverage",
        canonical_payload=coverage,
        event_type="coverage_computed",
        payload=coverage,
        base_dir=base_dir,
        validator=_validate_coverage_record,
    )


def evaluate_plan(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
    max_rounds: int = MAX_CROSS_REVIEW_ROUNDS,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_state(state, {"CRITIQUED", "CROSS_REVIEWED"}, "evaluate plan")
        if state.get("current_round") != round_number:
            raise GovernanceError("round_number must match the current critique round")
        decision = _evaluate_cross_review_state(state, round_number, max_rounds=max_rounds) if state.get("state") == "CROSS_REVIEWED" else _evaluate_state(state, round_number)
        if decision["terminal_state"] == "NEXT_ROUND_REQUIRED":
            return {
                "schema_version": 1,
                "plan_id": plan_id,
                "event_appended": False,
                "status": "next_round_required",
                "reason_codes": decision["reason_codes"],
                "gate_decisions": decision["gate_decisions"],
            }
        payload = {
            "round_number": round_number,
            "terminal_state": decision["terminal_state"],
            "risks_rollup_summary": decision["risks_rollup_summary"],
            "gate_decisions": decision["gate_decisions"],
            "reason_codes": decision["reason_codes"],
        }
        key = _idempotency_key(plan_id, "evaluate", {"round_number": round_number})
        existing = _find_by_idempotency(root, key)
        if existing:
            result = _event_result(existing, idempotent=True)
            result["status"] = "evaluated"
            return result
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_evaluated", payload=payload, idempotency_key=key)
        # Z3b (ORPHAN-HIGH-629) — the duel finally leaves a rateable trace.
        # One knowledge-graph row per evaluated round, written inside the
        # plan lock at the exact point an outcome becomes fact. Ratings are
        # computed at READ time (`calibrated_intelligence.bradley_terry`)
        # from these rows — the ledger stores outcomes, never scores. Not a
        # plan event: EVENT_TYPES is documented as a one-way door, and this
        # is an observation, not lifecycle. Failure costs the observation,
        # never the evaluation.
        try:
            _record_duel_observation(root, plan_id, round_number, state, decision)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        result = _event_result(event, idempotent=False)
        result["status"] = "evaluated"
        return result


def _record_duel_observation(
    root: Path,
    plan_id: str,
    round_number: int,
    fold: dict[str, Any],
    decision: dict[str, Any],
) -> None:
    from .knowledge_graph import _append_row

    reviews = (fold.get("cross_reviews", {}).get(round_number) or {}).get("reviews") or []
    verdicts_by_direction = {
        str(review.get("review_direction")): review.get("verdict")
        for review in reviews
        if isinstance(review, dict)
    }
    risks = fold.get("cross_review_risks_by_round", {}).get(round_number) or []
    _append_row(
        Path(root) / "knowledge-graph" / "duel-ratings.jsonl",
        {
            "schema_version": 1,
            "plan_id": plan_id,
            "round": round_number,
            "primary_agent": "aria-primary-planner",
            "challenger_agent": "aria-challenger-planner",
            "verdicts_by_direction": verdicts_by_direction,
            "material_risk_count": sum(
                1 for r in risks
                if isinstance(r, dict) and r.get("severity") in ("blocking", "material")
            ),
            "resolved_risk_count": len(fold.get("resolved_review_risk_ids") or []),
            "terminal_state": decision.get("terminal_state"),
        },
    )


def list_active_plans(*, base_dir: str | Path | None = None) -> list[str]:
    root = ensure_tools_dir(base_dir)
    path = events_path(root)
    raw = path.read_bytes() if path.exists() else b""
    events_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
    cache_path = root / "plans" / "active-plans-cache.json"
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("events_hash") == events_hash and isinstance(cached.get("active_plan_ids"), list):
                return [str(item) for item in cached["active_plan_ids"]]
        except (OSError, json.JSONDecodeError):
            pass
    event_rows = load_declared_jsonl(
        path,
        expected_surface="plan_convergence_events",
    )
    plan_ids = sorted({str(row.get("plan_id")) for row in event_rows if row.get("plan_id")})
    active = [plan_id for plan_id in plan_ids if fold_plan_state(plan_id=plan_id, base_dir=root).get("state") not in TERMINAL_STATES]
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"schema_version": 1, "events_hash": events_hash, "event_count": len(event_rows), "active_plan_ids": active}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return active


_IMPLEMENTATION_PHASE_STATES = {
    "IMPLEMENTATION_REQUESTED",
    "IMPLEMENTATION_IN_FLIGHT",
    "IMPLEMENTATION_RECORDED",
}


def resume_candidate_plan_id(*, base_dir: str | Path | None = None) -> str | None:
    """E2/F9 — the newest plan still mid-CONVERGENCE, if any.

    Plan identity used to be minted from the cycle id (`plan-<cycle_id>`)
    and the drainer resumed only its own cycle's plan — so the envelopes
    the 01:00 producer minted were answered at 02:00 into a plan NOBODY
    was watching any more, and the next cycle started a fresh plan from
    scratch. Every night's agent work landed on an abandoned plan.

    A new cycle now ADOPTS the newest plan that is neither V8-terminal
    (list_active_plans already filters those) nor resting in an
    implementation-phase state (those belong to the implementer poll and
    the merge reconciler, not to a fresh convergence run). One active
    convergence at a time; None means "start fresh".
    """
    for plan_id in reversed(list_active_plans(base_dir=base_dir)):
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        if not isinstance(state, dict):
            continue
        if state.get("state") in _IMPLEMENTATION_PHASE_STATES:
            continue
        return plan_id
    return None


def force_plan_human_required(
    *,
    plan_id: str,
    round_number: int,
    reason_codes: list[str],
    active_gap_count: int = 0,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if not reason_codes:
        raise GovernanceError("reason_codes must be non-empty")
    root = ensure_tools_dir(base_dir)
    payload = {
        "round_number": round_number,
        "terminal_state": "HUMAN_REQUIRED",
        "risks_rollup_summary": {"max_rounds_reached": True, "active_gaps_unresolved": active_gap_count},
        "gate_decisions": [{"gate": "max_rounds", "decision": "human_escalation", "reason_codes": reason_codes}],
        "reason_codes": reason_codes,
    }
    key = _idempotency_key(plan_id, "force-human-required", payload)
    with _plan_lock(root):
        _verify_events_ledger(root)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_started(state, "force human required")
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_evaluated", payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


def abandon_plan(
    *,
    plan_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(reason, str) or not reason.strip():
        raise GovernanceError("reason must be a non-empty string")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        existing_abandon = _latest_event(state, "plan_abandoned")
        if existing_abandon:
            return _event_result(existing_abandon, idempotent=True)
        _require_started(state, "abandon plan")
        payload = {"reason": reason.strip(), "abandoned_from_state": state["state"]}
        key = _idempotency_key(plan_id, "abandon", payload)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_abandoned", payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


# =============================================================================
# Plan ARIA-V9.2 — implementation-phase public API
# =============================================================================
#
# Five event writers mirroring the V8 ``start_plan`` /
# ``submit_challenger_plan`` / ``record_revision`` pattern. Each
# validator does TWO things:
#
#   1. Pre-append state-precondition check via ``_require_state``
#      — failed precondition raises GovernanceError BEFORE the event
#      lands on disk. Defense-in-depth complement to the reducer-side
#      state precondition check in ``_apply_event`` (V9.0-B), which
#      catches the same violation on the NEXT fold.
#
#   2. Payload-shape check — required fields, value ranges. Shape
#      errors raise GovernanceError; the bad event never appends.
#
# These functions are the kernel-side surface invoked by V9.3
# (convergence_drainer + cross_review_bridge.issue_implementation_envelope)
# and V9.6 (auto_merge_runner). The aria-implementer agent never calls
# them directly — the agent submits its response envelope; the kernel's
# ``record_plan_result`` dispatcher in plan_convergence_bridge.py routes
# the role="implementation" path through ``record_implementation_outcome``
# (V9.3 lands the dispatcher arm).


def request_implementation(
    *,
    plan_id: str,
    implementer_agent: str,
    converged_plan_revision_id: str,
    converged_plan_content_hash: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """V9.2 — emit ``implementation_requested`` event.

    State precondition: CONVERGED (only legal predecessor per V9.0-B
    reducer). The new event transitions state to
    IMPLEMENTATION_REQUESTED.

    Idempotent on (plan_id, "request-implementation",
    {implementer_agent, converged_plan_revision_id,
     converged_plan_content_hash}) — re-requesting the same
    implementation on the same plan is a no-op.
    """
    _validate_id(plan_id, "plan_id")
    _require_non_empty(implementer_agent, "implementer_agent")
    _require_non_empty(converged_plan_revision_id, "converged_plan_revision_id")
    _require_hash(converged_plan_content_hash, "converged_plan_content_hash")
    payload = {
        "implementer_agent": implementer_agent,
        "converged_plan_revision_id": converged_plan_revision_id,
        "converged_plan_content_hash": converged_plan_content_hash,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="request-implementation",
        canonical_payload=payload,
        event_type="implementation_requested",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: (
            _require_state(state, {"CONVERGED"}, "request implementation"),
            _require_coverage_for_implementation(state),
        ),
    )


def record_implementation_started(
    *,
    plan_id: str,
    claim_id: str,
    implementer_agent: str,
    started_at: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """V9.2 — emit ``implementation_started`` event.

    State precondition: IMPLEMENTATION_REQUESTED. Agent has claimed
    the lease.
    """
    _validate_id(plan_id, "plan_id")
    _require_non_empty(claim_id, "claim_id")
    _require_non_empty(implementer_agent, "implementer_agent")
    _require_non_empty(started_at, "started_at")
    payload = {
        "claim_id": claim_id,
        "implementer_agent": implementer_agent,
        "started_at": started_at,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="record-implementation-started",
        canonical_payload=payload,
        event_type="implementation_started",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _require_state(
            state, {"IMPLEMENTATION_REQUESTED"}, "record implementation started",
        ),
    )


def record_implementation_outcome(
    *,
    plan_id: str,
    claim_id: str,
    pr_url: str,
    diff_hash: str,
    branch_tip_sha: str,
    base_branch_sha: str,
    validation_results: list[dict[str, Any]],
    signer_key_fp: str,
    completed_at: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """V9.2 — emit ``implementation_outcome_recorded`` event.

    State precondition: IMPLEMENTATION_IN_FLIGHT. Agent has applied
    the diff, run validations, opened the PR.

    Validation_results entries are size-capped by V9.0-D
    ``truncate_validation_result`` (caller-side per
    MAX_VALIDATION_RESULT_BYTES = 4096). signer_key_fp MUST match the
    cycle's ephemeral key from V9.0-C ``gh_token_factory.SigningKey``;
    the kernel-side ``verify_commit_signature`` cross-check happens
    via implementation_safety, not this validator (we don't want a
    state-machine validator that requires git access).
    """
    _validate_id(plan_id, "plan_id")
    _require_non_empty(claim_id, "claim_id")
    _require_non_empty(pr_url, "pr_url")
    _require_hash(diff_hash, "diff_hash")
    _require_non_empty(branch_tip_sha, "branch_tip_sha")
    _require_non_empty(base_branch_sha, "base_branch_sha")
    _require_non_empty(signer_key_fp, "signer_key_fp")
    _require_non_empty(completed_at, "completed_at")
    if not isinstance(validation_results, list):
        raise GovernanceError("validation_results must be a list")
    payload = {
        "claim_id": claim_id,
        "pr_url": pr_url,
        "diff_hash": diff_hash,
        "branch_tip_sha": branch_tip_sha,
        "base_branch_sha": base_branch_sha,
        "validation_results": validation_results,
        "signer_key_fp": signer_key_fp,
        "completed_at": completed_at,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="record-implementation-outcome",
        canonical_payload=payload,
        event_type="implementation_outcome_recorded",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _require_state(
            state, {"IMPLEMENTATION_IN_FLIGHT"}, "record implementation outcome",
        ),
    )


def record_implementation_merged(
    *,
    plan_id: str,
    merge_sha: str,
    merged_at: str,
    idempotency_key_hash: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """V9.2 — emit ``implementation_merged`` event (terminal state
    IMPLEMENTATION_MERGED).

    State precondition: IMPLEMENTATION_RECORDED. CI green + auto-merge
    succeeded.

    ``idempotency_key_hash`` is sha256 of the V9.6 5-tuple
    (plan_id, diff_hash, pr_number, base_branch, branch_tip_sha) —
    re-running the auto-merge daemon against the same merged PR is
    a no-op.
    """
    _validate_id(plan_id, "plan_id")
    _require_non_empty(merge_sha, "merge_sha")
    _require_non_empty(merged_at, "merged_at")
    _require_hash(idempotency_key_hash, "idempotency_key_hash")
    payload = {
        "merge_sha": merge_sha,
        "merged_at": merged_at,
        "idempotency_key_hash": idempotency_key_hash,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="record-implementation-merged",
        canonical_payload=payload,
        event_type="implementation_merged",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _require_state(
            state, {"IMPLEMENTATION_RECORDED"}, "record implementation merged",
        ),
    )


def record_implementation_rejected(
    *,
    plan_id: str,
    rejection_class: str,
    rejected_at: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """V9.2 — emit ``implementation_rejected`` event (terminal state
    IMPLEMENTATION_REJECTED).

    State precondition: any of IMPLEMENTATION_REQUESTED,
    IMPLEMENTATION_IN_FLIGHT, IMPLEMENTATION_RECORDED.

    rejection_class MUST be in the V9.0-B canonical set (validated
    by _validate_event on append; double-checked here for fail-fast).
    """
    _validate_id(plan_id, "plan_id")
    _require_non_empty(rejection_class, "rejection_class")
    _require_non_empty(rejected_at, "rejected_at")
    payload = {
        "rejection_class": rejection_class,
        "rejected_at": rejected_at,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="record-implementation-rejected",
        canonical_payload=payload,
        event_type="implementation_rejected",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _require_state(
            state,
            {
                "IMPLEMENTATION_REQUESTED",
                "IMPLEMENTATION_IN_FLIGHT",
                "IMPLEMENTATION_RECORDED",
            },
            "record implementation rejected",
        ),
    )


# =============================================================================
# End Plan ARIA-V9.2 implementation-phase public API
# =============================================================================


def plan_status(*, plan_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return fold_plan_state(plan_id=plan_id, base_dir=base_dir)


# Plan ARIA-V8 §4 Phase 8.0 (B-V2-12) — fold_plan_state mtime+plan_id
# cache. Pre-V8 the function did a full ledger scan + per-event
# validate+apply on every call. Convergence_drainer polls it every
# sleep_interval (5s) × deadline (1800s) = 360 calls per cycle wait.
# A 30-cycle smoke with 3 waits per round × 2 rounds = 64,800 calls →
# 15M JSON rows parsed. C0 adds a per-(events_path_mtime_ns, plan_id)
# cache keyed on the events file's mtime; invalidated automatically
# when _append_event() writes (mtime advances). Mirrors the cache
# pattern in list_active_plans (line 296-313).
#
# WHY a module-level dict: thread-safe enough for the single-threaded
# orchestrator loop. WHEN to invalidate: every write to events.jsonl
# advances mtime; the next read sees the new mtime, recomputes, stores.
_FOLD_PLAN_STATE_CACHE: dict[tuple[int, str, str], dict[str, Any]] = {}
_FOLD_PLAN_STATE_CACHE_MAX_ENTRIES = 512


def _events_file_size_bytes(root: Path) -> int:
    """Use FILE SIZE as the cache invalidation key.

    WHY NOT mtime: `ensure_tools_dir` calls `update_tools_index` which
    touches integrity metadata on events.jsonl, advancing mtime even
    when content is unchanged. Using size instead means the cache only
    invalidates on REAL appends (events.jsonl grows monotonically).
    """
    p = events_path(root)
    try:
        return p.stat().st_size
    except (FileNotFoundError, OSError):
        return 0


def fold_plan_state(*, plan_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    cache_key = (_events_file_size_bytes(root), str(root), plan_id)
    cached = _FOLD_PLAN_STATE_CACHE.get(cache_key)
    if cached is not None:
        # Plan ARIA-V9.0-B — deepcopy on cache HIT.
        #
        # Pre-V9 the cache returned a SHALLOW dict-comprehension copy
        # (`{k: v.copy() if isinstance(v, (dict, list)) else v ...}`).
        # That copied the top-level dict + the FIRST level of nested
        # dicts/lists but NOT recursively. The V8 reducer wrote
        # `state["rounds"][N]["tasks"][hash] = {...}` two levels deep;
        # callers mutating round.tasks[hash].critique corrupted the
        # shared cache. V9 introduces `state["implementation"] = {...,
        # "validation_results": [{"stdout": ..., "stderr": ...}, ...]}`
        # which is 3 levels deep — the shallow strategy is unsafe.
        #
        # performance-expert PERF-MED-011 quantified ~50μs ×
        # ~1800 poll-calls/cycle = ~90ms/cycle overhead; acceptable.
        # ai-safety MED-019 + arch-arbiter MED-009 both reference this
        # site. Closes performance PERF-CRIT-004 + PERF-MED-011.
        return copy.deepcopy(cached)
    events = [
        row for row in load_declared_jsonl(
            events_path(root),
            expected_surface="plan_convergence_events",
        )
        if row.get("plan_id") == plan_id
    ]
    state = _initial_state(plan_id)
    for event in events:
        _validate_event(event)
        _apply_event(state, event)
    _derive_state(state)
    # Cap cache size — drop oldest entry when full (FIFO)
    if len(_FOLD_PLAN_STATE_CACHE) >= _FOLD_PLAN_STATE_CACHE_MAX_ENTRIES:
        _FOLD_PLAN_STATE_CACHE.pop(next(iter(_FOLD_PLAN_STATE_CACHE)))
    # Plan ARIA-V9.0-B — deepcopy on cache WRITE (paired with HIT-side
    # deepcopy above so cache entry can never share nested-mutable
    # references with the live `state` dict the caller now owns).
    _FOLD_PLAN_STATE_CACHE[cache_key] = copy.deepcopy(state)
    return state


_ORPHAN_PENDING_STATES: frozenset[str] = frozenset({
    "IMPLEMENTATION_REQUESTED",
    "IMPLEMENTATION_IN_FLIGHT",
})


def scan_orphan_implementation_requests(
    *,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V3.1-B2 — find plans stuck in pre-terminal implementation
    states (closes 6-validator H-12 orphan reaper).

    A plan is "orphan" when its folded state is one of
    `_ORPHAN_PENDING_STATES` (`IMPLEMENTATION_REQUESTED` —
    request was minted but agent never claimed; or
    `IMPLEMENTATION_IN_FLIGHT` — agent claimed but never returned).
    Crash paths in the orchestrator OR the aria-implementer that
    bypass try/finally cleanup leave plans in these states; the
    next orchestrator startup uses this scanner to enumerate them
    + transitions each to IMPLEMENTATION_REJECTED via
    record_implementation_rejected("orchestrator_restart_reaped_orphan").

    Returns list of dicts shaped:
        {"plan_id": str, "state": str, "last_event_at": str | None}

    Scans `plans/events.jsonl` exactly once + folds state per
    distinct plan_id (O(N events + K plans × cached fold)).
    """
    root = ensure_tools_dir(base_dir)
    events_file = root / "plans" / "events.jsonl"
    if not events_file.exists():
        return []
    # Enumerate distinct plan_ids + track last_event_at per plan.
    plan_ids: dict[str, str | None] = {}
    for event in load_declared_jsonl(
        events_file,
        expected_surface="plan_convergence_events",
    ):
        pid = event.get("plan_id")
        if isinstance(pid, str) and pid:
            ts = event.get("ts") or event.get("created_at")
            if isinstance(ts, str):
                plan_ids[pid] = ts
            else:
                plan_ids.setdefault(pid, None)
    orphans: list[dict[str, Any]] = []
    for plan_id, last_ts in plan_ids.items():
        try:
            state = fold_plan_state(plan_id=plan_id, base_dir=root)
        except Exception:
            # Bad row / unknown event_type — skip; the row-level
            # integrity gate runs elsewhere.
            continue
        s = state.get("state") if isinstance(state, dict) else None
        if isinstance(s, str) and s in _ORPHAN_PENDING_STATES:
            orphans.append({
                "plan_id": plan_id,
                "state": s,
                "last_event_at": last_ts,
            })
    return orphans


def content_hash(payload: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "plans" / "events.jsonl"


def _mutate(
    *,
    plan_id: str,
    command_name: str,
    canonical_payload: Any,
    event_type: str,
    payload: dict[str, Any],
    base_dir: str | Path | None,
    validator: Any,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    key = _idempotency_key(plan_id, command_name, canonical_payload)
    with _plan_lock(root):
        _verify_events_ledger(root)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        validator(state, payload) if _takes_payload(validator) else validator(state)
        event = _append_event(root=root, plan_id=plan_id, event_type=event_type, payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


def _append_event(
    *,
    root: Path,
    plan_id: str,
    event_type: str,
    payload: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    event = {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "plan_id": plan_id,
        "recorded_at": utc_now(),
        "idempotency_key": idempotency_key,
        "payload": payload,
    }
    _validate_event(event)
    return append_declared_jsonl(
        events_path(root),
        event,
        expected_surface="plan_convergence_events",
    )


def _append_rejection(root: Path, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    return append_tools_governance(root, kind, details)


def _event_result(event: dict[str, Any], *, idempotent: bool) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": event["plan_id"],
        "event_appended": not idempotent,
        "idempotent": idempotent,
        "event": event,
    }


def _idempotency_key(plan_id: str, command_name: str, canonical_payload: Any) -> str:
    raw = f"{plan_id}|{command_name}|{_canonical_json(canonical_payload)}"
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _canonical_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _find_by_idempotency(root: Path, key: str) -> dict[str, Any] | None:
    for row in load_declared_jsonl(
        events_path(root),
        expected_surface="plan_convergence_events",
    ):
        if row.get("idempotency_key") == key:
            return row
    return None


def _results_pair_hash_check(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan 026R §C.4 — bidirectional cross-review result-pair check.

    A convergent-planning round expects TWO accepted cross-review
    result rows (one per direction: primary→challenger and
    challenger→primary). This helper asserts:

    1. Both rows EXIST in ``agent-invocations/results.jsonl`` for the
       given ``(plan_id, round_number)``.
    2. Both rows carry a non-null ``content_hash`` field (§C.2 made
       this alias non-None on every accepted result row; pre-§C.4 the
       lookup was permanently None).
    3. The two ``content_hash`` values DIFFER. Identical hashes mean
       the same reviewer wrote both reviews — a collusion / single-
       agent signal that defeats the cross-review's adversarial
       contract.

    Raises ``GovernanceError`` with a structured reason code on any
    failure:

    * ``cross_review_pair_missing`` — zero rows found.
    * ``cross_review_pair_single_role_only`` — one direction filed.
    * ``cross_review_pair_identical_content_hash`` — collusion signal.

    On success returns ``{"plan_id", "round_number", "pair":
    [row_a, row_b]}`` so callers can chain ledger writes against the
    pair without re-querying.
    """
    root = Path(base_dir) if base_dir else Path.cwd()
    results = load_declared_jsonl(
        root / "agent-invocations" / "results.jsonl",
        expected_surface="agent_invocation_results",
    )
    candidates: list[dict[str, Any]] = []
    for row in results:
        if row.get("status") != "accepted":
            continue
        if row.get("role") != "cross_review":
            continue
        # Match on convergence_id OR plan_id; the kernel persists both
        # on different historical schemas, so accept either.
        row_plan_id = (
            row.get("plan_id")
            or row.get("convergence_id")
            or row.get("convergence_plan_id")
        )
        if row_plan_id != plan_id:
            continue
        if int(row.get("round_number") or row.get("round") or 0) != round_number:
            continue
        candidates.append(row)
    if not candidates:
        raise GovernanceError(
            f"cross_review_pair_missing: plan_id={plan_id!r} "
            f"round_number={round_number}"
        )
    if len(candidates) == 1:
        raise GovernanceError(
            f"cross_review_pair_single_role_only: plan_id={plan_id!r} "
            f"round_number={round_number} found 1 cross-review row, "
            f"need 2 (one per direction)"
        )
    # Take the most recent 2 (a round may have retries; the pair is
    # the last 2 by submission order).
    pair = candidates[-2:]
    hashes = [row.get("content_hash") for row in pair]
    if any(h is None for h in hashes):
        raise GovernanceError(
            f"cross_review_pair_missing_content_hash: plan_id={plan_id!r} "
            f"round_number={round_number} hashes={hashes}"
        )
    if hashes[0] == hashes[1]:
        raise GovernanceError(
            f"cross_review_pair_identical_content_hash: plan_id={plan_id!r} "
            f"round_number={round_number} hash={hashes[0]!r} — "
            f"identical reviews defeat the cross-review's adversarial "
            f"contract (collusion / single-agent signal)"
        )
    return {
        "plan_id": plan_id,
        "round_number": round_number,
        "pair": pair,
    }


def _cross_review_hash_mismatch(root: Path, payload: dict[str, Any]) -> dict[str, Any] | None:
    request_id = payload.get("agent_invocation_request_id")
    if not request_id:
        return None
    expected = payload.get("review_content_hash")
    for row in reversed(load_declared_jsonl(
        root / "agent-invocations" / "results.jsonl",
        expected_surface="agent_invocation_results",
    )):
        if row.get("request_id") == request_id:
            actual = row.get("content_hash")
            if actual != expected:
                return {"agent_invocation_request_id": request_id, "expected_content_hash": actual, "provided_review_content_hash": expected}
            return None
    return {"agent_invocation_request_id": request_id, "reason": "agent_invocation_result_not_found", "provided_review_content_hash": expected}


def _verify_events_ledger(root: Path) -> None:
    result = verify_jsonl(events_path(root))
    if result.get("valid") is not True:
        raise GovernanceError(f"plans/events.jsonl integrity failure: {result.get('reason')}")


@contextmanager
def _plan_lock(root: Path) -> Iterator[None]:
    lock_path = root / "plans" / "events.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": os.getpid(), "created_at": time.time()}
    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _reap_stale_lock(lock_path):
                continue
            raise GovernanceError("plans/events.jsonl is locked")
    try:
        os.write(fd, json.dumps(payload, sort_keys=True).encode("utf-8"))
        yield
    finally:
        if fd is not None:
            os.close(fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _reap_stale_lock(lock_path: Path) -> bool:
    try:
        data = json.loads(lock_path.read_text(encoding="utf-8") or "{}")
    except (OSError, json.JSONDecodeError):
        data = {}
    pid = data.get("pid")
    created_at = float(data.get("created_at") or 0)
    if time.time() - created_at < LOCK_STALE_SECONDS:
        return False
    if isinstance(pid, int) and _pid_exists(pid):
        return False
    try:
        lock_path.unlink()
        return True
    except FileNotFoundError:
        return True


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _initial_state(plan_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": plan_id,
        "state": None,
        "events": [],
        "plan_started": None,
        "latest_revision": None,
        "challenger_plan": None,
        "current_round": None,
        "rounds": {},
        "cross_reviews": {},
        "cross_review_risks_by_round": {},
        "resolved_review_risk_ids": [],
        "coverage_by_round": {},
        "terminal_state": None,
    }


def _apply_event(state: dict[str, Any], event: dict[str, Any]) -> None:
    state["events"].append(event)
    event_type = event["event_type"]
    payload = event["payload"]
    if event_type == "plan_started":
        state["state"] = "DRAFT"
        state["plan_started"] = payload
        state["latest_revision"] = {
            "revision_id": payload["initial_revision_id"],
            "content_hash": payload["content_hash"],
            "source": "plan_started",
        }
    elif event_type == "challenger_plan_drafted":
        # Plan ARIA-V8.18 — preserve plan_content in state reduction.
        # Pre-V8.18 the reduction stored only revision metadata + agent
        # identity but DISCARDED the actual plan_content dict from the
        # ledger event. The convergence_drainer V8.3 lookup then read
        # `state.challenger.plan_content` (also under the canonical
        # `challenger` key, not the pre-V8.18 `challenger_plan` alias)
        # to embed the challenger plan body into the cross_review
        # envelope's `<untrusted_challenger_plan>` delimiter. With
        # plan_content dropped, the drainer's fail-fast fallback fired
        # ("challenger plan_content unavailable in plan state"), the
        # cross-reviewer agent rightly refused with
        # `evidence_underspecified`, and convergence stalled.
        state["state"] = "CHALLENGER_DRAFTED"
        challenger_record = {
            "challenger_revision_id": payload["challenger_revision_id"],
            "content_hash": payload["content_hash"],
            "source_revision_id": payload["source_revision_id"],
            "source_plan_content_hash": payload["source_plan_content_hash"],
            "challenger_agent": payload.get("challenger_agent"),
            "plan_content": payload.get("plan_content"),
        }
        state["challenger"] = challenger_record
        # V8.18 — keep the legacy `challenger_plan` alias for any
        # consumer that already read it pre-V8.18; both keys point at
        # the same dict instance so a future drop of the legacy alias
        # is a single-line removal (no parallel data path).
        state["challenger_plan"] = challenger_record
    elif event_type == "critic_tasks_requested":
        round_number = payload["round_number"]
        state["current_round"] = round_number
        state["state"] = "CRITIQUE_REQUESTED"
        state["rounds"][round_number] = {
            "target_revision_id": payload["target_revision_id"],
            "target_plan_content_hash": payload["target_plan_content_hash"],
            "tasks": {
                task["task_packet_hash"]: {
                    **task,
                    "status": task["status_after"],
                    "critique": None,
                }
                for task in payload["tasks"]
            },
            "critiques": [],
        }
    elif event_type == "cross_review_tasks_requested":
        round_number = payload["round_number"]
        state["current_round"] = round_number
        state["state"] = "CROSS_REVIEW_REQUESTED"
        cross = state["cross_reviews"].setdefault(
            round_number,
            {
                "target_revision_id": payload["target_revision_id"],
                "target_plan_content_hash": payload["target_plan_content_hash"],
                "tasks": {},
                "reviews": [],
                "replaces_task_ids": [],
            },
        )
        replaced_by = {task_id: [] for task_id in payload.get("replaces_task_ids", [])}
        for task in payload["tasks"]:
            task_record = {**task, "status": task["status_after"], "review": None}
            cross["tasks"][task["task_packet_hash"]] = task_record
            for old_task_id in payload.get("replaces_task_ids", []):
                replaced_by.setdefault(old_task_id, []).append(task["task_id"])
        cross["replaces_task_ids"].extend(payload.get("replaces_task_ids", []))
        task_by_id = {task["task_id"]: task for task in cross["tasks"].values()}
        for old_task_id, new_task_ids in replaced_by.items():
            if old_task_id in task_by_id:
                task_by_id[old_task_id]["replaced_by_task_ids"] = sorted(set(new_task_ids))
    elif event_type == "critique_recorded":
        round_data = _round_for_target(state, payload["target_revision_id"], payload["target_plan_content_hash"])
        task = round_data["tasks"][payload["task_packet_hash"]]
        task["status"] = payload["status_after"]
        task["critique"] = payload
        round_data["critiques"].append(payload)
    elif event_type == "cross_review_recorded":
        cross = _cross_review_for_target(state, payload["target_revision_id"], payload["target_plan_content_hash"])
        task = cross["tasks"][payload["task_packet_hash"]]
        task["status"] = payload["status_after"]
        task["review"] = payload
        cross["reviews"].append(payload)
        surfaced = state["cross_review_risks_by_round"].setdefault(state["current_round"], [])
        # Z3-K3 (ORPHAN-HIGH-629) — the two cross_review_recorded events of a
        # round carried the same risks list and were appended blind, so every
        # risk counted twice: gate margins doubled and any rating metric
        # would read 2x. Dedup by risk_id within the round; a risk without an
        # id keeps legacy append behaviour (nothing to key on).
        seen_risk_ids = {r.get("risk_id") for r in surfaced if r.get("risk_id")}
        for risk in payload.get("risks", []):
            rid = risk.get("risk_id")
            if rid and rid in seen_risk_ids:
                continue
            if rid:
                seen_risk_ids.add(rid)
            surfaced.append({**risk, "surfaced_in_revision_id": payload["target_revision_id"]})
    elif event_type == "stale_tasks_reaped":
        round_data = state["rounds"].get(payload["round_number"]) or state["cross_reviews"].get(payload["round_number"], {})
        task_by_id = {task["task_id"]: task for task in round_data.get("tasks", {}).values()}
        for task_id in payload["reaped_task_ids"]:
            if task_id in task_by_id:
                task_by_id[task_id]["status"] = "TIMEOUT_ABORTED"
    elif event_type == "revision_recorded":
        state["state"] = "REVISED"
        state["latest_revision"] = {
            "revision_id": payload["revision_id"],
            "content_hash": payload["content_hash"],
            "source": "revision_recorded",
            "round": payload["round"],
        }
        # Plan ARIA-V10.4 Phase 3.H.11 (F-022) — advance current_round.
        # Pre-fix the reducer set the new latest_revision but left
        # current_round untouched at the round that PRODUCED the
        # revision. The next P+C+CR cycle's submit_cross_review_v8 then
        # read state["current_round"] = N and tried to register cross-
        # review tasks for round N, which already existed in
        # state["cross_reviews"][N] from the previous P+C+CR. The
        # validator at _validate_cross_review_task_payload (line 1623)
        # raised "round has already requested cross-review" and the
        # bridge fold fired agent_bridge_warning — cycle 1 (cyc-
        # 20260520T141138Z-auto) stalled at CHALLENGER_DRAFTED after
        # F-021 finally let the revision land. Tier-1 architectural
        # fix: revision_recorded is the natural state-machine seam
        # where "next round begins" — advance current_round to
        # payload["round"] + 1 so the next cross_review targets a
        # fresh round number.
        state["current_round"] = payload["round"] + 1
        resolved = set(state.get("resolved_review_risk_ids", []))
        resolved.update(str(item) for item in payload.get("addresses_review_risk_ids", []) if isinstance(item, str) and item)
        state["resolved_review_risk_ids"] = sorted(resolved)
    elif event_type == "coverage_computed":
        # Annotation event: state["state"] is deliberately NOT changed, so
        # _derive_state / evaluate_plan preconditions are untouched. The
        # legal-predecessor set includes the RAW request states because
        # CRITIQUED / CROSS_REVIEWED are derived only at the END of the
        # fold (_derive_state) — during replay the stored state at the
        # moment this event landed is still *_REQUESTED.
        if state.get("state") not in {
            "CRITIQUE_REQUESTED",
            "CRITIQUED",
            "CROSS_REVIEW_REQUESTED",
            "CROSS_REVIEWED",
        }:
            raise GovernanceError(
                f"invalid_transition: from={state.get('state')} "
                "event=coverage_computed expected=CRITIQUE_REQUESTED|CRITIQUED|"
                "CROSS_REVIEW_REQUESTED|CROSS_REVIEWED"
            )
        round_number = payload["round_number"]
        state["coverage_by_round"][round_number] = payload
        # Synthetic coverage_gap risks ride the EXISTING risk channel so the
        # material gate, risk rollups, and addresses_review_risk_ids feedback
        # all work unchanged. Risk ids are round-scoped (COV-R{N}-…) so the
        # globally-accumulating resolved_review_risk_ids set cannot mask a
        # re-detected gap in a later round.
        surfaced = state["cross_review_risks_by_round"].setdefault(round_number, [])
        for risk in payload.get("synthetic_risks", []):
            surfaced.append({**risk, "surfaced_in_revision_id": payload["target_revision_id"]})
    elif event_type == "plan_evaluated":
        state["state"] = payload["terminal_state"]
        state["terminal_state"] = payload["terminal_state"]
    elif event_type == "plan_abandoned":
        state["state"] = "ABANDONED"
        state["terminal_state"] = "ABANDONED"
    # Plan ARIA-V9.0-B — implementation-phase reducer transitions.
    # Each event_type checks the single legal predecessor state and
    # raises GovernanceError(invalid_transition: …) on out-of-order
    # arrival. Tier-1 (make impossible to reach an out-of-order
    # IMPLEMENTATION_RECORDED without first passing through
    # IMPLEMENTATION_REQUESTED + IMPLEMENTATION_IN_FLIGHT). Closes
    # architectural-arbiter CRIT-003 + MED-009.
    elif event_type == "implementation_requested":
        if state.get("state") != "CONVERGED":
            raise GovernanceError(
                f"invalid_transition: from={state.get('state')} "
                f"event=implementation_requested expected=CONVERGED"
            )
        state["state"] = "IMPLEMENTATION_REQUESTED"
        state["implementation"] = {
            "implementer_agent": payload["implementer_agent"],
            "converged_plan_revision_id": payload["converged_plan_revision_id"],
            "converged_plan_content_hash": payload["converged_plan_content_hash"],
            "claim_id": None,
            "pr_url": None,
            "diff_hash": None,
            "branch_tip_sha": None,
            "validation_results": [],
            "signer_key_fp": None,
            "base_branch_sha": None,
            "started_at": None,
            "completed_at": None,
            "merged_at": None,
            "rejected_at": None,
            "rejection_class": None,
        }
    elif event_type == "implementation_started":
        if state.get("state") != "IMPLEMENTATION_REQUESTED":
            raise GovernanceError(
                f"invalid_transition: from={state.get('state')} "
                f"event=implementation_started expected=IMPLEMENTATION_REQUESTED"
            )
        state["state"] = "IMPLEMENTATION_IN_FLIGHT"
        state["implementation"]["claim_id"] = payload["claim_id"]
        # V9.0-B: payload.implementer_agent is the agent that actually
        # claimed the lease; reducer preserves it for cross-check
        # against the implementer_agent recorded at request time —
        # mismatch is a downstream invariant test, not a kernel reject
        # (the kernel cannot adjudicate agent-identity drift).
        state["implementation"]["claimed_by_agent"] = payload["implementer_agent"]
        state["implementation"]["started_at"] = payload.get("started_at")
    elif event_type == "implementation_outcome_recorded":
        if state.get("state") != "IMPLEMENTATION_IN_FLIGHT":
            raise GovernanceError(
                f"invalid_transition: from={state.get('state')} "
                f"event=implementation_outcome_recorded expected=IMPLEMENTATION_IN_FLIGHT"
            )
        state["state"] = "IMPLEMENTATION_RECORDED"
        impl = state["implementation"]
        impl["pr_url"] = payload["pr_url"]
        impl["diff_hash"] = payload["diff_hash"]
        impl["branch_tip_sha"] = payload["branch_tip_sha"]
        impl["validation_results"] = payload.get("validation_results", [])
        impl["signer_key_fp"] = payload["signer_key_fp"]
        impl["base_branch_sha"] = payload["base_branch_sha"]
        impl["completed_at"] = payload.get("completed_at")
    elif event_type == "implementation_merged":
        if state.get("state") != "IMPLEMENTATION_RECORDED":
            raise GovernanceError(
                f"invalid_transition: from={state.get('state')} "
                f"event=implementation_merged expected=IMPLEMENTATION_RECORDED"
            )
        state["state"] = "IMPLEMENTATION_MERGED"
        state["terminal_state"] = "IMPLEMENTATION_MERGED"
        state["implementation"]["merge_sha"] = payload["merge_sha"]
        state["implementation"]["merged_at"] = payload["merged_at"]
        state["implementation"]["idempotency_key_hash"] = payload["idempotency_key_hash"]
    elif event_type == "implementation_rejected":
        # implementation_rejected has 3 legal predecessor states
        # (REQUESTED / IN_FLIGHT / RECORDED) — the rejection_class
        # value carries which transition fired so the audit trail is
        # unambiguous downstream.
        valid_predecessors = {
            "IMPLEMENTATION_REQUESTED",
            "IMPLEMENTATION_IN_FLIGHT",
            "IMPLEMENTATION_RECORDED",
        }
        prior_state = state.get("state")
        if prior_state not in valid_predecessors:
            raise GovernanceError(
                f"invalid_transition: from={prior_state} "
                f"event=implementation_rejected expected=any of "
                f"{sorted(valid_predecessors)}"
            )
        state["state"] = "IMPLEMENTATION_REJECTED"
        state["terminal_state"] = "IMPLEMENTATION_REJECTED"
        impl = state.setdefault("implementation", {})
        impl["rejection_class"] = payload["rejection_class"]
        impl["rejected_at"] = payload["rejected_at"]
        # Record the predecessor explicitly for audit forensics — V9.6
        # auto_merge runner reads rejected_from_state to attribute
        # rejection reason to a specific transition (e.g. ci_check_red
        # arriving in RECORDED vs in_flight_abandoned arriving in
        # IN_FLIGHT).
        impl["rejected_from_state"] = prior_state


def _derive_state(state: dict[str, Any]) -> None:
    if state["state"] in TERMINAL_STATES:
        return
    if state["state"] == "CROSS_REVIEW_REQUESTED":
        directions = _cross_review_direction_statuses(state, state.get("current_round"))
        if directions and all(status == "answered" for status in directions.values()):
            state["state"] = "CROSS_REVIEWED"
        return
    if state["state"] != "CRITIQUE_REQUESTED":
        return
    current_round = state.get("current_round")
    round_data = state["rounds"].get(current_round, {})
    tasks = list(round_data.get("tasks", {}).values())
    if tasks and all(task.get("status") in ANSWERED_STATES for task in tasks):
        state["state"] = "CRITIQUED"


def _round_for_target(state: dict[str, Any], revision_id: str, content_hash_value: str) -> dict[str, Any]:
    for round_data in state["rounds"].values():
        if round_data.get("target_revision_id") == revision_id and round_data.get("target_plan_content_hash") == content_hash_value:
            return round_data
    raise GovernanceError("target revision does not match an active critique round")


def _cross_review_for_target(state: dict[str, Any], revision_id: str, content_hash_value: str) -> dict[str, Any]:
    for round_data in state["cross_reviews"].values():
        if round_data.get("target_revision_id") == revision_id and round_data.get("target_plan_content_hash") == content_hash_value:
            return round_data
    raise GovernanceError("target revision does not match an active cross-review round")


def _normalize_critic_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise GovernanceError("critic request must be a JSON object")
    tasks = request.get("tasks")
    if not isinstance(tasks, list):
        raise GovernanceError("critic request tasks must be an array")
    return {
        "round_number": request.get("round_number"),
        "target_revision_id": request.get("target_revision_id"),
        "target_plan_content_hash": request.get("target_plan_content_hash"),
        "tasks": [{**task, "status_after": task.get("status_after", "PENDING")} for task in tasks],
    }


def _normalize_challenger_plan(challenger: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(challenger, dict):
        raise GovernanceError("challenger plan must be a JSON object")
    plan_content = challenger.get("plan_content")
    _validate_plan_content(plan_content)
    return {
        "challenger_agent": challenger.get("challenger_agent"),
        "challenger_revision_id": challenger.get("challenger_revision_id"),
        "source_revision_id": challenger.get("source_revision_id"),
        "source_plan_content_hash": challenger.get("source_plan_content_hash"),
        "plan_content": plan_content,
        "content_hash": content_hash(plan_content),
    }


def _normalize_cross_review_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise GovernanceError("cross-review request must be a JSON object")
    tasks = request.get("tasks")
    if not isinstance(tasks, list):
        raise GovernanceError("cross-review request tasks must be an array")
    return {
        "round_number": request.get("round_number"),
        "target_revision_id": request.get("target_revision_id"),
        "target_plan_content_hash": request.get("target_plan_content_hash"),
        "replaces_task_ids": [str(item) for item in request.get("replaces_task_ids", []) if isinstance(item, str) and item],
        "tasks": [{**task, "status_after": task.get("status_after", "PENDING")} for task in tasks],
    }


def _normalize_cross_review(review: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(review, dict):
        raise GovernanceError("cross-review must be a JSON object")
    return {
        "task_packet_hash": review.get("task_packet_hash"),
        "target_revision_id": review.get("target_revision_id"),
        "target_plan_content_hash": review.get("target_plan_content_hash"),
        "reviewer_agent": review.get("reviewer_agent"),
        "review_direction": review.get("review_direction"),
        "risks": review.get("risks", []),
        # Z3-K1 (ORPHAN-HIGH-629) — the reviewer's verdict was asked for by
        # the agent contract, promised by the submit docstring, and then
        # DROPPED here: no rating layer could ever see who judged whom
        # right. Legacy rows read back as None — old ledgers stay valid.
        "verdict": review.get("verdict"),
        "review_content_hash": review.get("review_content_hash"),
        "agent_invocation_request_id": review.get("agent_invocation_request_id"),
        "status_after": review.get("status_after", "ANSWERED"),
    }


def _normalize_critique(critique: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(critique, dict):
        raise GovernanceError("critique must be a JSON object")
    return {
        "task_packet_hash": critique.get("task_packet_hash"),
        "target_revision_id": critique.get("target_revision_id"),
        "target_plan_content_hash": critique.get("target_plan_content_hash"),
        "reviewer": critique.get("reviewer"),
        "risks": critique.get("risks", []),
        "critique_content_hash": critique.get("critique_content_hash"),
        "status_after": critique.get("status_after", "ANSWERED"),
    }


def _normalize_revision(revision: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(revision, dict):
        raise GovernanceError("revision must be a JSON object")
    return {
        "revision_id": revision.get("revision_id"),
        "round": revision.get("round"),
        "content_hash": revision.get("content_hash"),
        "parent_revision_hash": revision.get("parent_revision_hash"),
        "content": revision.get("content"),
        "addresses_review_risk_ids": [str(item) for item in revision.get("addresses_review_risk_ids", []) if isinstance(item, str) and item],
    }


def _validate_start(state: dict[str, Any]) -> None:
    if state["plan_started"] is not None:
        raise GovernanceError("plan has already been started")


def _validate_critic_request(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"DRAFT", "REVISED", "CROSS_REVIEWED"}, "request critics")
    round_number = payload.get("round_number")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if round_number in state["rounds"]:
        raise GovernanceError("round has already requested critics")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    latest = state["latest_revision"]
    if target_revision_id != latest["revision_id"] or target_hash != latest["content_hash"]:
        raise GovernanceError("critic request must target the latest revision")
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise GovernanceError("tasks must contain at least one task")
    if len(tasks) > MAX_TASKS_PER_ROUND:
        raise GovernanceError("critic tasks per round limit exceeded")
    seen_hashes = set()
    for task in tasks:
        _validate_task(task, target_revision_id, target_hash)
        packet_hash = task["task_packet_hash"]
        if packet_hash in seen_hashes:
            raise GovernanceError("duplicate task_packet_hash")
        seen_hashes.add(packet_hash)


def _validate_challenger_plan(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"DRAFT", "REVISED"}, "submit challenger plan")
    _validate_id(_require_non_empty(payload.get("challenger_revision_id"), "challenger_revision_id"), "challenger_revision_id")
    _require_hash(payload.get("content_hash"), "content_hash")
    source_revision_id = _require_non_empty(payload.get("source_revision_id"), "source_revision_id")
    source_hash = _require_hash(payload.get("source_plan_content_hash"), "source_plan_content_hash")
    latest = state["latest_revision"]
    if source_revision_id != latest["revision_id"] or source_hash != latest["content_hash"]:
        raise GovernanceError("challenger plan must target latest primary revision")


def _validate_cross_review_request(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CHALLENGER_DRAFTED"}, "request cross-review")
    _validate_cross_review_task_payload(state, payload, allow_replaces=False)


def _validate_cross_review_retry(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CROSS_REVIEW_REQUESTED"}, "request cross-review retry")
    _validate_cross_review_task_payload(state, payload, allow_replaces=True)
    cross = state["cross_reviews"].get(payload["round_number"], {})
    task_by_id = {task["task_id"]: task for task in cross.get("tasks", {}).values()}
    for task_id in payload.get("replaces_task_ids", []):
        if task_by_id.get(task_id, {}).get("status") != "TIMEOUT_ABORTED":
            raise GovernanceError("replaces_task_ids must name timed-out cross-review tasks")


def _validate_cross_review_task_payload(state: dict[str, Any], payload: dict[str, Any], *, allow_replaces: bool) -> None:
    round_number = payload.get("round_number")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if not allow_replaces and round_number in state["cross_reviews"]:
        raise GovernanceError("round has already requested cross-review")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    latest = state["latest_revision"]
    if target_revision_id != latest["revision_id"] or target_hash != latest["content_hash"]:
        raise GovernanceError("cross-review request must target the latest revision")
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise GovernanceError("tasks must contain at least one task")
    if len(tasks) > MAX_TASKS_PER_ROUND:
        raise GovernanceError("cross-review tasks per round limit exceeded")
    existing = state["cross_reviews"].get(round_number, {}) if allow_replaces else {}
    existing_task_ids = {task["task_id"] for task in existing.get("tasks", {}).values()}
    existing_packet_hashes = set(existing.get("tasks", {}).keys())
    seen_hashes = set()
    seen_task_ids = set()
    directions = set()
    for task in tasks:
        _validate_cross_review_task(task, target_revision_id, target_hash)
        packet_hash = task["task_packet_hash"]
        if packet_hash in seen_hashes:
            raise GovernanceError("duplicate task_packet_hash")
        if packet_hash in existing_packet_hashes:
            raise GovernanceError("retry task_packet_hash must be new")
        seen_hashes.add(packet_hash)
        task_id = task["task_id"]
        if task_id in seen_task_ids or task_id in existing_task_ids:
            raise GovernanceError("retry task_id must be new")
        seen_task_ids.add(task_id)
        directions.add(task["review_direction"])
    if not allow_replaces and not REQUIRED_CROSS_REVIEW_DIRECTIONS.issubset(directions):
        raise GovernanceError("cross-review must request both review directions")


def _validate_critique(state: dict[str, Any], payload: dict[str, Any], workspace_root: str | Path) -> None:
    _require_state(state, {"CRITIQUE_REQUESTED", "CRITIQUED"}, "record critique")
    packet_hash = _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    reviewer = _require_non_empty(payload.get("reviewer"), "reviewer")
    names = reviewer_names(workspace_root=workspace_root)
    if reviewer not in names:
        raise GovernanceError(f"unknown reviewer: {reviewer}")
    round_data = _round_for_target(state, target_revision_id, target_hash)
    task = round_data["tasks"].get(packet_hash)
    if task is None:
        raise GovernanceError("task_packet_hash does not match an active task")
    if task.get("status") == "TIMEOUT_ABORTED":
        raise GovernanceError("late critique after timeout is rejected")
    if task.get("status") != "PENDING":
        raise GovernanceError("critique task is not pending")
    if reviewer != task.get("target_agent"):
        raise GovernanceError("reviewer must match task target_agent")
    _require_hash(payload.get("critique_content_hash"), "critique_content_hash")
    if payload.get("status_after") != "ANSWERED":
        raise GovernanceError('critique status_after must be "ANSWERED"')
    risks = payload.get("risks")
    if not isinstance(risks, list):
        raise GovernanceError("risks must be an array")
    if len(risks) > MAX_RISKS:
        raise GovernanceError("risks limit exceeded")
    for risk in risks:
        _validate_risk(risk)


def _validate_cross_review_record(state: dict[str, Any], payload: dict[str, Any], workspace_root: str | Path) -> None:
    _require_state(state, {"CROSS_REVIEW_REQUESTED"}, "record cross-review")
    packet_hash = _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    reviewer = _require_non_empty(payload.get("reviewer_agent"), "reviewer_agent")
    names = reviewer_names(workspace_root=workspace_root)
    if reviewer not in names:
        raise GovernanceError(f"unknown reviewer: {reviewer}")
    cross = _cross_review_for_target(state, target_revision_id, target_hash)
    task = cross["tasks"].get(packet_hash)
    if task is None:
        raise GovernanceError("task_packet_hash does not match an active cross-review task")
    if task.get("status") == "TIMEOUT_ABORTED":
        raise GovernanceError("late cross-review after timeout is rejected")
    if task.get("status") != "PENDING":
        raise GovernanceError("cross-review task is not pending")
    if reviewer != task.get("reviewer_agent"):
        raise GovernanceError("reviewer_agent must match task reviewer_agent")
    if payload.get("review_direction") != task.get("review_direction"):
        raise GovernanceError("review_direction must match task review_direction")
    _require_hash(payload.get("review_content_hash"), "review_content_hash")
    if payload.get("status_after") != "ANSWERED":
        raise GovernanceError('cross_review_recorded status_after must be "ANSWERED"')
    risks = payload.get("risks")
    if not isinstance(risks, list):
        raise GovernanceError("risks must be an array")
    if len(risks) > MAX_RISKS:
        raise GovernanceError("risks limit exceeded")
    for risk in risks:
        _validate_cross_review_risk(risk)


def _validate_revision(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CRITIQUED", "CROSS_REVIEWED"}, "record revision")
    _validate_id(_require_non_empty(payload.get("revision_id"), "revision_id"), "revision_id")
    round_number = payload.get("round")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round must be a positive integer")
    if round_number != state.get("current_round"):
        raise GovernanceError("revision round must match current critique round")
    _require_hash(payload.get("content_hash"), "content_hash")
    _require_non_empty(payload.get("content"), "content")
    parent = _require_hash(payload.get("parent_revision_hash"), "parent_revision_hash")
    latest = state["latest_revision"]
    if parent != latest["content_hash"]:
        raise GovernanceError("parent_revision_hash must match the latest revision content hash")


def _validate_coverage_record(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CRITIQUED", "CROSS_REVIEWED"}, "record coverage")
    round_number = payload.get("round_number")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if round_number != state.get("current_round"):
        raise GovernanceError("coverage round must match the current round")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    # The coverage target is the plan content the CURRENT round evaluates:
    # round 1 evaluates the challenger revision (submit_cross_review_v8
    # targets it); later rounds evaluate the latest primary revision. Accept
    # whichever the ledger currently holds as the round's evaluation target —
    # stale coverage against any OTHER hash is refused (hash-mismatch
    # discipline, same as cross-review).
    latest = state["latest_revision"]
    challenger = state.get("challenger") or {}
    valid_targets = {
        (latest["revision_id"], latest["content_hash"]),
        (challenger.get("challenger_revision_id"), challenger.get("content_hash")),
    }
    if (target_revision_id, target_hash) not in valid_targets:
        raise GovernanceError("coverage must target the latest revision or the challenger revision")
    verdict = payload.get("verdict")
    if verdict not in COVERAGE_VERDICTS:
        raise GovernanceError(f"coverage verdict must be one of {sorted(COVERAGE_VERDICTS)}")
    if not _valid_repo_path(payload.get("closure_manifest_path")):
        raise GovernanceError("closure_manifest_path must be a repo-relative POSIX path")
    _require_hash(payload.get("closure_manifest_hash"), "closure_manifest_hash")
    if not isinstance(payload.get("closure_summary"), dict):
        raise GovernanceError("closure_summary must be a JSON object")
    if not isinstance(payload.get("witness"), dict):
        raise GovernanceError("witness must be a JSON object")
    _require_non_empty(payload.get("computed_at_sha"), "computed_at_sha")
    uncovered = payload.get("uncovered")
    if not isinstance(uncovered, list):
        raise GovernanceError("uncovered must be an array")
    for node in uncovered:
        if not isinstance(node, dict):
            raise GovernanceError("uncovered node must be a JSON object")
        _require_non_empty(node.get("node_id"), "uncovered node_id")
        _require_non_empty(node.get("kind"), "uncovered kind")
        _require_non_empty(node.get("why"), "uncovered why")
    waived = payload.get("waived")
    if not isinstance(waived, list):
        raise GovernanceError("waived must be an array")
    for waiver in waived:
        if not isinstance(waiver, dict):
            raise GovernanceError("waived entry must be a JSON object")
        _require_non_empty(waiver.get("node_id"), "waived node_id")
        _require_non_empty(waiver.get("reason"), "waived reason")
    synthetic_risks = payload.get("synthetic_risks")
    if not isinstance(synthetic_risks, list) or len(synthetic_risks) > MAX_RISKS:
        raise GovernanceError("synthetic_risks must be an array within the risk limit")
    for risk in synthetic_risks:
        _validate_cross_review_risk(risk)
    # Verdict/content consistency — a "gaps" verdict without named nodes (or
    # vice versa) is a witness bug and must not enter the ledger.
    if verdict == "gaps":
        if not uncovered or not synthetic_risks:
            raise GovernanceError("gaps verdict requires uncovered nodes and synthetic_risks")
    else:
        if uncovered or synthetic_risks:
            raise GovernanceError(f"{verdict} verdict must carry no uncovered nodes or synthetic_risks")


def _validate_task(task: dict[str, Any], target_revision_id: str, target_hash: str) -> None:
    if not isinstance(task, dict):
        raise GovernanceError("each task must be a JSON object")
    _validate_id(_require_non_empty(task.get("task_id"), "task_id"), "task_id")
    _require_hash(task.get("task_packet_hash"), "task_packet_hash")
    _require_non_empty(task.get("target_agent"), "target_agent")
    if task.get("target_revision_id") != target_revision_id:
        raise GovernanceError("task target_revision_id must match request target_revision_id")
    if task.get("target_plan_content_hash") != target_hash:
        raise GovernanceError("task target_plan_content_hash must match request target_plan_content_hash")
    if _parse_iso_datetime(_require_non_empty(task.get("sla_deadline"), "sla_deadline")) is None:
        raise GovernanceError("sla_deadline must be an ISO datetime")
    if task.get("status_after") != "PENDING":
        raise GovernanceError('task status_after must be "PENDING"')


def _validate_cross_review_task(task: dict[str, Any], target_revision_id: str, target_hash: str) -> None:
    if not isinstance(task, dict):
        raise GovernanceError("each cross-review task must be a JSON object")
    _validate_id(_require_non_empty(task.get("task_id"), "task_id"), "task_id")
    _require_hash(task.get("task_packet_hash"), "task_packet_hash")
    _require_non_empty(task.get("reviewer_agent"), "reviewer_agent")
    if task.get("review_direction") not in REQUIRED_CROSS_REVIEW_DIRECTIONS:
        raise GovernanceError("review_direction must be primary_to_challenger or challenger_to_primary")
    if task.get("target_revision_id") != target_revision_id:
        raise GovernanceError("task target_revision_id must match request target_revision_id")
    if task.get("target_plan_content_hash") != target_hash:
        raise GovernanceError("task target_plan_content_hash must match request target_plan_content_hash")
    if _parse_iso_datetime(_require_non_empty(task.get("sla_deadline"), "sla_deadline")) is None:
        raise GovernanceError("sla_deadline must be an ISO datetime")
    if task.get("status_after") != "PENDING":
        raise GovernanceError('task status_after must be "PENDING"')


def _validate_risk(risk: dict[str, Any]) -> None:
    if not isinstance(risk, dict):
        raise GovernanceError("risk must be a JSON object")
    for field in ("risk_category", "severity", "invariant", "recommendation"):
        _require_non_empty(risk.get(field), field)
    affected_files = risk.get("affected_files")
    if not isinstance(affected_files, list) or not all(_valid_repo_path(item) for item in affected_files):
        raise GovernanceError("affected_files must be repo-relative POSIX paths")
    evidence_refs = risk.get("evidence_refs")
    if not isinstance(evidence_refs, list) or not all(_valid_evidence_ref(item) for item in evidence_refs):
        raise GovernanceError("evidence_refs contains invalid reference")


def _validate_cross_review_risk(risk: dict[str, Any]) -> None:
    if not isinstance(risk, dict):
        raise GovernanceError("risk must be a JSON object")
    # Field names sourced from CROSS_REVIEW_RISK_REQUIRED (SSoT). The check
    # STRUCTURE is intentionally type-specific and order-sensitive: index 0
    # (risk_id) and indices 1..4 (string fields) go through _require_non_empty;
    # the trailing list fields (affected_files, evidence_refs) get list-type
    # validation below — collapsing into one uniform loop would wrongly
    # _require_non_empty the lists and change which error fires first.
    _require_non_empty(risk.get(CROSS_REVIEW_RISK_REQUIRED[0]), CROSS_REVIEW_RISK_REQUIRED[0])
    for field in CROSS_REVIEW_RISK_REQUIRED[1:5]:
        _require_non_empty(risk.get(field), field)
    if str(risk.get("severity")) not in {*RISK_SEVERITY_VALUES, *KNOWN_SEVERITIES}:
        raise GovernanceError("cross-review risk severity is invalid")
    affected_files = risk.get("affected_files")
    if not isinstance(affected_files, list) or not all(_valid_repo_path(item) for item in affected_files):
        raise GovernanceError("affected_files must be repo-relative POSIX paths")
    evidence_refs = risk.get("evidence_refs")
    if not isinstance(evidence_refs, list) or not all(_valid_evidence_ref(item) for item in evidence_refs):
        raise GovernanceError("evidence_refs contains invalid reference")


def _validate_plan_content(plan: dict[str, Any]) -> None:
    if not isinstance(plan, dict):
        raise GovernanceError("plan content must be a JSON object")
    if len(_canonical_json(plan).encode("utf-8")) > MAX_PLAN_BYTES:
        raise GovernanceError("plan.json size limit exceeded")
    required = PLAN_CONTENT_REQUIRED
    missing = [field for field in required if field not in plan]
    if missing:
        raise GovernanceError(f"plan content missing required field(s): {', '.join(missing)}")
    _require_non_empty(plan["title"], "title")
    _require_non_empty(plan["summary"], "summary")
    if not isinstance(plan["key_changes"], list) or not plan["key_changes"]:
        raise GovernanceError("key_changes must be a non-empty array")
    affected_paths = _affected_surface_paths(plan["affected_surfaces"])
    if len(affected_paths) > MAX_AFFECTED_PATHS:
        raise GovernanceError("affected_surfaces.paths limit exceeded")
    if not all(_valid_repo_path(path) for path in affected_paths):
        raise GovernanceError("affected_surfaces paths must be repo-relative POSIX paths")
    if not isinstance(plan["validation_commands"], list):
        raise GovernanceError("validation_commands must be an array")
    for command in plan["validation_commands"]:
        _validate_validation_command(command)
    if not isinstance(plan["evidence_refs"], list) or not all(_valid_evidence_ref(ref) for ref in plan["evidence_refs"]):
        raise GovernanceError("evidence_refs contains invalid reference")
    # Optional coverage block (schema_version >= 2 plans). NOT added to
    # PLAN_CONTENT_REQUIRED — fold_plan_state re-validates every historical
    # plan_started payload on every fold, so a new required field would break
    # replay of the entire recorded history. Waivers live in plan_content (not
    # in the coverage event) because they are PLAN CLAIMS: they must flow
    # through content_hash, revisions, and cross-review like any other claim.
    coverage = plan.get("coverage")
    if coverage is not None:
        if not isinstance(coverage, dict):
            raise GovernanceError("coverage must be a JSON object")
        waivers = coverage.get("waivers", [])
        if not isinstance(waivers, list) or len(waivers) > MAX_AFFECTED_PATHS:
            raise GovernanceError("coverage.waivers must be an array within the affected-paths limit")
        for waiver in waivers:
            if not isinstance(waiver, dict):
                raise GovernanceError("coverage waiver must be a JSON object")
            _require_non_empty(waiver.get("node"), "coverage waiver node")
            _require_non_empty(waiver.get("reason"), "coverage waiver reason")


def _validate_validation_command(command: dict[str, Any]) -> None:
    if not isinstance(command, dict):
        raise GovernanceError("validation command must be a JSON object")
    _require_non_empty(command.get("cmd"), "validation command cmd")
    expected_exit = command.get("expected_exit", 0)
    timeout_ms = command.get("timeout_ms", 60_000)
    if not isinstance(expected_exit, int):
        raise GovernanceError("validation command expected_exit must be an integer")
    if not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GovernanceError("validation command timeout_ms must be a positive integer")


def _validate_event(event: dict[str, Any]) -> None:
    if not isinstance(event, dict):
        raise GovernanceError("event must be a JSON object")
    _require_non_empty(event.get("event_id"), "event_id")
    if event.get("event_type") not in EVENT_TYPES:
        raise GovernanceError(f"unknown event_type: {event.get('event_type')}")
    _require_non_empty(event.get("plan_id"), "plan_id")
    _require_hash(event.get("idempotency_key"), "idempotency_key")
    if not isinstance(event.get("payload"), dict):
        raise GovernanceError("event payload must be a JSON object")
    payload = event["payload"]
    event_type = event["event_type"]
    if event_type == "plan_started":
        _validate_plan_content(payload.get("plan_content"))
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_non_empty(payload.get("initial_revision_id"), "initial_revision_id")
    elif event_type == "challenger_plan_drafted":
        _validate_plan_content(payload.get("plan_content"))
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_non_empty(payload.get("challenger_revision_id"), "challenger_revision_id")
        _require_non_empty(payload.get("source_revision_id"), "source_revision_id")
        _require_hash(payload.get("source_plan_content_hash"), "source_plan_content_hash")
    elif event_type == "critic_tasks_requested":
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        if not isinstance(payload.get("tasks"), list):
            raise GovernanceError("tasks must be an array")
    elif event_type == "cross_review_tasks_requested":
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        if not isinstance(payload.get("tasks"), list):
            raise GovernanceError("tasks must be an array")
        if not isinstance(payload.get("replaces_task_ids", []), list):
            raise GovernanceError("replaces_task_ids must be an array")
    elif event_type == "critique_recorded":
        _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_non_empty(payload.get("reviewer"), "reviewer")
        _require_hash(payload.get("critique_content_hash"), "critique_content_hash")
        if payload.get("status_after") != "ANSWERED":
            raise GovernanceError('critique_recorded status_after must be "ANSWERED"')
    elif event_type == "cross_review_recorded":
        _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_non_empty(payload.get("reviewer_agent"), "reviewer_agent")
        if payload.get("review_direction") not in REQUIRED_CROSS_REVIEW_DIRECTIONS:
            raise GovernanceError("review_direction must be primary_to_challenger or challenger_to_primary")
        _require_hash(payload.get("review_content_hash"), "review_content_hash")
        if payload.get("status_after") != "ANSWERED":
            raise GovernanceError('cross_review_recorded status_after must be "ANSWERED"')
    elif event_type == "stale_tasks_reaped":
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        reaped = payload.get("reaped_task_ids")
        if not isinstance(reaped, list) or not reaped or not all(isinstance(item, str) and item for item in reaped):
            raise GovernanceError("reaped_task_ids must be a non-empty string array")
    elif event_type == "revision_recorded":
        _require_non_empty(payload.get("revision_id"), "revision_id")
        if not isinstance(payload.get("round"), int):
            raise GovernanceError("round must be an integer")
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_hash(payload.get("parent_revision_hash"), "parent_revision_hash")
        _require_non_empty(payload.get("content"), "content")
        if not isinstance(payload.get("addresses_review_risk_ids", []), list):
            raise GovernanceError("addresses_review_risk_ids must be an array")
    elif event_type == "coverage_computed":
        # Shape-only (state preconditions live in the reducer + record-time
        # validator, per the V9 split documented below).
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        if payload.get("verdict") not in COVERAGE_VERDICTS:
            raise GovernanceError("coverage_computed verdict is invalid")
        _require_non_empty(payload.get("closure_manifest_path"), "closure_manifest_path")
        _require_hash(payload.get("closure_manifest_hash"), "closure_manifest_hash")
        for field in ("uncovered", "waived", "synthetic_risks"):
            if not isinstance(payload.get(field), list):
                raise GovernanceError(f"coverage_computed {field} must be an array")
    elif event_type == "plan_evaluated":
        if payload.get("terminal_state") not in {"CONVERGED", "HUMAN_REQUIRED"}:
            raise GovernanceError("plan_evaluated terminal_state must be CONVERGED or HUMAN_REQUIRED")
        for field in ("risks_rollup_summary", "gate_decisions", "reason_codes"):
            if field not in payload:
                raise GovernanceError(f"plan_evaluated missing {field}")
    elif event_type == "plan_abandoned":
        _require_non_empty(payload.get("reason"), "reason")
        _require_non_empty(payload.get("abandoned_from_state"), "abandoned_from_state")
    elif event_type == "lock_reaped":
        for field in ("stale_lock_pid", "lock_age_seconds", "reaped_by_pid"):
            if not isinstance(payload.get(field), int):
                raise GovernanceError(f"lock_reaped {field} must be an integer")
    # Plan ARIA-V9.0-B — implementation-phase event payload validators.
    # State preconditions live in _apply_event (the reducer), not here
    # — _validate_event is shape-only because validation runs once per
    # event-load whereas state preconditions depend on the cumulative
    # fold result. Splitting the responsibilities avoids a chicken-egg
    # dependency on fold_plan_state during a fold.
    elif event_type == "implementation_requested":
        _require_non_empty(payload.get("implementer_agent"), "implementer_agent")
        _require_non_empty(payload.get("converged_plan_revision_id"), "converged_plan_revision_id")
        _require_hash(payload.get("converged_plan_content_hash"), "converged_plan_content_hash")
    elif event_type == "implementation_started":
        _require_non_empty(payload.get("claim_id"), "claim_id")
        _require_non_empty(payload.get("implementer_agent"), "implementer_agent")
    elif event_type == "implementation_outcome_recorded":
        _require_non_empty(payload.get("claim_id"), "claim_id")
        _require_non_empty(payload.get("pr_url"), "pr_url")
        _require_hash(payload.get("diff_hash"), "diff_hash")
        _require_non_empty(payload.get("branch_tip_sha"), "branch_tip_sha")
        if not isinstance(payload.get("validation_results", []), list):
            raise GovernanceError("validation_results must be an array")
        _require_non_empty(payload.get("signer_key_fp"), "signer_key_fp")
        _require_non_empty(payload.get("base_branch_sha"), "base_branch_sha")
    elif event_type == "implementation_merged":
        _require_non_empty(payload.get("merge_sha"), "merge_sha")
        _require_non_empty(payload.get("merged_at"), "merged_at")
        # Idempotency-key is a 5-tuple per V9.6 (closes arb HIGH-006).
        # Encoded here as a sha256 hash of the canonical tuple so the
        # validator can _require_hash without re-implementing 5-field
        # parsing.
        _require_hash(payload.get("idempotency_key_hash"), "idempotency_key_hash")
    elif event_type == "implementation_rejected":
        # Canonical valid rejection classes (SSoT: implementation_rejections —
        # VALID_IMPLEMENTATION_REJECTION_CLASSES). Descriptions kept here as a
        # quick reference at the validation site; the authoritative set is the
        # imported frozenset.
        #   no_claim_timeout            (poll deadline in REQUESTED state)
        #   in_flight_abandoned         (poll deadline in IN_FLIGHT state)
        #   ci_check_timeout            (auto-merge poll deadline)
        #   ci_check_red                (any required check NOT SUCCESS)
        #   merge_policy_violation      (evaluate_auto_merge ineligible)
        #   branch_tip_drift            (headRefOid != recorded branch_tip_sha)
        #   content_hash_mismatch       (content_hash drift between mint + outcome)
        #   secret_leak_detected        (verify_no_secret_in_diff fired)
        #   kernel_self_modification_attempted (envelope-mint refusal)
        #   bash_command_denylist_hit   (V9.0-D ALLOWED_BASH_COMMANDS miss)
        #   path_escape_outside_workspace (V9.0-D verify_no_path_escape fired)
        #   file_lock_conflict          (V9.5 check 11 — per_file_mutual_exclusion)
        valid_rejection_classes = VALID_IMPLEMENTATION_REJECTION_CLASSES
        if payload.get("rejection_class") not in valid_rejection_classes:
            raise GovernanceError(
                f"implementation_rejected rejection_class must be one of "
                f"{sorted(valid_rejection_classes)}, got {payload.get('rejection_class')!r}"
            )
        _require_non_empty(payload.get("rejected_at"), "rejected_at")


def _evaluate_state(state: dict[str, Any], round_number: int) -> dict[str, Any]:
    round_data = state["rounds"][round_number]
    risks = [risk for critique in round_data.get("critiques", []) for risk in critique.get("risks", [])]
    tasks = list(round_data.get("tasks", {}).values())
    summary = {
        "critical": _severity_count(risks, "CRITICAL"),
        "high": _severity_count(risks, "HIGH"),
        "unknown": _unknown_count(risks),
        "medium": _severity_count(risks, "MEDIUM"),
        "low": _severity_count(risks, "LOW"),
        "pending_tasks": sum(1 for task in tasks if task.get("status") == "PENDING"),
        "timeout_aborted_tasks": sum(1 for task in tasks if task.get("status") == "TIMEOUT_ABORTED"),
        "risk_categories": sorted({str(risk.get("risk_category")) for risk in risks if risk.get("risk_category")}),
    }
    blockers = []
    if summary["critical"]:
        blockers.append("critical_risks_present")
    if summary["high"]:
        blockers.append("high_risks_present")
    if summary["unknown"]:
        blockers.append("unknown_risks_present")
    if summary["pending_tasks"]:
        blockers.append("pending_tasks_present")
    if summary["timeout_aborted_tasks"]:
        blockers.append("partial_coverage")
    new_categories = _new_categories(state, round_number)
    gate_decisions = [
        {"gate": "critical_zero", "passed": summary["critical"] == 0},
        {"gate": "high_zero", "passed": summary["high"] == 0},
        {"gate": "unknown_zero", "passed": summary["unknown"] == 0},
        {"gate": "no_pending_tasks", "passed": summary["pending_tasks"] == 0},
        {"gate": "no_partial_coverage", "passed": summary["timeout_aborted_tasks"] == 0},
        {"gate": "new_category_policy", "passed": not new_categories or round_number < 2, "new_categories": sorted(new_categories)},
    ]
    if blockers:
        return {
            "terminal_state": "HUMAN_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": blockers,
        }
    if round_number == 2 and new_categories:
        return {
            "terminal_state": "NEXT_ROUND_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": ["new_risk_category_round_2"],
        }
    if round_number >= 3 and new_categories:
        return {
            "terminal_state": "HUMAN_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": ["new_risk_category_round_3"],
        }
    return {
        "terminal_state": "CONVERGED",
        "risks_rollup_summary": summary,
        "gate_decisions": gate_decisions,
        "reason_codes": ["convergence_gates_passed"],
    }


def _evaluate_cross_review_state(state: dict[str, Any], round_number: int, *, max_rounds: int) -> dict[str, Any]:
    cross = state["cross_reviews"][round_number]
    risks = list(state.get("cross_review_risks_by_round", {}).get(round_number, []))
    resolved = set(state.get("resolved_review_risk_ids", []))
    active_risks = [risk for risk in risks if str(risk.get("risk_id")) not in resolved]
    material = [
        risk for risk in active_risks
        if str(risk.get("severity")).lower() in {"blocking", "material", "critical", "high"}
    ]
    tasks = list(cross.get("tasks", {}).values())
    directions = _cross_review_direction_statuses(state, round_number)
    summary = {
        "active_cross_review_risks": len(active_risks),
        "material_cross_review_risks": len(material),
        "partial_directions": sorted(direction for direction, status in directions.items() if status == "partial"),
        "pending_tasks": sum(1 for task in tasks if task.get("status") == "PENDING"),
        "timeout_aborted_tasks": sum(1 for task in tasks if task.get("status") == "TIMEOUT_ABORTED" and not task.get("replaced_by_task_ids")),
        "resolved_review_risks": len(resolved),
    }
    blockers = []
    if material:
        blockers.append("material_cross_review_risks_present")
    if summary["pending_tasks"]:
        blockers.append("pending_tasks_present")
    if summary["timeout_aborted_tasks"] or summary["partial_directions"]:
        blockers.append("partial_cross_review_coverage")
    gate_decisions = [
        {"gate": "material_cross_review_zero", "passed": not material},
        {"gate": "no_pending_tasks", "passed": summary["pending_tasks"] == 0},
        {"gate": "no_partial_directions", "passed": not summary["partial_directions"] and summary["timeout_aborted_tasks"] == 0},
        {"gate": "max_rounds", "passed": round_number < max_rounds, "max_rounds": max_rounds},
    ]
    # Plan-coverage gate. Enforcement lives in the VERDICT field, not only
    # in the synthetic risks: absence of a risk is indistinguishable from
    # absence of a check, so a missing coverage event on a schema_version>=2
    # plan fails closed to HUMAN_REQUIRED — and environment_unable escalates
    # immediately rather than looping NEXT_ROUND until max_rounds (the
    # environment does not heal round-over-round).
    applicable = _plan_requires_coverage(state)
    coverage = state.get("coverage_by_round", {}).get(round_number)
    coverage_verdict = (coverage or {}).get("verdict")
    summary["coverage_verdict"] = coverage_verdict if applicable else "not_applicable"
    gate_decisions.append({
        "gate": "plan_coverage",
        "applicable": applicable,
        "verdict": summary["coverage_verdict"],
        "passed": (not applicable) or coverage_verdict in {"covered", "covered_with_waivers"},
    })
    if applicable:
        if coverage is None or coverage_verdict == "environment_unable":
            reason = "coverage_missing" if coverage is None else "coverage_environment_unable"
            return {
                "terminal_state": "HUMAN_REQUIRED",
                "risks_rollup_summary": summary,
                "gate_decisions": gate_decisions,
                "reason_codes": sorted(set(blockers + [reason])),
            }
        if coverage_verdict == "gaps":
            blockers.append("coverage_gaps_present")
    if blockers:
        if round_number >= max_rounds:
            return {
                "terminal_state": "HUMAN_REQUIRED",
                "risks_rollup_summary": summary,
                "gate_decisions": gate_decisions,
                "reason_codes": sorted(set(blockers + ["max_rounds_reached"])),
            }
        return {
            "terminal_state": "NEXT_ROUND_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": blockers,
        }
    return {
        "terminal_state": "CONVERGED",
        "risks_rollup_summary": summary,
        "gate_decisions": gate_decisions,
        "reason_codes": ["cross_review_convergence_gates_passed"],
    }


def _cross_review_direction_statuses(state: dict[str, Any], round_number: int | None) -> dict[str, str]:
    if round_number is None or round_number not in state.get("cross_reviews", {}):
        return {}
    cross = state["cross_reviews"][round_number]
    statuses: dict[str, str] = {}
    for direction in REQUIRED_CROSS_REVIEW_DIRECTIONS:
        tasks = [
            task for task in cross.get("tasks", {}).values()
            if task.get("review_direction") == direction and not task.get("replaced_by_task_ids")
        ]
        if not tasks:
            statuses[direction] = "pending"
        elif all(task.get("status") == "ANSWERED" for task in tasks):
            statuses[direction] = "answered"
        elif any(task.get("status") in {"ANSWERED", "TIMEOUT_ABORTED"} for task in tasks):
            statuses[direction] = "partial"
        else:
            statuses[direction] = "pending"
    return statuses


def _new_categories(state: dict[str, Any], round_number: int) -> set[str]:
    current = set(_categories_for_round(state, round_number))
    previous: set[str] = set()
    for prior_round in range(1, round_number):
        previous.update(_categories_for_round(state, prior_round))
    return current - previous


def _categories_for_round(state: dict[str, Any], round_number: int) -> set[str]:
    round_data = state["rounds"].get(round_number, {})
    risks = [risk for critique in round_data.get("critiques", []) for risk in critique.get("risks", [])]
    return {str(risk.get("risk_category")) for risk in risks if risk.get("risk_category")}


def _severity_count(risks: list[dict[str, Any]], severity: str) -> int:
    return sum(1 for risk in risks if str(risk.get("severity", "")).upper() == severity)


def _unknown_count(risks: list[dict[str, Any]]) -> int:
    return sum(1 for risk in risks if str(risk.get("severity", "")).upper() not in KNOWN_SEVERITIES)


def _latest_event(state: dict[str, Any], event_type: str) -> dict[str, Any] | None:
    for event in reversed(state["events"]):
        if event.get("event_type") == event_type:
            return event
    return None


def _plan_requires_coverage(state: dict[str, Any]) -> bool:
    """Coverage-gate applicability key: plan_started schema_version >= 2.

    Anchored to plan_started (NOT the latest revision) so a challenger or
    revision emitting schema_version 1 cannot downgrade the gate mid-plan.
    Every historical plan and every existing fixture is v1 — the gate is
    structurally inert for recorded history.
    """
    started = state.get("plan_started") or {}
    content = started.get("plan_content") or {}
    try:
        return int(content.get("schema_version", 1)) >= 2
    except (TypeError, ValueError):
        return False


def _require_coverage_for_implementation(state: dict[str, Any]) -> None:
    """Defense-in-depth at the CONVERGED -> implementation seam.

    The evaluator gate lives in _evaluate_cross_review_state only; the
    critique-only path (_evaluate_state) and any future caller that reaches
    CONVERGED without the drainer would bypass it. A schema_version>=2 plan
    may not enter implementation without a passing coverage verdict.
    """
    if not _plan_requires_coverage(state):
        return
    rounds = state.get("coverage_by_round") or {}
    if not rounds:
        raise GovernanceError(
            "implementation_requires_coverage_verdict: no coverage_computed "
            "event recorded for a schema_version>=2 plan"
        )
    latest_round = max(rounds)
    verdict = (rounds[latest_round] or {}).get("verdict")
    if verdict not in {"covered", "covered_with_waivers"}:
        raise GovernanceError(
            f"implementation_requires_coverage_verdict: latest coverage verdict is {verdict}"
        )


def _require_started(state: dict[str, Any], action: str) -> None:
    if state["plan_started"] is None:
        raise GovernanceError(f"cannot {action}: plan has not been started")


def _require_state(state: dict[str, Any], allowed: set[str], action: str) -> None:
    _require_started(state, action)
    if state["state"] not in allowed:
        raise GovernanceError(f"cannot {action} from state {state['state']}")


def _require_non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GovernanceError(f"{field} must be a non-empty string")
    return value.strip()


def _require_hash(value: Any, field: str) -> str:
    value = _require_non_empty(value, field)
    if not value.startswith("sha256:") or len(value) != len("sha256:") + 64:
        raise GovernanceError(f"{field} must be a sha256 hash")
    return value


def _validate_id(value: str, field: str) -> None:
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", value or ""):
        raise GovernanceError(f"{field} contains invalid characters")


def _affected_surface_paths(affected_surfaces: Any) -> list[str]:
    if not isinstance(affected_surfaces, list):
        raise GovernanceError("affected_surfaces must be an array")
    paths: list[str] = []
    for surface in affected_surfaces:
        if isinstance(surface, str):
            paths.append(surface)
        elif isinstance(surface, dict):
            value = surface.get("paths", [])
            if not isinstance(value, list):
                raise GovernanceError("affected_surfaces.paths must be an array")
            paths.extend(value)
        else:
            raise GovernanceError("affected_surfaces entries must be strings or objects")
    return paths


def _valid_repo_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    path = value.strip()
    return not (path.startswith("/") or "\\" in path or path.startswith("../") or "/../" in path or path == "..")


def _valid_evidence_ref(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    ref = value.strip()
    return bool(FINDING_ID_RE.match(ref)) or _valid_repo_path(ref)


def _parse_iso_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _takes_payload(func: Any) -> bool:
    return getattr(func, "__name__", "") in {
        "_validate_critic_request",
        "_validate_revision",
    } or func.__class__.__name__ == "function" and getattr(func, "__code__", None) and func.__code__.co_argcount >= 2
