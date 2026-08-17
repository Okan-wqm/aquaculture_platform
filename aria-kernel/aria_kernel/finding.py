"""Operator-facing finding document writer for ARIA (Plan 016 Faz A2, CONTRACTS §6).

Two-layer model — this module is the OPERATOR-FACING layer:

1. Kernel ledger (existing — `feedback_store.py`):
   `aria-tools/findings.jsonl` records every adapter run's emitted findings
   plus operator feedback (TP/FP). Append-only, hash-chained, per-run scope.

2. Operator-facing committed document (this module):
   `aria-findings/F-*.json` is the human-and-CI readable record per CONTRACTS
   §6 schema (claim_type allowlist, severity floor, evidence floor, banned-
   phrase gate, traceability to originating run / pressure event).

Promotion path: `emit_finding` consumes either a kernel ledger entry, a
pressure event, or a manual operator trigger. The originating linkage is
preserved via `originating_run_id` / `originating_pressure_event_id` so the
operator-facing record can always be traced back to the kernel ledger.

Distinct from `report_ingestion`: that module imports findings produced by
external PR review agents into ARIA's belief graph. This module emits
findings ARIA's own adapters / skills / operator triggers create.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .agent_genesis import BANNED_PHRASES
from .diagnostics import emit_ledger_corruption_diagnostic
from .evidence_trust import classify_evidence_ref
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding


SEVERITIES = ("HIGH", "MEDIUM", "LOW", "INFORMATIONAL")
STATUSES = ("OPEN", "IN_PROGRESS", "RESOLVED", "SUPPRESSED", "WITHDRAWN")
# E21-c (ORPHAN-693) — İ2 decision, measured 2026-08-16: SUSPECTED /
# UNCERTAIN / UNKNOWN had ZERO producers (every emitter passes OBSERVED or
# nothing; no CLI flag exposes certainty), so three of five members were a
# dead dictionary — input vocabulary nothing could ever utter. They are
# REMOVED, not kept "just in case": a future lower-confidence producer
# re-adds its member in the same PR that adds the producer. CONFIRMED gains
# its first real producer here (record_finding_reproduction — an experiment
# that re-runs the defect deterministically), which is the whole point of
# the Deney Masası: certainty is EARNED by reproduction, not asserted.
CERTAINTIES = ("CONFIRMED", "OBSERVED")

# E21-c — closed finding-event vocabulary. The replay fold REFUSES an
# unknown event type instead of skipping it: pre-E21-c the fold silently
# skipped everything but finding_emitted, which is exactly how a
# reproduction event would have been invisible data loss. A closed set
# makes the next new event type a deliberate schema decision, not a row
# that vanishes on read.
FINDING_EVENT_TYPES = (
    "finding_emitted",
    "finding_reproduced",
    "finding_fix_verified",
    "finding_status_changed",
)

# E21-c — status transition map for operator/status events. RESOLVED and
# WITHDRAWN are terminal; SUPPRESSED can be reopened. finding_fix_verified
# is NOT routed through this map — its proof obligations (a matched green
# re-run of the same recipe that reproduced the defect) are stronger than
# any hand transition, and it lands directly on RESOLVED.
STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "OPEN": frozenset({"IN_PROGRESS", "SUPPRESSED", "WITHDRAWN"}),
    "IN_PROGRESS": frozenset({"OPEN", "RESOLVED", "SUPPRESSED", "WITHDRAWN"}),
    "SUPPRESSED": frozenset({"OPEN"}),
    "RESOLVED": frozenset(),
    "WITHDRAWN": frozenset(),
}

# Per CONTRACTS §6 claim_type allowlist with severity floor + min evidence count.
CLAIM_TYPES: dict[str, dict[str, Any]] = {
    "spine_drift": {"min_severity": "MEDIUM", "min_evidence": 2},
    "naming_drift": {"min_severity": "LOW", "min_evidence": 2},
    "convention_inconsistency": {"min_severity": "LOW", "min_evidence": 3},
    "wrong_code": {"min_severity": "MEDIUM", "min_evidence": 1},
    "absence_in_scope": {"min_severity": "INFORMATIONAL", "min_evidence": 1},
    "currency_gap": {"min_severity": "INFORMATIONAL", "min_evidence": 1},
    "duplication": {"min_severity": "LOW", "min_evidence": 3},
    "contradiction": {"min_severity": "MEDIUM", "min_evidence": 2},
    "test_disagreement": {"min_severity": "MEDIUM", "min_evidence": 1},
    "regression": {"min_severity": "HIGH", "min_evidence": 2},
    # V10.5 Phase 1 (per ADR-0002) — runtime state-machine anomaly observed
    # by ARIA-Watchdog. Semantically distinct from convention_inconsistency
    # (which is naming/format drift in code surface); operational_anomaly
    # is for stall / bridge_warning_repeat / rejection_repeat / phase_asymmetry
    # patterns detected at runtime.
    "operational_anomaly": {"min_severity": "LOW", "min_evidence": 3},
}

# V10.5 Phase 1 (per ADR-0002 + AISAFETY-HIGH-008) — closed allowlist for
# originating_skill field. emit_finding rejects unknown values to prevent
# external callers (e.g. report_ingestion) from forging "aria-watchdog:*"
# prefix and bypassing topology guards in the V10.6 self-feed source.
ORIGINATING_SKILL_ALLOWLIST: frozenset[str] = frozenset({
    "manual:operator",
    "aria-watchdog:stall",
    "aria-watchdog:bridge_warning_repeat",
    "report_ingestion:external_pr",
    # Kapalı Döngü D3 (ORPHAN-CRITICAL-642) — the judgment pipeline's own
    # origin: an ai_consensus true_positive promoted by finding_promotion.
    # Before this entry existed, NO code path could turn an accepted
    # consensus into a durable finding — the loop was "find → judge →
    # forget" by construction.
    "ai_consensus:judgment_pipeline",
    # Sabah treni (ORPHAN-702) — the drift seeder graduates from its own
    # file format to the ONE mint path; this is its registered origin.
    "seed:drift-scan",
    # V10.6 detectors registered here when F-AUTO-V10.6-EXTRA-DETECTORS lands:
    # "aria-watchdog:rejection_repeat",
    # "aria-watchdog:phase_asymmetry",
})

SEVERITY_RANK = {"INFORMATIONAL": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
SCHEMA_VERSION = 1
FINDING_ID_RE = re.compile(r"^F-\d{3,}$")


def findings_dir(repo_root: str | Path) -> Path:
    """SSoT for where committed findings live (Kapalı Döngü D3).

    Resolved through the one seam so findings survive the runner — see
    workspace.repo_state_root for why they did not. PUBLIC because the
    reader (reflection) used to rebuild this path by hand as
    `repo_root / "aria-findings"`, which diverges whenever
    ARIA_REPO_STATE_ROOT redirects the store: the writer wrote where the
    reader never looked, and the report said "no committed findings yet"
    over a directory that existed elsewhere.
    """
    from .workspace import repo_state_root

    return repo_state_root(Path(repo_root)) / "aria-findings"


def _findings_dir(repo_root: Path) -> Path:
    return findings_dir(repo_root)


def _index_path(repo_root: Path) -> Path:
    return _findings_dir(repo_root) / "_index.json"


def _events_path(repo_root: Path) -> Path:
    return _findings_dir(repo_root) / "finding-events.jsonl"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _evidence_chain_id(evidences: list[dict[str, Any]]) -> str:
    """Stable hash over the canonical evidence tuple — used to dedupe findings."""
    canonical = json.dumps(
        [{"ref": e["ref"], "summary": e.get("summary", "")} for e in evidences],
        sort_keys=True,
        separators=(",", ":"),
    )
    return "chain_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _check_banned_phrases(text: str, *, field: str) -> None:
    """Reject any banned-phrase substring (case-insensitive) per CLAUDE.md."""
    lowered = text.lower()
    for phrase in BANNED_PHRASES:
        if phrase in lowered:
            raise GovernanceError(
                f"finding {field} contains banned phrase '{phrase}': {text!r}"
            )


def _allocate_finding_id(repo_root: Path) -> str:
    """Allocate the next zero-padded sequential ID from the event ledger."""
    existing: list[str] = []
    for event in load_declared_jsonl(_events_path(repo_root), expected_surface="repo_finding_events"):
        finding_id = str(event.get("finding_id") or "")
        if event.get("event") == "finding_emitted" and FINDING_ID_RE.match(finding_id):
            existing.append(finding_id)
    if not existing:
        return "F-001"
    last_num = max(int(finding_id.split("-", 1)[1]) for finding_id in existing)
    return f"F-{last_num + 1:03d}"


def _validate_originating_skill(originating_skill: str) -> None:
    """V10.5 Phase 1 (AISAFETY-HIGH-008 + ADR-0002) — closed-allowlist check.

    Rejects originating_skill values outside ORIGINATING_SKILL_ALLOWLIST so
    external callers cannot forge an "aria-watchdog:*" prefix and bypass
    V10.6 self-feed topology guards.
    """
    if originating_skill not in ORIGINATING_SKILL_ALLOWLIST:
        raise GovernanceError(
            f"originating_skill {originating_skill!r} not in "
            f"ORIGINATING_SKILL_ALLOWLIST (V10.5 ADR-0002). Allowed values: "
            f"{sorted(ORIGINATING_SKILL_ALLOWLIST)!r}"
        )


def _validate_inputs(
    *,
    claim_type: str,
    severity: str,
    status: str,
    certainty: str,
    evidences: list[dict[str, Any]],
    claim_summary: str,
    facts: list[str],
    interpretations: list[dict[str, Any]] | None,
) -> None:
    if claim_type not in CLAIM_TYPES:
        raise GovernanceError(f"unknown claim_type: {claim_type}")
    if severity not in SEVERITIES:
        raise GovernanceError(f"invalid severity: {severity}")
    if status not in STATUSES:
        raise GovernanceError(f"invalid status: {status}")
    if certainty not in CERTAINTIES:
        raise GovernanceError(f"invalid certainty: {certainty}")
    floor = CLAIM_TYPES[claim_type]["min_severity"]
    if SEVERITY_RANK.get(severity, -1) < SEVERITY_RANK.get(floor, 0):
        raise GovernanceError(
            f"severity {severity} below floor {floor} for claim_type {claim_type}"
        )
    min_ev = CLAIM_TYPES[claim_type]["min_evidence"]
    if len(evidences) < min_ev:
        raise GovernanceError(
            f"claim_type {claim_type} requires >={min_ev} evidence(s), got {len(evidences)}"
        )
    for idx, ev in enumerate(evidences):
        if "ref" not in ev:
            raise GovernanceError(f"evidence[{idx}] missing 'ref'")
    _check_banned_phrases(claim_summary, field="claim_summary")
    for fact in facts:
        _check_banned_phrases(fact, field="facts[]")
    for entry in interpretations or []:
        text = entry.get("text", "")
        if text:
            _check_banned_phrases(text, field="interpretations[].text")


def _target_sha(repo_root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise GovernanceError("finding_evidence_target_sha_unavailable")
    return completed.stdout.strip()


def _normalize_evidences(
    repo_root: Path,
    evidences: list[dict[str, Any]],
    *,
    target_sha: str,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for ev in evidences:
        row = dict(ev)
        envelope = classify_evidence_ref(
            row.get("ref"),
            workspace_root=repo_root,
            source_hint="repo_source",
            context="finding",
            target_sha=target_sha,
        )
        if envelope.self_output_class == "aria_self_output":
            raise GovernanceError(
                f"finding evidence cannot cite ARIA self-output: {row.get('ref')!r}"
            )
        if envelope.trust_grade != "repo_verified":
            raise GovernanceError(
                "finding evidence must be repo_verified at target_sha: "
                f"ref={row.get('ref')!r} trust_grade={envelope.trust_grade!r} "
                f"errors={envelope.validation_errors!r}"
            )
        row["evidence_envelope"] = envelope.to_dict()
        normalized.append(row)
    return normalized


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _refresh_index(
    repo_root: Path,
    *,
    on_corruption: str = "advisory",
) -> dict[str, Any]:
    """Rebuild the finding index from the canonical event ledger only."""
    if on_corruption not in {"strict", "advisory"}:
        raise GovernanceError(
            f"refresh_index_invalid_on_corruption_mode: "
            f"{on_corruption!r} (must be 'strict' or 'advisory')"
        )
    rows: list[dict[str, Any]] = []
    replayed = _replay_findings(repo_root)
    event_rows = load_declared_jsonl(_events_path(repo_root), expected_surface="repo_finding_events")
    source_tip = event_rows[-1].get("ledger_hash") if event_rows else None
    for finding_id in sorted(replayed):
        doc = replayed[finding_id]
        rows.append(
            {
                "finding_id": doc.get("finding_id"),
                "severity": doc.get("severity"),
                "status": doc.get("status"),
                "claim_type": doc.get("claim_type"),
                "claim_summary": doc.get("claim_summary"),
                "evidence_chain_id": doc.get("evidence_chain_id"),
                "created_at": doc.get("created_at"),
                "path": f"{finding_id}.json",
                "source_event_id": doc.get("source_event_id"),
                "source_ledger_hash": doc.get("source_ledger_hash"),
            }
        )
    index: dict[str, Any] = {
        "schema_version": 2,
        "generated_at": _utc_now(),
        # E21-d audit catch (ORPHAN-693) — same class as the governance-path
        # fix in emit_finding: under ARIA_REPO_STATE_ROOT the events ledger
        # lives outside the repo tree; relative to the store that owns it.
        "source_ledger": _events_path(repo_root).relative_to(
            _findings_dir(repo_root).parent
        ).as_posix(),
        "source_ledger_tip_hash": source_tip,
        "findings": rows,
    }
    _atomic_write_json(_index_path(repo_root), index)
    return index


def emit_finding(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    claim_type: str,
    claim_summary: str,
    severity: str,
    certainty: str = "OBSERVED",
    evidences: list[dict[str, Any]],
    facts: list[str],
    scope_files: list[str],
    originating_skill: str = "manual:operator",
    originating_run_id: str | None = None,
    originating_pressure_event_id: str | None = None,
    interpretations: list[dict[str, Any]] | None = None,
    recommendation: dict[str, Any] | None = None,
    related_specialized_agent_domains: list[str] | None = None,
) -> dict[str, Any]:
    """Emit a hash-chained operator-facing finding.

    Why: Plan 016 Faz A2 closes the operator-visibility gap. Until a finding
    can land on disk under aria-findings/ + register a finding_emitted
    governance event, ARIA cycles produce raw observations the operator
    never sees. This primitive enforces every CONTRACTS §6 invariant
    (claim_type allowlist, severity floor, evidence count, banned-phrase
    gate) at emission time so daily reports can trust the record.

    Plan 026R §A.4 — frozen-profile gate at function entry. Pre-§A.4
    finding emission was a Plan 020 legacy mutator that frozen profile
    did NOT cover; an incident-response operator who froze the kernel
    could still have findings written into the audit trail. Now blocked
    under frozen via the ``finding`` surface_kind in
    PLAN_020_WRITE_SURFACES.
    """
    from .runtime_profile import enforce_profile_for_write
    from .file_lock import with_exclusive_lock
    enforce_profile_for_write("finding", base_dir=base_dir)
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)

    # V10.5 Phase 1 (AISAFETY-HIGH-008 + ADR-0002) — originating_skill allowlist.
    _validate_originating_skill(originating_skill)

    _validate_inputs(
        claim_type=claim_type,
        severity=severity,
        status="OPEN",
        certainty=certainty,
        evidences=evidences,
        claim_summary=claim_summary,
        facts=facts,
        interpretations=interpretations,
    )

    target_sha = _target_sha(repo_path)
    evidences = _normalize_evidences(repo_path, evidences, target_sha=target_sha)
    # E15-a — mint-time service dimension + specialist ownership. The
    # dimension comes from the paths the finding cites; the reviewing
    # agents come from the Lane-A touch-map SSoT (imported, not copied)
    # whenever the caller did not name them explicitly.
    from .service_dimension import (
        finding_dimension_paths,
        owning_agent_domains_for_paths,
        service_dimension,
    )

    dimension_paths = finding_dimension_paths(
        {"evidences": evidences, "scope": {"files": list(scope_files)}}
    )
    dimension = service_dimension(dimension_paths)
    if not related_specialized_agent_domains:
        related_specialized_agent_domains = owning_agent_domains_for_paths(
            dimension_paths
        )
    findings_dir = _findings_dir(repo_path)
    findings_dir.mkdir(parents=True, exist_ok=True)
    alloc_lock_path = findings_dir / ".alloc.lock"
    chain_id = _evidence_chain_id(evidences)
    with with_exclusive_lock(alloc_lock_path, timeout_seconds=5.0):
        finding_id = _allocate_finding_id(repo_path)
        record = {
            "$schema": "aria/finding/v1",
            "finding_id": finding_id,
            "severity": severity,
            "status": "OPEN",
            "claim_type": claim_type,
            "claim_summary": claim_summary,
            "certainty": certainty,
            "evidence_chain_id": chain_id,
            "evidences": evidences,
            "originating_skill": originating_skill,
            "originating_run_id": originating_run_id,
            "originating_pressure_event_id": originating_pressure_event_id,
            "scope": {"files": list(scope_files)},
            "service": dimension["service"],
            "services": dimension["services"],
            "related_specialized_agent_domains": list(related_specialized_agent_domains or []),
            "facts": list(facts),
            "interpretations": list(interpretations or []),
            "recommendation": recommendation,
            "created_at": _utc_now(),
            "closes_in_commit": None,
            "schema_version": SCHEMA_VERSION,
        }
        event = append_declared_jsonl(
            _events_path(repo_path),
            {
                "schema_version": 1,
                "event": "finding_emitted",
                "event_id": f"finding:{finding_id}:emitted",
                "finding_id": finding_id,
                "target_sha": target_sha,
                "record": record,
            },
            expected_surface="repo_finding_events",
        )
        record["source_event_id"] = event.get("event_id")
        record["source_ledger_hash"] = event.get("ledger_hash")
        output_path = _findings_dir(repo_path) / f"{finding_id}.json"
        if output_path.exists():
            raise GovernanceError(f"finding {finding_id} already exists at {output_path}")
        _atomic_write_json(output_path, record)
        _refresh_index(repo_path)

    append_tools_governance(
        tools_root,
        "finding_emitted",
        {
            "finding_id": finding_id,
            "severity": severity,
            "claim_type": claim_type,
            "evidence_chain_id": chain_id,
            "originating_skill": originating_skill,
            # E21-d audit catch (ORPHAN-693): under ARIA_REPO_STATE_ROOT the
            # finding store lives OUTSIDE the repo tree, and relative_to(repo)
            # raised ValueError — every emit_finding crashed the moment the
            # durable-store redirect was active. The path is relative to the
            # store that OWNS it (identical output when there is no redirect,
            # because repo_state_root(repo) == repo then).
            "path": output_path.relative_to(findings_dir.parent).as_posix(),
        },
    )
    return record


def list_findings(
    repo_root: str | Path,
    *,
    service: str | None = None,
) -> list[dict[str, Any]]:
    # E15-a — legacy docs carry no mint-time dimension; derive it at read
    # time from the same collector the mint uses, so a pre-E15 finding
    # filters identically to a post-E15 one.
    from .service_dimension import finding_dimension_paths, services_for_paths

    repo_path = Path(repo_root).resolve()
    rows: list[dict[str, Any]] = []
    for doc in _replay_findings(repo_path).values():
        services = doc.get("services") or services_for_paths(
            finding_dimension_paths(doc)
        )
        if service is not None and service not in services:
            continue
        rows.append(
            {
                "finding_id": doc.get("finding_id"),
                "severity": doc.get("severity"),
                "status": doc.get("status"),
                "claim_type": doc.get("claim_type"),
                "claim_summary": doc.get("claim_summary"),
                "evidence_chain_id": doc.get("evidence_chain_id"),
                "created_at": doc.get("created_at"),
                "path": f"{doc.get('finding_id')}.json",
                "source_ledger_hash": doc.get("source_ledger_hash"),
                "service": doc.get("service")
                or (services[0] if len(services) == 1 else None),
                "services": services,
            }
        )
    return rows


def show_finding(repo_root: str | Path, finding_id: str) -> dict[str, Any]:
    repo_path = Path(repo_root).resolve()
    if not FINDING_ID_RE.match(finding_id):
        raise GovernanceError(f"finding_id format invalid: {finding_id!r}")
    record = _replay_findings(repo_path).get(finding_id)
    if record is None:
        raise GovernanceError(f"finding {finding_id} not found")
    return record


def find_by_evidence_chain_id(repo_root: str | Path, chain_id: str) -> dict[str, Any] | None:
    """Helper for callers (e.g. debt.py) verifying originating_finding linkage."""
    for row in list_findings(repo_root):
        if row.get("evidence_chain_id") == chain_id:
            return show_finding(repo_root, row["finding_id"])
    return None


def _resolve_experiment_observation(
    *,
    finding_id: str,
    validation_run_id: str,
    base_dir: str | Path | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve (observation row, experiment row) for a finding-bound run.

    E21-c — the binding is DECLARED, not inferred: the experiment row must
    carry ``finding_ref == finding_id`` (set at registration). Without that
    check any matched observation could be stapled to any finding, and the
    certainty upgrade would be a claim about a coincidence.
    """
    from .experiment import get_experiment, list_experiment_observations

    observation: dict[str, Any] | None = None
    for row in list_experiment_observations(base_dir=base_dir):
        if row.get("validation_run_id") == validation_run_id:
            observation = row  # last row wins — re-recorded runs supersede
    if observation is None:
        raise GovernanceError(
            f"finding_experiment_observation_missing: no experiment "
            f"observation carries validation_run_id={validation_run_id!r}"
        )
    experiment = get_experiment(
        str(observation.get("experiment_id") or ""), base_dir=base_dir
    )
    if experiment.get("finding_ref") != finding_id:
        raise GovernanceError(
            f"finding_experiment_not_bound: experiment "
            f"{experiment.get('experiment_id')!r} declares "
            f"finding_ref={experiment.get('finding_ref')!r}, not {finding_id!r} — "
            f"bind the experiment at registration, do not staple observations"
        )
    if observation.get("matched") is not True:
        raise GovernanceError(
            f"finding_experiment_observation_unmatched: run "
            f"{validation_run_id!r} did not satisfy its observation contract; "
            f"an unmatched observation proves nothing about the hypothesis"
        )
    return observation, experiment


def _append_finding_event(
    repo_root: Path,
    event_row: dict[str, Any],
    *,
    governance_kind: str,
    governance_payload: dict[str, Any],
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """Single chokepoint for every non-mint finding event.

    Shares emit_finding's discipline: frozen-profile gate, the same
    ``.alloc.lock`` serialization, declared-surface append, governance echo.
    """
    from .runtime_profile import enforce_profile_for_write
    from .file_lock import with_exclusive_lock

    enforce_profile_for_write("finding", base_dir=base_dir)
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_root)
    findings_dir = _findings_dir(repo_root)
    findings_dir.mkdir(parents=True, exist_ok=True)
    with with_exclusive_lock(findings_dir / ".alloc.lock", timeout_seconds=5.0):
        stored = append_declared_jsonl(
            _events_path(repo_root), event_row,
            expected_surface="repo_finding_events",
        )
        _refresh_index(repo_root)
    append_tools_governance(tools_root, governance_kind, governance_payload)
    return stored


def record_finding_reproduction(
    repo_root: str | Path,
    *,
    finding_id: str,
    validation_run_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """E21-c (ORPHAN-693) — a red run of a bound recipe CONFIRMS the finding.

    Proof obligations, all structural:
      * the observation matched its contract (the run behaved as hypothesized)
      * the run itself FAILED — reproduction of a defect is a red run;
        a timeout is environment noise and is refused, not rounded to red
      * the experiment declares ``finding_ref`` == this finding

    This is the first (and only) producer of certainty=CONFIRMED: the top
    of the evidence hierarchy is re-production, not re-reading.
    """
    from .validation_runs_ledger import classify_validation_run_status

    repo_path = Path(repo_root).resolve()
    doc = _replay_findings(repo_path).get(finding_id)
    if doc is None:
        raise GovernanceError(f"finding {finding_id} not found")
    if doc.get("status") in ("RESOLVED", "WITHDRAWN"):
        raise GovernanceError(
            f"finding_reproduction_on_closed_finding: {finding_id} is "
            f"{doc.get('status')}; a defect that reproduces after resolution "
            f"is a REGRESSION and deserves a new finding with its own trail, "
            f"not a certainty edit on a closed one"
        )
    observation, experiment = _resolve_experiment_observation(
        finding_id=finding_id, validation_run_id=validation_run_id,
        base_dir=base_dir,
    )
    run_status = str(observation.get("run_status") or "")
    if run_status != "failed":
        raise GovernanceError(
            f"finding_reproduction_requires_red_run: run "
            f"{validation_run_id!r} ended {run_status!r}; only a failed run "
            f"demonstrates the defect (classify: "
            f"{classify_validation_run_status.__module__})"
        )
    event_row = {
        "schema_version": 1,
        "event": "finding_reproduced",
        "event_id": f"finding:{finding_id}:reproduced:{validation_run_id}",
        "finding_id": finding_id,
        "experiment_id": experiment.get("experiment_id"),
        "recipe_ref": experiment.get("recipe_ref"),
        "validation_run_id": validation_run_id,
        "observation_ledger_hash": observation.get("ledger_hash"),
        "run_status": run_status,
        "target_sha": _target_sha(repo_path),
        "recorded_at": _utc_now(),
    }
    return _append_finding_event(
        repo_path, event_row,
        governance_kind="finding_reproduced",
        governance_payload={
            "finding_id": finding_id,
            "experiment_id": experiment.get("experiment_id"),
            "recipe_ref": experiment.get("recipe_ref"),
            "validation_run_id": validation_run_id,
        },
        base_dir=base_dir,
    )


def record_finding_fix_verification(
    repo_root: str | Path,
    *,
    finding_id: str,
    validation_run_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """E21-c (ORPHAN-693) — the SAME recipe re-runs green, so the fix is real.

    Structural obligations:
      * a prior ``finding_reproduced`` event exists for this finding
      * the green run used the SAME recipe that reproduced the defect —
        a different recipe going green verifies nothing about this fix
      * the observation matched AND the run status is ``ok``

    The fold lands this directly on status=RESOLVED with
    ``closes_in_commit`` from the run's unforgeable provenance — RESOLVED
    gains its first producer whose proof is an executed experiment, not an
    assertion in a commit message.
    """
    repo_path = Path(repo_root).resolve()
    doc = _replay_findings(repo_path).get(finding_id)
    if doc is None:
        raise GovernanceError(f"finding {finding_id} not found")
    if doc.get("status") in ("RESOLVED", "WITHDRAWN"):
        raise GovernanceError(
            f"finding_fix_verification_on_closed_finding: {finding_id} is "
            f"already {doc.get('status')}"
        )
    reproduction = doc.get("reproduction")
    if not isinstance(reproduction, dict):
        raise GovernanceError(
            f"finding_fix_verification_requires_reproduction: {finding_id} "
            f"was never reproduced; verifying a fix against a defect that "
            f"never demonstrably ran red proves nothing"
        )
    observation, experiment = _resolve_experiment_observation(
        finding_id=finding_id, validation_run_id=validation_run_id,
        base_dir=base_dir,
    )
    if experiment.get("recipe_ref") != reproduction.get("recipe_ref"):
        raise GovernanceError(
            f"finding_fix_verification_recipe_mismatch: reproduction used "
            f"{reproduction.get('recipe_ref')!r}, verification ran "
            f"{experiment.get('recipe_ref')!r}; the fix experiment must "
            f"re-run the SAME recipe"
        )
    run_status = str(observation.get("run_status") or "")
    if run_status != "ok":
        raise GovernanceError(
            f"finding_fix_verification_requires_green_run: run "
            f"{validation_run_id!r} ended {run_status!r}"
        )
    event_row = {
        "schema_version": 1,
        "event": "finding_fix_verified",
        "event_id": f"finding:{finding_id}:fix_verified:{validation_run_id}",
        "finding_id": finding_id,
        "experiment_id": experiment.get("experiment_id"),
        "recipe_ref": experiment.get("recipe_ref"),
        "validation_run_id": validation_run_id,
        "observation_ledger_hash": observation.get("ledger_hash"),
        "commit_sha": observation.get("commit_sha"),
        "target_sha": _target_sha(repo_path),
        "recorded_at": _utc_now(),
    }
    return _append_finding_event(
        repo_path, event_row,
        governance_kind="finding_fix_verified",
        governance_payload={
            "finding_id": finding_id,
            "experiment_id": experiment.get("experiment_id"),
            "recipe_ref": experiment.get("recipe_ref"),
            "validation_run_id": validation_run_id,
            "commit_sha": observation.get("commit_sha"),
        },
        base_dir=base_dir,
    )


def record_finding_status_change(
    repo_root: str | Path,
    *,
    finding_id: str,
    to_status: str,
    reason: str,
    actor: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """E21-c (ORPHAN-693) — operator status transitions become event rows.

    STATUSES had readers (cycle_guard, debt, handoff) but NO writer could
    reach IN_PROGRESS / SUPPRESSED / WITHDRAWN through replay — a state
    machine whose states were unreachable. Transitions validate against
    STATUS_TRANSITIONS at append time; the fold trusts the ledger.
    """
    repo_path = Path(repo_root).resolve()
    if to_status not in STATUSES:
        raise GovernanceError(f"invalid status: {to_status}")
    if not isinstance(reason, str) or not reason.strip():
        raise GovernanceError("finding_status_change_reason_required")
    if not isinstance(actor, str) or not actor.strip():
        raise GovernanceError("finding_status_change_actor_required")
    _check_banned_phrases(reason, field="status_reason")
    doc = _replay_findings(repo_path).get(finding_id)
    if doc is None:
        raise GovernanceError(f"finding {finding_id} not found")
    current = str(doc.get("status") or "OPEN")
    allowed = STATUS_TRANSITIONS.get(current, frozenset())
    if to_status not in allowed:
        raise GovernanceError(
            f"finding_status_transition_invalid: {current} -> {to_status} "
            f"(allowed from {current}: {sorted(allowed) or 'none — terminal'})"
        )
    event_row = {
        "schema_version": 1,
        "event": "finding_status_changed",
        "event_id": f"finding:{finding_id}:status:{to_status}:{_utc_now()}",
        "finding_id": finding_id,
        "from_status": current,
        "to_status": to_status,
        "reason": reason,
        "actor": actor,
        "recorded_at": _utc_now(),
    }
    return _append_finding_event(
        repo_path, event_row,
        governance_kind="finding_status_changed",
        governance_payload={
            "finding_id": finding_id,
            "from_status": current,
            "to_status": to_status,
            "actor": actor,
        },
        base_dir=base_dir,
    )


def list_fix_verified_bindings(repo_root: str | Path) -> list[dict[str, Any]]:
    """E21-c — the permanent recipe↔finding bindings regression re-runs use.

    A recipe that turned green is NOT discarded (İ1): re-running it through
    the SAME experiment lane IS the regression fixture — no third fixture
    system. The nightly phase (E21-d) re-runs these; a binding that goes
    red again is a regression finding.
    """
    rows: list[dict[str, Any]] = []
    for doc in _replay_findings(Path(repo_root).resolve()).values():
        verification = doc.get("fix_verification")
        if isinstance(verification, dict):
            rows.append({
                "finding_id": doc.get("finding_id"),
                "recipe_ref": verification.get("recipe_ref"),
                "experiment_id": verification.get("experiment_id"),
                "evidence_chain_id": doc.get("evidence_chain_id"),
                "commit_sha": verification.get("commit_sha"),
                # E21-d — the regression re-runner resolves the original
                # observation (and through it the fix's change_id) by this id.
                "validation_run_id": verification.get("validation_run_id"),
            })
    return rows


def _replay_findings(repo_root: Path) -> dict[str, dict[str, Any]]:
    """Fold the event ledger into current finding state.

    E21-c (ORPHAN-693) — the fold speaks the FULL closed event vocabulary.
    Pre-E21-c it skipped everything but ``finding_emitted``, so a finding
    was frozen at mint forever: STATUSES had readers but no writer could
    ever reach them through replay. Now:

      * ``finding_reproduced``   → certainty CONFIRMED + reproduction proof
      * ``finding_fix_verified`` → status RESOLVED + closes_in_commit
      * ``finding_status_changed`` → operator transition (validated at
        append time against STATUS_TRANSITIONS)

    An UNKNOWN event type raises instead of skipping: silent skip is
    invisible data loss wearing a compatibility costume.
    """
    path = _events_path(repo_root)
    rows = load_declared_jsonl(path, expected_surface="repo_finding_events")
    findings: dict[str, dict[str, Any]] = {}
    for event in rows:
        event_type = str(event.get("event") or "")
        if event_type not in FINDING_EVENT_TYPES:
            raise GovernanceError(
                f"finding event type unknown: {event_type!r} "
                f"(allowed: {FINDING_EVENT_TYPES}) — a reader that skips "
                f"what it does not recognise loses data silently"
            )
        finding_id = str(event.get("finding_id") or "")
        if not FINDING_ID_RE.match(finding_id):
            raise GovernanceError(f"finding event has invalid finding_id: {finding_id!r}")
        if event_type == "finding_emitted":
            record = event.get("record")
            if not isinstance(record, dict):
                raise GovernanceError(f"finding event {event.get('event_id')!r} missing record")
            source_ledger_hash = event.get("ledger_hash")
            if not isinstance(source_ledger_hash, str) or not source_ledger_hash:
                raise GovernanceError(f"finding event {event.get('event_id')!r} missing ledger_hash")
            doc = dict(record)
            doc["source_event_id"] = event.get("event_id")
            doc["source_ledger_hash"] = source_ledger_hash
            findings[finding_id] = doc
            continue
        # Every non-mint event references a finding the ledger has already
        # emitted — append order guarantees it, so a miss is corruption.
        doc = findings.get(finding_id)
        if doc is None:
            raise GovernanceError(
                f"finding event {event.get('event_id')!r} references "
                f"{finding_id!r} before its finding_emitted row"
            )
        if event_type == "finding_reproduced":
            doc["certainty"] = "CONFIRMED"
            doc["reproduction"] = {
                "experiment_id": event.get("experiment_id"),
                "recipe_ref": event.get("recipe_ref"),
                "validation_run_id": event.get("validation_run_id"),
                "observation_ledger_hash": event.get("observation_ledger_hash"),
                "target_sha": event.get("target_sha"),
                "event_id": event.get("event_id"),
            }
        elif event_type == "finding_fix_verified":
            doc["status"] = "RESOLVED"
            doc["closes_in_commit"] = event.get("commit_sha")
            doc["fix_verification"] = {
                "experiment_id": event.get("experiment_id"),
                "recipe_ref": event.get("recipe_ref"),
                "validation_run_id": event.get("validation_run_id"),
                "observation_ledger_hash": event.get("observation_ledger_hash"),
                "commit_sha": event.get("commit_sha"),
                "event_id": event.get("event_id"),
            }
        elif event_type == "finding_status_changed":
            doc["status"] = event.get("to_status")
            doc["status_reason"] = event.get("reason")
            doc["status_actor"] = event.get("actor")
    return findings
