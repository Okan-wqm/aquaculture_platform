from __future__ import annotations

import hashlib
import json
import os
import subprocess
import stat as _stat
import time as _time
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

    committed_ref = None
    if git_available and mode == "committed":
        committed_ref = _git_rev_parse(root, "HEAD")
        if committed_ref is None:
            raise GovernanceError("committed_snapshot_base_unavailable")

    git_tracked_paths: list[str] = []
    working_tree_paths: list[str] = []
    if git_available:
        git_tracked_paths = _git_lines(root, ["ls-files"])
        working_tree_paths = sorted(set(git_tracked_paths + _git_lines(root, ["ls-files", "--others", "--exclude-standard"])))
        paths = _committed_paths(root, committed_ref) if committed_ref is not None else working_tree_paths
    else:
        paths = _filesystem_paths(root)
        git_tracked_paths = paths
        working_tree_paths = paths

    # The per-file fate+content-hash pass is the long part of a cycle (~2 min on
    # the real repo). Emit a coarse live progress tick every 2000 files so an
    # operator watching ARIA work sees the scan advancing instead of a 2-minute
    # silence (gated by ARIA_CYCLE_PROGRESS; a no-op otherwise).
    _total = len(paths)
    fates = []
    for _i, path in enumerate(paths):
        fates.append(_file_fate(root, path, committed_ref=committed_ref))
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
    base_commit_sha = committed_ref
    if git_available and mode == "working_tree":
        base_commit_sha = _git_rev_parse(root, "HEAD")
    snapshot = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "snapshot_mode": mode,
        "dirty_snapshot": mode == "working_tree" and bool(dirty_blockers),
        "base_commit_sha": base_commit_sha,
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


def _committed_paths(root: Path, commit_sha: str) -> list[str]:
    """Enumerate the same immutable tree used for committed content reads."""
    try:
        completed = _run_git_bytes(root, ["ls-tree", "-r", "--name-only", "-z", commit_sha])
    except OSError as exc:
        raise GovernanceError("committed_snapshot_tree_unavailable") from exc
    if completed.returncode != 0:
        raise GovernanceError("committed_snapshot_tree_unavailable")
    return sorted(os.fsdecode(path) for path in completed.stdout.split(b"\0") if path)


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


def _file_fate(root: Path, relative_path: str, *, committed_ref: str | None = None) -> dict[str, Any]:
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
    if committed_ref is not None:
        try:
            completed = _run_git_bytes(root, ["show", f"{committed_ref}:{relative_path}"])
        except OSError:
            completed = None
        if completed is None or completed.returncode != 0:
            row["fate"] = "unknown"
            row["error"] = "committed_blob_unavailable"
            return row
        data = completed.stdout
        row["size_bytes"] = len(data)
        row["content_hash"] = _sha256(data)
        return row
    try:
        if path.is_file():
            data = path.read_bytes()
            row["size_bytes"] = len(data)
            row["content_hash"] = _sha256(data)
            return row
    except OSError:
        pass
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


def _scoped_input_path(value: Any, *, canonical: bool = False) -> str | None:
    """Bound and normalize an explicit input-file name, without discovery."""
    if type(value) is not str or not value or len(value) > 512:
        return None
    try:
        if len(value.encode("utf-8")) > 512:
            return None
    except UnicodeEncodeError:
        return None
    path = normalize_path(value)
    if canonical and value != path:
        return None
    if Path(path).is_absolute() or any(part in ("", ".", "..", ".git") for part in path.split("/")) or any(char in path for char in "*?[]\x00\n\r"):
        return None
    return path


def _capture_scoped_files(root: Path, paths: list[str], *, byte_budget: int) -> dict[str, Any]:
    """Observe explicit working files without enumerating a repository snapshot.

    This is a partial input manifest, never a FATES/snapshot identity. The
    caller shares the remaining byte budget between before/after observations.
    Raw file reads cannot prefetch beyond the admitted regular-file length.
    """
    rows = []
    consumed = 0
    for relative in paths:
        row, _data, read_bytes = _read_scoped_working_file(root, relative, byte_budget=byte_budget - consumed)
        rows.append(row)
        consumed += read_bytes
    return {"files": rows, "bytes_read": consumed}


def _scoped_input_digest(rows: list[dict[str, Any]]) -> str | None:
    """Existing v1 successful explicit-file encoding, shared by its consumers.

    Preserve validation's historical bytes: the observation reason here is
    the v1 encoding's fixed label, not each consumer's display diagnostic.
    """
    if not rows or any(row.get("status") != "available" for row in rows):
        return None
    encoded_rows = [{"path": row["path"], "status": "available", "reason": "explicit_file_observed",
                     "size_bytes": row["size_bytes"], "content_hash": row["content_hash"]}
                    for row in sorted(rows, key=lambda item: item["path"])]
    return _sha256(json.dumps({"schema_version": 1, "files": encoded_rows}, sort_keys=True,
                             separators=(",", ":"), ensure_ascii=True).encode("utf-8"))


def _read_scoped_working_file(
    root: Path, relative: str, *, byte_budget: int, deadline_monotonic: float | None = None,
) -> tuple[dict[str, Any], bytes | None, int]:
    """One observed working file; metadata and optional parsing share its bytes."""
    row: dict[str, Any] = {"path": normalize_path(relative), "status": "unknown"}
    path = root / relative
    consumed = 0
    data = None
    if deadline_monotonic is not None and _time.monotonic() >= deadline_monotonic:
        row["reason"] = "qualification_deadline"
        return row, None, 0
    try:
        try:
            resolved = path.resolve()
        except RuntimeError:
            row["reason"] = "input_unreadable"
            return row, None, 0
        if not resolved.is_relative_to(root):
            row["reason"] = "outside_workspace"
        elif not _stat.S_ISREG(path.stat().st_mode):
            row["reason"] = "not_regular_file"
        else:
            with path.open("rb", buffering=0) as stream:
                before = os.fstat(stream.fileno())
                if deadline_monotonic is not None and _time.monotonic() >= deadline_monotonic:
                    row["reason"] = "qualification_deadline"
                elif not _stat.S_ISREG(before.st_mode):
                    row["reason"] = "not_regular_file"
                elif before.st_size > 2 * 1024 * 1024:
                    row["reason"] = "input_file_byte_limit"
                elif before.st_size > byte_budget:
                    row["reason"] = "input_total_byte_limit"
                else:
                    data = stream.read(before.st_size)
                    consumed = len(data)
                    after = os.fstat(stream.fileno())
                    if len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        row["reason"] = "changed_during_read"
                    else:
                        row.update(status="available", reason="explicit_file_observed",
                                   size_bytes=len(data), content_hash=_sha256(data))
    except FileNotFoundError:
        row["reason"] = "input_missing"
    except OSError:
        row["reason"] = "input_unreadable"
    if deadline_monotonic is not None and _time.monotonic() >= deadline_monotonic:
        row.update(status="unknown", reason="qualification_deadline")
    return row, data if row["status"] == "available" else None, consumed


class _ScopedSourceBudget:
    """Ephemeral shared accounting, not persisted workflow or memory state.

    The deadline has no default (ARIA-MEDIUM-082): the old ``+ 2`` here was
    the one literal every qualification inherited, so host load decided what
    the map answered. A caller states either ``deadline_seconds`` (an
    allowance from now, on this module's clock, resolved from
    ``genesis_policy.source_qualification_policy``) or ``deadline_monotonic``
    (an absolute instant, for callers that already pinned the clock).
    """

    def __init__(self, *, deadline_seconds: float | None = None, deadline_monotonic: float | None = None,
                 byte_limit: int = 16 * 1024 * 1024, path_limit: int = 256, membership_limit: int = 4096) -> None:
        if (deadline_seconds is None) == (deadline_monotonic is None):
            raise GovernanceError("scoped_source_budget_deadline_unspecified: pass exactly one of "
                                  "deadline_seconds or deadline_monotonic")
        self.deadline_monotonic = (_time.monotonic() + float(deadline_seconds) if deadline_monotonic is None
                                   else deadline_monotonic)
        self.remaining_bytes = byte_limit
        self.path_limit = path_limit
        self.paths_attempted = 0
        self.source_bytes_read = 0
        self.transport_bytes_reserved = 0
        self.remaining_membership_records = membership_limit
        self.known_membership_records = 0

    def expired(self) -> bool:
        return _time.monotonic() >= self.deadline_monotonic


def _read_scoped_committed_blob(
    root: Path, relative: str, commit_sha: str, size: int, *, budget: _ScopedSourceBudget,
) -> tuple[dict[str, Any], bytes | None]:
    """The existing known-size Git transport, shared by selected-source readers."""
    row = {"path": relative, "status": "unknown", "reason": "committed_blob_unavailable"}
    # Reserve EOF headroom and both pipes before acquiring a Git child.
    # Body bytes remain separate from this conservative transport debit.
    stderr_allowance = 1024
    reservation = size + 1 + stderr_allowance
    if reservation > budget.remaining_bytes:
        row["reason"] = "input_total_byte_limit"
        return row, None
    budget.remaining_bytes -= reservation
    budget.transport_bytes_reserved += reservation
    from .state_store import StateStoreError as _StateStoreError, _run_git_bytes_bounded

    try:
        completed = _run_git_bytes_bounded(
            root, ("cat-file", "blob", f"{commit_sha}:{relative}"),
            stdout_limit=size + 1, stderr_limit=stderr_allowance,
            budget_error="scoped_source_transport_limit",
            deadline_monotonic=budget.deadline_monotonic, strict_read_limits=True,
        )
    except _StateStoreError:
        row["reason"] = "qualification_deadline" if budget.expired() else "committed_blob_unavailable"
        return row, None
    data = completed.stdout
    budget.source_bytes_read += len(data)
    if completed.returncode != 0:
        row["reason"] = "committed_blob_unavailable"
        return row, None
    return row, data


def _read_scoped_committed_file(
    root: Path, relative: str, commit_sha: str, *, budget: _ScopedSourceBudget,
) -> tuple[dict[str, Any], bytes | None]:
    """Observe one selected Git blob without enumerating a repository snapshot.

    New excerpt callers have a commit/path, not a discovery fate. Their
    metadata and body reads share the same finite transport allowance.
    Existing discovery callers already know the size and skip this lookup.
    """
    row = {"path": relative, "status": "unknown", "reason": "committed_blob_unavailable"}
    if budget.expired():
        return {**row, "reason": "qualification_deadline"}, None
    if budget.paths_attempted >= budget.path_limit:
        return {**row, "reason": "input_path_limit"}, None
    budget.paths_attempted += 1
    if _scoped_input_path(relative, canonical=True) is None:
        return {**row, "reason": "input_path_unavailable"}, None
    if (not isinstance(commit_sha, str) or len(commit_sha) not in (40, 64)
            or any(char not in "0123456789abcdef" for char in commit_sha)):
        return {**row, "reason": "committed_snapshot_base_unavailable"}, None
    from .state_store import StateStoreError as _StateStoreError, _run_git_bytes_bounded

    reservation = 64 + 1024
    if budget.remaining_bytes < reservation:
        return {**row, "reason": "input_total_byte_limit"}, None
    budget.remaining_bytes -= reservation
    budget.transport_bytes_reserved += reservation
    try:
        metadata = _run_git_bytes_bounded(
            root, ("cat-file", "-s", f"{commit_sha}:{relative}"),
            stdout_limit=64, stderr_limit=1024, budget_error="scoped_source_metadata_limit",
            deadline_monotonic=budget.deadline_monotonic, strict_read_limits=True,
        )
    except (_StateStoreError, OSError):
        return {**row, "reason": "qualification_deadline" if budget.expired()
                else "committed_blob_unavailable"}, None
    size_text = metadata.stdout.strip()
    if metadata.returncode != 0 or not size_text.isdigit():
        return row, None
    size = int(size_text)
    if size > 2 * 1024 * 1024:
        return {**row, "reason": "input_file_byte_limit"}, None
    if budget.expired():
        return {**row, "reason": "qualification_deadline"}, None
    observed, data = _read_scoped_committed_blob(root, relative, commit_sha, size, budget=budget)
    if data is None:
        return observed, None
    if len(data) != size:
        return {**row, "reason": "committed_blob_size_mismatch"}, None
    content_hash = _sha256(data)
    if budget.expired():
        return {**row, "reason": "qualification_deadline"}, None
    return {"path": relative, "status": "available", "reason": "selected_source_bytes_observed",
            "size_bytes": size, "content_hash": content_hash, "commit_sha": commit_sha}, data


def _read_scoped_source_bytes(
    root: Path, fate: dict[str, Any], *, snapshot_mode: str, base_commit_sha: str | None,
    budget: _ScopedSourceBudget,
) -> tuple[dict[str, Any], bytes | None]:
    """Parse consumers receive only bytes matching their selected discovery view."""
    relative = _scoped_input_path(fate.get("path"), canonical=True)
    row = {"path": relative, "status": "unknown", "reason": "source_unavailable"}
    if budget.expired():
        row["reason"] = "qualification_deadline"
        return row, None
    if budget.paths_attempted >= budget.path_limit:
        row["reason"] = "input_path_limit"
        return row, None
    budget.paths_attempted += 1
    size = fate.get("size_bytes")
    expected_hash = fate.get("content_hash")
    if relative is None or fate.get("fate") != "tracked" or type(size) is not int or size < 0 or not isinstance(expected_hash, str):
        return row, None
    if size > 2 * 1024 * 1024:
        row["reason"] = "input_file_byte_limit"
        return row, None
    if snapshot_mode == "committed":
        if not base_commit_sha:
            row["reason"] = "committed_snapshot_base_unavailable"
            return row, None
        observed, data = _read_scoped_committed_blob(
            root, relative, base_commit_sha, size, budget=budget,
        )
        if data is None:
            return observed, None
    elif snapshot_mode == "working_tree":
        observed, data, consumed = _read_scoped_working_file(
            root, relative, byte_budget=budget.remaining_bytes, deadline_monotonic=budget.deadline_monotonic,
        )
        budget.source_bytes_read += consumed
        budget.remaining_bytes -= consumed
        if data is None:
            return observed, None
    else:
        row["reason"] = "snapshot_mode_unavailable"
        return row, None
    if budget.expired():
        row["reason"] = "qualification_deadline"
        return row, None
    if len(data) != size or _sha256(data) != expected_hash:
        row["reason"] = "source_changed_since_discovery"
        return row, None
    if budget.expired():
        row["reason"] = "qualification_deadline"
        return row, None
    row.update(status="available", reason="selected_source_bytes_observed", size_bytes=len(data), content_hash=expected_hash)
    return row, data


def _read_scoped_membership(
    root: Path, scopes: list[str], *, snapshot_mode: str, base_commit_sha: str | None,
    budget: _ScopedSourceBudget,
) -> dict[str, Any]:
    """Observe emitted scoped Git paths, not internal Git traversal telemetry."""
    unknown = {"status": "unknown", "reason": "scoped_membership_unavailable", "paths": []}
    if budget.expired():
        return {**unknown, "reason": "qualification_deadline"}
    remaining = budget.remaining_membership_records
    if remaining <= 0 or budget.remaining_bytes <= 1024:
        return {**unknown, "reason": "membership_budget_exhausted"}
    if any(_scoped_input_path(scope, canonical=True) is None for scope in scopes):
        return unknown
    if snapshot_mode == "committed" and base_commit_sha:
        args = ("ls-tree", "-r", "-z", "--name-only", base_commit_sha, "--", *scopes)
    elif snapshot_mode == "working_tree":
        args = ("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
                *(":(literal)" + scope for scope in scopes))
    else:
        return unknown
    stdout_allowance = min(remaining * 513 + 1, budget.remaining_bytes - 1024)
    reservation = stdout_allowance + 1024
    budget.remaining_bytes -= reservation
    budget.transport_bytes_reserved += reservation
    from .state_store import StateStoreError as _StateStoreError, _run_git_bytes_bounded
    try:
        result = _run_git_bytes_bounded(
            root, args, stdout_limit=stdout_allowance, stderr_limit=1024,
            budget_error="scoped_membership_limit", deadline_monotonic=budget.deadline_monotonic,
            strict_read_limits=True, stdout_records_limit=remaining,
        )
    except _StateStoreError as exc:
        # Consumption on failure is unknown: do not reuse the reserved
        # record allowance or label it as measured internal traversal.
        budget.remaining_membership_records = 0
        reason = "qualification_deadline" if budget.expired() else (
            "scoped_membership_limit" if exc.args == ("scoped_membership_limit",) else "membership_read_unavailable")
        return {**unknown, "reason": reason}
    records = result.stdout.count(b"\0")
    budget.known_membership_records += records
    budget.remaining_membership_records -= records
    if result.returncode != 0 or (result.stdout and not result.stdout.endswith(b"\0")):
        return unknown
    try:
        paths = [part.decode("utf-8") for part in result.stdout.split(b"\0")[:-1]]
    except UnicodeDecodeError:
        return unknown
    if any(_scoped_input_path(path, canonical=True) is None for path in paths) or budget.expired():
        return unknown
    return {"status": "available", "reason": "scoped_git_paths_observed", "paths": sorted(set(paths))}
