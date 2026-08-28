from __future__ import annotations

import json
import fnmatch
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .evidence_trust import EvidencePolicy, SELF_OUTPUT_PREFIXES, classify_evidence_ref
from .runs_reader import read_runs_rows
from .feedback_store import load_feedback
from .snapshot import file_counts_from_payload
from .tool_health import runs_path
from .tool_registry import GovernanceError, ensure_tools_dir, load_registry, utc_now

# Backwards-compatible import surface. The taxonomy itself lives in
# evidence_trust.py so memory, evidence validation, and tool health cannot drift.
MEMORY_KINDS = ("beliefs", "observations", "uncertainties", "contradictions", "calibration", "learning-events")
BELIEF_STATUSES = ("supported", "contradicted", "needs_revalidation", "stale", "withdrawn")
STALE_AFTER_REVALIDATION_CYCLES = 3
_MEMORY_SURFACE_BY_FILENAME = {
    "observations.jsonl": "memory_observations",
    "beliefs.jsonl": "memory_beliefs",
    "uncertainties.jsonl": "memory_uncertainties",
    "contradictions.jsonl": "memory_contradictions",
    "calibration.jsonl": "memory_calibration",
    "learning-events.jsonl": "memory_learning_events",
}


def append_jsonl(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    surface = _MEMORY_SURFACE_BY_FILENAME.get(path.name)
    if path.parent.name == "memory" and surface:
        return append_declared_jsonl(path, payload, expected_surface=surface)
    raise GovernanceError(f"memory_append_unknown_surface:{path.as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _MEMORY_SURFACE_BY_FILENAME.get(path.name)
    if path.parent.name == "memory" and surface:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"memory_load_unknown_surface:{path.as_posix()}")


def update_memory(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    include_discovery_beliefs: bool = True,
    include_tool_candidates: bool = True,
) -> dict[str, Any]:
    """Update memory ledgers (observations + beliefs + ...).

    Plan 026R §A.4 — frozen-profile gate at function entry via the
    ``observation`` surface_kind. The observation row at line 54 + every
    downstream belief append are observation-class writes that the
    Plan 020 SCOPED no-write invariant now covers under frozen.

    Plan ARIA-V2 §3.3 — FATES integrity verification now operates on
    the immutable snapshot (read from ``discovery/<cycle_id>/SNAPSHOT.json``
    alongside ``FATES.json``). The snapshot's ``base_commit_sha`` +
    ``snapshot_mode`` drive verification behavior:
      * ``committed`` mode → bytes read via ``git show <sha>:<path>``
        (immutable); mismatch raises ``memory_fates_content_hash_mismatch``.
      * ``working_tree`` mode → drift is expected operator-edit, NOT
        tamper. Emits ``memory_fates_working_tree_drift_observed``
        governance event; does not raise.
      * Legacy callers (no SNAPSHOT.json present) fall through to the
        pre-§3.3 disk-read behavior preserved for backward-compat.

    Pre-§3.3 behavior (Plan 026R §E.7 disk-read) is unchanged for
    workspaces that don't yet have a discovery/<cycle_id>/SNAPSHOT.json
    written alongside FATES.json — legacy ledgers continue to work.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("observation", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fingerprint = _read_json(discovery_dir / "REPO_FINGERPRINT.json")
    completion = _read_json(discovery_dir / "COMPLETION_PROOF.json")
    diff = _read_json(root / "cycle-diff" / f"{cycle_id}.json")
    fates = _read_json(discovery_dir / "FATES.json")
    snapshot_path = discovery_dir / "SNAPSHOT.json"
    snapshot = _read_json(snapshot_path) if snapshot_path.exists() else None
    if snapshot is not None or workspace_root is not None:
        _verify_fates_integrity(
            fates,
            snapshot=snapshot,
            workspace_root=workspace_root,
            base_dir=base_dir,
        )
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
            workspace_root=workspace_root,
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
            workspace_root=workspace_root,
        )
        beliefs_written += 1
    # Evidence_refs MUST be concrete, repo-verifiable paths (L1 grounded
    # evidence): a ``apps/*/.../*.ts`` glob resolves to ``missing`` and fails the
    # memory phase. Discovery surfaces ``migration_evidence_paths`` (bounded,
    # concrete, active-migration paths) exactly like ``web_modules_missing_project_json``;
    # the belief is seeded only when those paths exist.
    migration_evidence_paths = fingerprint.get("migration_evidence_paths") or []
    if (
        include_discovery_beliefs
        and int(fingerprint.get("migration_count") or 0) >= 5
        and isinstance(migration_evidence_paths, list)
        and migration_evidence_paths
    ):
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-has-recurring-typeorm-migration-surface",
            claim="repository has a recurring TypeORM migration surface that merits drift checks",
            evidence_refs=list(migration_evidence_paths),
            confidence=0.85,
            workspace_root=workspace_root,
        )
        beliefs_written += 1
    # Plan ARIA-V2 §3.5 + I-16 — surface MFEs missing project.json
    # as a first-class belief so downstream architecture-baseline
    # reviewers can decide whether to gate the gap. Discovery
    # populates ``web_modules_missing_project_json`` in REPO_FINGERPRINT
    # with concrete evidence paths.
    missing_mfe_project_json = fingerprint.get("web_modules_missing_project_json") or []
    if include_discovery_beliefs and isinstance(missing_mfe_project_json, list) and missing_mfe_project_json:
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="web-modules-missing-project-json",
            claim=(
                f"{len(missing_mfe_project_json)} MFE(s) under web/modules/ "
                "lack project.json — Nx-aware tooling cannot enumerate them; "
                "operator decides whether to add project.json or allowlist the gap."
            ),
            evidence_refs=list(missing_mfe_project_json),
            confidence=1.0,
            workspace_root=workspace_root,
        )
        beliefs_written += 1
    if include_tool_candidates:
        quarantined_tool_ids = _quarantined_tool_ids(root)
        beliefs_written += _mark_quarantined_source_beliefs(root, cycle_id, quarantined_tool_ids)
        beliefs_written += _ingest_memory_candidates(root, cycle_id, quarantined_tool_ids, workspace_root=workspace_root)
    # E21-c (ORPHAN-693) — reproduced findings feed the belief system
    # through THIS module (İ1: memory.py stays the only belief author; the
    # experiment lane never writes beliefs itself).
    beliefs_written += _record_experiment_reproduction_beliefs(
        root, cycle_id, workspace_root=workspace_root, base_dir=base_dir,
    )
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "observations_written": observations_written,
        "beliefs_written": beliefs_written,
    }


def rebuild_fates(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    workspace_base: str | Path | None = None,
    reason: str,
    acknowledge: bool,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.3 — audited rebuild of FATES.json content hashes.

    Re-hashes every entry in ``discovery/<cycle_id>/FATES.json`` from
    current on-disk content, rewrites FATES with the new hashes, and
    emits ``memory_fates_rebuilt`` governance event carrying both
    pre-state and post-state content_hash for each rebuilt file.

    The frozen-profile gate at function entry rejects rebuild under
    Plan 020 ``frozen`` profile via the ``tool_governance`` surface
    (the rebuild is a high-impact write to a snapshot-anchored
    artifact). Idempotent in the no-drift case: if no FATES entry
    needs rebuild, the function emits an audit row with empty
    ``rebuilt_files`` and returns.
    """
    if not acknowledge:
        raise GovernanceError("memory_rebuild_fates_requires_acknowledge")
    import hashlib
    from .evidence_validator import _canonical_evidence_path
    from .runtime_profile import enforce_profile_for_write
    from .tool_registry import append_tools_governance
    from .workspace import default_actor
    enforce_profile_for_write("tool_governance", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fates_path = discovery_dir / "FATES.json"
    if not fates_path.exists():
        raise GovernanceError(
            f"memory_rebuild_fates_no_discovery: {fates_path} not found"
        )
    fates = _read_json(fates_path)
    files = fates.get("files", []) if isinstance(fates, dict) else []
    if not isinstance(files, list):
        raise GovernanceError(
            f"memory_rebuild_fates_malformed_fates: files is not a list"
        )
    workspace_path = Path(workspace_root)
    rebuilt_files: list[dict[str, str]] = []
    new_files: list[dict[str, Any]] = []
    for entry in files:
        if not isinstance(entry, dict):
            new_files.append(entry)
            continue
        raw_path = entry.get("path")
        stored_hash = entry.get("content_hash")
        new_entry = dict(entry)
        if isinstance(raw_path, str) and isinstance(stored_hash, str):
            try:
                _rel, absolute = _canonical_evidence_path(raw_path, workspace_path)
            except GovernanceError:
                new_files.append(new_entry)
                continue
            if absolute.exists() and absolute.is_file():
                actual_hash = "sha256:" + hashlib.sha256(absolute.read_bytes()).hexdigest()
                if actual_hash != stored_hash:
                    new_entry["content_hash"] = actual_hash
                    rebuilt_files.append({
                        "path": raw_path,
                        "pre_state_content_hash": stored_hash,
                        "post_state_content_hash": actual_hash,
                    })
        new_files.append(new_entry)
    new_fates = dict(fates)
    new_fates["files"] = new_files
    fates_path.write_text(json.dumps(new_fates, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    actor = default_actor()
    append_tools_governance(
        root,
        "memory_fates_rebuilt",
        {
            "actor": actor,
            "cycle_id": cycle_id,
            "reason": reason,
            "rebuilt_files": rebuilt_files,
            "rebuilt_file_count": len(rebuilt_files),
            "result": "SUCCESS",
        },
    )
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "rebuilt_file_count": len(rebuilt_files),
        "rebuilt_files": rebuilt_files,
        "result": "SUCCESS",
    }


def reset_memory(
    *,
    workspace_root: str | Path,
    backup_to: str | Path,
    base_dir: str | Path | None = None,
    workspace_base: str | Path | None = None,
    reason: str,
    acknowledge: bool,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.3 — audited reset of the workspace memory dir.

    Moves the workspace's memory directory to ``backup_to`` (operator-
    supplied; no default — preventing accidental data loss) and
    re-bootstraps an empty memory state. Emits ``memory_reset``
    governance event with pre-reset FATES content_hash, backup path,
    operator actor + reason, in the WORKSPACE governance ledger (NOT
    tools governance — memory is workspace-owned per CONTRACTS.md §0.1).

    Frozen-profile-gated via tool_governance surface (the reset is
    destructive). Backup must NOT exist before reset (architectural
    Tier-1 — Make impossible to overwrite existing backup).
    """
    if not acknowledge:
        raise GovernanceError("memory_reset_requires_acknowledge")
    import hashlib
    import shutil
    from .runtime_profile import enforce_profile_for_write
    from .workspace import default_actor, record_workspace_governance, workspace_paths
    enforce_profile_for_write("tool_governance", base_dir=base_dir)
    backup_path = Path(backup_to)
    if backup_path.exists():
        raise GovernanceError(
            f"memory_reset_backup_path_exists: {backup_path} already exists; "
            "operator must supply a fresh path so existing backups cannot be overwritten"
        )
    paths = workspace_paths(
        Path(workspace_root),
        Path(workspace_base) if workspace_base else None,
    )
    if not paths.memory_dir.exists():
        raise GovernanceError(
            f"memory_reset_no_memory_dir: {paths.memory_dir} not found"
        )
    # Hash pre-reset state for audit row
    pre_reset_bytes_parts: list[bytes] = []
    for child in sorted(paths.memory_dir.rglob("*")):
        if child.is_file():
            pre_reset_bytes_parts.append(child.relative_to(paths.memory_dir).as_posix().encode("utf-8"))
            pre_reset_bytes_parts.append(b"\n")
            pre_reset_bytes_parts.append(child.read_bytes())
            pre_reset_bytes_parts.append(b"\n")
    pre_reset_hash = "sha256:" + hashlib.sha256(b"".join(pre_reset_bytes_parts)).hexdigest()
    # Move memory dir to backup
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(paths.memory_dir), str(backup_path))
    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    # Re-touch the empty ledgers so subsequent cycles can append
    for ledger_path in paths.ledgers.values():
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.touch(exist_ok=True)
    actor = default_actor()
    # Audit row lands in WORKSPACE governance ledger, not tools.
    record_workspace_governance(
        paths,
        "memory_reset",
        {
            "actor": actor,
            "reason": reason,
            "pre_reset_fates_hash": pre_reset_hash,
            "backup_path": str(backup_path),
            "result": "SUCCESS",
        },
    )
    return {
        "schema_version": 1,
        "pre_reset_fates_hash": pre_reset_hash,
        "backup_path": str(backup_path),
        "result": "SUCCESS",
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


def validate_repo_evidence(
    evidence_refs: list[str], *, workspace_root: str | Path | None = None,
) -> None:
    """Plan 026R §E.5 — canonical-path resolver via evidence_validator
    helper. Pre-§E.5 the validator used a lexical-only normalisation
    (replace backslash, strip ./ prefix, check startswith
    SELF_OUTPUT_PREFIXES). Lexical-only let a traversal path like
    ``src/../aria-findings/F-001.json`` escape detection because the
    lexical form ``src/../aria-findings/F-001.json`` does not match
    any SELF_OUTPUT prefix. §E.5 routes through
    ``evidence_validator._canonical_evidence_path`` which resolves
    the path FIRST (absolute, symlinks followed, traversal collapsed)
    then matches the canonical posix-relative form.

    When ``workspace_root`` is None the legacy lexical path is used
    (call-site backward compatibility); callers that have a real
    workspace MUST pass it to enable the canonical check.
    """
    if not evidence_refs:
        raise GovernanceError("memory belief requires at least one repo evidence reference")
    for raw_ref in evidence_refs:
        ref = str(raw_ref).replace("\\", "/")
        while ref.startswith("./"):
            ref = ref[2:]
        if not ref.strip():
            raise GovernanceError("memory belief evidence reference must not be empty")
        if workspace_root is not None:
            workspace = Path(workspace_root)
            target_sha = "HEAD" if (workspace / ".git").exists() else None
            envelope = classify_evidence_ref(
                ref,
                workspace_root=workspace,
                source_hint="repo_source",
                context="memory_belief",
                target_sha=target_sha,
            )
            if envelope.self_output_class == "aria_self_output":
                raise GovernanceError(
                    f"memory belief cannot use ARIA self-output as evidence: "
                    f"{ref!r} resolves to {envelope.canonical_ref!r}"
                )
            if envelope.trust_grade == "invalid":
                raise GovernanceError(
                    f"memory belief evidence is invalid: {ref!r}: "
                    f"grade={envelope.trust_grade!r} "
                    f"errors={list(envelope.validation_errors)!r}"
                )
            if target_sha is not None:
                # E5/M1 — a belief is a proposition about a CLASS of files,
                # so glob evidence that matches real committed files is
                # admissible here (repo_glob_verified), unlike a finding
                # which must cite one concrete file:line. This is the line
                # that let ARIA learn 0 beliefs from any tool: every
                # adapter belief candidate cited a glob, graded "missing",
                # rejected. Finding evidence stays file-exact (findings use
                # require_repo_verified, unchanged).
                EvidencePolicy.require_repo_or_glob_verified(envelope)
        elif ref.startswith(SELF_OUTPUT_PREFIXES):
            raise GovernanceError("memory belief cannot use ARIA self-output as evidence")


def _evidence_envelopes(
    evidence_refs: list[str],
    *,
    workspace_root: str | Path | None,
) -> list[dict[str, Any]]:
    source_hint = "repo_source" if workspace_root is not None else "legacy"
    return [
        classify_evidence_ref(
            ref,
            workspace_root=workspace_root,
            source_hint=source_hint,
            context="memory_belief",
        ).to_dict()
        for ref in evidence_refs
    ]


def _stamp_belief_freshness(
    row: dict[str, Any],
    *,
    cycle_id: str,
    repo_state: dict[str, Any],
    status: str,
    prior_verified_at: str | None = None,
) -> None:
    """Plan ARIA-V3.2 §2a (F-010 D1) — single chokepoint for
    belief-row freshness stamping. EVERY writer that emits a row
    to ``beliefs.jsonl`` (_record_belief, _apply_diff_to_existing_beliefs,
    _mark_quarantined_source_beliefs) MUST call this helper BEFORE
    ``append_jsonl``. The helper stamps:

      * ``recorded_at`` + ``updated_at`` — both set to ``utc_now()``
        every cycle (the row's age in this cycle).
      * ``base_commit_sha`` + ``repo_state_id`` — refreshed to the
        CURRENT cycle's repo_state. Pre-V3.2 the diff-decay +
        quarantine paths inherited these from ``row = dict(belief)``,
        leaving them frozen at the original verification SHA even
        after evidence changed.
      * ``last_seen_cycle`` — current cycle_id.
      * ``verified_at`` — refreshed to ``utc_now()`` ONLY when
        ``status == "supported"``. Other statuses preserve the
        prior verification timestamp (audit-trail signal of "when
        was this last verified") so the operator can see how long
        ago the belief left the supported state.

    Invariants I-V3.2-01..03b lock the contract. The helper is
    pure — no I/O, no side effects beyond mutating ``row``.
    """
    now = utc_now()
    row["recorded_at"] = now
    row["updated_at"] = now
    row["base_commit_sha"] = repo_state.get("base_commit_sha")
    row["repo_state_id"] = repo_state.get("repo_state_id")
    row["last_seen_cycle"] = cycle_id
    if status == "supported":
        row["verified_at"] = now
    elif prior_verified_at is not None and "verified_at" not in row:
        row["verified_at"] = prior_verified_at


def _record_belief(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    claim: str,
    evidence_refs: list[str],
    confidence: float,
    source_tool_ids: list[str] | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    validate_repo_evidence(evidence_refs, workspace_root=workspace_root)
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
    # REPETITION IS NOT CORROBORATION.
    #
    # ARIA re-records the same discovery beliefs on EVERY cycle, from the
    # same files. Both the counter and the confidence term used to move on
    # every one of those passes, and because the term is added to
    # `previous_confidence` rather than to the original, each pass
    # compounded on the already-raised value: one unchanged file carried a
    # belief from 0.605 to 0.925 in eleven observations. The system was
    # reading its own repetition as evidence.
    #
    # Both halves are gated on the same fact, because fixing either alone
    # leaves a ratchet — a frozen counter still adds its term to a rising
    # base, and a zeroed term still lets the counter inflate a later one.
    evidence_hashes = _evidence_hashes(root, cycle_id, evidence_refs)
    previous_hashes = list((existing or {}).get("evidence_hashes") or [])
    # Both sides come from `_evidence_hashes`, which returns sorted(), so
    # this compares content and not iteration order.
    evidence_is_new = existing is None or evidence_hashes != previous_hashes

    support_count = int((existing or {}).get("support_count", 0)) + (1 if evidence_is_new else 0)
    contradiction_count = len(contradictions)
    previous_confidence = float((existing or {}).get("confidence", confidence))
    base_confidence = previous_confidence if existing else confidence
    needs_revalidation_cycles = 0
    if evidence_state["missing_concrete_refs"] or evidence_state["empty_glob_refs"]:
        needs_revalidation_cycles = int((existing or {}).get("needs_revalidation_cycles", 0)) + 1
    support_term = min(0.05, support_count * 0.005) if evidence_is_new else 0.0
    next_confidence = _bounded_confidence(
        base_confidence
        + support_term
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
        "belief_id": belief_id,
        "claim": claim,
        "confidence": next_confidence,
        "status": status,
        "evidence_refs": evidence_refs,
        "evidence_envelopes": _evidence_envelopes(evidence_refs, workspace_root=workspace_root),
        "first_seen_cycle": (existing or {}).get("first_seen_cycle", cycle_id),
        # Occurrence is worth KEEPING — it just is not evidence. Dropping
        # the count would lose a real signal (how often ARIA has looked at
        # this), so it is recorded where nothing reads it into confidence:
        # the observation survives without getting a vote.
        # `last_seen_cycle` is NOT set here — the freshness helper every
        # belief writer must call already stamps it, and a field with two
        # writers is a field that drifts.
        "observation_count": int((existing or {}).get("observation_count", 0)) + 1,
        "support_count": support_count,
        "contradiction_count": contradiction_count,
        "needs_revalidation_cycles": needs_revalidation_cycles,
        "evidence_state": evidence_state,
        "evidence_hashes": evidence_hashes,
        "verification_status": verification_status,
        "source_tool_ids": sorted(set(source_tool_ids or (existing or {}).get("source_tool_ids", []))),
        "glob_match_history": _next_glob_history(existing, cycle_id, evidence_state),
    }
    # Plan ARIA-V3.2 §2a (F-010 D1) — route freshness fields through
    # the single ``_stamp_belief_freshness`` chokepoint so every
    # writer to beliefs.jsonl uses the same logic. Pre-V3.2 this
    # writer had its own inline freshness stamping (verified_at logic
    # was correct here); the diff-decay + quarantine writers below
    # did NOT have it, causing multi-writer staleness drift.
    _stamp_belief_freshness(
        row,
        cycle_id=cycle_id,
        repo_state=repo_state,
        status=status,
        prior_verified_at=(existing or {}).get("verified_at"),
    )
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


BELIEF_AGE_TTL_DAYS = 90


def decay_stale_beliefs_by_age(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    ttl_days: int = BELIEF_AGE_TTL_DAYS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Plan 028 §D4 — time-based belief decay for UNCHANGED code.

    Pre-Plan-028 belief decay was purely evidence/change-coupled
    (``_apply_diff_to_existing_beliefs`` fires only when a diff touches a
    belief's evidence). A belief about code that simply never changes could
    stay ``supported`` forever, even if it was last verified a year ago — the
    world may have moved (a dependency CVE, an upstream contract shift) without
    a local diff. This adds the missing AGE trigger: a ``supported`` belief
    whose ``verified_at`` is older than ``ttl_days`` is moved to
    ``needs_revalidation`` (or ``stale`` once the revalidation-cycle ceiling is
    crossed), which ``run_pressure`` already surfaces as operator pressure.

    Only ``supported`` beliefs are decayed — once a belief is already
    ``needs_revalidation``/``stale``/``contradicted``/``withdrawn`` the existing
    machinery owns it, so age-decay bumps each belief at most once.
    """
    root = ensure_tools_dir(base_dir)
    now_dt = now or datetime.now(timezone.utc)
    cutoff = now_dt - timedelta(days=ttl_days)
    repo_state = _repo_state(root, cycle_id)
    decayed: list[dict[str, Any]] = []
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        if belief.get("status") != "supported":
            continue
        verified_at = belief.get("verified_at")
        if not verified_at:
            continue
        try:
            verified_dt = datetime.fromisoformat(str(verified_at).replace("Z", "+00:00"))
        except ValueError:
            continue
        if verified_dt.tzinfo is None:
            verified_dt = verified_dt.replace(tzinfo=timezone.utc)
        if verified_dt >= cutoff:
            continue
        revalidation_cycles = int(belief.get("needs_revalidation_cycles", 0)) + 1
        status = "stale" if revalidation_cycles >= STALE_AFTER_REVALIDATION_CYCLES else "needs_revalidation"
        row = dict(belief)
        row.update(
            {
                "status": status,
                # M7/E12 — confidence moves IN the transition row itself.
                # All three decay paths used to write only status: a belief
                # marked stale kept confidence 1.0, so any confidence-sorted
                # consumer ranked stale-but-sure ahead of fresh-but-modest.
                "confidence": _decayed_confidence(belief, status),
                "needs_revalidation_cycles": revalidation_cycles,
                "stale_reason": f"belief not re-verified within {ttl_days}d (age decay, code unchanged)",
                "verification_status": "needs_revalidation",
            },
        )
        _stamp_belief_freshness(
            row,
            cycle_id=cycle_id,
            repo_state=repo_state,
            status=status,
            prior_verified_at=verified_at,
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        decayed.append({
            "belief_id": belief.get("belief_id"),
            "verified_at": verified_at,
            "status": status,
        })
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "ttl_days": ttl_days,
        "decayed_count": len(decayed),
        "decayed": decayed,
    }


def _changed_files_since(repo_root: Path, base_sha: str) -> list[str] | None:
    """git diff --name-only base_sha..HEAD, or None if the range is unusable."""
    import subprocess

    if not re.fullmatch(r"[0-9a-f]{7,64}", base_sha or ""):
        return None
    try:
        # Confirm both ends are real commits before diffing — a base_sha
        # that is not in this clone's history is not a signal, it's noise.
        subprocess.run(
            ["git", "cat-file", "-e", f"{base_sha}^{{commit}}"],
            cwd=repo_root, capture_output=True, check=True, timeout=5,
        )
        proc = subprocess.run(
            ["git", "diff", "--name-only", f"{base_sha}..HEAD"],
            cwd=repo_root, capture_output=True, text=True, check=False, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def _evidence_touches_changed(evidence_refs: list[str], changed: set[str]) -> bool:
    """Does any belief evidence ref intersect the changed-file set?

    Concrete paths match exactly (the ref carries no line for beliefs, but
    strip one if present); glob refs match by fnmatch — a belief about a
    CLASS of files is stale the moment any member of the class changes.
    """
    for raw in evidence_refs:
        ref = str(raw).split(":", 1)[0].replace("\\", "/")
        while ref.startswith("./"):
            ref = ref[2:]
        if any(ch in ref for ch in ("*", "?", "[")):
            if any(fnmatch.fnmatch(path, ref) for path in changed):
                return True
        elif ref in changed:
            return True
    return False


def decay_beliefs_by_head_distance(
    *,
    cycle_id: str,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """M6/E6 — remember what OTHERS did to the repo.

    The pre-E6 belief-staleness triggers were the FATES-hash cycle-diff
    (fires only on a discovery run) and the wall-clock TTL. Neither notices
    when someone ELSE merges a change to a file a belief depends on — the
    belief stays ``supported`` at full confidence against code that has
    moved under it (live: 3 beliefs anchored 102 commits behind HEAD, all
    ``supported``/1.0). This is the missing signal: for each supported
    belief, if any commit between its anchor SHA and HEAD touched one of its
    evidence files, the belief becomes ``needs_revalidation`` — regardless
    of WHO made the change or whether they used an ARIA trailer.

    Idempotent per belief per cycle (only ``supported`` rows are examined;
    the existing revalidation machinery owns the rest), and it stamps the
    same revalidation-cycle counter the age-decay path uses so a belief that
    keeps drifting eventually goes ``stale``.
    """
    root = ensure_tools_dir(base_dir)
    repo = Path(repo_root)
    repo_state = _repo_state(root, cycle_id)
    revalidated: list[dict[str, Any]] = []
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        if belief.get("status") != "supported":
            continue
        base_sha = str(belief.get("base_commit_sha") or "")
        if not base_sha:
            continue
        changed = _changed_files_since(repo, base_sha)
        if not changed:
            continue
        evidence_refs = _array_of_strings(belief.get("evidence_refs"))
        if not _evidence_touches_changed(evidence_refs, set(changed)):
            continue
        revalidation_cycles = int(belief.get("needs_revalidation_cycles", 0)) + 1
        status = "stale" if revalidation_cycles >= STALE_AFTER_REVALIDATION_CYCLES else "needs_revalidation"
        row = dict(belief)
        row.update({
            "status": status,
            # M7/E12 — see the age-decay path: the transition itself
            # carries the confidence drop.
            "confidence": _decayed_confidence(belief, status),
            "needs_revalidation_cycles": revalidation_cycles,
            "stale_reason": "evidence file changed since anchor commit (head-distance decay)",
            "verification_status": "needs_revalidation",
        })
        _stamp_belief_freshness(
            row, cycle_id=cycle_id, repo_state=repo_state, status=status,
            prior_verified_at=belief.get("verified_at"),
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        revalidated.append({
            "belief_id": belief.get("belief_id"),
            "base_commit_sha": base_sha,
            "status": status,
        })
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "revalidated_count": len(revalidated),
        "revalidated": revalidated,
    }


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
                "status": status,
                "needs_revalidation_cycles": revalidation_cycles,
                "stale_reason": "evidence changed, disappeared, or glob no longer matches",
                "evidence_state": evidence_state,
                "verification_status": "needs_revalidation",
                "glob_match_history": _next_glob_history(belief, cycle_id, evidence_state, current_paths=current_paths),
            },
        )
        # Plan ARIA-V3.2 §2a (F-010 D1) — route freshness fields
        # through the single chokepoint. Pre-V3.2 this writer
        # inherited ``base_commit_sha`` + ``repo_state_id`` from the
        # prior belief row (via ``row = dict(belief)``), leaving them
        # frozen at the original verification SHA. The unified
        # ``_stamp_belief_freshness`` helper refreshes them to the
        # current cycle's repo_state. ``verified_at`` is PRESERVED
        # via prior_verified_at because status=needs_revalidation
        # MUST NOT re-verify.
        repo_state = _repo_state(root, cycle_id)
        prior_verified_at = belief.get("verified_at")
        _stamp_belief_freshness(
            row,
            cycle_id=cycle_id,
            repo_state=repo_state,
            status=status,
            prior_verified_at=prior_verified_at,
        )
        # Pre-helper, the row pre-set its own verified_at via
        # ``row = dict(belief)``. The helper preserves it when
        # status != supported AND row doesn't already carry it; the
        # dict-copy guarantees the field IS present so the helper
        # is a no-op for verified_at here — which is the intended
        # invariant (audit-trail signal "last verified at when").
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
        # Plan 031 Gate B — a belief reopened because its evidence changed is a
        # reopen signal for the oscillation guard. Pure counter increment (no
        # escalation here); the fix dispatcher's guard_fix_dispatch decides.
        from .oscillation_guard import record_reopen
        record_reopen(
            fingerprint=f"belief:{belief.get('belief_id')}",
            cycle_id=cycle_id,
            base_dir=root,
            context={"reason": "belief_evidence_invalidated"},
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
                "status": status,
                # M7/E12 — see the age-decay path: the transition itself
                # carries the confidence drop.
                "confidence": _decayed_confidence(belief, status),
                "needs_revalidation_cycles": revalidation_cycles,
                "revalidation_reason": "source tool is quarantined",
                "quarantined_source_tool_ids": matched_tool_ids,
            },
        )
        # Plan ARIA-V3.2 §2a (F-010 D1) — same architectural pattern
        # as the diff-decay writer above: route freshness fields
        # through the single chokepoint to refresh base_commit_sha
        # + repo_state_id to the current cycle. Pre-V3.2 the
        # quarantine writer inherited stale freshness fields via
        # ``row = dict(belief)``.
        repo_state = _repo_state(root, cycle_id)
        prior_verified_at = belief.get("verified_at")
        _stamp_belief_freshness(
            row,
            cycle_id=cycle_id,
            repo_state=repo_state,
            status=status,
            prior_verified_at=prior_verified_at,
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


def _ingest_memory_candidates(
    root: Path,
    cycle_id: str,
    quarantined_tool_ids: set[str] | None = None,
    *,
    workspace_root: str | Path | None = None,
) -> int:
    quarantined_tool_ids = quarantined_tool_ids or set()
    written = 0
    for run in list(read_runs_rows(runs_path(root), base_dir=root)):
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
                    workspace_root=workspace_root,
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


def _record_experiment_reproduction_beliefs(
    root: Path,
    cycle_id: str,
    *,
    workspace_root: str | Path | None,
    base_dir: str | Path | None,
) -> int:
    """E21-c (ORPHAN-693) — an executed reproduction becomes remembered knowledge.

    WHY: the Deney Masası's whole point is that re-production outranks
    re-reading — but until this leg, a reproduced finding upgraded the
    FINDING record and taught the memory nothing: the next night's judges
    would re-derive from scratch what an experiment had already proven.

    WHAT: for every observation in THIS cycle that matched its contract
    with a RED run on a finding-bound experiment, record (or re-support)
    the belief that the finding reproduces deterministically. Evidence
    refs are the finding's own scope files, so the standard repo-evidence
    policy applies unchanged — no new evidence class, no parallel writer.
    """
    if workspace_root is None:
        return 0
    from .experiment import get_experiment, list_experiment_observations
    try:
        observations = list_experiment_observations(base_dir=base_dir)
    except GovernanceError:
        return 0
    written = 0
    for row in observations:
        if row.get("cycle_id") != cycle_id or row.get("matched") is not True:
            continue
        if str(row.get("run_status") or "") != "failed":
            continue
        try:
            experiment = get_experiment(
                str(row.get("experiment_id") or ""), base_dir=base_dir
            )
        except GovernanceError:
            continue
        finding_ref = experiment.get("finding_ref")
        if not finding_ref:
            continue
        try:
            from .finding import show_finding

            finding_doc = show_finding(workspace_root, str(finding_ref))
        except GovernanceError as exc:
            _record_uncertainty(
                root,
                cycle_id=cycle_id,
                belief_id=f"finding-reproduced-{str(finding_ref).lower()}",
                reason=f"experiment reproduction belief skipped: {exc}",
                evidence_refs=[],
            )
            continue
        scope_files = [
            str(item)
            for item in (finding_doc.get("scope") or {}).get("files") or []
            if isinstance(item, str) and item.strip()
        ]
        if not scope_files:
            _record_uncertainty(
                root,
                cycle_id=cycle_id,
                belief_id=f"finding-reproduced-{str(finding_ref).lower()}",
                reason="experiment reproduction belief skipped: finding carries no scope files to cite",
                evidence_refs=[],
            )
            continue
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id=f"finding-reproduced-{str(finding_ref).lower()}",
            claim=(
                f"finding {finding_ref} reproduces deterministically under "
                f"recipe {experiment.get('recipe_ref')} "
                f"(experiment {experiment.get('experiment_id')})"
            ),
            evidence_refs=scope_files,
            confidence=0.75,
            workspace_root=workspace_root,
        )
        written += 1
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


# M7/E12 — how much a staleness transition costs. Stale costs more than
# needs_revalidation because stale means the doubt has COMPOUNDED across
# cycles; both leave the belief rankable (never zeroed) so revalidation
# can restore it.
DECAY_CONFIDENCE_PENALTY: dict[str, float] = {
    "needs_revalidation": 0.1,
    "stale": 0.2,
}


def _decayed_confidence(belief: dict[str, Any], status: str) -> float:
    """The belief's confidence after a staleness transition.

    All three decay paths (age, head-distance, quarantined-source) used
    to write only ``status``: a belief marked stale kept confidence 1.0,
    so any confidence-sorted consumer ranked stale-but-sure ahead of
    fresh-but-modest. The drop rides the SAME row as the status change —
    one transition, one truth.
    """
    current = float(belief.get("confidence") or 0.0)
    return _bounded_confidence(current - DECAY_CONFIDENCE_PENALTY.get(status, 0.1))


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


def _verify_fates_integrity(
    fates: dict[str, Any],
    *,
    snapshot: dict[str, Any] | None = None,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    snapshot_mode: str | None = None,
    base_commit_sha: str | None = None,
) -> None:
    """Plan ARIA-V2 §3.3 — verify FATES.files content_hash against the
    immutable snapshot's git-tree bytes (committed mode) or emit a
    drift governance event (working_tree mode).

    Pre-§3.3 (Plan 026R §E.7) the function read files directly from
    ``workspace_root``, which conflated "did the snapshot internally
    agree with itself?" (the FATES invariant) with "did the working
    tree change between discovery and memory write?" (a different and
    weaker invariant). Working-tree edits during cycle execution
    produced false-positive ``memory_fates_content_hash_mismatch``
    errors that blocked operators from running cycles on dirty trees.

    Post-§3.3 contract:
      * ``committed`` snapshot mode → read bytes via
        ``git show <base_commit_sha>:<path>`` (immutable git object).
        Any working-tree edit between discovery and memory is invisible.
        Mismatch indicates real tamper of the snapshot's recorded hash
        and raises ``memory_fates_content_hash_mismatch``.
      * ``working_tree`` snapshot mode → mismatch is EXPECTED operator
        edit, not tamper. Emit ``memory_fates_working_tree_drift_observed``
        governance event so audit trails capture the looser invariant,
        do NOT raise.
      * Legacy callers (no snapshot, just ``workspace_root``) fall
        through to the pre-§3.3 disk-read behavior for backward-compat;
        existing tests + callsites continue to function unchanged.
    """
    from .evidence_validator import _canonical_evidence_path
    files = fates.get("files", []) if isinstance(fates, dict) else []
    if not isinstance(files, list):
        return

    if snapshot is None and (snapshot_mode is not None or base_commit_sha is not None):
        snapshot = {
            "snapshot_mode": snapshot_mode,
            "base_commit_sha": base_commit_sha,
        }

    snapshot_mode = (snapshot or {}).get("snapshot_mode") if snapshot else snapshot_mode
    base_sha = (snapshot or {}).get("base_commit_sha") if snapshot else base_commit_sha

    # Plan ARIA-V2 §3.3 — committed mode reads from immutable git tree
    if snapshot is not None and snapshot_mode == "committed" and base_sha and workspace_root is not None:
        _verify_fates_against_git_tree(
            files,
            base_sha=base_sha,
            workspace_root=Path(workspace_root),
        )
        return

    # Plan ARIA-V2 §3.3 — working_tree mode emits drift event, no raise
    if snapshot is not None and snapshot_mode == "working_tree":
        _emit_fates_working_tree_drift_observed(
            files,
            snapshot=snapshot,
            workspace_root=workspace_root,
            base_dir=base_dir,
        )
        return

    # Legacy path: pre-§3.3 disk-read behavior preserved when no snapshot
    # supplied. Existing callers that pass workspace_root alone continue
    # to work; the legacy path's false-positive class is documented in
    # Plan ARIA-V2 §Phase 2.
    if workspace_root is None:
        return
    workspace_path = Path(workspace_root)
    for entry in files:
        if not isinstance(entry, dict):
            continue
        raw_path = entry.get("path")
        stored_hash = entry.get("content_hash")
        if not isinstance(raw_path, str) or not isinstance(stored_hash, str):
            raise GovernanceError(
                f"memory_fates_entry_malformed: {entry!r}"
            )
        try:
            _rel, absolute = _canonical_evidence_path(raw_path, workspace_path)
        except GovernanceError as exc:
            raise GovernanceError(
                f"memory_fates_path_traversal_rejected: "
                f"path={raw_path!r} reason={exc}"
            )
        actual_hash = _fates_actual_hash(
            workspace_path=workspace_path,
            relative_path=_rel,
            absolute_path=absolute,
            snapshot_mode=snapshot_mode,
            base_commit_sha=base_sha,
        )
        if actual_hash is None:
            # File deleted between discovery + memory; legitimate
            # signal but not a tamper — operator path follows the
            # missing-evidence belief invalidation flow.
            continue
        if actual_hash != stored_hash:
            raise GovernanceError(
                f"memory_fates_content_hash_mismatch: "
                f"path={raw_path!r} stored={stored_hash!r} "
                f"actual={actual_hash!r}"
            )


def _verify_fates_against_git_tree(
    files: list[dict[str, Any]],
    *,
    base_sha: str,
    workspace_root: Path,
) -> None:
    """Plan ARIA-V2 §3.3 committed-mode verifier — bytes come from the
    immutable git tree at ``base_sha``, not the working tree. Any
    working-tree edit between discovery and memory write is invisible
    to this check.

    Mismatch indicates real tamper of FATES.files content_hash relative
    to what git records at the base commit — that IS a tamper and
    raises ``memory_fates_content_hash_mismatch``.

    Missing-in-git is silent (file deleted in commits since base_sha;
    treated as legitimate evidence-staleness signal).
    """
    import hashlib
    import subprocess
    for entry in files:
        if not isinstance(entry, dict):
            continue
        raw_path = entry.get("path")
        stored_hash = entry.get("content_hash")
        if not isinstance(raw_path, str) or not isinstance(stored_hash, str):
            raise GovernanceError(
                f"memory_fates_entry_malformed: {entry!r}"
            )
        try:
            result = subprocess.run(
                ["git", "show", f"{base_sha}:{raw_path}"],
                cwd=workspace_root,
                capture_output=True,
                check=False,
            )
        except OSError as exc:
            raise GovernanceError(
                f"memory_fates_git_show_failed: path={raw_path!r} error={exc}"
            )
        if result.returncode != 0:
            # File not in committed tree at base_sha (e.g. untracked
            # in working_tree mode FATES, or deleted before base_sha)
            # — silently skip, mirroring the legacy "file missing"
            # branch of the pre-§3.3 verifier.
            continue
        actual_hash = "sha256:" + hashlib.sha256(result.stdout).hexdigest()
        if actual_hash != stored_hash:
            raise GovernanceError(
                f"memory_fates_content_hash_mismatch: "
                f"path={raw_path!r} stored={stored_hash!r} "
                f"actual={actual_hash!r} base_sha={base_sha!r}"
            )


def _emit_fates_working_tree_drift_observed(
    files: list[dict[str, Any]],
    *,
    snapshot: dict[str, Any],
    workspace_root: str | Path | None,
    base_dir: str | Path | None,
) -> None:
    """Plan ARIA-V2 §3.3 working_tree-mode observer — count drifted
    files, emit a governance event, do NOT raise.

    Working-tree mode by definition captured operator state at a
    point in time. By the time memory runs, the operator may have
    edited files further. That is not tamper; it is the looser
    contract working_tree mode promised. We surface the drift as
    an audit-visible observation and continue.
    """
    import hashlib
    from .evidence_validator import _canonical_evidence_path
    drifted_count = 0
    if workspace_root is not None:
        workspace_path = Path(workspace_root)
        for entry in files:
            if not isinstance(entry, dict):
                continue
            raw_path = entry.get("path")
            stored_hash = entry.get("content_hash")
            if not isinstance(raw_path, str) or not isinstance(stored_hash, str):
                continue
            try:
                _rel, absolute = _canonical_evidence_path(raw_path, workspace_path)
            except GovernanceError:
                continue
            if not absolute.exists() or not absolute.is_file():
                continue
            actual_hash = "sha256:" + hashlib.sha256(absolute.read_bytes()).hexdigest()
            if actual_hash != stored_hash:
                drifted_count += 1
    if base_dir is not None:
        from .tool_registry import append_tools_governance
        append_tools_governance(
            Path(base_dir),
            "memory_fates_working_tree_drift_observed",
            {
                "snapshot_mode": "working_tree",
                "drifted_file_count": drifted_count,
                "base_commit_sha": (snapshot or {}).get("base_commit_sha"),
                "dirty_snapshot": (snapshot or {}).get("dirty_snapshot"),
            },
        )

def _fates_actual_hash(
    *,
    workspace_path: Path,
    relative_path: str,
    absolute_path: Path,
    snapshot_mode: str | None,
    base_commit_sha: str | None,
) -> str | None:
    import hashlib
    import subprocess

    if snapshot_mode == "committed" and isinstance(base_commit_sha, str) and base_commit_sha.strip():
        completed = subprocess.run(
            ["git", "show", f"{base_commit_sha}:{relative_path}"],
            cwd=workspace_path,
            capture_output=True,
            text=False,
            check=False,
        )
        if completed.returncode == 0:
            return "sha256:" + hashlib.sha256(completed.stdout).hexdigest()
    if not absolute_path.exists() or not absolute_path.is_file():
        return None
    return "sha256:" + hashlib.sha256(absolute_path.read_bytes()).hexdigest()


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
