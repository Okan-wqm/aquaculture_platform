from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .cycle_progress import emit_progress
from .tool_registry import GovernanceError, utc_now


SNAPSHOT_MODES = ("committed", "working_tree", "working-tree")
# Plan 023 v3 §C-1 — `aria-tools/` removed from this filter.
#
# Why: pre-fix the kernel-managed ledger directory was excluded from
# every dirty-path observation (build_repo_snapshot for spine/baseline
# AND _workspace_snapshot_raw for tool_runner mutation diff). A buggy or
# malicious adapter that wrote to aria-tools/registry.json,
# aria-tools/governance.jsonl, or any other ledger inside aria-tools/
# was therefore invisible to scope-out detection — _partition_mutations
# never received the path to classify because the upstream filter
# already dropped it. Removing the prefix makes those writes flow
# through to scope-out detection without changing the partition or
# quarantine logic that was already correct.
#
# Note on tool_runner audit-trail: record_run appends the runner's own
# row to aria-tools/runs.jsonl AFTER the post-snapshot is taken
# (tool_health.py:97 runs after _partition_mutations in tool_runner.py).
# The runner's own ledger write therefore does not appear in the
# before/after diff and no allowlist for it is needed.
DIRTY_IGNORE_PREFIXES = (
    "aria-kernel/aria_kernel/__pycache__/",
    "aria-kernel/tests/__pycache__/",
    "aria-kernel/aria_kernel.egg-info/",
    "aria-kernel/.pytest_cache/",
    ".nx/cache/",
    "node_modules/",
)
DIRTY_IGNORE_EXACT: set[str] = set()
GENERATED_PREFIXES = ("dist/", "coverage/", ".nx/cache/", "node_modules/")
GENERATED_PARTS = ("/dist/", "/coverage/", "/.nx/cache/", "/node_modules/")


def build_repo_snapshot(
    *,
    workspace_root: str | os.PathLike[str],
    mode: str = "committed",
    enforce_clean: bool = False,
) -> dict[str, Any]:
    if mode not in SNAPSHOT_MODES:
        raise GovernanceError(f"unknown snapshot mode: {mode}")
    mode = "working_tree" if mode == "working-tree" else mode
    root = Path(workspace_root).resolve()
    git_available = _git_available(root)
    dirty_paths = _dirty_paths(root) if git_available else []
    dirty_blockers = [path for path in dirty_paths if not ignored_dirty_path(path)]
    if mode == "committed" and enforce_clean and dirty_blockers:
        raise GovernanceError(f"workspace_dirty_blocked: {', '.join(dirty_blockers[:20])}")

    git_tracked_paths: list[str] = []
    working_tree_paths: list[str] = []
    if git_available:
        git_tracked_paths = _git_lines(root, ["ls-files"])
        working_tree_paths = sorted(set(git_tracked_paths + _git_lines(root, ["ls-files", "--others", "--exclude-standard"])))
        paths = git_tracked_paths
        if mode == "working_tree":
            paths = working_tree_paths
    else:
        paths = _filesystem_paths(root)
        git_tracked_paths = paths
        working_tree_paths = paths

    # The per-file fate+content-hash pass is the long part of a cycle (~2 min on
    # the real repo). Emit a coarse live progress tick every 2000 files so an
    # operator watching ARIA work sees the scan advancing instead of a 2-minute
    # silence (gated by ARIA_CYCLE_PROGRESS; a no-op otherwise).
    _committed = mode == "committed" and git_available
    _total = len(paths)
    fates = []
    for _i, path in enumerate(paths):
        fates.append(_file_fate(root, path, committed=_committed))
        if _i % 2000 == 0:
            emit_progress("discovery_scan", scanned=_i, total=_total)
    emit_progress("discovery_scan", scanned=_total, total=_total)
    allowed_paths = sorted(row["path"] for row in fates if row.get("fate") == "tracked")
    file_counts = _file_counts(
        git_tracked_paths=git_tracked_paths,
        working_tree_paths=working_tree_paths,
        allowed_paths=allowed_paths,
        fates=fates,
    )
    legacy_tracked_file_count = file_counts["allowed"]
    snapshot = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "snapshot_mode": mode,
        "dirty_snapshot": mode == "working_tree" and bool(dirty_blockers),
        "base_commit_sha": _git_rev_parse(root, "HEAD") if git_available else None,
        "file_counts": file_counts,
        "tracked_file_count": legacy_tracked_file_count,
        "legacy_tracked_file_count": legacy_tracked_file_count,
        "fated_file_count": file_counts["fated"],
        "unknown_count": file_counts["unknown"],
        "allowed_paths": allowed_paths,
        "dirty_paths": dirty_blockers,
        "generated_paths": sorted(row["path"] for row in fates if row.get("fate") == "generated"),
        "fates": fates,
    }
    snapshot["snapshot_hash"] = _snapshot_hash(snapshot)
    snapshot["repo_state_id"] = _repo_state_id(snapshot)
    return snapshot


def snapshot_allowed_set(snapshot: dict[str, Any] | None) -> set[str]:
    if not isinstance(snapshot, dict):
        return set()
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return set()
    return {normalize_path(path) for path in allowed if isinstance(path, str) and path.strip()}


def file_counts_from_payload(payload: dict[str, Any], *, fallback_fated: int | None = None) -> dict[str, int]:
    counts = payload.get("file_counts")
    if isinstance(counts, dict):
        return _normalize_file_counts(counts)
    legacy = _as_int(payload.get("legacy_tracked_file_count"), _as_int(payload.get("tracked_file_count"), fallback_fated or 0))
    fated = _as_int(payload.get("fated_file_count"), fallback_fated if fallback_fated is not None else legacy)
    generated = _as_int(payload.get("generated_file_count"), 0)
    unknown = _as_int(payload.get("unknown_count"), 0)
    return {
        "git_tracked": legacy,
        "working_tree": fated,
        "allowed": legacy,
        "generated": generated,
        "unknown": unknown,
        "fated": fated,
    }


def normalize_path(raw_path: Any) -> str:
    path = str(raw_path).replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def _git_available(root: Path) -> bool:
    return _run_git(root, ["rev-parse", "--is-inside-work-tree"]).returncode == 0


def _git_lines(root: Path, args: list[str]) -> list[str]:
    completed = _run_git(root, args)
    if completed.returncode != 0:
        return []
    return sorted(path for path in completed.stdout.splitlines() if path)


def _git_rev_parse(root: Path, ref: str) -> str | None:
    completed = _run_git(root, ["rev-parse", ref])
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def _dirty_paths(root: Path) -> list[str]:
    completed = _run_git(root, ["status", "--porcelain", "-z", "--untracked-files=all"])
    if completed.returncode != 0:
        return []
    entries = [entry for entry in completed.stdout.split("\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:
            skip_next = False
            continue
        status = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry
        if status.startswith("R") or status.startswith("C"):
            skip_next = True
        if path:
            paths.append(normalize_path(path))
    return sorted(set(paths))


def ignored_dirty_path(path: str) -> bool:
    normalized = normalize_path(path)
    return normalized in DIRTY_IGNORE_EXACT or any(normalized.startswith(prefix) for prefix in DIRTY_IGNORE_PREFIXES)


def _file_counts(
    *,
    git_tracked_paths: list[str],
    working_tree_paths: list[str],
    allowed_paths: list[str],
    fates: list[dict[str, Any]],
) -> dict[str, int]:
    return {
        "git_tracked": len(git_tracked_paths),
        "working_tree": len(working_tree_paths),
        "allowed": len(allowed_paths),
        "generated": sum(1 for row in fates if row.get("fate") == "generated"),
        "unknown": sum(1 for row in fates if row.get("fate") == "unknown"),
        "fated": len(fates),
    }


def _normalize_file_counts(raw_counts: dict[str, Any]) -> dict[str, int]:
    return {
        "git_tracked": _as_int(raw_counts.get("git_tracked"), 0),
        "working_tree": _as_int(raw_counts.get("working_tree"), 0),
        "allowed": _as_int(raw_counts.get("allowed"), 0),
        "generated": _as_int(raw_counts.get("generated"), 0),
        "unknown": _as_int(raw_counts.get("unknown"), 0),
        "fated": _as_int(raw_counts.get("fated"), 0),
    }


def _as_int(value: Any, default: int) -> int:
    return value if isinstance(value, int) else default


def _run_git(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)


def _run_git_bytes(root: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=False, check=False)


def _filesystem_paths(root: Path) -> list[str]:
    """Plan ARIA-V2 §3.4 — non-git snapshot walker.

    In a real git repo, ``git ls-files`` returns only tracked files and
    the canonical ``aria-tools/`` runtime ledgers are gitignored — so
    they never reach FATES and never trigger ``memory_fates_content_hash_mismatch``.
    In a fresh tempdir there is no git repo and no ``.gitignore``, so
    the walker has to skip the kernel-internal runtime directories
    itself. Without this, every cycle run in a tempdir produces FATES
    entries for mutating files (governance.jsonl, runs.jsonl …) and the
    Plan-026R §E.7 integrity check then raises against the cycle's
    own append-only writes (false positive that masks real input
    validation errors).

    The skip set mirrors the shared ``BASE_EXCLUDED_DIRS`` frozenset
    plus ``aria-tools`` itself (which is NOT in BASE_EXCLUDED_DIRS
    because operator tooling can legitimately walk into
    ``aria-tools/agent-evals/fixtures`` for read-only purposes). Treating
    aria-tools as a snapshot exclusion is the architecturally correct
    decision: snapshot is a SOURCE inventory; runtime ledgers are
    state, not source.
    """
    # Plan ARIA-V2 §3.4 — kernel runtime root + cross-tool excluded dirs.
    # ``aria-tools`` listed alongside BASE_EXCLUDED_DIRS so a tempdir
    # cycle's mutating governance.jsonl never enters FATES.
    try:
        from tools.shared.excluded_paths import BASE_EXCLUDED_DIRS as _SHARED_EXCLUDED
    except ImportError:
        _SHARED_EXCLUDED = frozenset()
    skipped_segments: frozenset[str] = _SHARED_EXCLUDED | frozenset({"aria-tools"})
    paths: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".git/"):
            continue
        # Reject if ANY path segment is in the excluded set; matches
        # os.walk's ``dirs[:] = ...`` behaviour for nested cases like
        # ``foo/node_modules/bar.js``.
        if any(segment in skipped_segments for segment in rel.split("/")):
            continue
        paths.append(rel)
    return sorted(paths)


def _file_fate(root: Path, relative_path: str, *, committed: bool = False) -> dict[str, Any]:
    normalized = normalize_path(relative_path)
    fate = "tracked"
    if normalized.startswith(GENERATED_PREFIXES) or any(part in normalized for part in GENERATED_PARTS):
        fate = "generated"
    path = root / normalized
    row: dict[str, Any] = {
        "path": normalized,
        "fate": fate,
        "suffix": path.suffix,
    }
    if committed:
        completed = _run_git_bytes(root, ["show", f"HEAD:{normalized}"])
        if completed.returncode == 0:
            data = completed.stdout
            row["size_bytes"] = len(data)
            row["content_hash"] = _sha256(data)
            return row
    if path.exists() and path.is_file():
        try:
            row["size_bytes"] = path.stat().st_size
            row["content_hash"] = _sha256(path.read_bytes())
        except OSError:
            row["fate"] = "unknown"
            row["error"] = "stat_or_read_failed"
    return row


def _snapshot_hash(snapshot: dict[str, Any]) -> str:
    stable = {
        "mode": snapshot.get("snapshot_mode"),
        "base_commit_sha": snapshot.get("base_commit_sha"),
        "files": [(row.get("path"), row.get("content_hash")) for row in snapshot.get("fates", [])],
    }
    return _sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _repo_state_id(snapshot: dict[str, Any]) -> str:
    digest = hashlib.sha256(str(snapshot["snapshot_hash"]).encode("utf-8")).hexdigest()
    return f"repo-state:{digest}"


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
