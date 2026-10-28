from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Mapping

from .agent_eval import _require_operator_approval_future, _validate_real_eval_provenance
from .genesis_policy import genesis_lifecycle_policy
from .ledger import append_declared_jsonl, load_declared_jsonl
from .ledger_refs import find_row_by_source_ledger_ref
from .tool_registry import GovernanceError, bound_workspace_root, ensure_tools_dir, parse_utc_stamp, utc_now
from .digest import is_sha256_digest


GenesisState = Literal[
    "PRESSURE",
    "CANDIDATE_PROPOSED",
    "HUMAN_REQUIRED",
    "REQUEST",
    "DRAFT",
    "REAL_SANDBOX",
    "SHADOW",
    "EVAL_WINDOW",
    "ACTIVE",
    "REJECTED",
]

GENESIS_LIFECYCLE_STATES: tuple[GenesisState, ...] = (
    "PRESSURE",
    "CANDIDATE_PROPOSED",
    "HUMAN_REQUIRED",
    "REQUEST",
    "DRAFT",
    "REAL_SANDBOX",
    "SHADOW",
    "EVAL_WINDOW",
    "ACTIVE",
    "REJECTED",
)

# ARIA-HIGH-238 — the states past DRAFT widen what the entity may do; a
# supplied operator approval for one of them is an authority grant.
_WIDENING_GENESIS_STATES: frozenset[GenesisState] = frozenset({
    "REAL_SANDBOX", "SHADOW", "EVAL_WINDOW", "ACTIVE",
})

ALLOWED_TRANSITIONS: dict[GenesisState, frozenset[GenesisState]] = {
    "PRESSURE": frozenset({"CANDIDATE_PROPOSED"}),
    "CANDIDATE_PROPOSED": frozenset({"HUMAN_REQUIRED", "REJECTED"}),
    "HUMAN_REQUIRED": frozenset({"REQUEST", "REJECTED"}),
    "REQUEST": frozenset({"DRAFT", "REJECTED"}),
    "DRAFT": frozenset({"REAL_SANDBOX", "REJECTED"}),
    "REAL_SANDBOX": frozenset({"SHADOW", "REJECTED"}),
    "SHADOW": frozenset({"EVAL_WINDOW", "REJECTED"}),
    "EVAL_WINDOW": frozenset({"ACTIVE", "REJECTED"}),
    "ACTIVE": frozenset(),
    "REJECTED": frozenset(),
}


@dataclass(frozen=True)
class GenesisLifecycleVerdict:
    valid: bool
    reasons: tuple[str, ...]


def lifecycle_events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "genesis-lifecycle" / "events.jsonl"


@dataclass(frozen=True)
class InvalidLifecycleChain:
    """An entity whose recorded rows are not a lawful lifecycle.

    WHAT: the value ``current_lifecycle_state`` returns when replaying an
    entity's own chain breaks a rule; ``reasons`` names each break. It is a
    value, not a raise and not a state string: a reader that asks "is this
    entity ACTIVE?" gets "no" without a crash, and a reader that needs the
    cause finds it on the value.

    WHY: the ledger is append-only but anyone who can append can write any
    row. The state is therefore what the transition law yields when the rows
    are replayed from nothing, never what the last row says it is.
    """

    entity_id: str
    reasons: tuple[str, ...]

    @property
    def reason(self) -> str:
        """The break as one named reason (``chain_invalid:<reasons>``), what a refusal carries."""
        return "chain_invalid:" + ";".join(self.reasons)


@dataclass(frozen=True)
class ReplayedChain:
    """One entity's replayed lifecycle: its state, the last row's evidence and when each state was entered.

    ``entered_at`` maps a state to the ``recorded_at`` stamp of the row that entered it. A lawful chain enters
    every state at most once (``ALLOWED_TRANSITIONS`` has no cycle), so the stamp is the entry of the entity's
    one stay. A chain the replay refuses carries none: a row the replay refused never dates anything.
    """

    state: GenesisState | None | InvalidLifecycleChain
    latest_evidence: Mapping[str, Any]
    entered_at: Mapping[str, str]


def _replay(entity_id: str, rows: list[dict[str, Any]], policy_root: Path) -> ReplayedChain:
    """Replay ``rows`` (one entity's, in ledger order) through ``validate_transition`` from nothing.

    The from-state of every step is the replayed one: a row's recorded
    ``from_state`` is checked against it, never trusted. A row whose
    ``to_state`` is not a known state, a recorded from-state that differs, an
    illegal transition or an ACTIVE row without the kernel-computed proof each
    make the chain invalid. A state later added to ``GENESIS_LIFECYCLE_STATES``
    is read here without another rule. The stamp of the row that entered each
    state is kept for a lawful chain (``ReplayedChain.entered_at``), so no
    reader walks the rows again to date an entry.
    """
    state: GenesisState | None = None
    reasons: list[str] = []
    entered_at: dict[str, str] = {}
    for row in rows:
        to_state = row.get("to_state")
        if to_state not in GENESIS_LIFECYCLE_STATES:
            reasons.append(f"genesis_lifecycle_unknown_state:{to_state}")
            continue
        if row.get("from_state") != state:
            reasons.append(f"genesis_from_state_mismatch:{row.get('from_state')!r}!={state!r}")
        verdict = validate_transition(
            from_state=state, to_state=to_state, evidence=row.get("evidence") or {}, repo_root=policy_root,
        )
        reasons.extend(verdict.reasons)
        entered_at[to_state] = str(row.get("recorded_at", ""))
        state = to_state
    latest_evidence = (rows[-1].get("evidence") or {}) if rows else {}
    if reasons:
        return ReplayedChain(InvalidLifecycleChain(entity_id, tuple(reasons)), latest_evidence, {})
    return ReplayedChain(state, latest_evidence, entered_at)


def _rows_by_entity(base_dir: str | Path | None) -> dict[str, list[dict[str, Any]]]:
    rows_by_entity: dict[str, list[dict[str, Any]]] = {}
    for row in load_declared_jsonl(lifecycle_events_path(base_dir), expected_surface="genesis_lifecycle_events"):
        rows_by_entity.setdefault(str(row.get("entity_id") or ""), []).append(row)
    return rows_by_entity


def lifecycle_chains(base_dir: str | Path | None = None) -> dict[str, ReplayedChain]:
    """Every entity in the ledger, replayed: one pass for a reader that needs them all."""
    policy_root = bound_workspace_root(base_dir)
    return {entity: _replay(entity, rows, policy_root) for entity, rows in _rows_by_entity(base_dir).items()}


def _replayed_chain(entity_id: str, base_dir: str | Path | None) -> ReplayedChain:
    """One entity's chain, replayed: the one walk of the events file and the one replay a single-entity reader takes."""
    return _replay(entity_id, _rows_by_entity(base_dir).get(entity_id, []), bound_workspace_root(base_dir))


def current_lifecycle_state(
    *,
    entity_id: str,
    base_dir: str | Path | None = None,
) -> GenesisState | None | InvalidLifecycleChain:
    """The entity's state as its own rows replay, ``None`` when it has none (see ``InvalidLifecycleChain``)."""
    return _replayed_chain(entity_id, base_dir).state


def production_block_reason(entity_id: str, *, base_dir: str | Path | None = None) -> str | None:
    """Why ``entity_id`` may not take production traffic, or ``None`` when nothing blocks it.

    ``"shadow"`` for a lawful SHADOW chain; ``"chain_invalid:<reasons>"`` when
    the chain does not replay (fail-closed: a forged ACTIVE row over a SHADOW
    chain must not unblock production). An entity with no chain (or no name)
    is not a lifecycle entity and is not blocked.
    """
    if not entity_id:
        return None
    state = current_lifecycle_state(entity_id=entity_id, base_dir=base_dir)
    if isinstance(state, InvalidLifecycleChain):
        return state.reason
    return "shadow" if state == "SHADOW" else None


def eval_window_entered_at(
    *,
    entity_id: str,
    base_dir: str | Path | None = None,
) -> datetime | None:
    """When the entity entered EVAL_WINDOW (an aware instant), or None.

    F1.8(a) — the anchor of the paired gain test. The test is valid at every
    look only if the evidence it counts accumulates, so its comparison starts
    at one fixed instant per entity, recorded once in this append-only ledger,
    rather than sliding with the clock.

    F1.8a — the anchor is read through the replay (``_replayed_chain``), the
    same walk ``current_lifecycle_state`` takes, so a row the replay refuses
    never dates anything. It is the stamp of the row that entered EVAL_WINDOW
    in a lawful chain whose replayed state is EVAL_WINDOW; None for a chain the
    replay refuses (``production_block_reason`` blocks it the same way), an
    entity with no chain, one that is not in EVAL_WINDOW now, and a stamp that
    cannot be read. The caller must not invent an anchor.
    """
    chain = _replayed_chain(entity_id, base_dir)
    if chain.state != "EVAL_WINDOW":
        return None
    return parse_utc_stamp(chain.entered_at["EVAL_WINDOW"])


def validate_transition(
    *,
    from_state: GenesisState | None,
    to_state: GenesisState,
    evidence: dict[str, Any],
    repo_root: str | Path | None = None,
) -> GenesisLifecycleVerdict:
    reasons: list[str] = []
    policy = genesis_lifecycle_policy(repo_root)
    if from_state is None:
        if to_state != "PRESSURE":
            reasons.append("genesis_initial_state_must_be_PRESSURE")
    elif to_state not in ALLOWED_TRANSITIONS[from_state]:
        reasons.append(f"genesis_invalid_transition:{from_state}->{to_state}")

    if to_state == "CANDIDATE_PROPOSED":
        repeated_cycles = int(evidence.get("valid_cycles") or evidence.get("repeated_observations") or 0)
        source_types = {str(item) for item in evidence.get("source_types") or [] if str(item).strip()}
        min_cycles = int(policy["shadow_min_clean_cycles"])
        if repeated_cycles < min_cycles and len(source_types) < 2:
            reasons.append(f"candidate_requires_{min_cycles}_valid_cycles_or_2_source_types")
    if to_state == "HUMAN_REQUIRED":
        # C4-c (ORPHAN-676) — the gate reads what the REAL producer
        # writes. The original shape (verdict∈{positive,covered,pass} +
        # coverage_score≥threshold) had NO producer anywhere:
        # capability_resolver — the only coverage authority — writes
        # decision∈{reuse,extend,request}. An unproducible predicate is
        # a locked door with no key; this arm now demands the resolver's
        # actual decision row: reuse blocks genesis (duplicate), extend/
        # request admit the human adjudication step.
        resolution = evidence.get("capability_resolution")
        decision = (
            resolution.get("decision") if isinstance(resolution, dict) else None
        )
        if decision not in {"extend", "request"}:
            reasons.append(
                "human_required_requires_capability_resolution_decision"
                f":{decision!r}"
            )
    if to_state == "REQUEST":
        # Y8 (ORPHAN-709) — two approval modes, one auditable ladder shape.
        # Panel mode is satisfied by a resolved genesis_candidate panel
        # adjudication (the ref is RESOLVED and overwritten kernel-side in
        # record_transition — hand-built evidence cannot validate); operator
        # mode keeps the signed feedback ref. Kernel-scoped entities are
        # forced to operator mode by the chain recorder.
        mode = str(evidence.get("approval_mode") or "operator")
        if mode == "panel":
            if not str(evidence.get("adjudication_ref") or "").strip():
                reasons.append("request_requires_panel_adjudication_ref")
        elif not str(evidence.get("operator_feedback_ref") or "").strip():
            reasons.append("request_requires_signed_operator_feedback")
    if to_state in {"REAL_SANDBOX", "SHADOW", "EVAL_WINDOW"}:
        required = ("eval_harness_id", "fixture_run_id", "transcript_hash", "operator_provenance_ref")
        missing = [field for field in required if not str(evidence.get(field) or "").strip()]
        if missing:
            reasons.append(f"{to_state.lower()}_requires_proof_fields:{','.join(missing)}")
    if to_state == "ACTIVE":
        reviewers = {str(item) for item in evidence.get("reviewers") or [] if str(item).strip()}
        validators = {str(item) for item in evidence.get("validators") or [] if str(item).strip()}
        if len(reviewers | validators) < 2:
            reasons.append("active_requires_2_reviewers_or_validators")
        # Z3d (ORPHAN 630 class) — the gate no longer reads the caller's
        # `eval_window_passed` bool: any caller could promote by asserting
        # the very thing the gate existed to measure. It reads the
        # KERNEL-COMPUTED proof `record_transition` injects from
        # genesis_superiority.compute_eval_window_superiority; a hand-built
        # evidence dict without that computation cannot validate.
        proof = evidence.get("resolved_eval_window_superiority")
        if not isinstance(proof, dict) or proof.get("passed") is not True:
            reasons.append("active_requires_kernel_computed_eval_superiority")
        elif not isinstance(proof.get("window"), dict) or not isinstance(
            proof.get("duel"), dict
        ):
            reasons.append("active_superiority_proof_missing_components")

    return GenesisLifecycleVerdict(valid=not reasons, reasons=tuple(reasons))


def verify_shadow_eval_proof(
    *,
    target_agent: str,
    eval_harness_id: str,
    fixture_run_id: str,
    transcript_hash: str,
    operator_provenance_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Resolve SHADOW eval proof fields to hash-chained ledger rows."""
    proof = {
        "eval_harness_id": str(eval_harness_id or "").strip(),
        "fixture_run_id": str(fixture_run_id or "").strip(),
        "transcript_hash": str(transcript_hash or "").strip(),
        "operator_provenance_ref": str(operator_provenance_ref or "").strip(),
    }
    missing = [key for key, value in proof.items() if not value]
    if missing:
        raise GovernanceError("shadow_eval_requires_harness_proof:" + ",".join(missing))
    if not is_sha256_digest(proof["transcript_hash"]):
        raise GovernanceError("shadow_eval_transcript_hash_must_be_sha256")

    root = ensure_tools_dir(base_dir)
    fixture = _find_ledger_row(
        load_declared_jsonl(
            root / "fixture-runs.jsonl",
            expected_surface="agent_eval_fixture_runs",
        ),
        ("execution_run_id", "fixture_run_id", "run_id"),
        proof["fixture_run_id"],
    )
    if fixture.get("passed") is not True and fixture.get("actual_status") != "pass":
        raise GovernanceError("shadow_eval_fixture_run_not_passing")

    eval_run = _find_ledger_row(
        load_declared_jsonl(
            root / "agent-evals" / "runs.jsonl",
            expected_surface="agent_evals",
        ),
        ("eval_harness_id", "harness_id", "run_id"),
        proof["eval_harness_id"],
    )
    if str(eval_run.get("target_agent") or target_agent) != target_agent:
        raise GovernanceError("shadow_eval_target_agent_mismatch")
    if eval_run.get("fixture_run_id") and eval_run.get("fixture_run_id") != proof["fixture_run_id"]:
        raise GovernanceError("shadow_eval_fixture_run_mismatch")
    required_chain_refs = (
        "request_ledger_ref",
        "claim_ledger_ref",
        "context_ledger_ref",
        "prompt_ledger_ref",
        "result_ledger_ref",
        "fixture_ledger_ref",
        "transcript_ledger_ref",
        "operator_approval_ledger_ref",
    )
    missing_chain = [
        field for field in required_chain_refs
        if not isinstance(eval_run.get(field), dict)
    ]
    if missing_chain:
        raise GovernanceError("shadow_eval_proof_chain_missing:" + ",".join(missing_chain))
    invocation_id = str(eval_run.get("invocation_id") or "")
    if not invocation_id:
        raise GovernanceError("shadow_eval_proof_chain_missing:invocation_id")
    try:
        _validate_real_eval_provenance(
            root,
            invocation_id=invocation_id,
            transcript_hash=proof["transcript_hash"],
            fixture_id=str(eval_run.get("fixture_id") or proof["fixture_run_id"]),
            target_agent=target_agent,
            request_ledger_ref=eval_run.get("request_ledger_ref"),
            claim_ledger_ref=eval_run.get("claim_ledger_ref"),
            context_ledger_ref=eval_run.get("context_ledger_ref"),
            prompt_ledger_ref=eval_run.get("prompt_ledger_ref"),
            result_ledger_ref=eval_run.get("result_ledger_ref"),
            fixture_ledger_ref=eval_run.get("fixture_ledger_ref"),
            transcript_ledger_ref=eval_run.get("transcript_ledger_ref"),
            operator_approval_ledger_ref=eval_run.get("operator_approval_ledger_ref"),
        )
    except GovernanceError as exc:
        raise GovernanceError(f"shadow_eval_proof_chain_invalid:{exc}") from exc

    transcript = _find_ledger_row(
        load_declared_jsonl(
            root / "agent-invocations" / "transcripts.jsonl",
            expected_surface="agent_invocation_transcripts",
        ),
        ("transcript_hash", "output_transcript_hash"),
        proof["transcript_hash"],
    )
    if str(transcript.get("target_agent") or target_agent) != target_agent:
        raise GovernanceError("shadow_eval_transcript_target_agent_mismatch")

    operator = find_row_by_source_ledger_ref(
        root,
        eval_run["operator_approval_ledger_ref"],
        expected_surface="operator_provenance",
        expected_row_type="operator_approval",
    )
    _require_operator_approval_future(operator)
    operator_refs = {
        str(operator.get(key) or "")
        for key in ("operator_provenance_ref", "provenance_ref", "event_id", "ref")
        if str(operator.get(key) or "").strip()
    }
    if proof["operator_provenance_ref"] not in operator_refs:
        raise GovernanceError("shadow_eval_operator_ref_mismatch")
    return {
        **proof,
        "fixture_run_ledger_hash": fixture.get("ledger_hash"),
        "eval_run_ledger_hash": eval_run.get("ledger_hash"),
        "transcript_ledger_hash": transcript.get("ledger_hash"),
        "operator_provenance_ledger_hash": operator.get("ledger_hash"),
    }


def _find_ledger_row(
    rows: list[dict[str, Any]],
    keys: tuple[str, ...],
    expected: str,
) -> dict[str, Any]:
    matches = [
        row for row in rows
        if any(str(row.get(key) or "") == expected for key in keys)
    ]
    if len(matches) > 1:
        raise GovernanceError(f"shadow_eval_proof_ambiguous:{expected}")
    for row in matches:
        if not isinstance(row.get("ledger_hash"), str) or not row.get("ledger_hash"):
            raise GovernanceError(f"shadow_eval_proof_row_missing_ledger_hash:{expected}")
        return row
    raise GovernanceError(f"shadow_eval_proof_unbound:{expected}")


def _resolve_panel_adjudication_proof(
    *,
    adjudication_ref: str,
    capability_gap_key: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Y8 (ORPHAN-709) — kernel-computed panel-approval proof.

    ``adjudication_ref`` names the genesis_candidate escalation record the
    panel APPROVED. The proof is derived from the record file, never from
    caller-supplied evidence: existence, resolved status, agent_panel
    resolver, an approving ``panel_outcome``, genesis_candidate kind, and a
    matching capability_gap_key are each a hard refusal.

    The outcome clause is what separates "the panel answered" from "the
    panel said yes" — the refuse branch of the fold resolves the record just
    as the approve branch does, so every other clause here holds for a
    REJECTED candidate.

    The checks themselves live in ``human_required.resolve_panel_adjudication_proof``
    — this lane's shape, generalised so the tool-promotion lane (JJ-2b) is
    the SAME resolver rather than a second one that forgets a clause.
    """
    from .human_required import resolve_panel_adjudication_proof

    return resolve_panel_adjudication_proof(
        adjudication_ref=adjudication_ref,
        expected_kind="genesis_candidate",
        context_match={"capability_gap_key": capability_gap_key},
        error_prefix="genesis_panel",
        base_dir=base_dir,
    )


def record_transition(
    *,
    entity_id: str,
    entity_kind: str,
    to_state: GenesisState,
    evidence: dict[str, Any],
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    if not entity_id.strip():
        raise GovernanceError("genesis_lifecycle_entity_id_required")
    if to_state not in GENESIS_LIFECYCLE_STATES:
        raise GovernanceError(f"genesis_lifecycle_unknown_state:{to_state!r}")
    from_state = current_lifecycle_state(entity_id=entity_id, base_dir=base_dir)
    if isinstance(from_state, InvalidLifecycleChain):
        raise GovernanceError(f"genesis_lifecycle_chain_invalid:{entity_id}:" + ";".join(from_state.reasons))
    # ARIA-MEDIUM-468 — the production producer passes no repo_root. Operator policy
    # then comes from the workspace this tools store is bound to, the same
    # owner the cost and drain-capacity gates read.
    policy_root = repo_root if repo_root is not None else bound_workspace_root(base_dir)
    if to_state == "ACTIVE":
        # Z3d — compute the superiority proof BEFORE validation and OVERWRITE
        # whatever the caller put under this key: the promotion gate reads
        # only what the kernel measured (verify_shadow_eval_proof pattern).
        from .genesis_superiority import compute_eval_window_superiority

        # C8/E11 — thread repo_root so the operator's superiority_policy
        # override (genesis_policy.superiority_policy) is actually read;
        # without it the policy block was dead configuration and every
        # promotion ran on hardcoded defaults.
        evidence = {
            **evidence,
            "resolved_eval_window_superiority": compute_eval_window_superiority(
                entity_id=entity_id, base_dir=base_dir, repo_root=policy_root
            ),
        }
    if to_state == "REQUEST" and str(evidence.get("approval_mode") or "") == "panel":
        # Y8 (ORPHAN-709) — Z3d pattern: resolve the panel proof kernel-side
        # and OVERWRITE whatever the caller put under the resolved key. The
        # policy switch lets an operator force operator-mode globally.
        policy_mode = str(
            genesis_lifecycle_policy(policy_root).get("request_approval_mode")
            or "operator"
        )
        if policy_mode != "panel":
            raise GovernanceError("genesis_panel_mode_disabled_by_policy")
        evidence = {
            **evidence,
            "resolved_panel_adjudication": _resolve_panel_adjudication_proof(
                adjudication_ref=str(evidence.get("adjudication_ref") or ""),
                capability_gap_key=str(evidence.get("capability_gap_key") or ""),
                base_dir=base_dir,
            ),
        }
    # ARIA-HIGH-238 — a supplied ref claims operator authority for the
    # transition. Widening states (REAL_SANDBOX/SHADOW/EVAL_WINDOW/ACTIVE —
    # the reach beyond DRAFT) are RAISING: the ref must be the operator's
    # own GitHub act naming entity + state, verified and consumed once.
    # Every other state (the procedural prefix, or a narrowing exit such as
    # REJECTED) is LOWERING: the ref is the reason on the record.
    approval_proof: dict[str, Any] | None = None
    if operator_approval_ref and to_state in _WIDENING_GENESIS_STATES:
        from .operator_approval import require_operator_act

        approval_proof = require_operator_act(
            operator_approval_ref,
            surface="genesis_transition",
            scope={"entity": entity_id, "state": to_state},
            base_dir=base_dir,
        )
    verdict = validate_transition(
        from_state=from_state, to_state=to_state, evidence=evidence, repo_root=policy_root,
    )
    if not verdict.valid:
        raise GovernanceError("genesis_lifecycle_transition_rejected:" + ";".join(verdict.reasons))
    if to_state in {"REAL_SANDBOX", "SHADOW", "EVAL_WINDOW"}:
        proof = verify_shadow_eval_proof(
            target_agent=entity_id,
            eval_harness_id=str(evidence.get("eval_harness_id") or ""),
            fixture_run_id=str(evidence.get("fixture_run_id") or ""),
            transcript_hash=str(evidence.get("transcript_hash") or ""),
            operator_provenance_ref=str(evidence.get("operator_provenance_ref") or ""),
            base_dir=base_dir,
        )
        evidence = {**evidence, "resolved_shadow_eval_proof": proof}
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "entity_id": entity_id,
        "entity_kind": entity_kind,
        "from_state": from_state,
        "to_state": to_state,
        "evidence": dict(evidence),
        "operator_approval_ref": operator_approval_ref,
        **({"operator_approval": approval_proof} if approval_proof is not None else {}),
    }
    return append_declared_jsonl(
        lifecycle_events_path(base_dir),
        row,
        expected_surface="genesis_lifecycle_events",
    )


def require_lifecycle_state(
    *,
    entity_id: str,
    allowed_states: set[GenesisState] | frozenset[GenesisState],
    base_dir: str | Path | None = None,
) -> GenesisState:
    state = current_lifecycle_state(entity_id=entity_id, base_dir=base_dir)
    if state not in allowed_states:
        raise GovernanceError(
            f"genesis_lifecycle_state_required: entity_id={entity_id!r} "
            f"state={state!r} allowed={sorted(allowed_states)!r}"
        )
    return state


__all__ = [
    "ALLOWED_TRANSITIONS",
    "GENESIS_LIFECYCLE_STATES",
    "GenesisLifecycleVerdict",
    "GenesisState",
    "InvalidLifecycleChain",
    "ReplayedChain",
    "current_lifecycle_state",
    "lifecycle_chains",
    "lifecycle_events_path",
    "production_block_reason",
    "record_transition",
    "require_lifecycle_state",
    "validate_transition",
    "verify_shadow_eval_proof",
]
