from __future__ import annotations

import json
import fnmatch
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .feedback_store import load_feedback
from .snapshot import file_counts_from_payload
from .tool_health import runs_path
from .tool_registry import GovernanceError, ensure_tools_dir, load_registry, utc_now

SELF_OUTPUT_PREFIXES = ("aria-tools/", "agent-workspace/", ".aria-poc/")
MEMORY_KINDS = ("beliefs", "observations", "uncertainties", "contradictions", "calibration", "learning-events")
BELIEF_STATUSES = ("supported", "contradicted", "needs_revalidation", "stale", "withdrawn")
STALE_AFTER_REVALIDATION_CYCLES = 3


def update_memory(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    include_discovery_beliefs: bool = True,
    include_tool_candidates: bool = True,
) -> dict[str, Any]:
    """Update memory ledgers (observations + beliefs + ...).

    Plan 026R §A.4 — frozen-profile gate at function entry via the
    ``observation`` surface_kind. The observation row at line 54 + every
    downstream belief append are observation-class writes that the
    Plan 020 SCOPED no-write invariant now covers under frozen.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("observation", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fingerprint = _read_json(discovery_dir / "REPO_FINGERPRINT.json")
    completion = _read_json(discovery_dir / "COMPLETION_PROOF.json")
    diff = _read_json(root / "cycle-diff" / f"{cycle_id}.json")
    fates = _read_json(discovery_dir / "FATES.json")
    observations_written = 0
    if include_discovery_beliefs:
        repo_state = _repo_state(root, cycle_id)
        file_counts = file_counts_from_payload(fingerprint)
        observation = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "repo_state_id": repo_state.get("repo_state_id"),
            "base_commit_sha": repo_state.get("base_commit_sha"),
            "kind": "repo_fingerprint",
            "file_counts": file_counts,
            "tracked_file_count": fingerprint.get("tracked_file_count", 0),
            "legacy_tracked_file_count": fingerprint.get("legacy_tracked_file_count", fingerprint.get("tracked_file_count", 0)),
            "service_count": fingerprint.get("service_count", 0),
            "web_module_count": fingerprint.get("web_module_count", 0),
            "migration_count": fingerprint.get("migration_count", 0),
            "complete_discovery": completion.get("complete") is True,
            "cycle_diff": diff.get("summary", {}),
            "evidence": ["package.json"] if fingerprint.get("has_package_json") else [],
        }
        append_jsonl(root / "memory" / "observations.jsonl", observation)
        observations_written = 1

    beliefs_written = _apply_diff_to_existing_beliefs(root, cycle_id, diff, fates) if include_discovery_beliefs else 0
    if include_discovery_beliefs and fingerprint.get("has_nx"):
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-uses-nx",
            claim="repository uses Nx workspace orchestration",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )
        beliefs_written += 1
    if include_discovery_beliefs and fingerprint.get("has_package_json"):
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-has-node-package-manifest",
            claim="repository exposes Node workspace metadata through package.json",
            evidence_refs=["package.json"],
            confidence=1.0,
        )
        beliefs_written += 1
    if include_discovery_beliefs and int(fingerprint.get("migration_count") or 0) >= 5:
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-has-recurring-typeorm-migration-surface",
            claim="repository has a recurring TypeORM migration surface that merits drift checks",
            evidence_refs=["apps/*/src/database/migrations/*.ts"],
            confidence=0.85,
        )
        beliefs_written += 1
    if include_tool_candidates:
        quarantined_tool_ids = _quarantined_tool_ids(root)
        beliefs_written += _mark_quarantined_source_beliefs(root, cycle_id, quarantined_tool_ids)
        beliefs_written += _ingest_memory_candidates(root, cycle_id, quarantined_tool_ids)
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "observations_written": observations_written,
        "beliefs_written": beliefs_written,
    }


def list_memory(
    *,
    kind: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    if kind not in MEMORY_KINDS:
        raise ValueError(f"unknown memory kind: {kind}")
    rows = load_jsonl(ensure_tools_dir(base_dir) / "memory" / f"{kind}.jsonl")
    if kind == "beliefs":
        return latest_beliefs(rows)
    return rows


def withdraw_belief(
    *,
    belief_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not belief_id.strip() or not reason.strip():
        raise GovernanceError("belief_id and reason are required")
    root = ensure_tools_dir(base_dir)
    existing = _latest_belief(root, belief_id)
    if existing is None:
        raise GovernanceError(f"belief not found: {belief_id}")
    row = dict(existing)
    row.update(
        {
            "recorded_at": utc_now(),
            "updated_at": utc_now(),
            "status": "withdrawn",
            "withdrawn_at": utc_now(),
            "withdrawn_reason": reason,
        },
    )
    append_jsonl(root / "memory" / "beliefs.jsonl", row)
    return row


def unwithdraw_belief(
    *,
    belief_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not belief_id.strip() or not reason.strip():
        raise GovernanceError("belief_id and reason are required")
    root = ensure_tools_dir(base_dir)
    existing = _latest_belief(root, belief_id)
    if existing is None:
        raise GovernanceError(f"belief not found: {belief_id}")
    if existing.get("status") != "withdrawn":
        raise GovernanceError(f"belief is not withdrawn: {belief_id}")
    row = dict(existing)
    row.update(
        {
            "recorded_at": utc_now(),
            "updated_at": utc_now(),
            "status": "needs_revalidation",
            "unwithdrawn_at": utc_now(),
            "unwithdrawn_reason": reason,
            "needs_revalidation_cycles": 1,
        },
    )
    row.pop("withdrawn_at", None)
    row.pop("withdrawn_reason", None)
    append_jsonl(root / "memory" / "beliefs.jsonl", row)
    return row


def latest_beliefs(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        belief_id = str(row.get("belief_id") or "")
        if belief_id:
            latest[belief_id] = _normalize_belief(row)
    return sorted(latest.values(), key=lambda row: str(row.get("belief_id")))


def validate_repo_evidence(evidence_refs: list[str]) -> None:
    if not evidence_refs:
        raise GovernanceError("memory belief requires at least one repo evidence reference")
    for raw_ref in evidence_refs:
        ref = str(raw_ref).replace("\\", "/")
        while ref.startswith("./"):
            ref = ref[2:]
        if not ref.strip():
            raise GovernanceError("memory belief evidence reference must not be empty")
        if ref.startswith(SELF_OUTPUT_PREFIXES):
            raise GovernanceError("memory belief cannot use ARIA self-output as evidence")


def _record_belief(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    claim: str,
    evidence_refs: list[str],
    confidence: float,
    source_tool_ids: list[str] | None = None,
) -> dict[str, Any]:
    validate_repo_evidence(evidence_refs)
    existing = {
        str(row.get("belief_id")): row
        for row in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl"))
    }.get(belief_id)
    if existing and existing.get("status") == "withdrawn":
        return existing
    contradictions = _open_contradictions_for(root, belief_id)
    feedback_adjustment = _feedback_adjustment(root, belief_id)
    evidence_refs = sorted(set(evidence_refs))
    if not belief_id.strip() or not claim.strip():
        raise GovernanceError("memory candidate requires belief_id and claim")
    evidence_state = _evidence_state(root, evidence_refs, cycle_id)
    repo_state = _repo_state(root, cycle_id)
    support_count = int((existing or {}).get("support_count", 0)) + 1
    contradiction_count = len(contradictions)
    previous_confidence = float((existing or {}).get("confidence", confidence))
    base_confidence = previous_confidence if existing else confidence
    needs_revalidation_cycles = 0
    if evidence_state["missing_concrete_refs"] or evidence_state["empty_glob_refs"]:
        needs_revalidation_cycles = int((existing or {}).get("needs_revalidation_cycles", 0)) + 1
    next_confidence = _bounded_confidence(
        base_confidence
        + min(0.05, support_count * 0.005)
        + feedback_adjustment
        - needs_revalidation_cycles * 0.1
        - contradiction_count * 0.15,
    )
    status = "supported"
    if contradiction_count:
        status = "contradicted"
    if needs_revalidation_cycles:
        status = "needs_revalidation"
    if needs_revalidation_cycles >= STALE_AFTER_REVALIDATION_CYCLES:
        status = "stale"
    if next_confidence < 0.5 and status != "stale":
        status = "needs_revalidation"
    verification_status = "verified" if status == "supported" else status
    row = {
        "schema_version": 2,
        "recorded_at": utc_now(),
        "updated_at": utc_now(),
        "repo_state_id": repo_state.get("repo_state_id"),
        "base_commit_sha": repo_state.get("base_commit_sha"),
        "belief_id": belief_id,
        "claim": claim,
        "confidence": next_confidence,
        "status": status,
        "evidence_refs": evidence_refs,
        "first_seen_cycle": (existing or {}).get("first_seen_cycle", cycle_id),
        "last_seen_cycle": cycle_id,
        "support_count": support_count,
        "contradiction_count": contradiction_count,
        "needs_revalidation_cycles": needs_revalidation_cycles,
        "evidence_state": evidence_state,
        "evidence_hashes": _evidence_hashes(root, cycle_id, evidence_refs),
        "verification_status": verification_status,
        "verified_at": utc_now() if verification_status == "verified" else (existing or {}).get("verified_at"),
        "source_tool_ids": sorted(set(source_tool_ids or (existing or {}).get("source_tool_ids", []))),
        "glob_match_history": _next_glob_history(existing, cycle_id, evidence_state),
    }
    append_jsonl(root / "memory" / "beliefs.jsonl", row)
    _record_learning_event(
        root,
        cycle_id=cycle_id,
        event_type=_belief_event_type(existing, row),
        target_type="belief",
        target_id=belief_id,
        repo_state_id=repo_state.get("repo_state_id"),
        base_commit_sha=repo_state.get("base_commit_sha"),
        evidence_hashes=row["evidence_hashes"],
        details={"status": status, "confidence": next_confidence},
    )
    return row


def _normalize_belief(row: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(row)
    if "evidence_refs" not in normalized and "evidence" in normalized:
        evidence = normalized.get("evidence")
        normalized["evidence_refs"] = evidence if isinstance(evidence, list) else []
    normalized.setdefault("status", "supported")
    normalized.setdefault("first_seen_cycle", normalized.get("cycle_id"))
    normalized.setdefault("last_seen_cycle", normalized.get("cycle_id"))
    normalized.setdefault("support_count", 1)
    normalized.setdefault("contradiction_count", 0)
    normalized.setdefault("needs_revalidation_cycles", 0)
    normalized.setdefault("evidence_state", {})
    normalized.setdefault("glob_match_history", [])
    normalized.setdefault("source_tool_ids", [])
    normalized.setdefault("repo_state_id", normalized.get("cycle_id"))
    normalized.setdefault("base_commit_sha", None)
    normalized.setdefault("evidence_hashes", [])
    normalized.setdefault("verification_status", "verified" if normalized.get("status") == "supported" else normalized.get("status"))
    normalized.setdefault("verified_at", normalized.get("updated_at") if normalized.get("status") == "supported" else None)
    return normalized


def _apply_diff_to_existing_beliefs(root: Path, cycle_id: str, diff: dict[str, Any], fates: dict[str, Any]) -> int:
    affected_paths = set(_array_of_strings(diff.get("removed_paths"))) | set(_array_of_strings(diff.get("changed_paths")))
    current_paths = _fate_paths(fates)
    if not affected_paths and current_paths:
        affected_paths = set()
    if not affected_paths and not current_paths:
        return 0
    written = 0
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        if belief.get("status") == "withdrawn":
            continue
        refs = _array_of_strings(belief.get("evidence_refs"))
        concrete_refs = [ref for ref in refs if not _is_glob_ref(ref)]
        glob_refs = [ref for ref in refs if _is_glob_ref(ref)]
        missing_refs = sorted(
            ref for ref in concrete_refs if ref in affected_paths or (current_paths and ref not in current_paths)
        )
        empty_globs = sorted(ref for ref in glob_refs if _glob_match_count(ref, current_paths) == 0)
        if not missing_refs and not empty_globs:
            continue
        revalidation_cycles = int(belief.get("needs_revalidation_cycles", 0)) + 1
        status = "stale" if revalidation_cycles >= STALE_AFTER_REVALIDATION_CYCLES else "needs_revalidation"
        row = dict(belief)
        evidence_state = {
            "missing_concrete_refs": missing_refs,
            "empty_glob_refs": empty_globs,
            "glob_refs": glob_refs,
        }
        row.update(
            {
                "recorded_at": utc_now(),
                "updated_at": utc_now(),
                "last_seen_cycle": cycle_id,
                "status": status,
                "needs_revalidation_cycles": revalidation_cycles,
                "stale_reason": "evidence changed, disappeared, or glob no longer matches",
                "evidence_state": evidence_state,
                "verification_status": "needs_revalidation",
                "glob_match_history": _next_glob_history(belief, cycle_id, evidence_state, current_paths=current_paths),
            },
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        _record_learning_event(
            root,
            cycle_id=cycle_id,
            event_type="evidence_invalidated",
            target_type="belief",
            target_id=str(belief.get("belief_id")),
            repo_state_id=row.get("repo_state_id"),
            base_commit_sha=row.get("base_commit_sha"),
            evidence_hashes=_array_of_strings(row.get("evidence_hashes")),
            details={"affected_evidence_refs": missing_refs + empty_globs, "status": status},
        )
        _record_uncertainty(
            root,
            cycle_id=cycle_id,
            belief_id=str(belief.get("belief_id")),
            reason="belief evidence changed, disappeared, or glob no longer matches",
            evidence_refs=missing_refs + empty_globs,
        )
        written += 1
    return written


def _quarantined_tool_ids(root: Path) -> set[str]:
    return {
        str(tool.get("tool_id"))
        for tool in load_registry(root).get("tools", [])
        if tool.get("status") == "QUARANTINED" and str(tool.get("tool_id") or "").strip()
    }


def _mark_quarantined_source_beliefs(root: Path, cycle_id: str, quarantined_tool_ids: set[str]) -> int:
    if not quarantined_tool_ids:
        return 0
    written = 0
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        belief_id = str(belief.get("belief_id") or "")
        if belief.get("status") == "withdrawn" or not belief_id:
            continue
        matched_tool_ids = sorted(set(_array_of_strings(belief.get("source_tool_ids"))) & quarantined_tool_ids)
        if not matched_tool_ids:
            continue
        revalidation_cycles = int(belief.get("needs_revalidation_cycles", 0)) + 1
        previous_status = str(belief.get("status") or "supported")
        status = (
            "stale"
            if previous_status == "stale" or revalidation_cycles >= STALE_AFTER_REVALIDATION_CYCLES
            else "needs_revalidation"
        )
        row = dict(belief)
        row.update(
            {
                "recorded_at": utc_now(),
                "updated_at": utc_now(),
                "last_seen_cycle": cycle_id,
                "status": status,
                "needs_revalidation_cycles": revalidation_cycles,
                "revalidation_reason": "source tool is quarantined",
                "quarantined_source_tool_ids": matched_tool_ids,
            },
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        _record_uncertainty(
            root,
            cycle_id=cycle_id,
            belief_id=belief_id,
            reason="belief source tool is quarantined",
            evidence_refs=_array_of_strings(belief.get("evidence_refs")),
        )
        _record_calibration(
            root,
            cycle_id=cycle_id,
            belief_id=belief_id,
            source_tool_id=",".join(matched_tool_ids),
            reason="existing belief requires revalidation because its source tool is quarantined",
        )
        written += 1
    return written


def _ingest_memory_candidates(root: Path, cycle_id: str, quarantined_tool_ids: set[str] | None = None) -> int:
    quarantined_tool_ids = quarantined_tool_ids or set()
    written = 0
    for run in load_jsonl(runs_path(root)):
        if run.get("cycle_id") != cycle_id:
            continue
        for candidate in _array_of_dicts(run.get("memory_candidates")):
            try:
                source_tool_id = str(candidate.get("source_tool_id") or run.get("tool_id"))
                if source_tool_id in quarantined_tool_ids:
                    belief_id = str(candidate.get("belief_id", "<unknown>"))
                    _record_uncertainty(
                        root,
                        cycle_id=cycle_id,
                        belief_id=belief_id,
                        reason="memory candidate skipped because source tool is quarantined",
                        evidence_refs=_array_of_strings(candidate.get("evidence_refs")),
                    )
                    _record_calibration(
                        root,
                        cycle_id=cycle_id,
                        belief_id=belief_id,
                        source_tool_id=source_tool_id,
                        reason="quarantined source tool emitted a memory candidate",
                    )
                    continue
                existing = _latest_belief(root, str(candidate.get("belief_id", "")))
                if existing and existing.get("status") == "withdrawn":
                    _record_contradiction(
                        root,
                        cycle_id=cycle_id,
                        belief_id=str(candidate.get("belief_id", "")),
                        reason="withdrawn belief candidate re-emitted by adapter",
                        source_tool_id=source_tool_id,
                    )
                    continue
                _record_belief(
                    root,
                    cycle_id=cycle_id,
                    belief_id=str(candidate.get("belief_id", "")),
                    claim=str(candidate.get("claim", "")),
                    confidence=float(candidate.get("confidence", 0.5)),
                    evidence_refs=_array_of_strings(candidate.get("evidence_refs")),
                    source_tool_ids=[source_tool_id],
                )
                written += 1
            except (GovernanceError, TypeError, ValueError) as exc:
                _record_uncertainty(
                    root,
                    cycle_id=cycle_id,
                    belief_id=str(candidate.get("belief_id", "<unknown>")),
                    reason=f"memory candidate rejected: {exc}",
                    evidence_refs=_array_of_strings(candidate.get("evidence_refs")),
                )
    return written


def _record_uncertainty(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    reason: str,
    evidence_refs: list[str],
) -> None:
    append_jsonl(
        root / "memory" / "uncertainties.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "belief_id": belief_id,
            "reason": reason,
            "evidence_refs": evidence_refs,
            "status": "open",
        },
    )


def _record_contradiction(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    reason: str,
    source_tool_id: str,
) -> None:
    append_jsonl(
        root / "memory" / "contradictions.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "belief_id": belief_id,
            "reason": reason,
            "source_tool_id": source_tool_id,
            "status": "open",
        },
    )


def _record_calibration(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    source_tool_id: str,
    reason: str,
) -> None:
    append_jsonl(
        root / "memory" / "calibration.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "belief_id": belief_id,
            "source_tool_id": source_tool_id,
            "reason": reason,
            "status": "open",
        },
    )


def _record_learning_event(
    root: Path,
    *,
    cycle_id: str | None,
    event_type: str,
    target_type: str,
    target_id: str,
    repo_state_id: str | None,
    base_commit_sha: str | None,
    evidence_hashes: list[str],
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return append_jsonl(
        root / "memory" / "learning-events.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "event_type": event_type,
            "target_type": target_type,
            "target_id": target_id,
            "repo_state_id": repo_state_id,
            "base_commit_sha": base_commit_sha,
            "evidence_hashes": evidence_hashes,
            "details": details or {},
        },
    )


def _open_contradictions_for(root: Path, belief_id: str) -> list[dict[str, Any]]:
    return [
        row
        for row in load_jsonl(root / "memory" / "contradictions.jsonl")
        if row.get("status", "open") == "open" and row.get("belief_id") == belief_id
    ]


def _feedback_adjustment(root: Path, belief_id: str) -> float:
    """Apply feedback only through exact affected_belief_ids.

    Legacy rows are still loaded from operator-feedback.jsonl, but note/body
    substring matches are intentionally ignored to avoid broad confidence drift.
    """
    adjustment = 0.0
    for feedback in load_feedback(base_dir=root):
        affected = _array_of_strings(feedback.get("affected_belief_ids"))
        if belief_id not in affected:
            continue
        if feedback.get("verdict") == "true_positive":
            adjustment += 0.05
        elif feedback.get("verdict") == "false_positive":
            adjustment -= 0.2 if feedback.get("severity") == "critical" else 0.1
    return adjustment


def _bounded_confidence(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 3)


def _latest_belief(root: Path, belief_id: str) -> dict[str, Any] | None:
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        if belief.get("belief_id") == belief_id:
            return belief
    return None


def _evidence_state(root: Path, evidence_refs: list[str], cycle_id: str) -> dict[str, Any]:
    concrete_refs = [ref for ref in evidence_refs if not _is_glob_ref(ref)]
    glob_refs = [ref for ref in evidence_refs if _is_glob_ref(ref)]
    fates = _read_json(root / "discovery" / cycle_id / "FATES.json")
    current_paths = _fate_paths(fates)
    glob_counts = {ref: _glob_match_count(ref, current_paths) for ref in glob_refs}
    return {
        "missing_concrete_refs": sorted(ref for ref in concrete_refs if current_paths and ref not in current_paths),
        "concrete_refs": concrete_refs,
        "glob_refs": glob_refs,
        "glob_match_counts": glob_counts,
        "empty_glob_refs": sorted(ref for ref, count in glob_counts.items() if count == 0),
    }


def _repo_state(root: Path, cycle_id: str) -> dict[str, Any]:
    completion = _read_json(root / "discovery" / cycle_id / "COMPLETION_PROOF.json")
    return {
        "repo_state_id": completion.get("repo_state_id") or f"cycle:{cycle_id}",
        "base_commit_sha": completion.get("base_commit_sha"),
    }


def _evidence_hashes(root: Path, cycle_id: str, evidence_refs: list[str]) -> list[str]:
    fates = _read_json(root / "discovery" / cycle_id / "FATES.json")
    files = fates.get("files", [])
    by_path = {
        str(row.get("path")): str(row.get("content_hash"))
        for row in files
        if isinstance(row, dict) and isinstance(row.get("path"), str) and isinstance(row.get("content_hash"), str)
    } if isinstance(files, list) else {}
    hashes: set[str] = set()
    for ref in evidence_refs:
        if _is_glob_ref(ref):
            hashes.update(content_hash for path, content_hash in by_path.items() if fnmatch.fnmatch(path, ref))
        elif ref in by_path:
            hashes.add(by_path[ref])
    return sorted(hashes)


def _belief_event_type(existing: dict[str, Any] | None, row: dict[str, Any]) -> str:
    if existing is None:
        return "belief_proposed"
    if existing.get("status") != row.get("status") or existing.get("claim") != row.get("claim"):
        return "belief_corrected"
    if row.get("status") == "supported":
        return "belief_confirmed"
    return "belief_proposed"


def _is_glob_ref(ref: str) -> bool:
    return any(marker in ref for marker in ("*", "?", "["))


def _fate_paths(fates: dict[str, Any]) -> list[str]:
    files = fates.get("files", [])
    if not isinstance(files, list):
        return []
    return sorted(str(row.get("path")) for row in files if isinstance(row, dict) and isinstance(row.get("path"), str))


def _glob_match_count(pattern: str, paths: list[str]) -> int:
    return sum(1 for path in paths if fnmatch.fnmatch(path, pattern))


def _next_glob_history(
    existing: dict[str, Any] | None,
    cycle_id: str,
    evidence_state: dict[str, Any],
    *,
    current_paths: list[str] | None = None,
) -> list[dict[str, Any]]:
    history = list((existing or {}).get("glob_match_history", []))
    counts = evidence_state.get("glob_match_counts")
    if not isinstance(counts, dict):
        paths = current_paths or []
        counts = {ref: _glob_match_count(ref, paths) for ref in _array_of_strings(evidence_state.get("glob_refs"))}
    for ref, count in sorted(counts.items()):
        history.append({"cycle_id": cycle_id, "evidence_ref": ref, "match_count": count})
    return history[-20:]


def _array_of_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]


def _array_of_dicts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
