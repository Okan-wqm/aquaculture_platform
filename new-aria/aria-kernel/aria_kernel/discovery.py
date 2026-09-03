from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from .snapshot import build_repo_snapshot
from .tool_registry import append_tools_governance, ensure_tools_binding, ensure_tools_dir, utc_now

# Plan ARIA-V2 §3.6 + I-22 — both the ARIA Phase-1 PoC and the kernel
# discovery engine MUST consume the *same* exclusion frozenset
# (``poc.EXCLUDED_DIRS is discovery.EXCLUDED_DIRS``). The bootstrap
# below makes ``tools.shared`` importable from any CWD by computing
# the repo root from ``__file__`` (Tier-1: import resolution becomes
# a function of file layout, not operator-environment PYTHONPATH).
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.shared.excluded_paths import (
    BASE_EXCLUDED_DIRS as EXCLUDED_DIRS,
    augmented_excluded_paths,
)


def run_discovery(
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
    snapshot_mode: str = "committed",
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=root)
    snapshot = build_repo_snapshot(workspace_root=root, mode=snapshot_mode, enforce_clean=False)
    if snapshot_mode == "committed" and snapshot.get("dirty_paths"):
        dirty_paths = snapshot.get("dirty_paths", [])
        message = f"warning: committed snapshot ignores {len(dirty_paths)} dirty/staged path(s)"
        print(message, file=sys.stderr)
        append_tools_governance(
            tools_root,
            "discovery_dirty_tree_skipped",
            # Plan ARIA-V3.2 §2c (F-010-D3) — every cycle-bound
            # governance event MUST carry cycle_id so replay tools
            # filtering by cycle correctly surface the dirty-tree
            # decision. Sibling event ``discovery_legacy_field_emitted``
            # below also includes it (line 66). Invariant I-V3.2-08
            # locks the closed allowlist contract.
            {
                "dirty_files_count": len(dirty_paths),
                "head_sha": snapshot.get("base_commit_sha"),
                "cycle_id": cycle_id,
            },
        )
    fates = snapshot["fates"]
    missing = [fate["path"] for fate in fates if fate["fate"] == "unknown"]
    file_counts = snapshot["file_counts"]
    legacy_tracked_file_count = file_counts["allowed"]
    fingerprint = _repo_fingerprint(root, fates, file_counts)
    # Plan ARIA-V2 §3.5 + I-37 — single-fire deprecation event when
    # the legacy ``web_module_count`` field is computed. The field is
    # preserved for backward-compat with downstream consumers but the
    # event names the rename (``web_mfe_count`` is the canonical
    # successor) so future drops are detectable at audit time.
    append_tools_governance(
        tools_root,
        "discovery_legacy_field_emitted",
        {
            "legacy_field": "web_module_count",
            "canonical_successor": "web_mfe_count",
            "severity": "deprecation",
            "removal_target": "v4",
            "cycle_id": cycle_id,
        },
    )
    service_map = _service_map(root)
    completion_proof = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "generated_at": utc_now(),
        "base_commit_sha": snapshot.get("base_commit_sha"),
        "repo_state_id": snapshot.get("repo_state_id"),
        "snapshot_hash": snapshot.get("snapshot_hash"),
        "snapshot_mode": snapshot.get("snapshot_mode"),
        "dirty_snapshot": snapshot.get("dirty_snapshot", False),
        "dirty_path_count": len(snapshot.get("dirty_paths", [])),
        "file_counts": file_counts,
        "tracked_file_count": legacy_tracked_file_count,
        "legacy_tracked_file_count": legacy_tracked_file_count,
        "fated_file_count": file_counts["fated"],
        "unknown_count": file_counts["unknown"],
        "missing_fates": missing,
        "complete": len(snapshot.get("allowed_paths", [])) <= len(fates) and not missing,
    }

    output_dir = tools_root / "discovery" / cycle_id
    _write_json(output_dir / "FATES.json", {"schema_version": 1, "cycle_id": cycle_id, "files": fates})
    _write_json(output_dir / "SNAPSHOT.json", {key: value for key, value in snapshot.items() if key != "fates"})
    _write_json(output_dir / "REPO_FINGERPRINT.json", fingerprint)
    _write_json(output_dir / "SERVICE_MAP.json", service_map)
    _write_json(output_dir / "COMPLETION_PROOF.json", completion_proof)
    return {
        "fates": fates,
        "fingerprint": fingerprint,
        "service_map": service_map,
        "completion_proof": completion_proof,
        "snapshot": {key: value for key, value in snapshot.items() if key != "fates"},
        "artifact_dir": output_dir.as_posix(),
    }


def _repo_fingerprint(root: Path, fates: list[dict[str, Any]], file_counts: dict[str, int]) -> dict[str, Any]:
    language_histogram = Counter(str(fate.get("suffix") or "<none>") for fate in fates)
    legacy_tracked_file_count = len(fates)
    migration_ts_paths = sorted(
        str(fate.get("path", ""))
        for fate in fates
        if _is_migration_ts_path(str(fate.get("path", "")))
    )
    migration_ts_count = len(migration_ts_paths)
    # Plan ARIA-V2 §3.5 — a bounded list of CONCRETE migration file paths so
    # memory.py can seed the migration-surface belief with repo-verifiable
    # evidence_refs (a ``apps/*/.../*.ts`` glob is not a resolvable evidence
    # ref and fails L1 grounded-evidence verification). Active (non-archived)
    # migrations are preferred so the evidence describes the live schema.
    migration_evidence_paths = [
        p for p in migration_ts_paths if "/.archive/" not in p
    ][:5]
    migration_sql_count = sum(
        1
        for fate in fates
        if str(fate.get("path", "")).startswith("apps/")
        and "/src/database/migrations/" in str(fate.get("path", ""))
        and str(fate.get("path", "")).endswith(".sql")
    )
    web_modules_children = _children(root / "web" / "modules")
    web_mfe_count = len(web_modules_children)
    return {
        "schema_version": 2,
        "generated_at": utc_now(),
        "file_counts": file_counts,
        "tracked_file_count": legacy_tracked_file_count,
        "legacy_tracked_file_count": legacy_tracked_file_count,
        "fated_file_count": file_counts["fated"],
        "language_histogram": dict(sorted(language_histogram.items())),
        "service_count": len(_children(root / "apps")),
        "web_dir_child_count": len(_children(root / "web")),
        # Plan ARIA-V2 §3.5 — ``web_mfe_count`` is the canonical name.
        # ``web_module_count`` preserved as legacy mirror (same value)
        # for backward-compat with downstream consumers; deprecation
        # event ``discovery_legacy_field_emitted`` fires once per
        # cycle so the rename is audit-visible. Removal target: v4.
        "web_mfe_count": web_mfe_count,
        "web_module_count": web_mfe_count,
        "web_app_count": len(_children(root / "web" / "apps")),
        "platform_lib_count": len(_children(root / "platform/libs")),
        "shared_lib_count": len(_children(root / "libs")),
        "adr_count": len(list((root / "docs/adr").glob("*.md"))) if (root / "docs/adr").exists() else 0,
        "migration_ts_count": migration_ts_count,
        "migration_sql_count": migration_sql_count,
        "migration_count": migration_ts_count + migration_sql_count,
        "has_nx": (root / "nx.json").exists(),
        "has_package_json": (root / "package.json").exists(),
        # Plan ARIA-V2 §3.5 — surface the MFEs missing project.json so
        # downstream memory.py can emit ``web-modules-missing-project-json``
        # belief with concrete evidence_refs.
        "web_modules_missing_project_json": [
            child.relative_to(root).as_posix()
            for child in web_modules_children
            if not (child / "project.json").exists()
        ],
        "migration_evidence_paths": migration_evidence_paths,
    }


def _is_migration_ts_path(path: str) -> bool:
    return (
        path.startswith("apps/")
        and "/src/database/migrations/" in path
        and path.endswith(".ts")
        and not path.endswith(".spec.ts")
    )


def _service_map(root: Path) -> dict[str, Any]:
    """Plan ARIA-V2 §3.5 — SERVICE_MAP v2 typed-buckets shape.

    Pre-§3.5 ``web`` was a flat list of top-level web/* directory
    children (4 entries: apps, modules, shared-ui, shell). The MFEs
    under web/modules/ were never enumerated, so drift surfaces on
    individual MFEs (e.g. dashboard's sensor-service drift) couldn't
    be discovered by downstream consumers reading SERVICE_MAP.

    Post-§3.5 ``web`` becomes a typed dict with explicit buckets so
    consumers can drill into MFE / app / shell layers separately:

      web: {
        modules: [...7 MFE rows...],
        apps: [...AquaMobil row...],
        shared_ui: [...shared-ui row...],
        shell: [...shell row...],
      }

    schema_version bumped to 2; v1 consumers read the legacy flat
    shape via upcasters.service_map_v1_to_v2.downcast().
    """
    return {
        "schema_version": 2,
        "generated_at": utc_now(),
        "apps": _project_rows(root, "apps"),
        "web": {
            "modules": _project_rows(root, "web/modules"),
            "apps": _project_rows(root, "web/apps"),
            "shared_ui": _project_rows_at_path(root, "web/shared-ui"),
            "shell": _project_rows_at_path(root, "web/shell"),
        },
        "platform_libs": _project_rows(root, "platform/libs"),
        "libs": _project_rows(root, "libs"),
    }


# Plan ARIA-V2 §3.5 — MFE allowlist used as a fallback signal in
# ``is_leaf_project``. Children matching this allowlist are recognized
# as leaf projects even when project.json is missing; the gap is
# surfaced separately via ``web_modules_missing_project_json``.
_MFE_NAME_ALLOWLIST: frozenset[str] = frozenset({
    "dashboard",
    "farm-module",
    "sensor-module",
    "hr-module",
    "admin-panel",
    "tenant-admin",
    "hydroponics-module",
})


def is_leaf_project(child: Path) -> bool:
    """Plan ARIA-V2 §3.5 + I-17 — decide whether a directory is a
    project leaf based on locally-observable markers ONLY.

    The predicate is Tier-1 idempotent: it inspects ``child`` direct
    contents and the child's name; it does NOT recurse into the
    subtree. Removing this invariant would let SERVICE_MAP collapse
    multi-level project hierarchies into nested-confusion, breaking
    the v2 typed-bucket contract.

    Markers (any one is sufficient):
      * ``child / "project.json"`` exists (Nx project)
      * ``child / "Cargo.toml"`` exists (Rust crate)
      * child name is in the MFE allowlist (legacy guard for MFEs
        that haven't gained project.json yet; surfaced separately
        via ``web_modules_missing_project_json`` belief)
    """
    if (child / "project.json").is_file():
        return True
    if (child / "Cargo.toml").is_file():
        return True
    if child.name in _MFE_NAME_ALLOWLIST:
        return True
    return False


def _project_rows(root: Path, relative_dir: str) -> list[dict[str, Any]]:
    """Plan ARIA-V2 §3.5 — recursive project-rows walk.

    At each level, if any child satisfies ``is_leaf_project`` the
    function enumerates those leaves and stops descending. If no
    child is a leaf but children exist, recurse one level deeper.
    This handles nested structures (e.g. web/modules/<mfe>) without
    requiring the caller to know the depth ahead of time.
    """
    base = root / relative_dir
    rows: list[dict[str, Any]] = []
    children = _children(base)
    if not children:
        return rows
    if any(is_leaf_project(child) for child in children):
        for child in children:
            rows.append(_project_row(root, child))
        return rows
    # No leaves at this level — recurse one level into each subdir.
    for child in children:
        rows.extend(_project_rows(root, child.relative_to(root).as_posix()))
    return rows


def _project_rows_at_path(root: Path, relative_path: str) -> list[dict[str, Any]]:
    """Plan ARIA-V2 §3.5 — single-project row variant for known leaves
    like ``web/shared-ui`` and ``web/shell`` that are themselves the
    project (not parent directories of sibling projects).
    """
    target = root / relative_path
    if not target.exists() or not target.is_dir():
        return []
    return [_project_row(root, target)]


def _project_row(root: Path, child: Path) -> dict[str, Any]:
    return {
        "name": child.name,
        "path": child.relative_to(root).as_posix(),
        "has_project_json": (child / "project.json").exists(),
        "has_readme": (child / "README.md").exists(),
        "is_leaf_project": is_leaf_project(child),
    }


def _children(path: Path) -> list[Path]:
    if not path.exists() or not path.is_dir():
        return []
    return sorted(child for child in path.iterdir() if child.is_dir())


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
