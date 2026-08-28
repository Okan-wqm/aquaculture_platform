"""HUMAN_REQUIRED escalation surface (Plan 016 Faz D9).

Plan 016 §HUMAN_REQUIRED operator SLA:
- CRITICAL / HIGH severity: 72h response window;
- MEDIUM severity: 7 days.

The lease lifecycle (`agent_invocations.derive_request_state`) already
emits a `human_required` event on the claims ledger when a request
exceeds `DEFAULT_MAX_REQUEUES` requeues. This module adds the
operator-facing surface: `aria-tools/human-required/<request_id>.json`
files the operator reads first, plus a daily-report top-of-page
section that surfaces any pending HUMAN_REQUIRED entries with their
SLA status.

Why a separate file per request_id (instead of a single jsonl): the
operator opens this directory to triage; one file per request lets
them resolve / archive entries individually without rewriting the
whole ledger. The kernel emits a `human_required_recorded` governance
event on creation so the audit chain still captures the escalation.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .agent_invocations import _request_event_count, derive_request_state
from .ledger import load_declared_jsonl
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


# Plan 016 SLA windows per severity. CRITICAL/HIGH share the 72h window;
# MEDIUM gets 7 days; everything else falls back to 14 days.
SLA_WINDOWS = {
    "CRITICAL": timedelta(hours=72),
    "HIGH": timedelta(hours=72),
    "MEDIUM": timedelta(days=7),
    "LOW": timedelta(days=14),
    "INFORMATIONAL": timedelta(days=14),
}
DEFAULT_SEVERITY = "HIGH"


def _human_required_dir(tools_root: Path) -> Path:
    return tools_root / "human-required"


def _human_required_path(tools_root: Path, request_id: str) -> Path:
    return _human_required_dir(tools_root) / f"{request_id}.json"


def _resolve_severity(severity: str | None) -> str:
    if isinstance(severity, str):
        upper = severity.strip().upper()
        if upper in SLA_WINDOWS:
            return upper
    return DEFAULT_SEVERITY


def record_human_required(
    *,
    request_id: str,
    severity: str | None = None,
    reason: str,
    context: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Persist a HUMAN_REQUIRED operator-triage record.

    Idempotent: if the record already exists, returns the existing row
    without re-emitting the governance event. The lease lifecycle path
    (reap_stale_claims / release_claim escalations) calls this when a
    request crosses the requeue threshold; operators can also call it
    via CLI to escalate manually before the threshold.

    Plan 026R §A.4 — frozen-profile gate at function entry.
    """
    if not isinstance(reason, str) or not reason.strip():
        raise GovernanceError("reason is required")
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("human_required", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    out_path = _human_required_path(root, request_id)
    if out_path.exists():
        try:
            return json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass  # fall through and overwrite a corrupted file

    sev = _resolve_severity(severity)
    ts = now or datetime.now(timezone.utc)
    sla_deadline = ts + SLA_WINDOWS[sev]
    record = {
        "$schema": "aria/human-required/v1",
        "schema_version": 1,
        "request_id": request_id,
        "severity": sev,
        "reason": reason,
        "recorded_at": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sla_deadline": sla_deadline.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "open",
    }
    # Plan 024 §B — carry structured identifiers (not just reason prose) so the
    # operator's resolution can fan back into the ground-truth feedback ledger.
    if context:
        record["context"] = context
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_tools_governance(
        root,
        "human_required_recorded",
        {
            "request_id": request_id,
            "severity": sev,
            "sla_deadline": record["sla_deadline"],
            "path": out_path.relative_to(root).as_posix(),
        },
    )
    return record


def list_human_required(
    *,
    base_dir: str | Path | None = None,
    include_resolved: bool = False,
) -> list[dict[str, Any]]:
    """List HUMAN_REQUIRED entries, sorted by SLA deadline (most urgent first)."""
    root = ensure_tools_dir(base_dir)
    directory = _human_required_dir(root)
    if not directory.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in directory.glob("*.json"):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not include_resolved and doc.get("status") != "open":
            continue
        rows.append(doc)
    rows.sort(key=lambda r: r.get("sla_deadline", ""))
    return rows


RESOLVED_BY_OPERATOR: str = "operator"
RESOLVED_BY_AGENT_PANEL: str = "agent_panel"
RESOLVED_BY_VALUES: frozenset[str] = frozenset({
    RESOLVED_BY_OPERATOR, RESOLVED_BY_AGENT_PANEL,
})

# THE PANEL'S DECISION VOCABULARY — declared here, with the record schema.
#
# WHAT these are: the three outcomes ``human_required_adjudication.fold_adjudication``
# can reach. WHY they live in this module rather than in the fold: the record
# written below is what a LATER cycle reads back as proof, so the writer, the
# reader and the fold have to name the same strings. They were declared in the
# fold and the record never carried them at all, which is precisely how a
# refusal became indistinguishable from an approval on disk (see
# ``resolve_panel_adjudication_proof``). i1 — the fold imports these names; it
# does not keep a second spelling of "refused".
OUTCOME_RESOLVED: str = "resolved"
OUTCOME_REFUSED: str = "refused"
OUTCOME_STILL_ESCALATED: str = "still_escalated"

# The outcomes that may CLOSE a record. ``still_escalated`` is deliberately
# absent: "the panel could not answer" is not a decision, and a record closed
# as if it were would be an answer nobody gave.
PANEL_DECIDED_OUTCOMES: frozenset[str] = frozenset({
    OUTCOME_RESOLVED, OUTCOME_REFUSED,
})


def resolve_panel_adjudication_proof(
    *,
    adjudication_ref: str,
    expected_kind: str,
    context_match: dict[str, str],
    error_prefix: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Kernel-computed proof that a panel really adjudicated ``adjudication_ref``.

    ONE resolver for every "a panel approved this" claim in the kernel.
    ``adjudication_ref`` names a HUMAN_REQUIRED record; the proof is derived
    from the record FILE, never from what the caller says about it:
    existence, ``status=resolved``, ``resolved_by=agent_panel``,
    ``panel_outcome=resolved``, the expected context kind, and every
    ``context_match`` key are each a hard refusal.

    WHY ``panel_outcome`` IS A CLAUSE AND NOT A DETAIL
      A panel that REFUSES a promotion closes the record with exactly the
      same ``status``/``resolved_by`` pair as a panel that approves one —
      the refusal branch in ``human_required_adjudication`` resolves the
      record so the sweep stops re-asking. Before this clause the only
      difference on disk was ``resolution_note`` free text, which nothing
      read, so replaying a REFUSED ref through
      ``promote_tool(..., panel_approval_ref=...)`` armed the veto window
      and activated the adapter the panel had just rejected. Proving that
      an adjudication HAPPENED is not proving WHAT IT DECIDED; this
      resolver now demands the decision, and the writer
      (:func:`resolve_human_required`) cannot close a panel record without
      stating one.

    WHY IT IS SHARED (i1): the genesis lane
    (``genesis_lifecycle._resolve_panel_adjudication_proof``) proved the ref
    against the ledger; the tool-promotion lane checked only that the string
    was non-empty, so ``promote_tool(..., panel_approval_ref="anything")``
    armed a veto window and a later cycle activated the adapter on a
    workspace that had never held an adjudication at all. A second resolver
    would have been a second place to forget; this is the first one, moved
    where both lanes can reach it.

    Refusal is a GovernanceError, never a False: an unprovable panel
    approval is a governance event, and callers that own an ineligibility
    vocabulary (``promotion_veto``) re-raise it under their own class.
    """
    if not str(adjudication_ref or "").strip():
        raise GovernanceError(f"{error_prefix}_proof_requires_adjudication_ref")
    root = ensure_tools_dir(base_dir)
    path = _human_required_path(root, adjudication_ref)
    if not path.exists():
        raise GovernanceError(
            f"{error_prefix}_adjudication_not_found:{adjudication_ref}"
        )
    record = json.loads(path.read_text(encoding="utf-8"))
    context = record.get("context") or {}
    if str(context.get("kind") or "") != expected_kind:
        raise GovernanceError(
            f"{error_prefix}_adjudication_wrong_kind:{context.get('kind')!r}"
        )
    if (
        record.get("status") != "resolved"
        or record.get("resolved_by") != RESOLVED_BY_AGENT_PANEL
    ):
        raise GovernanceError(
            f"{error_prefix}_adjudication_not_panel_resolved:"
            f"status={record.get('status')!r},resolved_by={record.get('resolved_by')!r}"
        )
    # The DECISION, not merely the fact that one was taken. An absent
    # ``panel_outcome`` fails closed on purpose: a record written before the
    # field existed never recorded what the panel answered, so it can prove
    # an approval only by assumption — and this whole resolver exists to stop
    # authority resting on assumptions.
    panel_outcome = str(record.get("panel_outcome") or "")
    if panel_outcome != OUTCOME_RESOLVED:
        raise GovernanceError(
            f"{error_prefix}_adjudication_not_approved:"
            f"panel_outcome={panel_outcome!r}"
        )
    for key, expected in context_match.items():
        recorded = str(context.get(key) or "")
        if not expected or recorded != expected:
            raise GovernanceError(
                f"{error_prefix}_adjudication_{key}_mismatch:"
                f"{recorded!r}!={expected!r}"
            )
    return {
        "adjudication_ref": adjudication_ref,
        "context_kind": expected_kind,
        "panel_outcome": panel_outcome,
        "resolved_at": record.get("resolved_at"),
        "resolution_note": str(record.get("resolution_note") or "")[:300],
        **{key: str(context.get(key) or "") for key in context_match},
    }


def resolve_human_required(
    *,
    request_id: str,
    resolution_note: str,
    verdict: str | None = None,
    resolved_by: str = RESOLVED_BY_OPERATOR,
    panel_outcome: str | None = None,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Mark a HUMAN_REQUIRED entry resolved.

    Plan 024 §B — when ``verdict`` (true_positive | false_positive) is supplied
    and the record is a consensus escalation, the operator's adjudication is
    fanned into the ground-truth feedback ledger via ``record_operator_feedback``
    so judge calibration (Plan 024 §A) can score the judges that disagreed.

    ORPHAN-HIGH-426 — an independent agent panel may also resolve, via
    ``human_required_adjudication.adjudicate_human_required``. Two
    properties are enforced here rather than left to the caller:

      * ``resolved_by`` is recorded, so an operator can always tell an
        agent-adjudicated clearance from their own.
      * a panel may NOT supply ``verdict``. That parameter writes into the
        ground-truth feedback ledger with ``source_type="human"``, which
        judge calibration scores against. Letting agents write their own
        judgment in as human ground truth would have them grading
        themselves and would silently corrupt calibration — so the
        combination is refused, not merely discouraged.
      * a panel MUST supply ``panel_outcome``. The panel resolves a record
        on BOTH answers — an approval and a refusal both close it, because
        a closed record is what stops the sweep re-asking the same question
        every night. Recording only that a panel answered therefore made
        the two indistinguishable on disk, and
        :func:`resolve_panel_adjudication_proof` read the survivor of that
        ambiguity as an approval: a refused promotion could be replayed
        into an ACTIVE adapter. The decision is now a required, structured
        field rather than a sentence in ``resolution_note`` that nothing
        parses, and the callers pass ``PanelVerdict.outcome`` itself, so no
        branch can stamp a decision the fold did not reach.

    Symmetrically, ``panel_outcome`` is REFUSED when the operator resolves:
    an operator closing an escalation is exercising his own authority, not
    reporting a panel's, and a record carrying both would be two claims of
    authority in one row.
    """
    if not isinstance(resolution_note, str) or not resolution_note.strip():
        raise GovernanceError("resolution_note is required")
    if resolved_by not in RESOLVED_BY_VALUES:
        raise GovernanceError(
            f"resolved_by must be one of {sorted(RESOLVED_BY_VALUES)}"
        )
    if resolved_by != RESOLVED_BY_OPERATOR and verdict is not None:
        raise GovernanceError(
            "human_required_agent_panel_cannot_supply_ground_truth_verdict"
        )
    if resolved_by == RESOLVED_BY_AGENT_PANEL:
        if panel_outcome not in PANEL_DECIDED_OUTCOMES:
            raise GovernanceError(
                "human_required_agent_panel_resolution_requires_decided_outcome:"
                f"{panel_outcome!r} not in {sorted(PANEL_DECIDED_OUTCOMES)}"
            )
    elif panel_outcome is not None:
        raise GovernanceError(
            "human_required_panel_outcome_requires_agent_panel_resolver:"
            f"resolved_by={resolved_by!r}"
        )
    root = ensure_tools_dir(base_dir)
    path = _human_required_path(root, request_id)
    if not path.exists():
        raise GovernanceError(f"human-required record not found: {request_id}")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("status") == "resolved":
        return record
    ts = now or datetime.now(timezone.utc)
    record["status"] = "resolved"
    record["resolved_at"] = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    record["resolution_note"] = resolution_note
    record["resolved_by"] = resolved_by
    if panel_outcome is not None:
        record["panel_outcome"] = panel_outcome

    if verdict is not None:
        from .belief_escalation import belief_panel_finding_id
        from .feedback_store import (
            FEEDBACK_VERDICTS,
            JUDGMENT_SUBJECT_BELIEF,
            record_operator_feedback,
        )
        if verdict not in FEEDBACK_VERDICTS:
            raise GovernanceError(f"verdict must be one of {FEEDBACK_VERDICTS}")
        ctx = record.get("context") or {}
        if ctx.get("kind") == "consensus_escalation" and all(
            ctx.get(k) for k in ("tool_id", "run_id", "finding_id")
        ):
            record_operator_feedback(
                tool_id=str(ctx["tool_id"]),
                run_id=str(ctx["run_id"]),
                finding_id=str(ctx["finding_id"]),
                verdict=verdict,
                severity="medium",
                note=f"operator adjudication of consensus escalation {request_id}",
                source_type="human",
                judgment_group_id=str(ctx.get("judgment_group_id") or "") or None,
                base_dir=root,
            )
            record["operator_verdict"] = verdict
        elif ctx.get("kind") == "belief_escalation" and ctx.get("belief_id"):
            # M4+M8/E8 — the belief-verdict bridge. `affected_belief_ids`
            # existed on the feedback row and `_feedback_adjustment` read
            # it, but no producer ever passed it: verdicts could not move
            # belief confidence. The GENERAL producer (bind beliefs to
            # findings by evidence overlap) is comprehension-program work —
            # mechanical file-matching would smuggle back the drift the
            # field avoids. But HERE the affected belief is exact by
            # construction: the operator is adjudicating this belief's own
            # standing contradiction. run_id names the escalation record
            # and finding_id names its own kind — real identities, not
            # pointers to findings that do not exist.
            belief_id = str(ctx["belief_id"])
            record_operator_feedback(
                tool_id=str(ctx.get("source_tool_id") or "unknown"),
                run_id=request_id,
                # ONE spelling of this ledger identity, not two. The panel
                # arm (JJ-3) writes the same (run_id, finding_id) key and its
                # idempotency check depends on it — an f-string here and a
                # helper there is two spellings of one identity waiting to
                # drift apart, and the drift would let the same belief be
                # adjudicated twice.
                finding_id=belief_panel_finding_id(belief_id),
                verdict=verdict,
                severity="medium",
                note=f"operator adjudication of belief escalation {request_id}",
                affected_belief_ids=[belief_id],
                source_type="human",
                # JJ-3 (ORPHAN-HIGH-755) - this settles a BELIEF, not a
                # finding this adapter emitted. Declared on the row so the
                # adapter-precision lanes exclude it structurally instead of
                # each reader re-deciding from finding_id spelling.
                judgment_subject=JUDGMENT_SUBJECT_BELIEF,
                base_dir=root,
            )
            record["operator_verdict"] = verdict

    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_tools_governance(
        root,
        "human_required_resolved",
        {
            "request_id": request_id,
            "resolved_at": record["resolved_at"],
            "resolved_by": resolved_by,
            # The audit ledger could not tell an approval from a refusal
            # either; both appeared as one `human_required_resolved` row.
            "panel_outcome": panel_outcome,
        },
    )
    return record


# Y7 (ORPHAN-708) — per-sweep ceiling for anchor-stale escalations: bounds
# panel inflow (each record costs a 3-envelope panel) while a legacy corpse
# pile drains over nights instead of all at once.
ANCHOR_STALE_SWEEP_CAP = 5


def sweep_lease_lifecycle_for_human_required(
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Find lease-lifecycle requests whose derived state is HUMAN_REQUIRED but
    have no corresponding `aria-tools/human-required/<request_id>.json` file yet.
    Records one for each, returns the lists. Idempotent.
    """
    root = ensure_tools_dir(base_dir)
    requests = load_declared_jsonl(
        root / "agent-invocations" / "requests.jsonl",
        expected_surface="agent_invocation_requests",
    )
    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for request in requests:
        rid = request.get("request_id")
        if not rid:
            continue
        try:
            state = derive_request_state(request_id=rid, base_dir=root)
        except GovernanceError:
            continue
        if state != "HUMAN_REQUIRED":
            continue
        existing = _human_required_path(root, rid)
        if existing.exists():
            skipped.append({"request_id": rid, "reason": "already_recorded"})
            continue
        # Look up the requeue count to surface in the reason text.
        claims = load_declared_jsonl(
            root / "agent-invocations" / "claims.jsonl",
            expected_surface="agent_invocation_claims",
        )
        requeue_count = _request_event_count(claims, rid, "requeued")
        record = record_human_required(
            request_id=rid,
            severity=request.get("severity") or DEFAULT_SEVERITY,
            reason=(
                f"lease lifecycle exhausted requeues for request {rid!r} "
                f"(requeue_count={requeue_count}); operator follow-up required."
            ),
            # E3/F12 — `lease_lifecycle` has always been an ADMITTED
            # adjudication kind, but this producer wrote no context, so
            # the classifier answered `no_context_to_classify` and every
            # lease exhaustion parked on the operator forever. Live proof:
            # 7 of the 9 records in the human-required box were exactly
            # this shape. A capacity fault is machine-adjudicable.
            context={
                "kind": "lease_lifecycle",
                "request_id": rid,
                "role": request.get("role"),
                "target_agent": request.get("target_agent"),
                "requeue_count": requeue_count,
            },
            base_dir=root,
            now=now,
        )
        created.append(record)

    # Y7 (ORPHAN-708) — the OTHER operational death: an envelope nobody
    # claimed before its anchor window closed. Pre-Y7 these died silently
    # (296 measured on the second sealed night) — no record, no panel, the
    # work just gone. Capped per sweep so a stale backlog drains gradually
    # instead of flooding the panel queue; a request that already has a
    # remint successor is recovered, not escalated.
    anchor_created = 0
    remint_successors = {
        str(r.get("remint_of")) for r in requests if r.get("remint_of")
    }
    for request in requests:
        if anchor_created >= ANCHOR_STALE_SWEEP_CAP:
            break
        rid = request.get("request_id")
        if not rid:
            continue
        if rid in remint_successors:
            skipped.append({"request_id": rid, "reason": "remint_successor_exists"})
            continue
        try:
            state = derive_request_state(request_id=rid, base_dir=root)
        except GovernanceError:
            continue
        if state != "ANCHOR_STALE":
            continue
        existing = _human_required_path(root, rid)
        if existing.exists():
            continue
        record = record_human_required(
            request_id=rid,
            severity=request.get("severity") or DEFAULT_SEVERITY,
            reason=(
                f"request {rid!r} died ANCHOR_STALE unclaimed; "
                f"panel disposition required (re_mint / drop_with_reason)."
            ),
            context={
                "kind": "anchor_stale",
                "request_id": rid,
                "role": request.get("role"),
                "target_agent": request.get("target_agent"),
            },
            base_dir=root,
            now=now,
        )
        created.append(record)
        anchor_created += 1
    return {"created": created, "skipped": skipped}


# Plan 023 §B — consensus-failure escalation mapping.
# ``judge_disagreement`` is a genuine split verdict between independent judges
# (HIGH). ``low_confidence`` is an aligned-but-weak verdict (MEDIUM).
# ``single_judge`` is the benign "only one judge sampled this finding" case —
# it is re-sampled next cycle and is intentionally NOT escalated, to avoid
# flooding operator triage with sampling-order noise.
CONSENSUS_UNCERTAINTY_SEVERITY = {
    "judge_disagreement": "HIGH",
    "low_confidence": "MEDIUM",
    # Plan 024 §C — a judge citing evidence that does not resolve in the repo is
    # a fabrication signal; the cheap tier must not be rubber-stamped on it.
    "evidence_not_repo_verified": "HIGH",
    # Kalibre Zekâ Z2b — a judge group with no numeric confidence at all is
    # a bridge/schema fault, not a quality verdict; it escalates under its
    # own name (a reason absent from this map is silently dropped as
    # benign_not_escalated — that is why this entry MUST exist).
    "missing_confidence": "MEDIUM",
    # Z2c — a passing consensus below the calibrated conformal floor is a
    # statistically-guaranteed "too uncertain to auto-accept" signal.
    "conformal_abstain": "HIGH",
}


def _consensus_uncertainties_path(tools_root: Path) -> Path:
    return tools_root / "feedback-consensus-uncertainties.jsonl"


def sweep_consensus_uncertainties_for_human_required(
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Drain ``feedback-consensus-uncertainties.jsonl`` into HUMAN_REQUIRED.

    Before Plan 023 the consensus gate wrote every judge disagreement /
    low-confidence outcome to that file and NOTHING ever read it — a split
    verdict was silently held forever and never reached a human. This consumer
    closes that hole: each genuine consensus failure becomes one idempotent
    HUMAN_REQUIRED operator-triage record keyed by the uncertainty's stable
    ``escalation_id``. Idempotent across cycles (re-running the drain on the
    same file creates nothing new).
    """
    root = ensure_tools_dir(base_dir)
    path = _consensus_uncertainties_path(root)
    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen_escalations: set[str] = set()
    # E14 — arbitration first, the operator as the fallback. A split verdict
    # now mints a `consensus_arbitration` envelope (judge_fanout), and that
    # arbiter is one of the three agents this escalation's adjudication panel
    # would dispatch anyway: escalating while arbitration is still in flight
    # asks the same agent the same question twice. Once arbitration reaches a
    # terminal state and the group is still unsettled, the escalation is raised
    # on the next sweep — nothing is dropped, only ordered.
    from .judge_fanout import pending_arbitration_group_ids

    arbitration_pending = pending_arbitration_group_ids(base_dir=root)
    # Plan 026R §A.3 — route the JSONL read through the strict reader instead
    # of a bare silent-skip; a corrupt row emits a ledger-corruption diagnostic
    # rather than vanishing. Tolerant mode so one bad row cannot block
    # escalation of the valid ones. Non-existent path → empty iterator.
    for entry in read_strict_jsonl(path, on_corruption="tolerant", base_dir=root):
        for unc in entry.get("uncertainties", []) or []:
            if not isinstance(unc, dict):
                continue
            reason = str(unc.get("reason") or "")
            severity = CONSENSUS_UNCERTAINTY_SEVERITY.get(reason)
            escalation_id = str(unc.get("escalation_id") or "")
            if severity is None:
                skipped.append({"reason": reason or "unknown", "kind": "benign_not_escalated"})
                continue
            if not escalation_id:
                skipped.append({"reason": reason, "kind": "missing_escalation_id"})
                continue
            if escalation_id in seen_escalations:
                continue
            seen_escalations.add(escalation_id)
            group_id = str(unc.get("judgment_group_id") or "")
            if group_id and group_id in arbitration_pending:
                skipped.append({
                    "request_id": escalation_id,
                    "judgment_group_id": group_id,
                    "reason": "arbitration_in_flight",
                })
                continue
            if _human_required_path(root, escalation_id).exists():
                skipped.append({"request_id": escalation_id, "reason": "already_recorded"})
                continue
            record = record_human_required(
                request_id=escalation_id,
                severity=severity,
                reason=(
                    f"AI consensus could not be reached ({reason}) for finding "
                    f"{unc.get('finding_id')!r} (tool {unc.get('tool_id')!r}, run "
                    f"{unc.get('run_id')!r}); independent judges disagreed or were "
                    f"low-confidence. Operator adjudication required."
                ),
                context={
                    "kind": "consensus_escalation",
                    "uncertainty_reason": reason,
                    "tool_id": unc.get("tool_id"),
                    "run_id": unc.get("run_id"),
                    "finding_id": unc.get("finding_id"),
                    "judgment_group_id": unc.get("judgment_group_id"),
                },
                base_dir=root,
                now=now,
            )
            created.append(record)
    return {"created": created, "skipped": skipped}
