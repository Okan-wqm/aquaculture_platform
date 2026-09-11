from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat as _stat
import subprocess
from contextlib import contextmanager as _contextmanager
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .artifact_safety import scrub_json
from .ledger import LedgerIntegrityError, append_declared_jsonl, file_hash, load_declared_jsonl, load_jsonl, verify_jsonl
from .ledger import (
    LEDGER_ROW_MAX_BYTES as _LEDGER_ROW_MAX_BYTES,
    LedgerReadLimitError as _LedgerReadLimitError,
    _assert_declared_surface as _assert_archive_surface,
    state_transaction as _archive_transaction,
    verify_jsonl_chunks as _verify_archive_chunks,
)
from .tool_registry import GovernanceError, ensure_tools_binding, ensure_tools_dir, tools_dir, utc_now


RUN_LEDGER_FORMAT_ENV = "ARIA_RUN_LEDGER_FORMAT"
RUN_LEDGER_FORMATS = ("v1", "v2-shadow", "v2")
DEFAULT_RUN_LEDGER_FORMAT = "v2-shadow"
ARTIFACT_VERIFIER_VERSION = "runtime-artifact-graph-v2"
SUMMARY_STDOUT_MAX_BYTES = 32 * 1024
ARTIFACT_BEARING = "artifact_bearing"
LIFECYCLE_ONLY = "lifecycle_only"
INTEGRITY_FAILED = "integrity_failed"
INCOMPLETE = "incomplete"

DISCOVERY_ARTIFACTS = (
    "COMPLETION_PROOF.json",
    "FATES.json",
    "REPO_FINGERPRINT.json",
    "SERVICE_MAP.json",
    "SNAPSHOT.json",
)

ARTIFACT_REF_V2_SCHEMA_VERSION = 2
ARTIFACT_REF_V2_REQUIRED: tuple[str, ...] = (
    "schema_version",
    "artifact_id",
    "uri",
    "sha256",
    "content_type",
    "produced_by_workflow_run_id",
    "source_surface",
)
ARTIFACT_REF_LEGACY_ALIASES: frozenset[str] = frozenset({
    "hash",
    "content_hash",
    "artifact_path",
    "path",
    "source_surfaces",
})
ARTIFACT_REF_V2_KEYS: frozenset[str] = frozenset(ARTIFACT_REF_V2_REQUIRED)
ARTIFACT_REF_FORBIDDEN_URI_PREFIXES: tuple[str, ...] = (
    "tmp/",
    "agent-workspace/",
    ".aria-poc/",
    "runner-temp/",
)


@dataclass(frozen=True)
class ArtifactRefV2:
    schema_version: int
    artifact_id: str
    uri: str
    sha256: str
    content_type: str
    produced_by_workflow_run_id: str
    source_surface: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ArtifactRefV2":
        _validate_artifact_ref_v2_shape(value)
        return cls(
            schema_version=int(value["schema_version"]),
            artifact_id=str(value["artifact_id"]),
            uri=str(value["uri"]),
            sha256=str(value["sha256"]),
            content_type=str(value["content_type"]),
            produced_by_workflow_run_id=str(value["produced_by_workflow_run_id"]),
            source_surface=str(value["source_surface"]),
        )


def run_ledger_format(
    base_dir: str | Path | None = None,
    *,
    workspace_root: str | Path | None = None,
) -> str:
    value = os.environ.get(RUN_LEDGER_FORMAT_ENV, DEFAULT_RUN_LEDGER_FORMAT).strip()
    if value not in RUN_LEDGER_FORMATS:
        raise GovernanceError(
            f"{RUN_LEDGER_FORMAT_ENV} must be one of {', '.join(RUN_LEDGER_FORMATS)}",
        )
    if value == "v2":
        require_runtime_v2_promotion(base_dir=base_dir, workspace_root=workspace_root)
    return value


def run_artifacts_root(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "run-artifacts"


def artifact_index_path(base_dir: str | Path | None = None) -> Path:
    return run_artifacts_root(base_dir) / "artifact-index.jsonl"


def artifact_manifest_path(base_dir: str | Path | None = None) -> Path:
    return run_artifacts_root(base_dir) / "manifest.jsonl"


def retention_events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "retention" / "events.jsonl"


def artifact_inventory_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "observability" / "artifact-inventory.jsonl"


def by_cycle_runs_path(base_dir: str | Path | None, cycle_uid: str) -> Path:
    safe_cycle = _safe_segment(cycle_uid)
    return ensure_tools_dir(base_dir) / "runs" / "by-cycle" / f"{safe_cycle}.jsonl"


def write_run_artifact(
    *,
    base_dir: str | Path | None,
    run_id: str,
    cycle_uid: str,
    tool_id: str,
    kind: str,
    payload: dict[str, Any],
    run_status: str,
    repo_state_id: str | None = None,
    owner: str = "tool_runner",
) -> dict[str, Any]:
    """Persist full runtime evidence before the thin run row is appended.

    The returned dict is intentionally ledger-ready: callers can copy
    ``artifact_ref``, ``artifact_hash`` and ``artifact_status`` onto the
    run row without re-reading the artifact.
    """
    root = run_artifacts_root(base_dir)
    artifact_id = f"{_safe_segment(cycle_uid)}.{_safe_segment(run_id)}.{_safe_segment(kind)}"
    artifact_path = root / "hot" / _safe_segment(cycle_uid) / _safe_segment(run_id) / f"{_safe_segment(kind)}.json"
    _assert_under_root(artifact_path, root)
    payload = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "artifact_kind": kind,
        "run_id": run_id,
        "cycle_uid": cycle_uid,
        "tool_id": tool_id,
        "created_at": utc_now(),
        "payload": scrub_json(payload),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    digest = _sha256_bytes(encoded)
    try:
        _atomic_write_bytes(artifact_path, encoded)
        actual = _sha256_bytes(artifact_path.read_bytes())
        if actual != digest:
            raise GovernanceError("run_artifact_hash_mismatch_after_write")
        status = "present"
        reason = None
    except Exception as exc:
        return {
            "artifact_id": artifact_id,
            "artifact_ref": None,
            "artifact_hash": None,
            "artifact_status": "write_failed",
            "artifact_error": str(exc),
        }

    uri = _relative_uri(ensure_tools_dir(base_dir), artifact_path)
    ref = {
        "schema_version": ARTIFACT_REF_V2_SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "uri": uri,
        "sha256": digest,
        "content_type": "application/json",
        "produced_by_workflow_run_id": run_id,
        "source_surface": "runtime_artifact",
    }
    index_row = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "cycle_id": cycle_uid,
        "cycle_uid": cycle_uid,
        "run_id": run_id,
        "tool_id": tool_id,
        "kind": kind,
        "sha256": digest,
        "size_bytes": len(encoded),
        "created_at": utc_now(),
        "storage_tier": "hot",
        "current_uri": uri,
        "owner": owner,
        "repo_state_id": repo_state_id,
        "run_status": run_status,
        "artifact_status": status,
    }
    append_declared_jsonl(artifact_index_path(base_dir), index_row, expected_surface="runtime_artifact_index")
    append_declared_jsonl(artifact_manifest_path(base_dir), {"event": "artifact_created", **index_row}, expected_surface="runtime_artifact_manifest")
    append_declared_jsonl(artifact_inventory_path(base_dir), {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_uid,
        "run_id": run_id,
        "artifact_id": artifact_id,
        "artifact_class": kind,
        "path": uri,
        "bytes": len(encoded),
        "sha256": digest,
        "storage_tier": "hot",
        "retention_action": None,
    }, expected_surface="runtime_artifact_inventory")
    return {
        "artifact_id": artifact_id,
        "artifact_ref": ref,
        "artifact_hash": digest,
        "artifact_status": status,
        "artifact_error": reason,
    }


def budget_projection(run_row: dict[str, Any]) -> dict[str, Any]:
    """duration, the budget it ran under, and how much of it was consumed."""
    duration = run_row.get("duration_ms")
    timeout = run_row.get("timeout_ms")
    projection: dict[str, Any] = {"duration_ms": duration, "timeout_ms": timeout}
    if isinstance(duration, (int, float)) and isinstance(timeout, (int, float)) and timeout > 0:
        projection["budget_utilisation"] = round(float(duration) / float(timeout), 4)
    else:
        projection["budget_utilisation"] = None
    return projection


def append_run_by_cycle(
    *,
    base_dir: str | Path | None,
    cycle_uid: str,
    run_row: dict[str, Any],
) -> None:
    summary = {
        "schema_version": 1,
        "recorded_at": run_row.get("recorded_at") or utc_now(),
        "cycle_id": run_row.get("cycle_id"),
        "cycle_uid": cycle_uid,
        "run_id": run_row.get("run_id"),
        "tool_id": run_row.get("tool_id"),
        "status": run_row.get("status"),
        "artifact_ref": run_row.get("artifact_ref"),
        "artifact_hash": run_row.get("artifact_hash"),
        "artifact_status": run_row.get("artifact_status", "legacy_inline_or_sample_only"),
        "runner": _runner_summary(run_row.get("runner")),
        # ORPHAN-HIGH-801 — by-cycle is the ONLY runs ledger published to
        # aria/state, so whatever it drops is unmeasurable after the night
        # ends. It dropped duration, which is why a 180s budget survived
        # unexamined until the adapter it governs could no longer finish
        # inside it. Utilisation is derived here rather than by the reader,
        # so every consumer sees the same number.
        **budget_projection(run_row),
    }
    append_declared_jsonl(by_cycle_runs_path(base_dir, cycle_uid), summary, expected_surface="runs_by_cycle")


def read_runs_for_cycle(
    *,
    base_dir: str | Path | None,
    cycle_uid: str,
) -> list[dict[str, Any]]:
    from .runs_reader import read_runs_rows
    from .tool_health import runs_path

    by_cycle = by_cycle_runs_path(base_dir, cycle_uid)
    if by_cycle.exists():
        return list(read_runs_rows(by_cycle, base_dir=ensure_tools_dir(base_dir)))
    return [
        row for row in read_runs_rows(runs_path(base_dir), base_dir=ensure_tools_dir(base_dir))
        if row.get("cycle_id") == cycle_uid
    ]


# ORPHAN-HIGH-798 — per-process artifact payload cache. resolve_finding_
# from_artifact is called once per raw-finding candidate row in the sampler;
# without a cache, every call re-reads a 7.84MB artifact file from disk,
# re-hashes it, and re-parses the JSON — measured worst case: 1,158 rows
# sharing one artifact = ~9.1GB of redundant I/O in a single sampler pass.
# Keyed by resolved path, expected hash and the observed file identity. Native
# republication replaces the file; its old ref must not reuse a cached payload.
# Retain the existing 64-entry bound and hot-reader size compatibility.
_ARTIFACT_CACHE: OrderedDict[tuple, dict[str, Any] | None] = OrderedDict()
_ARTIFACT_CACHE_MAX = 64


def _cached_artifact_payload(
    path: Path,
    expected_sha256: str,
) -> dict[str, Any] | None:
    before = _archive_stat_identity(path.stat())
    cache_key = (str(path), expected_sha256, before)
    if cache_key in _ARTIFACT_CACHE:
        _ARTIFACT_CACHE.move_to_end(cache_key)
        return _ARTIFACT_CACHE[cache_key]
    raw = path.read_bytes()
    if _sha256_bytes(raw) != expected_sha256:
        result = None
    else:
        try:
            parsed = json.loads(raw.decode("utf-8"))
            result = parsed if isinstance(parsed, dict) else None
        except (ValueError, UnicodeDecodeError):
            result = None
    if _archive_stat_identity(path.stat()) != before:
        return None
    _ARTIFACT_CACHE[cache_key] = result
    if len(_ARTIFACT_CACHE) > _ARTIFACT_CACHE_MAX:
        _ARTIFACT_CACHE.popitem(last=False)
    return result


_ARCHIVE_SOURCE_BYTES = 16 * 1024 * 1024
_ARCHIVE_ARTIFACT_BYTES = 16 * 1024 * 1024
_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024
_ARCHIVE_SOURCE_FILES = 32
_ARCHIVE_ROWS = 20_000
_ARCHIVE_CANDIDATES = 32


class _ArchiveLimit(GovernanceError):
    pass


class _ArchiveUnavailable(GovernanceError):
    pass


@dataclass
class _ArchiveReadBudget:
    source_bytes: int = 0
    artifact_bytes: int = 0
    source_files: int = 0
    verified_rows: int = 0
    candidates: int = 0

    def counters(self) -> dict[str, int]:
        return {"bytes_read": self.source_bytes + self.artifact_bytes,
                "source_bytes_read": self.source_bytes,
                "artifact_bytes_read": self.artifact_bytes,
                "source_files_read": self.source_files,
                "verified_rows": self.verified_rows,
                "candidates": self.candidates}


def _archive_stat_identity(value: Any) -> tuple:
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


@_contextmanager
def _archive_file_chunks(root: Path, uri: str, *, budget: _ArchiveReadBudget,
                         source: bool, max_bytes: int):
    """Reuse URI containment; debit requested reads before another read starts."""
    path = _resolve_uri(root, uri)
    if source:
        if budget.source_files >= _ARCHIVE_SOURCE_FILES:
            raise _ArchiveLimit("archive_source_file_limit")
        budget.source_files += 1
    with path.open("rb", buffering=0) as stream:
        before = os.fstat(stream.fileno())
        if not _stat.S_ISREG(before.st_mode):
            raise _ArchiveUnavailable("archive_file_not_regular")
        remaining = (_ARCHIVE_SOURCE_BYTES - budget.source_bytes if source
                     else _ARCHIVE_ARTIFACT_BYTES - budget.artifact_bytes)
        if before.st_size > min(max_bytes, remaining):
            raise _ArchiveLimit("archive_byte_limit")

        def chunks():
            observed = 0
            while observed < before.st_size:
                remaining = (_ARCHIVE_SOURCE_BYTES - budget.source_bytes if source
                             else _ARCHIVE_ARTIFACT_BYTES - budget.artifact_bytes)
                allowance = min(64 * 1024, before.st_size - observed, remaining,
                                max_bytes - observed)
                if allowance <= 0:
                    raise _ArchiveLimit("archive_byte_limit")
                chunk = stream.read(allowance)
                if source:
                    budget.source_bytes += len(chunk)
                else:
                    budget.artifact_bytes += len(chunk)
                observed += len(chunk)
                if not chunk:
                    raise _ArchiveUnavailable("archive_file_changed")
                yield chunk
            if _archive_stat_identity(os.fstat(stream.fileno())) != _archive_stat_identity(before):
                raise _ArchiveUnavailable("archive_file_changed")
            if _archive_stat_identity(path.stat()) != _archive_stat_identity(before):
                raise _ArchiveUnavailable("archive_file_changed")

        yield before.st_size, chunks()


def _archive_rows(root: Path, relative: str, surface: str, *, budget: _ArchiveReadBudget,
                  keep: Any) -> list[dict[str, Any]]:
    path = root / relative
    if not path.exists():
        return []
    _surface, bound_root = _assert_archive_surface(
        path, expected_surface=surface, enforce_write_profile=False,
    )
    if bound_root.resolve() != root.resolve():
        raise _ArchiveUnavailable("archive_history_root_mismatch")
    selected: list[dict[str, Any]] = []

    def capture(row: dict[str, Any]) -> None:
        budget.verified_rows += 1
        if keep(row):
            if budget.candidates >= _ARCHIVE_CANDIDATES:
                raise _ArchiveLimit("archive_candidate_limit")
            budget.candidates += 1
            selected.append(row)

    with _archive_file_chunks(root, relative, budget=budget, source=True,
                              max_bytes=_ARCHIVE_SOURCE_BYTES) as (size, chunks):
        _verify_archive_chunks(
            chunks, source=path, expected_size=size, max_line_bytes=_LEDGER_ROW_MAX_BYTES,
            max_rows=max(0, _ARCHIVE_ROWS - budget.verified_rows),
            expected_surface=surface, expected_surface_instance=relative, on_row=capture,
        )
    # Captured callbacks are provisional until full chain/size/file verification.
    return selected


def _artifact_identity(ref: dict[str, Any]) -> tuple[str, str, str, str]:
    return (ref["source_surface"], ref["artifact_id"], ref["uri"], ref["sha256"])


def _runtime_creation_ref(row: dict[str, Any]) -> dict[str, Any] | None:
    """The known native runtime JSON producer, not a filename-based inference."""
    if row.get("event") != "artifact_created":
        return None
    if (not isinstance(row.get("run_id"), str) or not row["run_id"]
            or not isinstance(row.get("cycle_uid"), str) or not row["cycle_uid"]
            or type(row.get("size_bytes")) is not int or row["size_bytes"] < 0):
        return None
    ref = {"schema_version": 2, "artifact_id": row.get("artifact_id"),
           "uri": row.get("current_uri"), "sha256": row.get("sha256"),
           "content_type": "application/json", "produced_by_workflow_run_id": row["run_id"],
           "source_surface": "runtime_artifact"}
    try:
        ArtifactRefV2.from_dict(ref)
    except GovernanceError:
        return None
    return ref


def _consistent_runtime_creations(creations: list[dict[str, Any]]) -> None:
    seen: dict[tuple, tuple] = {}
    for row in creations:
        ref = _runtime_creation_ref(row)
        if ref is None:
            raise _ArchiveUnavailable("legacy_identity_unavailable")
        key = _artifact_identity(ref)
        value = (ref["produced_by_workflow_run_id"], row["cycle_uid"], row["size_bytes"], row.get("kind"))
        if key in seen and seen[key] != value:
            raise _ArchiveUnavailable("archive_creator_conflict")
        seen[key] = value


def _archive_event_matches(row: dict[str, Any], ref: dict[str, Any], *,
                           creation: dict[str, Any] | None) -> bool:
    if (row.get("event") != "artifact_archived"
            or row.get("artifact_id") != ref["artifact_id"]
            or row.get("original_path") != ref["uri"]
            or row.get("sha256") != ref["sha256"]):
        return False
    descriptor = row.get("source_descriptor")
    if descriptor is not None:
        if descriptor != {"schema_version": 1, "artifact_ref": ref}:
            return False
    elif creation is None or _runtime_creation_ref(creation) != ref:
        return False
    if creation is not None:
        if (row.get("cycle_uid") != creation.get("cycle_uid")
                or row.get("size") != creation.get("size_bytes")):
            return False
    return isinstance(row.get("new_path"), str) and bool(row["new_path"])


def _archive_history(root: Path, query: dict[str, Any] | str, *,
                     budget: _ArchiveReadBudget) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    def matches(row: dict[str, Any]) -> bool:
        if isinstance(query, str):
            return query == row.get("artifact_id") or query == row.get("current_uri") or query == row.get("original_path")
        return (row.get("artifact_id") == query["artifact_id"]
                and (row.get("current_uri") or row.get("original_path")) == query["uri"]
                and row.get("sha256") == query["sha256"])

    creations = _archive_rows(root, "run-artifacts/manifest.jsonl", "runtime_artifact_manifest",
                              budget=budget, keep=lambda row: row.get("event") == "artifact_created" and matches(row))
    events = _archive_rows(root, "retention/events.jsonl", "retention_events",
                           budget=budget, keep=lambda row: row.get("event") == "artifact_archived" and matches(row))
    index = _archive_rows(root, "run-artifacts/artifact-index.jsonl", "runtime_artifact_index",
                          budget=budget, keep=matches)
    return creations, events, index


def _archive_ref_for_query(root: Path, query: str, *, budget: _ArchiveReadBudget) -> dict[str, Any]:
    creations, events, index = _archive_history(root, query, budget=budget)
    _consistent_runtime_creations(creations)
    refs: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    incomplete = False
    for creation in creations:
        ref = _runtime_creation_ref(creation)
        if ref is None:
            incomplete = True
            continue
        key = _artifact_identity(ref)
        if key in refs and refs[key] != ref:
            raise _ArchiveUnavailable("archive_creator_conflict")
        refs[key] = ref
    for row in events:
        descriptor = row.get("source_descriptor")
        if descriptor is not None:
            if (not isinstance(descriptor, dict) or set(descriptor) != {"schema_version", "artifact_ref"}
                    or descriptor.get("schema_version") != 1 or not isinstance(descriptor.get("artifact_ref"), dict)):
                raise _ArchiveUnavailable("archive_descriptor_unavailable")
            ref = descriptor["artifact_ref"]
            ArtifactRefV2.from_dict(ref)
            if not _archive_event_matches(row, ref, creation=None):
                raise _ArchiveUnavailable("archive_descriptor_conflict")
            key = _artifact_identity(ref)
            if key in refs and refs[key] != ref:
                raise _ArchiveUnavailable("archive_creator_conflict")
            refs[key] = ref
        elif not any(_archive_event_matches(row, ref, creation=creation)
                     for creation in creations
                     if (ref := _runtime_creation_ref(creation)) is not None):
            incomplete = True
    for row in index:
        if not any(row.get("artifact_id") == ref["artifact_id"]
                   and row.get("current_uri") == ref["uri"] and row.get("sha256") == ref["sha256"]
                   and row.get("run_id") == ref["produced_by_workflow_run_id"] for ref in refs.values()):
            incomplete = True
    if len(refs) > 1:
        raise GovernanceError(f"artifact_ambiguous:{query}")
    if incomplete:
        raise _ArchiveUnavailable("legacy_identity_unavailable")
    if not refs:
        raise GovernanceError(f"artifact_not_found:{query}")
    return next(iter(refs.values()))


def _read_ref_content(root: Path, uri: str, ref: dict[str, Any], *,
                      budget: _ArchiveReadBudget, max_bytes: int) -> bytes:
    with _archive_file_chunks(root, uri, budget=budget, source=False,
                              max_bytes=min(max_bytes, _ARCHIVE_FILE_BYTES)) as (_size, chunks):
        content = b"".join(chunks)
    if _sha256_bytes(content) != ref["sha256"]:
        raise _ArchiveUnavailable("archive_content_hash_mismatch")
    return content


def _resolve_artifact_bytes(artifact_ref: dict[str, Any], *, base_dir: str | Path | None,
                            max_bytes: int, _budget: _ArchiveReadBudget | None = None,
                            _archive_only: bool = False) -> dict[str, Any]:
    ArtifactRefV2.from_dict(artifact_ref)
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("artifact_byte_limit_invalid")
    ref = dict(artifact_ref)
    budget = _budget if _budget is not None else _ArchiveReadBudget()
    root = tools_dir(base_dir)
    result = {"status": "unavailable", "content": None, "source_tier": None,
              "resolved_uri": None, "artifact_id": ref["artifact_id"], "sha256": ref["sha256"],
              "reason": "artifact_missing"}
    try:
        content = None
        if not _archive_only:
            try:
                content = _read_ref_content(root, ref["uri"], ref, budget=budget, max_bytes=max_bytes)
            except FileNotFoundError:
                pass
            except _ArchiveUnavailable as exc:
                if str(exc) != "archive_content_hash_mismatch":
                    raise
                # A newer native version can occupy this URI. The attempted
                # hot read remains charged; only the exact retained ref may serve.
        if content is not None:
            result.update(status="resolved", content=content, source_tier="hot", resolved_uri=ref["uri"], reason=None)
        else:
            creations, events, _index = _archive_history(root, ref, budget=budget)
            _consistent_runtime_creations(creations)
            matching = [creation for creation in creations if _runtime_creation_ref(creation) == ref]
            # A conflicting creator for the same full identity is not corroboration.
            if any(_runtime_creation_ref(creation) != ref for creation in creations):
                raise _ArchiveUnavailable("archive_creator_conflict")
            candidates = [row for row in events if _archive_event_matches(
                row, ref, creation=matching[0] if matching else None,
            )]
            if events and not candidates:
                raise _ArchiveUnavailable("legacy_identity_unavailable")
            for row in sorted(candidates, key=lambda item: item["new_path"]):
                try:
                    content = _read_ref_content(root, row["new_path"], ref, budget=budget, max_bytes=max_bytes)
                except FileNotFoundError:
                    continue
                if type(row.get("size")) is not int or row["size"] != len(content):
                    raise _ArchiveUnavailable("archive_size_mismatch")
                result.update(status="resolved", content=content, source_tier="archive",
                              resolved_uri=row["new_path"], reason=None)
                break
    except (_ArchiveLimit, _LedgerReadLimitError):
        result.update(status="budget_exceeded", reason="budget_exceeded")
    except _ArchiveUnavailable as exc:
        result["reason"] = str(exc)
    except OSError:
        result["reason"] = "artifact_read_unavailable"
    result.update(budget.counters())
    return result


def resolve_artifact_payload(
    artifact_ref: Any,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    if not isinstance(artifact_ref, dict):
        return None
    try:
        ref = ArtifactRefV2.from_dict(artifact_ref)
    except GovernanceError:
        return None
    # WHY not ensure_tools_dir: this is a pure READ path that
    # verify_runtime_artifacts calls once per raw-findings row. Each
    # ensure_tools_dir re-globs the whole tools tree (_prepare_tools_dirs)
    # and rewrites integrity_index.json inside a locked transaction
    # (update_tools_index) — ~0.5 s on a 2k-row store, so verification
    # paid a 15-20 minute O(store^2) tax and the nightly cycle hit its
    # wall-clock deadline before the planner ever ran. A read must not
    # write-init the root; resolve it the way _artifact_root already does.
    root = Path(base_dir) if base_dir is not None else ensure_tools_dir(None)
    path = _resolve_uri(root, ref.uri)
    try:
        if path.is_file():
            payload = _cached_artifact_payload(path, ref.sha256)
            if payload is not None:
                return payload
        elif path.exists():
            return None
    except FileNotFoundError:
        # A normal hot removal may complete between the stat and read.
        pass
    try:
        resolved = _resolve_artifact_bytes(artifact_ref, base_dir=root, max_bytes=_ARCHIVE_FILE_BYTES,
                                           _archive_only=True)
    except LedgerIntegrityError:
        return None
    if resolved["status"] != "resolved":
        return None
    try:
        payload = json.loads(resolved["content"])
    except (ValueError, UnicodeError):
        return None
    return payload if isinstance(payload, dict) else None


def resolve_finding_from_artifact(
    row: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    pointer = row.get("json_pointer")
    if not isinstance(pointer, str) or not pointer.startswith("/payload/raw_findings/"):
        return None
    artifact = resolve_artifact_payload(row.get("artifact_ref"), base_dir=base_dir)
    if artifact is None:
        return None
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    findings = payload.get("raw_findings")
    if not isinstance(findings, list):
        return None
    try:
        index = int(pointer.rsplit("/", 1)[-1])
    except ValueError:
        return None
    if index < 0 or index >= len(findings) or not isinstance(findings[index], dict):
        return None
    return findings[index]


def verify_artifacts(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = Path(base_dir) if base_dir is not None else ensure_tools_dir(None)
    issues: list[dict[str, Any]] = []
    rows = load_declared_jsonl(root / "run-artifacts" / "artifact-index.jsonl", expected_surface="runtime_artifact_index")
    verified = 0
    for row in rows:
        artifact_id = str(row.get("artifact_id") or "")
        uri = str(row.get("current_uri") or "")
        expected = str(row.get("sha256") or "")
        if not uri:
            issues.append({"code": "run_artifact_missing", "artifact_id": artifact_id, "reason": "empty_uri"})
            continue
        try:
            path = _resolve_uri(root, uri)
        except GovernanceError as exc:
            issues.append({"code": "run_artifact_path_escape", "artifact_id": artifact_id, "reason": str(exc)})
            continue
        if not path.exists():
            issues.append({"code": "run_artifact_missing", "artifact_id": artifact_id, "path": uri})
            continue
        actual = _sha256_bytes(path.read_bytes())
        if actual != expected:
            issues.append({
                "code": "run_artifact_hash_mismatch",
                "artifact_id": artifact_id,
                "expected": expected,
                "actual": actual,
            })
            continue
        verified += 1
    return {
        "schema_version": 1,
        "status": "ok" if not issues else "drift",
        "valid": not issues,
        "artifact_count": len(rows),
        "verified_count": verified,
        "issues": issues,
    }


def classify_cycle_evidence(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    verification = verify_runtime_artifacts(base_dir=root, cycle_id=cycle_id)
    cycle_rows = [row for row in load_declared_jsonl(root / "cycles.jsonl", expected_surface="cycles") if row.get("cycle_id") == cycle_id]
    has_terminal = any(row.get("event") in {"completed", "failed", "stopped", "aborted"} or row.get("status") in {"completed", "failed", "stopped", "aborted"} for row in cycle_rows)
    run_rows = [row for row in load_declared_jsonl(root / "runs.jsonl", expected_surface="runs") if row.get("cycle_id") == cycle_id]
    registry_issues: list[dict[str, Any]] = []
    runnable_tools = [
        tool for tool in _load_registry_tools(root, issues=registry_issues)
        if tool.get("status") in {"ACTIVE", "SHADOW", "CALIBRATE"}
    ]
    expected_tool_count = len(runnable_tools)
    ok_runs = [row for row in run_rows if row.get("status") == "ok"]
    artifact_ok_runs = [row for row in ok_runs if _artifact_refs_from_run(row)]
    missing_artifact_ok_runs = len(ok_runs) - len(artifact_ok_runs)
    non_ok_count = sum(1 for row in run_rows if row.get("status") != "ok")
    missing_expected = max(0, expected_tool_count - len(run_rows))
    hidden_non_ok_count = non_ok_count + missing_expected
    if not has_terminal:
        evidence_class = INCOMPLETE
    elif verification["status"] != "ok" or registry_issues or hidden_non_ok_count or missing_artifact_ok_runs:
        evidence_class = INTEGRITY_FAILED
    elif artifact_ok_runs:
        evidence_class = ARTIFACT_BEARING
    else:
        evidence_class = LIFECYCLE_ONLY
    issues = list(verification["issues"]) + registry_issues
    if missing_artifact_ok_runs:
        issues.append({"code": "ok_run_missing_artifact_ref", "count": missing_artifact_ok_runs})
    return {"schema_version": 1, "cycle_id": cycle_id, "cycle_evidence_class": evidence_class, "verified_artifact_count": int(verification["verified_artifact_count"]), "expected_tool_count": expected_tool_count, "hidden_non_ok_count": hidden_non_ok_count, "promotion_eligible": evidence_class == ARTIFACT_BEARING, "issues": issues}


def verify_runtime_artifacts(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    root = tools_dir(base_dir)
    workspace = Path(workspace_root).resolve() if workspace_root else None
    issues: list[dict[str, Any]] = []
    verified = 0
    issues.extend(_ledger_issues(root / "runs.jsonl", "runs"))
    issues.extend(_ledger_issues(root / "raw-findings.jsonl", "raw_findings"))
    issues.extend(_ledger_issues(root / "cycles.jsonl", "cycles"))
    issues.extend(_ledger_issues(root / "pressure" / "pressure-log.jsonl", "pressure_log"))
    issues.extend(_ledger_issues(root / "run-artifacts" / "artifact-index.jsonl", "runtime_artifact_index"))
    issues.extend(_ledger_issues(root / "run-artifacts" / "manifest.jsonl", "runtime_artifact_manifest"))
    issues.extend(_ledger_issues(root / "observability" / "artifact-inventory.jsonl", "runtime_artifact_inventory"))
    _load_registry_tools(root, issues=issues)
    runs = _safe_load_jsonl(root / "runs.jsonl", issues, "runs", expected_surface="runs")
    by_cycle = root / "runs" / "by-cycle" / f"{_safe_segment(cycle_id)}.jsonl" if cycle_id is not None else None
    if by_cycle is not None and by_cycle.exists():
        runs.extend(_safe_load_jsonl(by_cycle, issues, "runs_by_cycle", expected_surface="runs_by_cycle"))
    raw_findings = _safe_load_jsonl(root / "raw-findings.jsonl", issues, "raw_findings", expected_surface="raw_findings")
    if cycle_id is not None:
        runs = [row for row in runs if row.get("cycle_id") == cycle_id or row.get("cycle_uid") == cycle_id]
        raw_findings = [row for row in raw_findings if row.get("cycle_id") == cycle_id]
    raw_by_run: dict[str, list[dict[str, Any]]] = {}
    for row in raw_findings:
        raw_by_run.setdefault(str(row.get("run_id") or ""), []).append(row)
        raw_issue = _raw_finding_issue(row, base_dir=root)
        if raw_issue:
            issues.append(raw_issue)
    artifact_refs_seen: list[Any] = []
    seen_run_ids: set[str] = set()
    for run in runs:
        run_id = str(run.get("run_id") or "")
        if run_id in seen_run_ids:
            continue
        if run_id:
            seen_run_ids.add(run_id)
        verified += 1
        expected_raw = int((run.get("runner") or {}).get("raw_findings_count") or 0)
        if expected_raw and not raw_by_run.get(run_id) and not _artifact_ref_has_raw_findings(run, base_dir=root):
            issues.append({"code": "raw_pointer_missing", "run_id": run_id, "cycle_id": run.get("cycle_id") or run.get("cycle_uid"), "expected_raw_findings_count": expected_raw})
        for ref in _artifact_refs_from_run(run):
            artifact_refs_seen.append(ref)
            issue = _verify_artifact_ref(ref, root=root, workspace_root=workspace, source={"kind": "run", "run_id": run_id})
            if issue:
                issues.append(issue)
            else:
                verified += 1
    verified += _verify_cycle_files(root=root, cycle_id=cycle_id, issues=issues)
    _verify_artifact_indexes(root=root, artifact_refs_seen=artifact_refs_seen, issues=issues)
    _verify_manifests_and_inventory(root=root, cycle_id=cycle_id, artifact_refs_seen=artifact_refs_seen, issues=issues)
    _verify_retention_events(root=root, issues=issues)
    return {"schema_version": 1, "status": "ok" if not issues else "failed", "valid": not issues, "cycle_id": cycle_id, "verified_artifact_count": verified, "issues": issues}


def approve_runtime_v2_promotion(
    *,
    evidence_bundle: str | Path,
    base_dir: str | Path | None = None,
    operator_approval_ref: str | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    from .runtime_profile import enforce_profile_for_write

    root = (
        ensure_tools_binding(base_dir, workspace_root=workspace_root)
        if workspace_root is not None
        else ensure_tools_dir(base_dir)
    )
    enforce_profile_for_write("runtime_v2_promotion", base_dir=root)
    bundle_path = Path(evidence_bundle).expanduser().resolve()
    if not bundle_path.exists() or not bundle_path.is_file():
        raise GovernanceError("runtime_v2_evidence_bundle_missing")
    try:
        bundle_path.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError("runtime_v2_evidence_bundle_must_be_under_tools_root") from exc
    payload = _read_json(bundle_path)
    if operator_approval_ref is None:
        operator_approval_ref = str(payload.get("operator_approval_ref") or "")
    if not operator_approval_ref.strip():
        raise GovernanceError("runtime_v2_promotion_requires_operator_approval_ref")
    # ARIA-AUDIT-015: a non-empty string is a claim, not authority. The
    # reference must resolve against recorded operator action — a
    # governance event, a review anchor, or an operator-injected
    # acknowledgment variable — or the promotion refuses.
    from .operator_approval import OperatorApprovalUnrecorded, verify_operator_approval_ref

    try:
        verify_operator_approval_ref(
            operator_approval_ref, base_dir=root, surface="runtime_v2_promotion",
        )
    except OperatorApprovalUnrecorded as exc:
        raise GovernanceError(
            f"runtime_v2_promotion_operator_approval_unrecorded: {exc}"
        ) from exc
    bound_workspace = Path(workspace_root).resolve() if workspace_root is not None else _bound_workspace_root(root)
    if bound_workspace is None:
        raise GovernanceError("runtime_v2_promotion_requires_workspace_root")
    target_sha = str(payload.get("target_sha") or payload.get("code_sha") or "")
    if not target_sha.strip():
        raise GovernanceError("runtime_v2_promotion_requires_target_sha")
    current_sha = _git_head(bound_workspace)
    if current_sha != target_sha:
        raise GovernanceError("runtime_v2_promotion_target_sha_mismatch")
    verification = verify_runtime_artifacts(base_dir=root, workspace_root=bound_workspace)
    if verification["status"] != "ok":
        raise GovernanceError("runtime_v2_promotion_evidence_integrity_failed")
    bundle_hash = "sha256:" + hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    identity_hash = _current_tools_identity_hash(root)
    if identity_hash is None:
        raise GovernanceError("runtime_v2_promotion_requires_tools_identity")
    row = {
        "$schema": "aria/runtime-v2-promotion/v1",
        "schema_version": 2,
        "recorded_at": utc_now(),
        "status": "approved",
        "operator_approval_ref": operator_approval_ref,
        "target_sha": target_sha,
        "tools_identity_hash": identity_hash,
        "artifact_verifier_version": ARTIFACT_VERIFIER_VERSION,
        "evidence_bundle": bundle_path.as_posix(),
        "evidence_bundle_hash": bundle_hash,
        "verification": {
            "verified_artifact_count": verification["verified_artifact_count"],
            "issue_count": len(verification["issues"]),
        },
    }
    return append_declared_jsonl(
        root / "runtime" / "v2-promotions.jsonl",
        row,
        expected_surface="runtime_v2_promotions",
    )


def require_runtime_v2_promotion(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
) -> None:
    root = (
        ensure_tools_binding(base_dir, workspace_root=workspace_root)
        if workspace_root is not None
        else ensure_tools_dir(base_dir)
    )
    rows = load_declared_jsonl(root / "runtime" / "v2-promotions.jsonl", expected_surface="runtime_v2_promotions")
    approved = [row for row in rows if row.get("status") == "approved"]
    if not approved:
        raise GovernanceError("ARIA_RUN_LEDGER_FORMAT=v2 requires approved runtime v2 promotion record")
    latest = approved[-1]
    if latest.get("artifact_verifier_version") != ARTIFACT_VERIFIER_VERSION:
        raise GovernanceError("runtime_v2_promotion_stale_verifier_version")
    if not latest.get("operator_approval_ref") or not latest.get("evidence_bundle_hash"):
        raise GovernanceError("runtime_v2_promotion_unbound_approval")
    target_sha = str(latest.get("target_sha") or "")
    if not target_sha:
        raise GovernanceError("runtime_v2_promotion_unbound_target_sha")
    bound_workspace = Path(workspace_root).resolve() if workspace_root is not None else _bound_workspace_root(root)
    if bound_workspace is None:
        raise GovernanceError("runtime_v2_promotion_requires_workspace_root")
    if _git_head(bound_workspace) != target_sha:
        raise GovernanceError("runtime_v2_promotion_target_sha_mismatch")
    identity_hash = _current_tools_identity_hash(root)
    if latest.get("tools_identity_hash") != identity_hash:
        raise GovernanceError("runtime_v2_promotion_tools_identity_mismatch")
    bundle_path = Path(str(latest.get("evidence_bundle") or "")).expanduser().resolve()
    try:
        bundle_path.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError("runtime_v2_promotion_evidence_bundle_outside_tools_root") from exc
    if not bundle_path.exists() or not bundle_path.is_file():
        raise GovernanceError("runtime_v2_promotion_evidence_bundle_missing")
    actual_hash = "sha256:" + hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    if latest.get("evidence_bundle_hash") != actual_hash:
        raise GovernanceError("runtime_v2_promotion_evidence_bundle_hash_mismatch")

def retention_dry_run(
    *,
    base_dir: str | Path | None = None,
    retain_hot_cycles: int = 20,
) -> dict[str, Any]:
    rows = load_declared_jsonl(artifact_index_path(base_dir), expected_surface="runtime_artifact_index")
    candidates = _retention_candidates(rows, retain_hot_cycles=retain_hot_cycles)
    return {
        "schema_version": 1,
        "mode": "dry-run",
        "retain_hot_cycles": retain_hot_cycles,
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


def retention_apply(
    *,
    base_dir: str | Path | None = None,
    acknowledge: bool = False,
    retain_hot_cycles: int = 20,
    workspace_root: str | Path | None = None,
    reason: str | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    if not acknowledge:
        raise GovernanceError("retention_apply_requires_acknowledge")
    if not reason or not reason.strip():
        raise GovernanceError("retention_apply_requires_reason")
    if not operator_approval_ref or not operator_approval_ref.strip():
        raise GovernanceError("retention_apply_requires_operator_approval_ref")
    root = (
        ensure_tools_binding(base_dir, workspace_root=workspace_root)
        if workspace_root is not None
        else ensure_tools_dir(base_dir)
    )
    candidates = _retention_candidates(load_declared_jsonl(artifact_index_path(root), expected_surface="runtime_artifact_index"), retain_hot_cycles=retain_hot_cycles)
    archived: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate.get("review_required"):
            continue
        source = _resolve_uri(root, str(candidate["current_uri"]))
        if not source.exists():
            continue
        budget = _ArchiveReadBudget()
        query = {"artifact_id": candidate["artifact_id"], "uri": candidate["current_uri"],
                 "sha256": candidate["sha256"]}
        creations, _events, _index = _archive_history(root, query, budget=budget)
        _consistent_runtime_creations(creations)
        if not creations:
            raise _ArchiveUnavailable("legacy_identity_unavailable")
        ref = _runtime_creation_ref(creations[0])
        assert ref is not None  # Validated by the creation owner above.
        content = _read_ref_content(root, ref["uri"], ref, budget=budget, max_bytes=_ARCHIVE_FILE_BYTES)
        if len(content) != creations[0]["size_bytes"]:
            raise _ArchiveUnavailable("archive_size_mismatch")
        archive_path = root / ".archive" / "runtime" / ref["sha256"].removeprefix("sha256:") / _safe_segment(ref["artifact_id"]) / source.name
        _assert_under_root(archive_path, root / ".archive")
        if archive_path.exists():
            _read_ref_content(root, _relative_uri(root, archive_path), ref,
                              budget=budget, max_bytes=_ARCHIVE_FILE_BYTES)
        else:
            _atomic_write_bytes(archive_path, content)
            _read_ref_content(root, _relative_uri(root, archive_path), ref,
                              budget=budget, max_bytes=_ARCHIVE_FILE_BYTES)
        actual = ref["sha256"]
        archive_id = "retention." + hashlib.sha256(
            json.dumps(_artifact_identity(ref), separators=(",", ":")).encode("utf-8"),
        ).hexdigest()
        event = {
            "schema_version": 1,
            "event": "artifact_archived",
            "manifest_id": archive_id,
            "artifact_id": candidate["artifact_id"],
            "cycle_uid": candidate.get("cycle_uid"),
            "original_path": candidate["current_uri"],
            "new_path": _relative_uri(root, archive_path),
            "sha256": actual,
            "size": len(content),
            "source_descriptor": {"schema_version": 1, "artifact_ref": ref},
            "reason": reason.strip(),
            "candidate_reason": candidate.get("reason"),
            "operator_approval_ref": operator_approval_ref.strip(),
            "reviewed": True,
            "recorded_at": utc_now(),
        }
        events_path = root / "retention/events.jsonl"
        # One logical archive operation even when identical retain calls overlap.
        # R3 separately owns coordinated artifact publication and final eviction.
        with _archive_transaction([events_path]) as transaction:
            prior = _archive_rows(root, "retention/events.jsonl", "retention_events", budget=budget,
                                  keep=lambda row: row.get("event") == "artifact_archived" and row.get("manifest_id") == archive_id)
            if any(row.get("source_descriptor") != event["source_descriptor"]
                   or row.get("new_path") != event["new_path"] or row.get("sha256") != actual for row in prior):
                raise _ArchiveUnavailable("archive_operation_conflict")
            if prior:
                continue
            transaction.append_declared_jsonl(events_path, event, expected_surface="retention_events")
        archived.append(event)
    return {
        "schema_version": 1,
        "mode": "apply",
        "archived_count": len(archived),
        "archived": archived,
    }

def restore_artifact(
    *,
    base_dir: str | Path | None = None,
    artifact_ref: str,
    workspace_root: str | Path | None = None,
    reason: str | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    if not reason or not reason.strip():
        raise GovernanceError("restore_artifact_requires_reason")
    if not operator_approval_ref or not operator_approval_ref.strip():
        raise GovernanceError("restore_artifact_requires_operator_approval_ref")
    root = (
        ensure_tools_binding(base_dir, workspace_root=workspace_root)
        if workspace_root is not None
        else ensure_tools_dir(base_dir)
    )
    budget = _ArchiveReadBudget()
    try:
        ref = _archive_ref_for_query(root, artifact_ref, budget=budget)
        resolved = _resolve_artifact_bytes(ref, base_dir=root, max_bytes=_ARCHIVE_FILE_BYTES, _budget=budget)
    except (_ArchiveLimit, _LedgerReadLimitError) as exc:
        raise GovernanceError(f"artifact_unavailable:{artifact_ref}:budget_exceeded") from exc
    except _ArchiveUnavailable as exc:
        raise GovernanceError(f"artifact_unavailable:{artifact_ref}:{exc}") from exc
    if resolved["status"] != "resolved":
        raise GovernanceError(f"artifact_unavailable:{artifact_ref}:{resolved['reason']}")
    uri = ref["uri"]
    path = _resolve_uri(root, uri)
    restored_from_archive = resolved["source_tier"] == "archive"
    if restored_from_archive:
        _atomic_write_bytes(path, resolved["content"])
        _read_ref_content(root, uri, ref, budget=budget, max_bytes=_ARCHIVE_FILE_BYTES)
    actual = ref["sha256"]
    event = append_declared_jsonl(retention_events_path(root), {
        "schema_version": 1,
        "event": "artifact_restored",
        "artifact_id": ref["artifact_id"],
        "path": uri,
        "sha256": actual,
        "restored_from_archive": restored_from_archive,
        "reason": reason.strip(),
        "operator_approval_ref": operator_approval_ref.strip(),
        "recorded_at": utc_now(),
    }, expected_surface="retention_events")
    return {
        "schema_version": 1,
        "status": "restored",
        "artifact_id": ref["artifact_id"],
        "path": uri,
        "sha256": actual,
        "retention_event_id": event.get("event_id"),
    }

def rollback_retention(
    *,
    base_dir: str | Path | None = None,
    manifest_id: str,
    workspace_root: str | Path | None = None,
    reason: str | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    if not reason or not reason.strip():
        raise GovernanceError("rollback_retention_requires_reason")
    if not operator_approval_ref or not operator_approval_ref.strip():
        raise GovernanceError("rollback_retention_requires_operator_approval_ref")
    root = (
        ensure_tools_binding(base_dir, workspace_root=workspace_root)
        if workspace_root is not None
        else ensure_tools_dir(base_dir)
    )
    events = load_declared_jsonl(retention_events_path(root), expected_surface="retention_events")
    matches = [row for row in events if row.get("manifest_id") == manifest_id]
    restored: list[dict[str, Any]] = []
    for row in matches:
        source = _resolve_uri(root, str(row.get("new_path")))
        destination = _resolve_uri(root, str(row.get("original_path")))
        if not source.exists():
            raise GovernanceError(f"archive_restore_failed:{manifest_id}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        actual = _sha256_bytes(destination.read_bytes())
        if actual != row.get("sha256"):
            raise GovernanceError(f"artifact_hash_mismatch:{manifest_id}")
        restored.append({"artifact_id": row.get("artifact_id"), "path": row.get("original_path")})
    event = append_declared_jsonl(retention_events_path(root), {
        "schema_version": 1,
        "event": "retention_rollback",
        "manifest_id": manifest_id,
        "restored_count": len(restored),
        "reason": reason.strip(),
        "operator_approval_ref": operator_approval_ref.strip(),
        "recorded_at": utc_now(),
    }, expected_surface="retention_events")
    return {
        "schema_version": 1,
        "status": "rolled_back",
        "manifest_id": manifest_id,
        "restored_count": len(restored),
        "restored": restored,
        "retention_event_id": event.get("event_id"),
    }

# ORPHAN-HIGH-424 — the marker keys producers already use to report
# suppression and truncation (``aria_watchdog`` emits
# ``findings_suppressed``; ``executor`` packets carry
# ``prompt_truncated``). Pre-fix ``suppressed_count`` and
# ``truncated_count`` were locals initialised to 0 and never
# incremented, so no producer could ever move them. Reading the markers
# instead means a producer that starts reporting either quantity is
# counted without further wiring.
_SUPPRESSED_MARKER_KEYS: tuple[str, ...] = (
    "findings_suppressed",
    "suppressed_count",
)
_TRUNCATED_MARKER_KEYS: tuple[str, ...] = (
    "prompt_truncated",
    "truncated_count",
)


def _marker_total(container: dict[str, Any], keys: tuple[str, ...]) -> int:
    """Sum the reported marker values on one dict.

    ``bool`` is checked before ``int`` because ``True`` is an ``int`` in
    Python and a truncation flag means "one truncation", not "one".
    """
    total = 0
    for key in keys:
        value = container.get(key)
        if isinstance(value, bool):
            total += 1 if value else 0
        elif isinstance(value, int):
            total += max(0, value)
    return total


# A tool that finishes this close to its declared timeout is reported as
# pressure. 0.8 leaves a full night of notice at the growth rates this repo
# has actually shown, without firing on tools that merely use their budget.
BUDGET_PRESSURE_THRESHOLD = 0.8


_MEMORY_DISPLAY_BYTES = 8 * 1024
_MEMORY_DISPLAY_CYCLES = 4
_MEMORY_DISPLAY_OBSERVATIONS = 8
_MEMORY_STATUSES = frozenset({
    "no_op_memory_hook", "needs_signing", "no_pattern_signature", "not_attempted",
    "completed", "completed_with_errors", "callback_error", "audit_error",
    "pending", "already_recorded", "memory_hook_recorded", "convention_audit_failed",
    "convention_record_failed", "convention_chain_invalid", "attempt_audit_failed",
    "observation_source_failed",
})


def _memory_receipt(value: Any, *, present: bool) -> dict[str, Any]:
    """Project public facts only; missing data is not a negative observation."""
    row = value if isinstance(value, dict) else {}
    status = row.get("status")
    receipt: dict[str, Any] = {
        "input_status": "present" if isinstance(value, dict) else "unavailable" if present else "missing",
        "status": status if isinstance(status, str) and status in _MEMORY_STATUSES else None,
        "convention_recorded": row.get("convention_recorded") if type(row.get("convention_recorded")) is bool else None,
        "chain_verified": row.get("chain_verified") if type(row.get("chain_verified")) is bool else None,
    }
    for key in ("cycle_id", "plan_id", "plan_revision_id", "plan_content_hash",
                "pending_event_hash", "convergence_event_id", "convergence_event_hash",
                "signer_cycle_id", "signer_key_fp"):
        item = row.get(key)
        # Never shorten an identity and present the shortened value as exact.
        receipt[key] = item if isinstance(item, str) and len(item) <= 512 else None
        if isinstance(item, str) and len(item) > 512:
            receipt.setdefault("identity_omissions", {})[key] = "display_length_exceeded"
    for key in ("error_class", "audit_error_class"):
        item = row.get(key)
        if isinstance(item, str) and len(item) <= 80 and item.isidentifier():
            receipt[key] = item
    if type(row.get("append_attempted")) is bool:
        receipt["append_attempted"] = row["append_attempted"]
    return receipt


def _memory_priority(receipt: dict[str, Any]) -> int:
    if receipt.get("error_class") or receipt.get("audit_error_class") or receipt.get("chain_verified") is False:
        return 0
    return 1 if receipt.get("status") in {"needs_signing", "pending"} else 2


def _memory_omissions(projection: dict[str, Any]) -> None:
    cycles = projection["cycles"]
    kept = sum(len(cycle["completion"]["observations"]) for cycle in cycles)
    projection["omitted_cycle_count"] = projection["input_cycle_count"] - len(cycles)
    projection["omitted_observation_count"] = projection["reported_observation_counts"]["items"] - kept
    projection["truncated"] = bool(projection["omitted_cycle_count"] or projection["omitted_observation_count"])


def _memory_drop_detail(projection: dict[str, Any]) -> bool:
    """Remove display detail, never counts or persistence/error facts in totals."""
    # The byte bound must obey the same global receipt priority as selection.
    # Deterministic ties discard the later displayed receipt first.
    candidates = [(_memory_priority(row), cycle_index, index)
                  for cycle_index, cycle in enumerate(projection["cycles"])
                  for index, row in enumerate(cycle["completion"]["observations"])]
    if candidates:
        _, cycle_index, index = max(candidates)
        projection["cycles"][cycle_index]["completion"]["observations"].pop(index)
        _memory_omissions(projection)
        return True
    if projection["cycles"]:
        _, index = max((min(_memory_priority(cycle["initial"]), _memory_priority(cycle["completion"])), index)
                       for index, cycle in enumerate(projection["cycles"]))
        projection["cycles"].pop(index)
        _memory_omissions(projection)
        return True
    return False


def _memory_learning_projection(per_cycle: list[Any]) -> dict[str, Any] | None:
    """Pure projection of supplied outer results, not a history/backlog query.

    Initial state, callback status and individual receipts are independent.
    Counters describe reporting occurrences, not new appends or learning gain.
    """
    if not any(isinstance(item, dict) and ("memory_hook" in item or "memory_completion" in item)
               for item in per_cycle):
        return None
    projection: dict[str, Any] = {
        "schema_version": 1, "input_cycle_count": 0,
        "initial_status_counts": {}, "completion_status_counts": {},
        "reported_observation_counts": {
            "items": 0, "recorded_receipts": 0, "already_recorded_receipts": 0,
            "item_errors": 0, "audit_errors": 0, "unverified_recorded_receipts": 0,
        },
        "cycles": [], "truncated": False, "omitted_cycle_count": 0, "omitted_observation_count": 0,
    }
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    counts = projection["reported_observation_counts"]
    for ordinal, outer in enumerate(per_cycle):
        if not isinstance(outer, dict):
            continue
        projection["input_cycle_count"] += 1
        initial = _memory_receipt(outer.get("memory_hook"), present="memory_hook" in outer)
        completion = _memory_receipt(outer.get("memory_completion"), present="memory_completion" in outer)
        # The initial hook omits plan_id; its real caller used this supplied
        # convergence linkage. Never synthesize an ID from a cycle name.
        convergence = outer.get("convergence")
        convergence = convergence if isinstance(convergence, dict) else {}
        linkage = _memory_receipt({"cycle_id": outer.get("cycle_id"), "plan_id": convergence.get("plan_id")}, present=True)
        for key in ("cycle_id", "plan_id"):
            if initial[key] is None and key not in initial.get("identity_omissions", {}):
                initial[key] = linkage[key]
                if key in linkage.get("identity_omissions", {}):
                    initial.setdefault("identity_omissions", {})[key] = linkage["identity_omissions"][key]
        raw_completion = outer.get("memory_completion")
        raw_completion = raw_completion if isinstance(raw_completion, dict) else {}
        for key in ("attempted", "already_recorded"):
            value = raw_completion.get(key)
            completion[key] = value if type(value) is int and value >= 0 else None
        for name, receipt in (("initial_status_counts", initial), ("completion_status_counts", completion)):
            status = receipt["status"] or receipt["input_status"]
            projection[name][status] = projection[name].get(status, 0) + 1
        observations = raw_completion.get("observations")
        observations = observations if isinstance(observations, list) else []
        selected: list[tuple[int, int, dict[str, Any]]] = []
        for index, value in enumerate(observations):
            receipt = _memory_receipt(value, present=True)
            counts["items"] += 1
            recorded = receipt["convention_recorded"] is True
            counts["recorded_receipts"] += int(recorded)
            counts["already_recorded_receipts"] += int(receipt["status"] == "already_recorded" and recorded)
            counts["item_errors"] += int(bool(receipt.get("error_class") or receipt["chain_verified"] is False))
            counts["audit_errors"] += int(bool(receipt.get("audit_error_class")))
            counts["unverified_recorded_receipts"] += int(recorded and receipt["chain_verified"] is not True)
            selected.append((_memory_priority(receipt), index, receipt))
            selected.sort(key=lambda item: item[:2])
            del selected[_MEMORY_DISPLAY_OBSERVATIONS:]
        completion["observations"] = [item[2] for item in selected]
        cycle = {"cycle_id": linkage["cycle_id"], "initial": initial, "completion": completion}
        if "cycle_id" in linkage.get("identity_omissions", {}):
            cycle["identity_omissions"] = {"cycle_id": linkage["identity_omissions"]["cycle_id"]}
        priority = min([_memory_priority(initial), _memory_priority(completion), *[item[0] for item in selected]])
        candidates.append((priority, ordinal, cycle))
        candidates.sort(key=lambda item: item[:2])
        del candidates[_MEMORY_DISPLAY_CYCLES:]
    # Select cycles by priority, then retain source order for receipt ties and
    # later byte fitting; no display ordinal may masquerade as source order.
    projection["cycles"] = [item[2] for item in sorted(candidates, key=lambda item: item[1])]
    # The cycle cap bounds this pool to 32 receipts. Spend the observation
    # budget globally, so one cycle's replays cannot displace another's errors.
    while sum(len(cycle["completion"]["observations"]) for cycle in projection["cycles"]) > _MEMORY_DISPLAY_OBSERVATIONS:
        _memory_drop_detail(projection)
    _memory_omissions(projection)
    while len(json.dumps(projection, indent=2, sort_keys=True).encode("utf-8")) > _MEMORY_DISPLAY_BYTES:
        if not _memory_drop_detail(projection):
            break
    return projection


def _fit_memory_learning_summary(summary: dict[str, Any]) -> None:
    """Fit optional receipts to the actual stdout object, including artifact URI.

    The legacy full_result is an artifact payload, not stdout. If essential
    metadata cannot fit, the CLI's existing contract-error guard remains final.
    """
    projection = summary.get("memory_learning")
    if not isinstance(projection, dict):
        return
    stdout = {key: value for key, value in summary.items() if key != "full_result"}
    # CLI print() emits one trailing newline in addition to the JSON bytes.
    while len(json.dumps(stdout, indent=2, sort_keys=True).encode("utf-8")) + 1 > SUMMARY_STDOUT_MAX_BYTES:
        if not _memory_drop_detail(projection):
            break


def _cycle_result_status(cycle: dict[str, Any], *, default: str = "unknown") -> str:
    """Project existing execution and terminal facts for result consumers.

    Runtime failures retain their detail. Successful execution cannot hide
    a failed or unresolved terminal result. Older callers that omit either
    field retain their existing fallback; the original fields are not changed.
    """
    runtime = str(cycle.get("runtime_status") or cycle.get("status") or default)
    terminal = str(cycle.get("status") or runtime)
    if runtime not in {"ok", "completed"}:
        return runtime
    if terminal not in {"ok", "completed"}:
        return terminal
    return "failed" if cycle.get("non_ok_tools") else runtime


def autonomy_output_summary(
    result: dict[str, Any],
    *,
    result_detail: str = "summary",
    base_dir: str | Path | None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """`base_dir` is keyword-REQUIRED (no default) on purpose: a summary that
    cannot open the store cannot honestly claim anything about artifact
    integrity, and a default would let a caller silently produce that claim."""
    per_cycle = result.get("per_cycle") if isinstance(result.get("per_cycle"), list) else []
    cycle_status_counts: dict[str, int] = {}
    tool_status_counts: dict[str, int] = {}
    artifact_refs: list[dict[str, Any]] = []
    non_ok_tools: list[dict[str, Any]] = []
    evidence_errors = 0
    incomplete_lifecycle_count = 0
    failed_phases: list[dict[str, Any]] = []
    suppressed_count = 0
    truncated_count = 0
    warnings: list[dict[str, Any]] = []
    budget_pressure: list[dict[str, Any]] = []
    for item in per_cycle:
        if not isinstance(item, dict):
            continue
        cycle = item.get("cycle") if isinstance(item.get("cycle"), dict) else {}
        status = _cycle_result_status(cycle)
        cycle_status_counts[status] = cycle_status_counts.get(status, 0) + 1
        cycle_incomplete = int(cycle.get("incomplete_lifecycle_count") or 0)
        incomplete_lifecycle_count += cycle_incomplete
        suppressed_count += _marker_total(cycle, _SUPPRESSED_MARKER_KEYS)
        truncated_count += _marker_total(cycle, _TRUNCATED_MARKER_KEYS)
        # ORPHAN-HIGH-424 — a started-without-terminal cycle, and an
        # unreadable cycles.jsonl, are both operator-actionable and were
        # both invisible while warning_count was pinned to 0.
        if cycle_incomplete:
            warnings.append({
                "code": "incomplete_cycle_lifecycle",
                "cycle_id": cycle.get("cycle_id"),
                "incomplete_count": cycle_incomplete,
            })
        lifecycle = cycle.get("cycle_lifecycle")
        if isinstance(lifecycle, dict) and lifecycle.get("valid") is False and not cycle_incomplete:
            warnings.append({
                "code": "cycle_lifecycle_unreadable",
                "cycle_id": cycle.get("cycle_id"),
                "detail": lifecycle.get("ledger_integrity_error")
                or lifecycle.get("lifecycle_read_error"),
            })
        for phase in cycle.get("failed_phases", []) if isinstance(cycle.get("failed_phases"), list) else []:
            if isinstance(phase, dict):
                failed_phases.append(phase)
        for ref in cycle.get("artifact_refs", []) if isinstance(cycle.get("artifact_refs"), list) else []:
            if isinstance(ref, dict):
                artifact_refs.append(ref)
        for run in cycle.get("tool_run_summary", []) if isinstance(cycle.get("tool_run_summary"), list) else []:
            if not isinstance(run, dict):
                continue
            tool_status = str(run.get("status") or "unknown")
            tool_status_counts[tool_status] = tool_status_counts.get(tool_status, 0) + 1
            suppressed_count += _marker_total(run, _SUPPRESSED_MARKER_KEYS)
            truncated_count += _marker_total(run, _TRUNCATED_MARKER_KEYS)
            if tool_status not in {"ok"}:
                non_ok_tools.append({
                    "cycle_id": cycle.get("cycle_id"),
                    "tool_id": run.get("tool_id"),
                    "status": tool_status,
                    "artifact_status": run.get("artifact_status"),
                })
            if tool_status == "evidence_error":
                evidence_errors += 1
            utilisation = run.get("budget_utilisation")
            if isinstance(utilisation, (int, float)) and utilisation >= BUDGET_PRESSURE_THRESHOLD:
                budget_pressure.append({
                    "cycle_id": cycle.get("cycle_id"),
                    "tool_id": run.get("tool_id"),
                    "budget_utilisation": round(float(utilisation), 4),
                    "duration_ms": run.get("duration_ms"),
                    "timeout_ms": run.get("timeout_ms"),
                })
            if run.get("artifact_status") in {"missing", "hash_mismatch", "write_failed"}:
                non_ok_tools.append({
                    "cycle_id": cycle.get("cycle_id"),
                    "tool_id": run.get("tool_id"),
                    "status": "integrity_failed",
                    "artifact_status": run.get("artifact_status"),
                })
    if result.get("exits_clean") is False:
        overall = "blocked" if result.get("exit_reason") == "daemon_already_running" else "failed"
    elif any(status in cycle_status_counts for status in ("failed", "integrity_failed", "aborted")) or non_ok_tools:
        overall = "failed"
    elif any(status in cycle_status_counts for status in ("degraded", "partial")):
        overall = "degraded"
    else:
        overall = "ok"
    artifact_hash_status, artifact_hash_issues = _artifact_hash_status(
        artifact_refs, base_dir=base_dir, workspace_root=workspace_root,
    )
    # ORPHAN-HIGH-424 — anomalies that are real but not fatal. `overall`
    # already turns "failed" on a bad cycle status or a non-ok tool, so
    # these are precisely the signals that used to reach the operator as
    # warning_count: 0 next to overall_status: ok.
    # "none" means there were no artifact refs to verify, which is not an
    # anomaly; only "drift" is (see _artifact_hash_status).
    if artifact_hash_status == "drift":
        warnings.append({
            "code": "artifact_hash_drift",
            "artifact_hash_status": artifact_hash_status,
            # Bounded: the summary has a 32 KB stdout ceiling, and an operator
            # needs the first offenders by name, not all of them.
            "issues": [
                {"code": issue.get("code"), "path": issue.get("path") or issue.get("ref")}
                for issue in artifact_hash_issues[:10]
            ],
            "issue_count": len(artifact_hash_issues),
        })
    if failed_phases and overall == "ok":
        warnings.append({
            "code": "failed_phases_without_failed_status",
            "failed_phase_count": len(failed_phases),
        })
    if evidence_errors:
        warnings.append({"code": "evidence_errors", "count": evidence_errors})
    if budget_pressure:
        # ORPHAN-HIGH-801 — a tool that finished at 96% of its budget is one
        # repo-growth commit away from a dead cycle, and today that arrives
        # with no notice at all: the run is `ok` and nothing says how close it
        # came. This is the notice. It is a warning, never a status change —
        # a run that finished, finished.
        warnings.append({
            "code": "tool_budget_pressure",
            "threshold": BUDGET_PRESSURE_THRESHOLD,
            "tools": budget_pressure[:10],
            "tool_count": len(budget_pressure),
        })
    summary = {
        "schema_version": 2,
        "result_detail": result_detail,
        "overall_status": overall,
        "exit_code": autonomy_exit_code(overall),
        "exit_reason": result.get("exit_reason"),
        "cycles_completed": result.get("cycles_completed", 0),
        "cycle_status_counts": dict(sorted(cycle_status_counts.items())),
        "tool_status_counts": dict(sorted(tool_status_counts.items())),
        "error_count": len(non_ok_tools),
        "warning_count": len(warnings),
        "warnings": warnings,
        "suppressed_count": suppressed_count,
        "truncated_count": truncated_count,
        "non_ok_tools": non_ok_tools,
        "evidence_errors": evidence_errors,
        "artifact_refs": artifact_refs,
        "artifact_hash_status": artifact_hash_status,
        "quarantine_count": sum(1 for item in non_ok_tools if item.get("status") == "scope_violation"),
        "scope_out_count": sum(1 for item in non_ok_tools if item.get("status") == "scope_violation"),
        "failed_phases": failed_phases,
        "incomplete_lifecycle_count": incomplete_lifecycle_count,
    }
    memory_learning = _memory_learning_projection(per_cycle)
    if memory_learning is not None:
        summary["memory_learning"] = memory_learning
        _fit_memory_learning_summary(summary)
    if result_detail == "full":
        summary["full_result"] = result
    return summary


def autonomy_exit_code(status: str) -> int:
    return {
        "ok": 0,
        "failed": 1,
        "degraded": 2,
        "blocked": 3,
        "integrity_failed": 4,
        "contract_error": 4,
    }.get(status, 1)


def _ledger_issues(path: Path, name: str) -> list[dict[str, Any]]:
    result = verify_jsonl(path)
    if result.get("valid") is True:
        return []
    return [{"code": "ledger_integrity_failed", "ledger": name, "details": result}]


def _safe_load_jsonl(
    path: Path,
    issues: list[dict[str, Any]],
    name: str,
    *,
    expected_surface: str | None = None,
) -> list[dict[str, Any]]:
    try:
        if expected_surface is not None:
            return load_declared_jsonl(path, expected_surface=expected_surface)
        return load_jsonl(path, verify=True)
    except LedgerIntegrityError as exc:
        issues.append({"code": "ledger_load_failed", "ledger": name, "error": str(exc)})
        return []


def _artifact_refs_from_run(run: dict[str, Any]) -> list[Any]:
    refs: list[Any] = []
    singular = run.get("artifact_ref")
    if isinstance(singular, (dict, str)):
        refs.append(singular)
    for key in ("artifact_refs", "artifacts"):
        value = run.get(key)
        if isinstance(value, list):
            refs.extend(value)
    runner = run.get("runner")
    if isinstance(runner, dict):
        value = runner.get("artifact_refs")
        if isinstance(value, list):
            refs.extend(value)
    return refs


def _verify_artifact_ref(ref: Any, *, root: Path, workspace_root: Path | None, source: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(ref, str):
        return {"code": "artifact_ref_hashless_legacy", "ref": ref, "source": source}
    if isinstance(ref, dict):
        shape_issue = _artifact_ref_v2_issue(ref, source=source)
        if shape_issue is not None:
            return shape_issue
        artifact = ArtifactRefV2.from_dict(ref)
        raw_path = artifact.uri
        expected_hash = artifact.sha256
    else:
        return {"code": "artifact_ref_invalid", "ref": repr(ref), "source": source}
    if not raw_path.strip():
        return {"code": "artifact_ref_missing_path", "ref": ref, "source": source}
    raw_path_obj = Path(raw_path)
    if raw_path_obj.is_absolute():
        return {"code": "artifact_ref_absolute_uri_forbidden", "path": raw_path, "source": source}
    if raw_path.startswith("aria-tools/"):
        return {"code": "artifact_ref_aria_tools_alias_forbidden", "path": raw_path, "source": source}
    try:
        path = _resolve_artifact_path(raw_path, root=root, workspace_root=workspace_root)
    except GovernanceError as exc:
        return {"code": "artifact_path_escape", "path": raw_path, "source": source, "reason": str(exc)}
    rels = [raw_path]
    for allowed in [root.resolve(), *( [workspace_root.resolve()] if workspace_root is not None else [] )]:
        try:
            rels.append(path.resolve().relative_to(allowed).as_posix())
        except ValueError:
            continue
    if any(
        rel.startswith(prefix)
        for rel in rels
        for prefix in ARTIFACT_REF_FORBIDDEN_URI_PREFIXES
    ):
        return {"code": "artifact_ref_self_output_uri_forbidden", "path": raw_path, "source": source}
    if not path.exists():
        try:
            retained = _resolve_artifact_bytes(ref, base_dir=root, max_bytes=_ARCHIVE_FILE_BYTES)
        except (LedgerIntegrityError, GovernanceError, OSError):
            return {"code": "artifact_ref_missing", "path": raw_path, "source": source,
                    "reason": "archive_history_unavailable"}
        if retained["status"] == "resolved" and retained["source_tier"] == "archive":
            return None
        return {"code": "artifact_ref_missing", "path": raw_path, "source": source,
                "reason": retained["reason"]}
    if path.is_file():
        actual = file_hash(path)
        normalized = str(expected_hash)
        if normalized.startswith("sha256:"):
            normalized = normalized.split(":", 1)[1]
        if normalized != actual:
            try:
                retained = _resolve_artifact_bytes(ref, base_dir=root, max_bytes=_ARCHIVE_FILE_BYTES,
                                                   _archive_only=True)
            except (LedgerIntegrityError, GovernanceError, OSError):
                retained = None
            if retained is not None and retained["status"] == "resolved":
                return None
            return {"code": "artifact_hash_mismatch", "path": raw_path, "expected": expected_hash, "actual": "sha256:" + actual, "source": source}
    return None


def _artifact_ref_v2_issue(ref: dict[str, Any], *, source: dict[str, Any]) -> dict[str, Any] | None:
    try:
        _validate_artifact_ref_v2_shape(ref)
    except GovernanceError as exc:
        return {"code": "artifact_ref_v2_invalid", "reason": str(exc), "ref": ref, "source": source}
    return None


def _validate_artifact_ref_v2_shape(ref: dict[str, Any]) -> None:
    legacy = sorted(key for key in ARTIFACT_REF_LEGACY_ALIASES if key in ref)
    if legacy:
        raise GovernanceError("artifact_ref_v2_rejects_legacy_aliases:" + ",".join(legacy))
    extra = sorted(key for key in ref if key not in ARTIFACT_REF_V2_KEYS)
    if extra:
        raise GovernanceError("artifact_ref_v2_rejects_unknown_fields:" + ",".join(extra))
    missing = [key for key in ARTIFACT_REF_V2_REQUIRED if key not in ref]
    if missing:
        raise GovernanceError("artifact_ref_v2_missing_required:" + ",".join(missing))
    if ref.get("schema_version") != ARTIFACT_REF_V2_SCHEMA_VERSION:
        raise GovernanceError("artifact_ref_v2_schema_version_required")
    for key in ("artifact_id", "uri", "sha256", "content_type", "source_surface"):
        value = ref.get(key)
        if not isinstance(value, str) or not value.strip():
            raise GovernanceError(f"artifact_ref_v2_{key}_must_be_non_empty_string")
    produced = ref.get("produced_by_workflow_run_id")
    if not isinstance(produced, str) or not produced.strip():
        raise GovernanceError("artifact_ref_v2_produced_by_workflow_run_id_required")
    if produced == "local-runtime":
        raise GovernanceError("artifact_ref_v2_local_runtime_producer_forbidden")
    if not _is_sha256_digest(str(ref.get("sha256") or "")):
        raise GovernanceError("artifact_ref_v2_sha256_required")
    if isinstance(ref.get("source_surface"), list):
        raise GovernanceError("artifact_ref_v2_source_surface_must_be_single_string")


def _is_sha256_digest(value: str) -> bool:
    return (
        value.startswith("sha256:")
        and len(value) == len("sha256:") + 64
        and all(ch in "0123456789abcdef" for ch in value[len("sha256:"):])
    )


def _resolve_artifact_path(raw_path: str, *, root: Path, workspace_root: Path | None) -> Path:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = root.parent / raw_path if raw_path.startswith("aria-tools/") else root / raw_path
    resolved = candidate.resolve()
    allowed_roots = [root.resolve()]
    if workspace_root is not None:
        allowed_roots.append(workspace_root.resolve())
    for allowed in allowed_roots:
        try:
            resolved.relative_to(allowed)
            return resolved
        except ValueError:
            continue
    raise GovernanceError("artifact path escapes tools/workspace roots")


def _artifact_ref_has_raw_findings(run: dict[str, Any], *, base_dir: Path) -> bool:
    for ref in _artifact_refs_from_run(run):
        payload = resolve_artifact_payload(ref, base_dir=base_dir)
        inner = payload.get("payload") if isinstance(payload, dict) else None
        if isinstance(inner, dict) and isinstance(inner.get("raw_findings"), list):
            return True
    return False


def _raw_finding_issue(row: dict[str, Any], *, base_dir: Path) -> dict[str, Any] | None:
    finding = row.get("finding")
    if not isinstance(finding, dict):
        finding = resolve_finding_from_artifact(row, base_dir=base_dir)
    if not isinstance(finding, dict):
        return {"code": "raw_pointer_corrupt", "run_id": row.get("run_id"), "finding_id": row.get("finding_id")}
    expected = row.get("evidence_hash")
    if expected:
        actual = _evidence_hash_for_finding(finding)
        if actual != expected:
            return {"code": "raw_pointer_hash_mismatch", "run_id": row.get("run_id"), "finding_id": row.get("finding_id"), "expected": expected, "actual": actual}
    return None


def _evidence_hash_for_finding(finding: dict[str, Any]) -> str:
    refs = finding.get("evidence", [])
    if not isinstance(refs, list):
        refs = []
    canonical = json.dumps(refs, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _verify_cycle_files(*, root: Path, cycle_id: str | None, issues: list[dict[str, Any]]) -> int:
    if cycle_id is None:
        return 0
    verified = 0
    discovery_dir = root / "discovery" / cycle_id
    if discovery_dir.exists():
        for name in DISCOVERY_ARTIFACTS:
            path = discovery_dir / name
            if not path.exists():
                issues.append({"code": "discovery_artifact_missing", "cycle_id": cycle_id, "path": path.as_posix()})
                continue
            try:
                _read_json(path)
                verified += 1
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "discovery_artifact_corrupt", "cycle_id": cycle_id, "path": path.as_posix()})
    for path in (root / "cycle-diff" / f"{cycle_id}.json", root / "pressure" / f"{cycle_id}.json"):
        if path.exists():
            try:
                _read_json(path)
                verified += 1
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "cycle_artifact_corrupt", "cycle_id": cycle_id, "path": path.as_posix()})
    return verified


def _refs_requiring_hot_index(root: Path, refs: list[Any]) -> list[Any]:
    remaining = []
    for ref in refs:
        try:
            # Restoring an identical hot copy does not recreate a compacted
            # index row. Qualify the retained source independently of hot state.
            retained = _resolve_artifact_bytes(ref, base_dir=root, max_bytes=_ARCHIVE_FILE_BYTES,
                                               _archive_only=True)
        except (LedgerIntegrityError, GovernanceError, OSError, TypeError):
            remaining.append(ref)
            continue
        if retained["status"] != "resolved" or retained["source_tier"] != "archive":
            remaining.append(ref)
    return remaining


def _verify_artifact_indexes(*, root: Path, artifact_refs_seen: list[Any], issues: list[dict[str, Any]]) -> None:
    index_paths = [root / "run-artifacts" / "artifact-index.jsonl", root / "artifact-index.json", root / "artifact-index.jsonl", root / "artifacts" / "index.json"]
    existing = [path for path in index_paths if path.exists()]
    if artifact_refs_seen and not existing:
        if _refs_requiring_hot_index(root, artifact_refs_seen):
            issues.append({"code": "missing_artifact_index", "artifact_ref_count": len(artifact_refs_seen)})
        return
    for path in existing:
        if path.suffix == ".jsonl":
            expected_surface = (
                "runtime_artifact_index"
                if path == root / "run-artifacts" / "artifact-index.jsonl"
                else None
            )
            rows = _safe_load_jsonl(
                path,
                issues,
                "artifact_index",
                expected_surface=expected_surface,
            )
            required_refs = (_refs_requiring_hot_index(root, artifact_refs_seen)
                             if expected_surface == "runtime_artifact_index" else artifact_refs_seen)
            if required_refs and not rows:
                issues.append({"code": "artifact_index_empty_with_run_refs", "path": path.as_posix()})
            _verify_index_rows_cover_refs(rows, required_refs, issues=issues, path=path)
            continue
        try:
            payload = _read_json(path)
        except (OSError, json.JSONDecodeError):
            issues.append({"code": "artifact_index_corrupt", "path": path.as_posix()})
            continue
        entries = payload.get("artifacts") or payload.get("entries") or []
        if artifact_refs_seen and not entries:
            issues.append({"code": "artifact_index_empty_with_run_refs", "path": path.as_posix()})
        if isinstance(entries, list):
            dict_entries = [entry for entry in entries if isinstance(entry, dict)]
            _verify_index_rows_cover_refs(dict_entries, artifact_refs_seen, issues=issues, path=path)


def _verify_index_rows_cover_refs(
    rows: list[dict[str, Any]],
    artifact_refs_seen: list[Any],
    *,
    issues: list[dict[str, Any]],
    path: Path,
) -> None:
    if not artifact_refs_seen:
        return
    for ref in artifact_refs_seen:
        if not isinstance(ref, dict):
            continue
        artifact_id = str(ref.get("artifact_id") or "")
        uri = str(ref.get("uri") or "")
        expected = str(ref.get("sha256") or "")
        match = None
        for row in rows:
            row_id = str(row.get("artifact_id") or "")
            row_uri = str(row.get("current_uri") or row.get("uri") or "")
            if artifact_id and row_id == artifact_id:
                match = row
                break
            if uri and row_uri == uri:
                match = row
                break
        if match is None:
            issues.append({"code": "artifact_index_ref_missing", "artifact_id": artifact_id, "uri": uri, "index": path.as_posix()})
            continue
        indexed_hash = str(match.get("sha256") or "")
        if expected and indexed_hash and indexed_hash != expected:
            issues.append({"code": "artifact_index_hash_mismatch", "artifact_id": artifact_id, "uri": uri, "expected": expected, "actual": indexed_hash, "index": path.as_posix()})


def _verify_manifests_and_inventory(*, root: Path, cycle_id: str | None, artifact_refs_seen: list[Any], issues: list[dict[str, Any]]) -> None:
    _verify_global_manifest_inventory(root=root, artifact_refs_seen=artifact_refs_seen, issues=issues)
    cycle_dirs: list[Path] = []
    by_cycle = root / "runs" / "by-cycle"
    if cycle_id is not None:
        cycle_dirs.append(by_cycle / cycle_id)
    elif by_cycle.exists():
        cycle_dirs.extend(path for path in by_cycle.iterdir() if path.is_dir())
    for directory in cycle_dirs:
        if not directory.exists() or directory.is_file():
            continue
        manifest = directory / "manifest.json"
        inventory = directory / "inventory.json"
        if not manifest.exists() and not inventory.exists():
            continue
        if not manifest.exists():
            issues.append({"code": "missing_manifest", "path": manifest.as_posix()})
            continue
        try:
            manifest_payload = _read_json(manifest)
        except (OSError, json.JSONDecodeError):
            issues.append({"code": "manifest_corrupt", "path": manifest.as_posix()})
            manifest_payload = {}
        if inventory.exists():
            try:
                inventory_payload = _read_json(inventory)
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "inventory_corrupt", "path": inventory.as_posix()})
                inventory_payload = {}
            manifest_items = set(_item_paths(manifest_payload))
            inventory_items = set(_item_paths(inventory_payload))
            if manifest_items and inventory_items and manifest_items != inventory_items:
                issues.append({"code": "inventory_drift", "path": inventory.as_posix(), "manifest_only": sorted(manifest_items - inventory_items), "inventory_only": sorted(inventory_items - manifest_items)})
        else:
            issues.append({"code": "missing_inventory", "path": inventory.as_posix()})


def _item_paths(payload: dict[str, Any]) -> list[str]:
    value = payload.get("artifacts") or payload.get("files") or payload.get("items") or []
    out: list[str] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                path = item.get("path") or item.get("artifact_path") or item.get("uri")
                if isinstance(path, str):
                    out.append(path)
    return out


def _verify_global_manifest_inventory(*, root: Path, artifact_refs_seen: list[Any], issues: list[dict[str, Any]]) -> None:
    if not artifact_refs_seen:
        return
    manifest_path = root / "run-artifacts" / "manifest.jsonl"
    inventory_path = root / "observability" / "artifact-inventory.jsonl"
    manifest_rows = _safe_load_jsonl(manifest_path, issues, "runtime_artifact_manifest", expected_surface="runtime_artifact_manifest")
    inventory_rows = _safe_load_jsonl(inventory_path, issues, "runtime_artifact_inventory", expected_surface="runtime_artifact_inventory")
    if not manifest_rows:
        issues.append({"code": "artifact_manifest_empty_with_run_refs", "path": manifest_path.as_posix()})
    if not inventory_rows:
        issues.append({"code": "artifact_inventory_empty_with_run_refs", "path": inventory_path.as_posix()})
    for ref in artifact_refs_seen:
        if not isinstance(ref, dict):
            continue
        artifact_id = str(ref.get("artifact_id") or "")
        expected_hash = str(ref.get("sha256") or "")
        expected_uri = str(ref.get("uri") or "")
        if not artifact_id:
            continue
        manifest = _native_summary_for_ref(manifest_rows, ref, uri_field="current_uri")
        if manifest is None:
            issues.append({"code": "artifact_manifest_ref_missing", "artifact_id": artifact_id, "path": manifest_path.as_posix()})
        else:
            _verify_summary_row_against_ref(manifest, artifact_id=artifact_id, expected_hash=expected_hash, expected_uri=expected_uri, expected_producer=ref.get("produced_by_workflow_run_id"), issues=issues, code_prefix="artifact_manifest", path=manifest_path)
        inventory = _native_summary_for_ref(inventory_rows, ref, uri_field="path")
        if inventory is None:
            issues.append({"code": "artifact_inventory_ref_missing", "artifact_id": artifact_id, "path": inventory_path.as_posix()})
        else:
            _verify_summary_row_against_ref(inventory, artifact_id=artifact_id, expected_hash=expected_hash, expected_uri=expected_uri, expected_producer=ref.get("produced_by_workflow_run_id"), issues=issues, code_prefix="artifact_inventory", path=inventory_path)


def _native_summary_for_ref(
    rows: list[dict[str, Any]], ref: dict[str, Any], *, uri_field: str,
) -> dict[str, Any] | None:
    """Select the native version; retain the old diagnostic row if it is absent."""
    diagnostic = None
    for row in rows:
        if row.get("artifact_id") != ref.get("artifact_id"):
            continue
        diagnostic = row
        if (row.get(uri_field) == ref.get("uri")
                and row.get("sha256") == ref.get("sha256")
                and row.get("run_id") == ref.get("produced_by_workflow_run_id")):
            return row
    return diagnostic


def _verify_summary_row_against_ref(
    row: dict[str, Any],
    *,
    artifact_id: str,
    expected_hash: str,
    expected_uri: str,
    expected_producer: str | None,
    issues: list[dict[str, Any]],
    code_prefix: str,
    path: Path,
) -> None:
    row_hash = str(row.get("sha256") or "")
    row_uri = str(row.get("current_uri") or row.get("uri") or row.get("path") or "")
    if expected_hash and row_hash and row_hash != expected_hash:
        issues.append({"code": f"{code_prefix}_hash_mismatch", "artifact_id": artifact_id, "expected": expected_hash, "actual": row_hash, "path": path.as_posix()})
    if expected_uri and row_uri and row_uri != expected_uri:
        issues.append({"code": f"{code_prefix}_uri_mismatch", "artifact_id": artifact_id, "expected": expected_uri, "actual": row_uri, "path": path.as_posix()})
    if expected_producer and row.get("run_id") != expected_producer:
        issues.append({"code": f"{code_prefix}_producer_mismatch", "artifact_id": artifact_id, "expected": expected_producer, "actual": row.get("run_id"), "path": path.as_posix()})


def _source_is_native_republication(
    root: Path, event: dict[str, Any], actual_sha256: str, *, budget: _ArchiveReadBudget,
) -> bool:
    """Join retained A and later native B before accepting different hot bytes."""
    if event.get("event") != "artifact_archived":
        return False
    creations = _archive_rows(
        root, "run-artifacts/manifest.jsonl", "runtime_artifact_manifest", budget=budget,
        keep=lambda row: (row.get("event") == "artifact_created"
                          and row.get("artifact_id") == event.get("artifact_id")
                          and row.get("current_uri") == event.get("original_path")),
    )
    _consistent_runtime_creations(creations)
    for position, original in enumerate(creations):
        original_ref = _runtime_creation_ref(original)
        if original_ref is None or not _archive_event_matches(event, original_ref, creation=original):
            continue
        current_ref = {**original_ref, "sha256": actual_sha256}
        for newer in creations[position + 1:]:
            if (_runtime_creation_ref(newer) == current_ref
                    and newer.get("cycle_uid") == original.get("cycle_uid")
                    and newer.get("kind") == original.get("kind")):
                return True
    return False


def _verify_retention_events(*, root: Path, issues: list[dict[str, Any]]) -> None:
    path = root / "retention" / "events.jsonl"
    budget = _ArchiveReadBudget()
    for row in _safe_load_jsonl(path, issues, "retention_events", expected_surface="retention_events"):
        kind = str(row.get("kind") or row.get("event") or row.get("event_type") or "")
        source = row.get("source_path") or row.get("original_path")
        archive = row.get("archive_path") or row.get("new_path")
        if kind in {"retention_apply", "cycle_artifact_archived", "artifact_archived"} and source:
            try:
                source_path = _resolve_artifact_path(str(source), root=root, workspace_root=None)
            except GovernanceError:
                issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
                continue
            if archive:
                try:
                    archive_path = _resolve_artifact_path(str(archive), root=root, workspace_root=None)
                except GovernanceError:
                    issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
                    continue
                if not archive_path.exists():
                    issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
                    continue
                expected_source_hash = str(row.get("source_sha256") or row.get("sha256") or "")
                expected_archive_hash = str(row.get("archive_sha256") or row.get("sha256") or "")
                if expected_source_hash and source_path.exists():
                    normalized = expected_source_hash.split(":", 1)[1] if expected_source_hash.startswith("sha256:") else expected_source_hash
                    actual_source = file_hash(source_path)
                    if actual_source != normalized:
                        try:
                            republished = _source_is_native_republication(
                                root, row, "sha256:" + actual_source, budget=budget,
                            )
                        except (_ArchiveUnavailable, _ArchiveLimit, _LedgerReadLimitError, LedgerIntegrityError, OSError):
                            republished = False
                            issues.append({"code": "retention_source_provenance_unavailable", "source_path": str(source)})
                        if not republished:
                            issues.append({"code": "retention_source_hash_mismatch", "source_path": str(source), "expected": expected_source_hash, "actual": "sha256:" + actual_source})
                if expected_archive_hash:
                    normalized = expected_archive_hash.split(":", 1)[1] if expected_archive_hash.startswith("sha256:") else expected_archive_hash
                    try:
                        with _archive_file_chunks(root, str(archive), budget=budget, source=False,
                                                  max_bytes=_ARCHIVE_FILE_BYTES) as (_size, chunks):
                            digest = hashlib.sha256()
                            for chunk in chunks:
                                digest.update(chunk)
                        actual_archive = digest.hexdigest()
                    except (_ArchiveLimit, _ArchiveUnavailable, OSError) as exc:
                        issues.append({"code": "retention_archive_unavailable", "archive_path": str(archive),
                                       "reason": "budget_exceeded" if isinstance(exc, _ArchiveLimit) else "archive_read_unavailable"})
                        continue
                    if actual_archive != normalized:
                        issues.append({"code": "retention_archive_hash_mismatch", "archive_path": str(archive), "expected": expected_archive_hash, "actual": "sha256:" + actual_archive})
        if kind in {"retention_missing_source", "restore_failed"}:
            issues.append({"code": str(kind), "details": row})
        if kind == "rollback" and not row.get("manifest_id") and not row.get("manifest_path"):
            issues.append({"code": "unknown_manifest_rollback", "details": row})


def _load_registry_tools(root: Path, *, issues: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    path = root / "registry.json"
    try:
        payload = _read_json(path)
    except FileNotFoundError:
        if issues is not None and (root / "repo_identity.json").exists() and _runtime_tool_evidence_present(root):
            issues.append({"code": "registry_missing", "path": path.as_posix()})
        return []
    except (OSError, json.JSONDecodeError) as exc:
        if issues is not None:
            issues.append({"code": "registry_corrupt", "path": path.as_posix(), "error": str(exc)})
        return []
    tools = payload.get("tools")
    if not isinstance(tools, list):
        if issues is not None:
            issues.append({"code": "registry_tools_invalid", "path": path.as_posix()})
        return []
    return tools


def _runtime_tool_evidence_present(root: Path) -> bool:
    for relative in (
        "cycles.jsonl",
        "runs.jsonl",
        "raw-findings.jsonl",
        "run-artifacts/artifact-index.jsonl",
        "run-artifacts/manifest.jsonl",
        "observability/artifact-inventory.jsonl",
    ):
        path = root / relative
        try:
            if path.exists() and path.stat().st_size > 0:
                return True
        except OSError:
            return True
    runs_path = root / "runs.jsonl"
    if runs_path.exists():
        for row in load_declared_jsonl(runs_path, expected_surface="runs"):
            if _artifact_refs_from_run(row):
                return True
    return False


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise json.JSONDecodeError("JSON payload must be object", "", 0)
    return payload


def _retention_candidates(rows: list[dict[str, Any]], *, retain_hot_cycles: int) -> list[dict[str, Any]]:
    cycles = []
    seen = set()
    for row in reversed(rows):
        cycle = str(row.get("cycle_uid") or row.get("cycle_id") or "")
        if cycle and cycle not in seen:
            seen.add(cycle)
            cycles.append(cycle)
    retained = set(cycles[:retain_hot_cycles])
    candidates: list[dict[str, Any]] = []
    for row in rows:
        cycle = str(row.get("cycle_uid") or row.get("cycle_id") or "")
        if row.get("storage_tier") != "hot" or cycle in retained:
            continue
        status = str(row.get("run_status") or "")
        review_required = status not in {"ok", "completed", ""}
        candidates.append({
            "artifact_id": row.get("artifact_id"),
            "cycle_uid": cycle,
            "current_uri": row.get("current_uri"),
            "sha256": row.get("sha256"),
            "size": row.get("size_bytes"),
            "reason": "hot_retention_window_exceeded",
            "review_required": review_required,
        })
    return candidates


def _latest_archive_event(root: Path, artifact_id: str) -> dict[str, Any] | None:
    latest = None
    for row in load_declared_jsonl(retention_events_path(root), expected_surface="retention_events"):
        if row.get("artifact_id") == artifact_id and row.get("event") == "artifact_archived":
            latest = row
    return latest


def _artifact_hash_status(
    refs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None,
    workspace_root: str | Path | None,
) -> tuple[str, list[dict[str, Any]]]:
    """The artifact verdict, computed by RE-HASHING each referenced artifact.

    WHY this reads the store instead of a field: the previous implementation
    asked each ref for `verification_status`. No writer in the kernel has ever
    set that key — `write_run_artifact` stamps artifact_id, sha256, uri,
    source_surface, content_type, schema_version and produced_by_workflow_run_id,
    and nothing else. So `str(None or "")` was never in {"present", "ok"} and
    EVERY cycle that produced an artifact reported `artifact_hash_drift`. The
    warning was unconditional, which makes it worthless: an operator who sees
    it every night learns to scroll past the one night it means something. It
    also contradicted the state-integrity step, which re-hashes the same
    artifacts and passed on the same run.

    `_verify_artifact_ref` is the verifier the integrity path already uses:
    it resolves the uri inside the store, refuses escapes and aliases, and
    compares the recorded sha256 against the file on disk. Returning the
    issues alongside the verdict lets the warning say WHICH artifact drifted
    and why, instead of asserting drift with no referent.
    """
    if not refs:
        return "none", []
    root = tools_dir(base_dir)
    workspace = Path(workspace_root).resolve() if workspace_root else None
    issues: list[dict[str, Any]] = []
    for ref in refs:
        issue = _verify_artifact_ref(
            ref,
            root=root,
            workspace_root=workspace,
            source={"surface": "autonomy_summary"},
        )
        if issue is not None:
            issues.append(issue)
    return ("ok" if not issues else "drift"), issues


def _runner_summary(runner: Any) -> dict[str, Any]:
    if not isinstance(runner, dict):
        return {}
    return {
        "type": runner.get("type"),
        "exit_code": runner.get("exit_code"),
        "timed_out": runner.get("timed_out"),
        "raw_observations_count": runner.get("raw_observations_count", 0),
        "raw_findings_count": runner.get("raw_findings_count", 0),
        "scoped_mutations": runner.get("scoped_mutations", []),
        "scope_out_mutations": runner.get("scope_out_mutations", []),
        "parse_error": runner.get("parse_error"),
    }


def _relative_uri(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _resolve_uri(root: Path, uri: str) -> Path:
    candidate = (root / uri).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError(f"run_artifact_path_escape:{uri}") from exc
    if candidate.is_symlink():
        raise GovernanceError(f"run_artifact_path_escape:{uri}")
    return candidate


def _assert_under_root(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError(f"run_artifact_path_escape:{path}") from exc


def _safe_segment(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in str(value))
    return safe.strip("._") or "unknown"


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{datetime.now(timezone.utc).timestamp()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        try:
            os.write(fd, content)
            os.fsync(fd)
        finally:
            os.close(fd)
        tmp.replace(path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    if not os.name == "nt":
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def _current_tools_identity_hash(root: Path) -> str | None:
    identity_path = root / "repo_identity.json"
    if not identity_path.exists():
        return None
    return "sha256:" + hashlib.sha256(identity_path.read_bytes()).hexdigest()


def _bound_workspace_root(root: Path) -> Path | None:
    identity_path = root / "repo_identity.json"
    if not identity_path.exists():
        return None
    try:
        identity = _read_json(identity_path)
    except (OSError, json.JSONDecodeError):
        return None
    raw = identity.get("bound_repo_root")
    if not isinstance(raw, str) or not raw.strip():
        return None
    candidate = Path(raw).expanduser().resolve()
    return candidate if candidate.exists() else None


def _git_head(workspace_root: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=workspace_root,
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise GovernanceError("runtime_v2_workspace_head_unavailable") from exc
    return completed.stdout.strip()


__all__ = [
    "ArtifactRefV2", "ARTIFACT_REF_V2_SCHEMA_VERSION", "ARTIFACT_REF_V2_REQUIRED",
    "ARTIFACT_BEARING", "LIFECYCLE_ONLY", "INTEGRITY_FAILED", "INCOMPLETE",
    "RUN_LEDGER_FORMAT_ENV", "RUN_LEDGER_FORMATS", "DEFAULT_RUN_LEDGER_FORMAT",
    "SUMMARY_STDOUT_MAX_BYTES", "append_run_by_cycle", "approve_runtime_v2_promotion",
    "artifact_index_path", "artifact_inventory_path", "artifact_manifest_path",
    "budget_projection",
    "autonomy_exit_code", "autonomy_output_summary", "by_cycle_runs_path",
    "classify_cycle_evidence", "read_runs_for_cycle", "require_runtime_v2_promotion",
    "resolve_artifact_payload", "resolve_finding_from_artifact", "restore_artifact",
    "retention_apply", "retention_dry_run", "rollback_retention", "run_artifacts_root",
    "run_ledger_format", "verify_artifacts", "verify_runtime_artifacts", "write_run_artifact",
]
