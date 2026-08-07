from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .feedback import normalize_feedback_event, pressure_evidence_fingerprint, slug
from .ledger import append_jsonl, read_jsonl, rewrite_jsonl, stamp_row_format, verify_jsonl, write_index
from .tool_registry import GovernanceError, SCHEMA_VERSION as TOOLS_SCHEMA_VERSION, append_tools_governance, covered_tool_ledgers, sync_tools_contract, tools_contract_version, update_tools_index
from .workspace import WorkspacePaths, canonical_identity, canonical_identity_source, default_actor, governance_event, record_workspace_governance, repo_hash, workspace_paths


MIGRATION_PHASES = ("started", "copied", "validated", "finalized")
TOOLS_LOCK_TIMEOUT_SECONDS = 30
TOOLS_LOCK_STALE_SECONDS = 120
MIGRATION_REWRITE_EXPIRES_AT = "2026-12-31T00:00:00+00:00"


def _rewrite_migration_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    rewrite_jsonl(
        path,
        rows,
        allow_legacy=True,
        legacy_reason="operator_acknowledged_migration_rewrite",
        expires_at=MIGRATION_REWRITE_EXPIRES_AT,
    )


def _append_tools_migration_governance(root: Path, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    if (root / "repo_identity.json").exists():
        return append_tools_governance(root, kind, details)
    return append_jsonl(
        root / "governance.jsonl",
        governance_event(kind=kind, details=details),
        allow_legacy=True,
        legacy_reason="operator_acknowledged_tools_migration_bootstrap",
        expires_at=MIGRATION_REWRITE_EXPIRES_AT,
    )


def migrate_workspace_v1_to_v2(
    *,
    workspace_root: str | Path,
    workspace_base: str | Path | None = None,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("migration requires --acknowledge and --reason")
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    backup = _backup_dir(paths.workspace_root, "workspace-v1")
    if paths.workspace_root.exists() and not backup.exists():
        shutil.copytree(paths.workspace_root, backup)
    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    existing_index = _read_json(paths.feedback_index)
    dropped_legacy_field = "pressure_keys_emitted" if "pressure_keys_emitted" in existing_index else None
    _migrate_workspace_ledgers(paths)
    for path in paths.ledgers.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
    identity = {
        "aria_workspace_contract_version": 2,
        "repo_hash": repo_hash(Path(workspace_root)),
        "repo_root": str(Path(workspace_root).resolve()),
        "schema_version": 2,
    }
    paths.identity_file.write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_index(paths.feedback_index, {"pressure_evidence_fingerprints_emitted": _pressure_fingerprints(paths)}, paths.ledgers)
    record_workspace_governance(
        paths,
        "migration_completed",
        {"schema_from": 1, "schema_to": 2, "phase": "workspace", "reason": reason, "dropped_legacy_field": dropped_legacy_field},
    )
    state = {"schema_version": 2, "migration": "workspace_v1_to_v2", "backup_path": backup.as_posix(), "completed_at": _now()}
    (paths.workspace_root / "migration_state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return state


def rollback_workspace_v2_to_v1(
    *,
    workspace_root: str | Path,
    workspace_base: str | Path | None = None,
    from_backup: str | Path,
    acknowledge: bool,
    reason: str,
    force_discard_since_migration: bool = False,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("rollback requires --acknowledge and --reason")
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    backup = Path(from_backup)
    actor = default_actor()
    discarded = _discarded_event_count(paths.ledgers, backup / "aria-memory")
    _guard_post_migration_rows(paths.ledgers, backup / "aria-memory", force_discard_since_migration)
    since_rows = (
        _since_migration_rows(paths.ledgers, backup / "aria-memory")
        if force_discard_since_migration
        else []
    )
    if paths.workspace_root.exists():
        shutil.rmtree(paths.workspace_root)
    shutil.copytree(backup, paths.workspace_root)
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    if force_discard_since_migration:
        _rewrite_migration_jsonl(paths.ledgers["since_migration_events"], since_rows)
    record_workspace_governance(
        paths,
        "rollback_started",
        {
            "reason": reason,
            "acknowledged_by": actor,
            "from_backup": backup.as_posix(),
            "force_discard_since_migration": force_discard_since_migration,
        },
    )
    record_workspace_governance(paths, "rollback_phase", {"phase": "restored_backup", "restored_ledger": "all"})
    record_workspace_governance(
        paths,
        "rollback_completed",
        {
            "reason": reason,
            "acknowledged_by": actor,
            "restored_to_state": "workspace_v1",
            "discarded_event_count": discarded if force_discard_since_migration else 0,
        },
    )
    return {"schema_version": 2, "rollback": "workspace_v2_to_v1", "from_backup": backup.as_posix(), "force_discard": force_discard_since_migration}


def migrate_tools_v1_to_v2(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("tools migration requires --acknowledge and --reason")
    root = Path(tools_dir)
    repo_root = _resolve_repo_root(workspace_root)
    _assert_workspace_binding(repo_root)
    root.mkdir(parents=True, exist_ok=True)
    with tools_lock(root, "tools_migration", repo_hash(repo_root)):
        version = tools_contract_version(root)
        if version >= 2:
            existing_state = _read_json(root / "migration_state.json")
            if existing_state and existing_state.get("phase") != "finalized":
                version = 1
            else:
                return {"schema_version": 2, "migration": "tools_v1_to_v2", "status": "already_v2", "warning": "tools root is already v2"}
        if version == 0 and not (root / "repo_identity.json").exists() and not _tools_has_covered_ledgers(root):
            _prepare_covered_tool_ledgers(root)
            identity = {
                "aria_tools_contract_version": 2,
                "bound_repo_hash": repo_hash(repo_root),
                "bound_repo_root": str(repo_root),
                "schema_version": 2,
            }
            _atomic_write_json(root / "repo_identity.json", identity)
            sync_tools_contract(root)
            if not (root / "registry.json").exists():
                _atomic_write_json(root / "registry.json", {"schema_version": TOOLS_SCHEMA_VERSION, "tools": []})
            _append_tools_migration_governance(
                root,
                "tools_root_bootstrapped",
                {"tools_dir": root.as_posix(), "schema_version": 2, "bound_repo_hash": repo_hash(repo_root)},
            )
            update_tools_index(root)
            return {"schema_version": 2, "migration": "tools_v1_to_v2", "status": "auto_bootstrapped"}

        _prepare_covered_tool_ledgers(root)
        existing_state = _read_json(root / "migration_state.json")
        if existing_state.get("phase") == "finalized":
            return dict(existing_state, status="already_finalized")

        source_state = _tools_source_state(root)
        empty_v0_state = not _tools_has_covered_ledgers(root)
        actor = default_actor()
        backup = Path(existing_state.get("backup_path") or _tools_backup_dir(root))
        dropped_legacy_fields: list[str] = []

        _append_tools_migration_governance(
            root,
            "migration_started",
            {
                "reason": reason,
                "acknowledged_by": actor,
                "source_state": source_state,
                "target_state": "tools_v2",
            },
        )
        _write_migration_state(root, "started", backup)
        _append_migration_phase(root, "started")

        _clean_orphan_partial_backups(root)
        if not backup.exists():
            _copy_tools_backup(root, backup)
        _write_migration_state(root, "copied", backup)
        _append_migration_phase(root, "copied")

        for path in covered_tool_ledgers(root).values():
            # ORPHAN-HIGH-552 — `stamp_row_format` is the appender's own
            # definition, so restamping rows the governed appender wrote is
            # the identity and this rewrite is byte-idempotent across a
            # restore. A private `_restamp` here is how two formats came to
            # share one file.
            rows = [stamp_row_format(row) for row in read_jsonl(path)]
            _rewrite_migration_jsonl(path, rows)
            result = verify_jsonl(path)
            if result.get("valid") is not True:
                raise GovernanceError(f"migration_validation_failed:{path.name}")
        _write_migration_state(root, "validated", backup)
        _append_migration_phase(root, "validated")

        identity = {
            "aria_tools_contract_version": 2,
            "bound_repo_hash": repo_hash(repo_root),
            "bound_repo_root": str(repo_root),
            "schema_version": 2,
        }
        _atomic_write_json(root / "repo_identity.json", identity)
        sync_tools_contract(root)
        if not (root / "registry.json").exists():
            _atomic_write_json(root / "registry.json", {"schema_version": TOOLS_SCHEMA_VERSION, "tools": []})
        index = _read_json(root / "integrity_index.json")
        if "pressure_keys_emitted" in index:
            dropped_legacy_fields.append("pressure_keys_emitted")
            index.pop("pressure_keys_emitted", None)
        update_tools_index(root)
        _write_migration_state(root, "finalized", backup)
        _append_migration_phase(root, "finalized")
        _append_tools_migration_governance(
            root,
            "migration_completed",
            {
                "reason": reason,
                "acknowledged_by": actor,
                "dropped_legacy_field": dropped_legacy_fields[0] if dropped_legacy_fields else None,
                "empty_v0_state": empty_v0_state,
            },
        )
        state = _read_json(root / "migration_state.json")
        state.update({"status": "completed", "completed_at": _now()})
        _atomic_write_json(root / "migration_state.json", state)
        update_tools_index(root)
        return state


def rollback_tools_v2_to_v1(
    *,
    tools_dir: str | Path,
    from_backup: str | Path,
    acknowledge: bool,
    reason: str,
    force_discard_since_migration: bool = False,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("tools rollback requires --acknowledge and --reason")
    root = Path(tools_dir)
    backup = Path(from_backup)
    with tools_lock(root, "tools_rollback", ""):
        actor = default_actor()
        discarded = _discarded_event_count(covered_tool_ledgers(root), backup)
        _guard_post_migration_rows(covered_tool_ledgers(root), backup, force_discard_since_migration)
        since_rows = _since_migration_rows(covered_tool_ledgers(root), backup) if force_discard_since_migration else []
        tmp_restore = root.parent / f".{root.name}.rollback-tmp"
        if tmp_restore.exists():
            shutil.rmtree(tmp_restore)
        shutil.copytree(backup, tmp_restore)
        if root.exists():
            shutil.rmtree(root)
        shutil.copytree(tmp_restore, root)
        shutil.rmtree(tmp_restore)
        if force_discard_since_migration:
            _rewrite_migration_jsonl(root / "since_migration_events.jsonl", since_rows)
            update_tools_index(root)
        _append_tools_migration_governance(
            root,
            "rollback_started",
            {
                "reason": reason,
                "acknowledged_by": actor,
                "from_backup": backup.as_posix(),
                "force_discard_since_migration": force_discard_since_migration,
            },
        )
        _append_tools_migration_governance(root, "rollback_phase", {"phase": "restored_backup", "restored_ledger": "all"})
        _append_tools_migration_governance(
            root,
            "rollback_completed",
            {
                "reason": reason,
                "acknowledged_by": actor,
                "restored_to_state": "tools_v1",
                "discarded_event_count": discarded if force_discard_since_migration else 0,
            },
        )
        return {"schema_version": 2, "rollback": "tools_v2_to_v1", "from_backup": backup.as_posix(), "force_discard": force_discard_since_migration}


def migrate_tools_v2_to_v3(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.8 + I-34 — migrate aria-tools/ from contract v2 to v3.

    Frozen-profile-aware: under ``ARIA_RUNTIME_PROFILE=frozen`` the
    write is rejected via the standard ``tool_governance`` gate so
    the no-write invariant cannot be accidentally bypassed through
    a contract upgrade.

    v2→v3 rebinds the tools root from environment-bound ``bound_repo_hash``
    (mixed-in filesystem path + remote URL) to environment-independent
    ``bound_canonical_identity`` (canonical remote URL only).

    Emits THREE separate audit events per AUDITTRAIL-MED-007 Rec E,
    linked via a shared ``migration_event_id``:
      1. ``tools_root_rebound_for_v3_identity_recipe`` — new binding
      2. ``tools_root_schema_stripped`` — committed file mutation
      3. ``aria_tools_contract_version_bumped`` — version field change

    Idempotent: re-running on a v3 tree returns ``already_at_target``.
    """
    if not acknowledge or not reason.strip():
        raise ValueError("v2-to-v3 tools migration requires --acknowledge and --reason")
    root = Path(tools_dir)
    # Plan ARIA-V2 I-34 — frozen-profile guard. Migration is a high-
    # impact write to aria-tools/repo_identity.json + governance.jsonl;
    # the tool_governance gate rejects under frozen.
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("tool_governance", base_dir=str(root))
    repo_root = _resolve_repo_root(workspace_root)
    if not (root / "repo_identity.json").exists():
        raise GovernanceError("tools_v2_to_v3_no_identity: aria-tools/repo_identity.json missing")
    identity = _read_json(root / "repo_identity.json")
    current_version = int(identity.get("aria_tools_contract_version") or identity.get("schema_version") or 1)
    if current_version >= TOOLS_SCHEMA_VERSION:
        return {
            "schema_version": TOOLS_SCHEMA_VERSION,
            "migration": "tools_v2_to_v3",
            "status": "already_at_target",
            "current_version": current_version,
        }
    if current_version < 2:
        raise GovernanceError(
            f"tools_v2_to_v3_requires_v2_first: current={current_version} — "
            "run migrate_tools_v1_to_v2 first, or use migrate_tools_bootstrap"
        )
    legacy_bound = identity.get("bound_repo_hash")
    new_canonical = canonical_identity(repo_root)
    identity_source = canonical_identity_source(repo_root)
    actor = default_actor()
    migration_event_id = f"MIG-tools-v2-v3-{hashlib.sha256(f'{root}{actor}{_now()}'.encode()).hexdigest()[:16]}"
    pre_strip_hash = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    # Event 1: rebind for v3 recipe
    append_tools_governance(
        root,
        "tools_root_rebound_for_v3_identity_recipe",
        {
            "migration_event_id": migration_event_id,
            "legacy_bound_repo_hash": legacy_bound,
            "new_bound_canonical_identity": new_canonical,
            "bound_repo_root": str(repo_root),
            "identity_source": identity_source["source"],
            "reason": reason,
            "acknowledged_by": actor,
        },
    )
    if identity_source["source"] != "remote_url":
        append_tools_governance(
            root,
            "canonical_identity_offline_fallback",
            {
                "migration_event_id": migration_event_id,
                "identity_source": identity_source["source"],
                "seed_summary": identity_source["normalized"][:64],
                "canonical_identity": new_canonical,
            },
        )
    # Event 2: schema strip (committed file mutation)
    new_identity = {
        "aria_tools_contract_version": TOOLS_SCHEMA_VERSION,
        "schema_version": TOOLS_SCHEMA_VERSION,
        "bound_canonical_identity": new_canonical,
        "bound_repo_hash": new_canonical,  # legacy mirror for tolerance
        "bound_repo_root": str(repo_root),
    }
    _atomic_write_json(root / "repo_identity.json", new_identity)
    sync_tools_contract(root)
    post_strip_hash = hashlib.sha256(json.dumps(new_identity, sort_keys=True).encode()).hexdigest()
    append_tools_governance(
        root,
        "tools_root_schema_stripped",
        {
            "migration_event_id": migration_event_id,
            "pre_strip_content_hash": f"sha256:{pre_strip_hash}",
            "post_strip_content_hash": f"sha256:{post_strip_hash}",
            "reason": reason,
            "acknowledged_by": actor,
        },
    )
    # Event 3: contract version bump
    append_tools_governance(
        root,
        "aria_tools_contract_version_bumped",
        {
            "migration_event_id": migration_event_id,
            "from_version": current_version,
            "to_version": TOOLS_SCHEMA_VERSION,
            "reason": reason,
            "acknowledged_by": actor,
        },
    )
    update_tools_index(root)
    return {
        "schema_version": TOOLS_SCHEMA_VERSION,
        "migration": "tools_v2_to_v3",
        "status": "completed",
        "migration_event_id": migration_event_id,
        "legacy_bound_repo_hash": legacy_bound,
        "new_bound_canonical_identity": new_canonical,
        "identity_source": identity_source["source"],
    }


def migrate_tools_bootstrap(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.8 — idempotent umbrella migration to v3.

    Detects current contract version and applies the necessary chain:
      * v0/v1 → v1→v2 (existing) → v2→v3 (new)
      * v2    → v2→v3
      * v3    → no-op, status ``already_at_target``

    This is the recommended CLI for operators; ``migrate-tools-v1-to-v2``
    and ``migrate-tools-v2-to-v3`` remain available for surgical use.
    """
    if not acknowledge or not reason.strip():
        raise ValueError("bootstrap tools migration requires --acknowledge and --reason")
    root = Path(tools_dir)
    # Plan ARIA-V2 I-34 — frozen-profile guard at the umbrella entry
    # point too; chained migrations would otherwise mutate before the
    # underlying step's gate fires.
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("tool_governance", base_dir=str(root))
    current_version = tools_contract_version(root) if root.exists() else 0
    # ORPHAN-HIGH-556 — a MIGRATION IS NOT A BIND, and this is where the two
    # used to be indistinguishable. Now that the tree publishes its own
    # contract version, a restored tree already at the target reaches here
    # with nothing to migrate — and returning `already_at_target` would hand
    # back a success for a root that still has no host identity and still
    # fails `ensure_tools_dir` as `ambiguous_tools_root`. Refusing names the
    # operation the caller actually wanted instead of leaving them a tree that
    # reports healthy and cannot be used.
    if (
        root.exists()
        and current_version >= TOOLS_SCHEMA_VERSION
        and not (root / "repo_identity.json").exists()
    ):
        raise GovernanceError(
            "tools_root_needs_binding_not_migration: the tree is already at "
            f"contract v{current_version} and has no host identity. Run "
            "`aria-kernel integrity bind-tools-root` — a migration cannot bind "
            "a root, and this one has nothing to migrate."
        )
    chain = []
    if current_version < 2:
        v2_result = migrate_tools_v1_to_v2(
            tools_dir=tools_dir,
            workspace_root=workspace_root,
            acknowledge=acknowledge,
            reason=reason,
        )
        chain.append({"step": "v1_to_v2", "result": v2_result})
    new_version = tools_contract_version(root)
    if new_version < 3:
        v3_result = migrate_tools_v2_to_v3(
            tools_dir=tools_dir,
            workspace_root=workspace_root,
            acknowledge=acknowledge,
            reason=reason,
        )
        chain.append({"step": "v2_to_v3", "result": v3_result})
    final_version = tools_contract_version(root)
    return {
        "schema_version": TOOLS_SCHEMA_VERSION,
        "migration": "tools_bootstrap",
        "status": "completed" if chain else "already_at_target",
        "starting_version": current_version,
        "final_version": final_version,
        "chain": chain,
    }


def rollback_tools_v3_to_v2(
    *,
    tools_dir: str | Path,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.8 — reverse migration for rollback parity.

    Strips ``bound_canonical_identity`` from ``aria-tools/repo_identity.json``
    and downgrades ``aria_tools_contract_version`` from 3 to 2. The
    legacy ``bound_repo_hash`` field is preserved so the v2 codepath
    continues to work after rollback. Operator-driven only — every
    rollback emits ``aria_tools_contract_version_rolled_back`` audit row.
    """
    if not acknowledge or not reason.strip():
        raise ValueError("v3-to-v2 tools rollback requires --acknowledge and --reason")
    root = Path(tools_dir)
    if not (root / "repo_identity.json").exists():
        raise GovernanceError("rollback_no_identity: aria-tools/repo_identity.json missing")
    identity = _read_json(root / "repo_identity.json")
    current_version = int(identity.get("aria_tools_contract_version") or identity.get("schema_version") or 1)
    if current_version != 3:
        return {
            "schema_version": current_version,
            "rollback": "tools_v3_to_v2",
            "status": "not_at_v3",
            "current_version": current_version,
        }
    actor = default_actor()
    rolled_back = {
        "aria_tools_contract_version": 2,
        "schema_version": 2,
        "bound_repo_hash": identity.get("bound_repo_hash") or identity.get("bound_canonical_identity"),
        "bound_repo_root": identity.get("bound_repo_root"),
    }
    _atomic_write_json(root / "repo_identity.json", rolled_back)
    # The rollback is a WRITER too. `sync_tools_contract` was wired into every
    # forward writer and the reverse ones were missed, so a rollback downgraded
    # the identity to v2 while the published contract went on claiming v3 —
    # and `tools_contract_version` reads the contract first. Caught by
    # `test_rollback_v3_to_v2_downgrades_contract`, which is the whole reason
    # a reverse migration has a test at all.
    sync_tools_contract(root)
    append_tools_governance(
        root,
        "aria_tools_contract_version_rolled_back",
        {
            "from_version": 3,
            "to_version": 2,
            "reason": reason,
            "acknowledged_by": actor,
        },
    )
    update_tools_index(root)
    return {
        "schema_version": 2,
        "rollback": "tools_v3_to_v2",
        "status": "completed",
    }


def _migrate_workspace_ledgers(paths: WorkspacePaths) -> None:
    for name in ("unknowns", "missed_signals", "external_feedback"):
        path = paths.ledgers[name]
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [normalize_feedback_event(row) for row in read_jsonl(path)]
        _rewrite_migration_jsonl(path, rows)
    pressure_rows = []
    id_map = _legacy_feedback_id_map(paths)
    for row in read_jsonl(paths.ledgers["pressure"]):
        migrated = dict(stamp_row_format(row))
        migrated["$schema"] = "aria/pressure-event/v2"
        migrated["schema_version"] = 2
        legacy_ids = [str(item) for item in row.get("feedback_event_ids", []) if isinstance(item, str)]
        feedback_ids = sorted(id_map.get(item, item) for item in legacy_ids)
        migrated["feedback_event_ids"] = feedback_ids
        migrated["legacy_feedback_event_ids"] = legacy_ids
        migrated["legacy_event_ids"] = [row["event_id"]] if isinstance(row.get("event_id"), str) else []
        primitive = str(migrated.get("primitive") or migrated.get("type") or "UNKNOWN")
        subtype = str(migrated.get("subtype") or "legacy")
        migrated["evidence_fingerprint"] = pressure_evidence_fingerprint(primitive, subtype, feedback_ids)
        pressure_rows.append(migrated)
    _rewrite_migration_jsonl(paths.ledgers["pressure"], pressure_rows)
    paths.ledgers["governance"].parent.mkdir(parents=True, exist_ok=True)
    paths.ledgers["governance"].touch(exist_ok=True)


def _legacy_feedback_id_map(paths: WorkspacePaths) -> dict[str, str]:
    result = {}
    for name in ("unknowns", "missed_signals", "external_feedback"):
        for row in read_jsonl(paths.ledgers[name]):
            for legacy in row.get("legacy_event_ids", []):
                result[str(legacy)] = str(row.get("event_id"))
    return result


def _pressure_fingerprints(paths: WorkspacePaths) -> list[str]:
    return sorted(
        str(row["evidence_fingerprint"])
        for row in read_jsonl(paths.ledgers["pressure"])
        if isinstance(row.get("evidence_fingerprint"), str)
    )


def _backup_dir(root: Path, label: str) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root.parent / f"{root.name}.backup.{label}.{ts}"


def _tools_backup_dir(root: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root / ".backups" / f"migration-v0-to-v2-{ts}"


def _prepare_covered_tool_ledgers(root: Path) -> None:
    (root / "fixtures").mkdir(parents=True, exist_ok=True)
    for path in covered_tool_ledgers(root).values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)


def _tools_has_covered_ledgers(root: Path) -> bool:
    return any(path.exists() and path.stat().st_size > 0 for path in covered_tool_ledgers(root).values())


def _tools_source_state(root: Path) -> str:
    identity = _read_json(root / "repo_identity.json")
    if not identity:
        return "tools_v0_identity_missing"
    version = int(identity.get("aria_tools_contract_version") or identity.get("schema_version") or 1)
    return f"tools_v{version}"


def _resolve_repo_root(workspace_root: str | Path) -> Path:
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=Path(workspace_root),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise GovernanceError("repo_resolution_failed")
    return Path(completed.stdout.strip()).resolve()


def _assert_workspace_binding(repo_root: Path) -> None:
    paths = workspace_paths(repo_root)
    if not paths.identity_file.exists():
        return
    identity = _read_json(paths.identity_file)
    existing = identity.get("repo_hash")
    expected = repo_hash(repo_root)
    if existing and existing != expected:
        raise GovernanceError("binding_mismatch")


def _copy_tools_backup(root: Path, backup: Path) -> None:
    backup.parent.mkdir(parents=True, exist_ok=True)
    partial = backup.with_name(f"{backup.name}.partial")
    if partial.exists():
        shutil.rmtree(partial)
    shutil.copytree(root, partial, ignore=shutil.ignore_patterns(".backups", "tools.lock"))
    partial.replace(backup)


def _clean_orphan_partial_backups(root: Path) -> None:
    backups = root / ".backups"
    if not backups.exists():
        return
    for partial in backups.glob("migration-v0-to-v2-*.partial"):
        shutil.rmtree(partial)
        _append_tools_migration_governance(root, "orphan_partial_backup_cleaned", {"path": partial.as_posix()})


def _write_migration_state(root: Path, phase: str, backup: Path) -> None:
    payload = {
        "schema_version": 2,
        "migration": "tools_v1_to_v2",
        "phase": phase,
        "phases": list(MIGRATION_PHASES[: MIGRATION_PHASES.index(phase) + 1]),
        "backup_path": backup.as_posix(),
        "updated_at": _now(),
    }
    _atomic_write_json(root / "migration_state.json", payload)
    update_tools_index(root)


def _append_migration_phase(root: Path, phase: str) -> None:
    _append_tools_migration_governance(root, "migration_phase", {"phase": phase, "schema_from": 1, "schema_to": 2})


@contextmanager
def tools_lock(root: Path, operation: str, target_repo_hash: str) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "tools.lock"
    deadline = time.monotonic() + TOOLS_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            payload = {
                "operation": operation,
                "pid": os.getpid(),
                "actor": default_actor(),
                "started_at": _now(),
                "target_repo_hash": target_repo_hash,
            }
            os.write(fd, json.dumps(payload, sort_keys=True).encode("utf-8"))
            os.close(fd)
            break
        except FileExistsError as exc:
            if _reap_stale_lock(lock_path, root):
                continue
            if time.monotonic() >= deadline:
                raise GovernanceError("tools_root_locked") from exc
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _reap_stale_lock(lock_path: Path, root: Path) -> bool:
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8") or "{}")
        started = datetime.fromisoformat(str(payload.get("started_at", "")).replace("Z", "+00:00"))
    except (OSError, ValueError, json.JSONDecodeError):
        started = datetime.fromtimestamp(0, timezone.utc)
        payload = {}
    age = (datetime.now(timezone.utc) - started.astimezone(timezone.utc)).total_seconds()
    pid = int(payload.get("pid") or 0)
    if age < TOOLS_LOCK_STALE_SECONDS:
        return False
    if pid > 0 and _pid_exists(pid):
        return False
    try:
        lock_path.unlink()
    except FileNotFoundError:
        return False
    _append_tools_migration_governance(
        root,
        "lock_reaped",
        {"stale_lock_pid": pid, "lock_age_seconds": int(age), "reaped_by_pid": os.getpid()},
    )
    return True


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _discarded_event_count(current: dict[str, Path], backup_root: Path) -> int:
    discarded = 0
    for path in current.values():
        backup_path = backup_root / path.relative_to(path.parent)
        discarded += max(0, len(read_jsonl(path)) - len(read_jsonl(backup_path)))
    return discarded


def _guard_post_migration_rows(current: dict[str, Path], backup_root: Path, force: bool) -> None:
    if force:
        return
    for name, path in current.items():
        backup_path = backup_root / path.name
        if backup_root.name != "aria-memory":
            backup_path = backup_root / path.relative_to(path.parent)
        if len(read_jsonl(path)) > len(read_jsonl(backup_path)):
            raise ValueError(f"post_migration_rows_present:{name}")


def _since_migration_rows(current: dict[str, Path], backup_root: Path) -> list[dict[str, Any]]:
    rows = []
    for name, path in current.items():
        backup_path = backup_root / path.name
        rows.extend({"ledger": name, "row": row} for row in read_jsonl(path)[len(read_jsonl(backup_path)) :])
    return rows


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
