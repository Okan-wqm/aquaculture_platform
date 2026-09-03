from __future__ import annotations

import json
import shutil
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .agent_satisfaction import agent_satisfaction_scan
from .batch_containment import BATCH_FAILURE_SAMPLE_CAP, guard_item, with_item_failures
from .agent_network import agent_network_index
from .agent_genesis import (
    existing_genesis_request_keys,
    record_extension_decision,
    request_agent_genesis,
)
from .capability_gap import detect_capability_gaps, latest_capability_gaps
from .feedback import load_failure_mode_vocabulary
from .fitness import agent_fitness_score
from .genesis_policy import load_policy as load_genesis_policy
from .impact_graph import plan_downstream_impact
from .ledger import LedgerIntegrityError, load_jsonl, verify_index_hashes
from .pressure import DEFAULT_DECAY_THRESHOLDS, TERMINAL_STATES, append_pressure_state_event, effective_workspace_pressures
from .report_ingestion import report_ingestion_scan
from .semantic_dedup import semantic_dedup_compute
from .service_agent_targeting import propose_service_auditor_requests
from .plan_convergence import list_active_plans
from .trailer_scan import git_trailer_scan
from .trust import ref_staleness_check, trust_escalation_derive
from .triage import triage_policy_apply
from .tool_registry import append_tools_governance
from .workspace import WorkspacePaths, record_workspace_governance


DEFAULT_ARTIFACT_TTL_DAYS = 365
LEARNING_HOOK_ORDER = (
    "decay_recompute",
    "artifact_prune",
    "vocabulary_reload_check",
    "git_trailer_scan",
    "agent_satisfaction_scan",
    "report_ingestion_scan",
    "semantic_dedup_compute",
    "trust_escalation_derive",
    "ref_staleness_check",
    "triage_policy_apply",
    "agent_network_index",
    "capability_gap_detect",
    "plan_convergence_advance",
    "impact_graph_compute",
    "skill_or_agent_genesis",
    "service_auditor_targeting",
    # Y8 (ORPHAN-709 follow-through) — the sweep was REGISTERED in the hook
    # table but absent from this ORDER, and _run_learning_hooks selects by
    # order membership: registered-but-never-selected is the exact
    # dead-hook class this repository keeps closing. Caught by the first
    # post-merge verification run (sweep left zero trace); the parity pin
    # in test_y8_genesis_panel_gate now makes the mismatch impossible.
    # Placed AFTER service_auditor_targeting: that pair's adjacency is its
    # own pinned contract (LearningWiringTests).
    "genesis_panel_sweep",
    "agent_fitness_score",
)
PRE_CYCLE_LEARNING_HOOKS = (
    "decay_recompute",
    "artifact_prune",
    "vocabulary_reload_check",
    "git_trailer_scan",
)
POST_EVIDENCE_LEARNING_HOOKS = tuple(
    hook for hook in LEARNING_HOOK_ORDER if hook not in PRE_CYCLE_LEARNING_HOOKS
)


def _run_learning_hooks(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    now: datetime | None = None,
    artifact_ttl_days: int = DEFAULT_ARTIFACT_TTL_DAYS,
    hook_names: tuple[str, ...] = LEARNING_HOOK_ORDER,
) -> dict[str, Any]:
    """Run Phase-2A cycle learning hooks in contract order."""

    now = now or datetime.now(timezone.utc)
    verify_index_hashes(paths.feedback_index, paths.ledgers)
    root = Path(tools_root) if tools_root is not None else None
    hooks: tuple[tuple[str, Callable[[], dict[str, Any]]], ...] = (
        ("decay_recompute", lambda: recompute_pressure_decay(paths, cycle_id=cycle_id, now=now)),
        ("artifact_prune", lambda: prune_cycle_artifacts(paths, cycle_id=cycle_id, tools_root=root, now=now, ttl_days=artifact_ttl_days)),
        ("vocabulary_reload_check", lambda: vocabulary_reload_check(paths)),
        ("git_trailer_scan", lambda: git_trailer_scan(paths, cycle_id=cycle_id, tools_root=root)),
        ("agent_satisfaction_scan", lambda: agent_satisfaction_scan(paths, cycle_id=cycle_id, tools_root=root)),
        ("report_ingestion_scan", lambda: report_ingestion_scan(paths, cycle_id=cycle_id, tools_root=root)),
        ("semantic_dedup_compute", lambda: semantic_dedup_compute(paths, cycle_id=cycle_id, tools_root=root)),
        ("trust_escalation_derive", lambda: trust_escalation_derive(paths, cycle_id=cycle_id)),
        ("ref_staleness_check", lambda: ref_staleness_check(paths, cycle_id=cycle_id)),
        ("triage_policy_apply", lambda: triage_policy_apply(paths, cycle_id=cycle_id, tools_root=root)),
        ("agent_network_index", lambda: agent_network_index(workspace_root=paths.repo_root, base_dir=root, cycle_id=cycle_id) if root else _skipped(cycle_id, "tools_root_required")),
        ("capability_gap_detect", lambda: detect_capability_gaps(cycle_id=cycle_id, paths=paths, base_dir=root) if root else _skipped(cycle_id, "tools_root_required")),
        ("plan_convergence_advance", lambda: _plan_convergence_advance(cycle_id=cycle_id, tools_root=root)),
        ("impact_graph_compute", lambda: _impact_graph_compute(cycle_id=cycle_id, paths=paths, tools_root=root)),
        ("skill_or_agent_genesis", lambda: _skill_or_agent_genesis(cycle_id=cycle_id, paths=paths, tools_root=root)),
        ("service_auditor_targeting", lambda: _service_auditor_targeting(cycle_id=cycle_id, paths=paths, tools_root=root)),
        # Y8 (ORPHAN-709) — gaps blocked on genesis adjudication route to the
        # agent panel instead of vanishing from the actionable filter above.
        # Registry position matches LEARNING_HOOK_ORDER (execution order is
        # the registry's; phase2a pins the two lists equal).
        ("genesis_panel_sweep", lambda: _genesis_panel_sweep(cycle_id=cycle_id, paths=paths, tools_root=root)),
        ("agent_fitness_score", lambda: agent_fitness_score(cycle_id=cycle_id, base_dir=root)),
    )
    selected = set(hook_names)
    hooks = tuple((name, hook) for name, hook in hooks if name in selected)
    results: list[dict[str, Any]] = []
    for hook_name, hook in hooks:
        try:
            payload = hook()
            item_failures = payload.get("item_failures") if isinstance(payload, dict) else None
            if item_failures:
                # A batch that lost items is not "ok". Without this, per-item
                # containment would trade a loud wholesale failure for a silent
                # partial one — a worse deal than the blast radius it fixes.
                event = record_workspace_governance(
                    paths,
                    "learning_hook_items_failed",
                    {
                        "hook_name": hook_name,
                        "failure_count": len(item_failures),
                        "failures": list(item_failures)[:BATCH_FAILURE_SAMPLE_CAP],
                    },
                )
                results.append({
                    "hook_name": hook_name,
                    "status": "partial",
                    "result": payload,
                    "governance_event_id": event.get("event_id"),
                })
            else:
                results.append({"hook_name": hook_name, "status": "ok", "result": payload})
        except LedgerIntegrityError:
            raise
        except Exception as exc:  # local hook errors are recorded, then the cycle continues
            event = record_workspace_governance(paths, "learning_hook_failed", _hook_failure_details(hook_name, exc))
            results.append({"hook_name": hook_name, "status": "failed", "governance_event_id": event.get("event_id")})
    return {"schema_version": 1, "cycle_id": cycle_id, "hooks": results}


def run_learning_pre_cycle(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    now: datetime | None = None,
    artifact_ttl_days: int = DEFAULT_ARTIFACT_TTL_DAYS,
) -> dict[str, Any]:
    return _run_learning_hooks(
        paths,
        cycle_id=cycle_id,
        tools_root=tools_root,
        now=now,
        artifact_ttl_days=artifact_ttl_days,
        hook_names=PRE_CYCLE_LEARNING_HOOKS,
    )


def run_learning_post_evidence_closure(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    now: datetime | None = None,
    artifact_ttl_days: int = DEFAULT_ARTIFACT_TTL_DAYS,
) -> dict[str, Any]:
    return _run_learning_hooks(
        paths,
        cycle_id=cycle_id,
        tools_root=tools_root,
        now=now,
        artifact_ttl_days=artifact_ttl_days,
        hook_names=POST_EVIDENCE_LEARNING_HOOKS,
    )


def run_learning_pass(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    now: datetime | None = None,
    artifact_ttl_days: int = DEFAULT_ARTIFACT_TTL_DAYS,
) -> dict[str, Any]:
    pre = run_learning_pre_cycle(
        paths, cycle_id=cycle_id, tools_root=tools_root,
        now=now, artifact_ttl_days=artifact_ttl_days,
    )
    post = run_learning_post_evidence_closure(
        paths, cycle_id=cycle_id, tools_root=tools_root,
        now=now, artifact_ttl_days=artifact_ttl_days,
    )
    return {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "pre_cycle": pre,
        "post_evidence_closure": post,
        "hooks": list(pre.get("hooks", [])) + list(post.get("hooks", [])),
    }


def _skipped(cycle_id: str, reason: str) -> dict[str, Any]:
    return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": reason}


def _service_auditor_targeting(
    *,
    cycle_id: str,
    paths: WorkspacePaths,
    tools_root: Path | None,
) -> dict[str, Any]:
    """E15-c — one guarded call in the genesis phase family.

    Runs right after ``skill_or_agent_genesis`` so its requests land in
    the same nightly window; the surrounding hook loop already records a
    failure and continues (a broken trigger never costs the night).
    """
    if tools_root is None:
        return _skipped(cycle_id, "tools_root_required")
    return propose_service_auditor_requests(
        cycle_id=cycle_id,
        base_dir=tools_root,
        repo_root=paths.repo_root,
    )


def _plan_convergence_advance(*, cycle_id: str, tools_root: Path | None) -> dict[str, Any]:
    if tools_root is None:
        return _skipped(cycle_id, "tools_root_required")
    return {"schema_version": 1, "cycle_id": cycle_id, "status": "ok", "active_plan_ids": list_active_plans(base_dir=tools_root)}


def _impact_graph_compute(
    *,
    cycle_id: str,
    paths: WorkspacePaths,
    tools_root: Path | None,
) -> dict[str, Any]:
    """Compute downstream impact for every pending dispatch request.

    Why: convergence promotes to dispatch; the verification scope (direct vs
    downstream Nx projects) must be known before the worker runs. The hook
    drives this automatically using existing plan_downstream_impact.
    """
    if tools_root is None:
        return _skipped(cycle_id, "tools_root_required")
    pending = [
        row for row in load_jsonl(tools_root / "dispatch" / "requests.jsonl")
        if row.get("state") == "pending"
    ]
    if not pending:
        return _skipped(cycle_id, "no_pending_dispatch")
    pressures_by_id = {
        str(row.get("event_id") or row.get("pressure_id") or ""): row
        for row in load_jsonl(paths.ledgers["pressure"])
    }
    computed: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    skipped_no_evidence = 0
    for dispatch in pending:
        pressure_id = str(dispatch.get("pressure_event_id") or "")
        pressure = pressures_by_id.get(pressure_id)
        if pressure is None:
            continue
        evidence = [
            ref for ref in pressure.get("evidence_refs", [])
            if isinstance(ref, str) and ref.strip()
            and not ref.startswith(("agent:", "manual:", "github:", "git:"))
        ]
        if not evidence:
            skipped_no_evidence += 1
            continue
        # A refused computation used to be counted as `skipped_no_evidence`,
        # which asserts something false about the input: the evidence was
        # there, the graph refused it. An operator reading that number could
        # not tell the two apart, so the counter now means only what it says.
        ok, row = guard_item(
            item_failures,
            item_kind="dispatch",
            item_id=str(dispatch.get("assignment_id") or pressure_id),
            work=lambda evidence=evidence: plan_downstream_impact(
                changed_files=evidence,
                workspace_root=paths.repo_root,
                base_dir=tools_root,
                cycle_id=cycle_id,
            ),
        )
        if not ok or row is None:
            continue
        computed.append({
            "assignment_id": dispatch.get("assignment_id"),
            "pressure_event_id": pressure_id,
            "validation_scope": row.get("validation_scope"),
            "graph_source": row.get("graph_source"),
        })
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "computed_count": len(computed),
        "skipped_no_evidence": skipped_no_evidence,
        "dispatches": computed,
    }, item_failures)


def _genesis_panel_sweep(
    *,
    cycle_id: str,
    paths: WorkspacePaths,
    tools_root: Path | None,
) -> dict[str, Any]:
    """Y8 (ORPHAN-709) — parked gaps become panel questions.

    The actionable filter above rightly skips blocked gaps; pre-Y8 that
    skip was a black hole (16 gaps parked on per-gap operator approval,
    skill_genesis forever no_requests). This hook hands each
    genesis-token-blocked gap to sweep_candidate_gaps_for_adjudication,
    which mints ONE idempotent genesis_candidate escalation the existing
    adjudication sweep panels.
    """
    if tools_root is None:
        return _skipped(cycle_id, "tools_root_required")
    from .agent_genesis import sweep_candidate_gaps_for_adjudication

    return sweep_candidate_gaps_for_adjudication(
        base_dir=tools_root, cycle_id=cycle_id, repo_root=paths.repo_root,
    )


def _skill_or_agent_genesis(
    *,
    cycle_id: str,
    paths: WorkspacePaths,
    tools_root: Path | None,
) -> dict[str, Any]:
    """Emit genesis request rows for actionable capability gaps.

    Why: closing the autonomous learning loop requires a write surface that
    surfaces unowned-pressure gaps to the operator without invoking the Agent
    tool from the kernel. Operators or Claude Code sessions pick up rows from
    agent-genesis/requests.jsonl and run draft → sandbox → materialize.
    """
    if tools_root is None:
        return _skipped(cycle_id, "tools_root_required")
    policy = load_genesis_policy(paths.repo_root)
    if not policy.get("enable_request_generation", True):
        return {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "status": "skipped",
            "reason": "genesis_disabled",
            "policy": policy,
        }
    gaps = latest_capability_gaps(base_dir=tools_root)
    actionable = [gap for gap in gaps if not gap.get("blocked_by")]
    already_requested = existing_genesis_request_keys(base_dir=tools_root)
    fresh = [
        gap for gap in actionable
        if str(gap.get("capability_gap_key") or gap.get("gap_id") or "") not in already_requested
    ]
    cap = int(policy.get("max_requests_per_cycle", 5))
    capped = fresh[:cap]
    requests_emitted: list[dict[str, Any]] = []
    extension_audit_rows: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    for gap in capped:
        # Each gap already commits its own ledger row and governance event, so
        # a bare loop would leave the earlier gaps' writes on disk while the
        # hook reported nothing but a wholesale failure — side effects landed,
        # accounting lost.
        guard_item(
            item_failures,
            item_kind="capability_gap",
            item_id=str(gap.get("gap_id") or gap.get("capability_gap_key") or ""),
            work=lambda gap=gap: _emit_genesis_for_gap(
                gap,
                cycle_id=cycle_id,
                tools_root=tools_root,
                requests_emitted=requests_emitted,
                extension_audit_rows=extension_audit_rows,
            ),
        )
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "policy": policy,
        "actionable_gap_count": len(actionable),
        "skipped_already_requested": len(actionable) - len(fresh),
        "capped_count": max(0, len(fresh) - len(capped)),
        "requested_count": len(requests_emitted),
        "extension_audit_count": len(extension_audit_rows),
        "requests": requests_emitted,
    }, item_failures)


def _emit_genesis_for_gap(
    gap: dict[str, Any],
    *,
    cycle_id: str,
    tools_root: Path,
    requests_emitted: list[dict[str, Any]],
    extension_audit_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Route one capability gap to its genesis surface."""
    gap_type = str(gap.get("gap_type") or "")
    if gap_type == "existing_agent_extension":
        row = record_extension_decision(gap, base_dir=tools_root, cycle_id=cycle_id)
        extension_audit_rows.append(row)
        append_tools_governance(
            tools_root,
            "genesis_extension_recorded",
            {"cycle_id": cycle_id, "gap_id": gap.get("gap_id"), "capability_gap_key": gap.get("capability_gap_key")},
        )
        return row
    if gap_type in ("skill_gap", "unobserved_surface"):
        # Plan 026R §E.9 — skill_gap routes to skill_genesis, NOT
        # agent_genesis. Pre-§E.9 every non-extension gap fell to
        # the request_agent_genesis branch; a skill_gap silently
        # spawned an agent_genesis request (wrong target).
        #
        # H-3 — unobserved_surface joins it, and for a sharper reason. A root
        # no adapter can parse is missing a READER, not a REVIEWER: minting
        # a review agent leaves declared_scope untouched, so the next night
        # measures the identical blindness and the gap can never close.
        # request_skill_genesis is the surface that authors tool adapters
        # (the same one the F-012 adapter seeds feed), so it is the only
        # genesis on this router that can move observed_ratio.
        from .skill_genesis import request_skill_genesis
        row = request_skill_genesis(
            capability_gap_key=str(gap.get("capability_gap_key") or ""),
            title=str(gap.get("title") or gap.get("summary") or "skill"),
            base_dir=tools_root,
        )
        requests_emitted.append(row)
        append_tools_governance(
            tools_root,
            "skill_genesis_request_emitted",
            {
                "cycle_id": cycle_id,
                "gap_id": gap.get("gap_id"),
                "capability_gap_key": gap.get("capability_gap_key"),
                # WHY the type is on the event: both branches land in one
                # ledger kind, and "we asked for an adapter because we are
                # blind here" reads differently from "we asked for a skill".
                "gap_type": gap_type,
            },
        )
        return row
    row = request_agent_genesis(gap, base_dir=tools_root, cycle_id=cycle_id)
    requests_emitted.append(row)
    append_tools_governance(
        tools_root,
        "genesis_request_emitted",
        {"cycle_id": cycle_id, "gap_id": gap.get("gap_id"), "capability_gap_key": gap.get("capability_gap_key")},
    )
    return row


def recompute_pressure_decay(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    thresholds = load_decay_thresholds(paths)
    records = effective_workspace_pressures(paths, now=now, decay_thresholds=thresholds)
    transitions: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    for record in records:
        pressure_event_id = str(record.get("event_id") or record.get("pressure_id") or "")
        if not pressure_event_id:
            continue
        explicit_state = _explicit_state(record)
        if explicit_state in TERMINAL_STATES:
            continue
        target_state = str(record.get("decay_state") or "active")
        if _state_rank(target_state) <= _state_rank(explicit_state):
            continue
        # A bare loop here loses the `pressure_decayed` governance event for
        # transitions ALREADY appended to the ledger, so the decay telemetry
        # undercounts state changes that genuinely happened.
        ok, transition = guard_item(
            item_failures,
            item_kind="pressure",
            item_id=pressure_event_id,
            work=lambda record=record, target_state=target_state: append_pressure_state_event(
                paths,
                pressure=record,
                to_state=target_state,
                reason="decay_recompute",
                cycle_id=cycle_id,
                evidence_refs=[],
                feedback_event_ids=[],
                details={
                    "last_evidence_at": record.get("last_evidence_at"),
                    "age_days": _age_days(str(record.get("last_evidence_at") or ""), now),
                    "decay_thresholds": thresholds,
                },
                now=now,
                decay_thresholds=thresholds,
            ),
        )
        if not ok or transition is None:
            continue
        if transition.get("ledger_hash"):
            transitions.append(
                {
                    "pressure_event_id": pressure_event_id,
                    "from_state": explicit_state,
                    "to_state": target_state,
                    "state_event_id": transition.get("event_id"),
                    "last_evidence_at": record.get("last_evidence_at"),
                    "age_days": _age_days(str(record.get("last_evidence_at") or ""), now),
                },
            )
    if transitions:
        record_workspace_governance(
            paths,
            "pressure_decayed",
            {"transitions": transitions, "total": len(records), "cycle_id": cycle_id},
        )
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "thresholds": thresholds,
        "transition_count": len(transitions),
        "total": len(records),
        "transitions": transitions,
    }, item_failures)


def load_decay_thresholds(paths: WorkspacePaths) -> dict[str, int]:
    config_path = paths.workspace_root / "aria-config" / "decay_thresholds.json"
    if not config_path.exists():
        return dict(DEFAULT_DECAY_THRESHOLDS)
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("decay_thresholds_must_be_object")
    raw = payload.get("thresholds") if isinstance(payload.get("thresholds"), dict) else payload
    thresholds = dict(DEFAULT_DECAY_THRESHOLDS)
    for state in ("faded", "sleeping", "archived"):
        if state in raw:
            thresholds[state] = _parse_day_value(raw[state], key=state)
    if not (thresholds["faded"] <= thresholds["sleeping"] <= thresholds["archived"]):
        raise ValueError("decay_thresholds_must_be_monotonic")
    return thresholds


def prune_cycle_artifacts(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    now: datetime | None = None,
    ttl_days: int = DEFAULT_ARTIFACT_TTL_DAYS,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    ttl = timedelta(days=ttl_days)
    archived: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    # One unmovable artifact — a permission, a cross-device rename, a file
    # deleted between the glob and the move — must not stop the prune for
    # every artifact after it, which is how a disk fills quietly.
    for artifact in sorted(paths.cycle_dir.glob("cyc-*.json")):
        if artifact.stem == cycle_id or not artifact.is_file():
            continue
        artifact_at = _timestamp_from_cycle_name(artifact.stem)
        if artifact_at is None or now - artifact_at < ttl:
            continue
        ok, row = guard_item(
            item_failures,
            item_kind="workspace_artifact",
            item_id=artifact.name,
            work=lambda artifact=artifact, artifact_at=artifact_at: _archive_workspace_artifact(
                paths, artifact, artifact_at, cycle_id,
            ),
        )
        if ok and row is not None:
            archived.append(row)
    if tools_root is not None:
        discovery_root = Path(tools_root) / "discovery"
        for artifact in sorted(discovery_root.iterdir()) if discovery_root.exists() else []:
            if artifact.name == cycle_id or not artifact.is_dir():
                continue
            artifact_at = _timestamp_from_cycle_name(artifact.name) or datetime.fromtimestamp(artifact.stat().st_mtime, timezone.utc)
            if now - artifact_at < ttl:
                continue
            ok, row = guard_item(
                item_failures,
                item_kind="tools_artifact",
                item_id=artifact.name,
                work=lambda artifact=artifact, artifact_at=artifact_at: _archive_tools_artifact(
                    Path(tools_root), artifact, artifact_at, cycle_id,
                ),
            )
            if ok and row is not None:
                archived.append(row)
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "ttl_days": ttl_days,
        "archived_count": len(archived),
        "archived": archived,
    }, item_failures)


def vocabulary_reload_check(paths: WorkspacePaths) -> dict[str, Any]:
    modes, metadata = load_failure_mode_vocabulary(paths)
    return {"schema_version": 1, "mode_count": len(modes), "metadata": metadata}


def _archive_workspace_artifact(paths: WorkspacePaths, artifact: Path, artifact_at: datetime, cycle_id: str) -> dict[str, Any]:
    archive_path = _archive_destination(paths.workspace_root, artifact, artifact_at)
    archive_path = _move_artifact(artifact, archive_path)
    details = _archive_details("workspace", artifact, archive_path, cycle_id)
    record_workspace_governance(paths, "cycle_artifact_archived", details)
    return details


def _archive_tools_artifact(tools_root: Path, artifact: Path, artifact_at: datetime, cycle_id: str) -> dict[str, Any]:
    archive_path = _archive_destination(tools_root, artifact, artifact_at)
    archive_path = _move_artifact(artifact, archive_path)
    details = _archive_details("tools", artifact, archive_path, cycle_id)
    append_tools_governance(tools_root, "cycle_artifact_archived", details)
    return details


def _archive_destination(root: Path, artifact: Path, artifact_at: datetime) -> Path:
    relative = artifact.relative_to(root)
    return root / ".archive" / str(artifact_at.year) / relative


def _move_artifact(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination = destination.with_name(f"{destination.name}.{int(datetime.now(timezone.utc).timestamp())}")
    shutil.move(str(source), str(destination))
    return destination


def _archive_details(scope: str, artifact: Path, archive_path: Path, cycle_id: str) -> dict[str, Any]:
    return {
        "scope": scope,
        "artifact_path": artifact.as_posix(),
        "archive_path": archive_path.as_posix(),
        "archived_at_cycle": cycle_id,
    }


def _explicit_state(record: dict[str, Any]) -> str:
    history = record.get("state_history")
    if isinstance(history, list) and history:
        latest = history[-1]
        if isinstance(latest, dict) and isinstance(latest.get("to_state"), str):
            return latest["to_state"]
    return "active"


def _state_rank(state: str) -> int:
    ranks = {"active": 0, "faded": 1, "sleeping": 2, "archived": 3}
    return ranks.get(state, 0)


def _parse_day_value(value: Any, *, key: str) -> int:
    if isinstance(value, str):
        raw = value.strip().lower()
        if raw.endswith("d"):
            raw = raw[:-1]
        value = raw
    try:
        days = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"decay_threshold_invalid:{key}") from exc
    if days < 0:
        raise ValueError(f"decay_threshold_invalid:{key}")
    return days


def _timestamp_from_cycle_name(name: str) -> datetime | None:
    if not name.startswith("cyc-"):
        return None
    try:
        return datetime.strptime(name, "cyc-%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _age_days(value: str, now: datetime) -> int:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, (now - parsed.astimezone(timezone.utc)).days)


def _hook_failure_details(hook_name: str, exc: Exception) -> dict[str, Any]:
    return {
        "hook_name": hook_name,
        "error_class": exc.__class__.__name__,
        "error_message": str(exc),
        "traceback_first_line": (traceback.format_exception_only(type(exc), exc)[-1].strip() if exc else None),
    }
