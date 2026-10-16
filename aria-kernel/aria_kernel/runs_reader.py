"""Plan 026R §A.3 — runs.jsonl strict reader (closes ORPHAN-HIGH-061).

Pre-§A.3 four+ callsites of ``aria-tools/runs.jsonl`` each repeated
the silent-skip ``except json.JSONDecodeError: continue`` pattern:

* ``spine_orchestrator._latest_run_for_adapter``
* ``architecture_spine_gate._check_auth_security``
* ``architecture_spine_gate._check_harness_security``
* (plus historical callsites prior to Plan 024)

The callees are cited by name; line locators are not used, because they
go stale on the first unrelated edit above them.

This module collapses those into a single strict primitive on top of
``strict_jsonl_reader.read_strict_jsonl`` with the runs-specific
``tool_id`` filter + a ``latest_run_for_tool`` convenience. The strict
default surfaces a corrupt runs.jsonl row as a ``GovernanceError``
rather than silently dropping it — the runs ledger is the spine
freshness gate's primary input, so dropping rows silently turns a
"cache stale" into a "cache empty" with no operator-visible signal.

§A.3 AST invariant pins these migrations: callsites that still inline
the silent-skip pattern on runs.jsonl fail at build time.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterator

from .runtime_artifacts import resolve_artifact_payload
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import GovernanceError


def read_runs_rows(
    path: Path,
    *,
    tool_id: str | None = None,
    on_corruption: str = "strict",
    base_dir: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Iterate runs.jsonl rows; optionally filter by ``tool_id``.

    Strict by default. The tool_id filter is applied AFTER strict
    JSON parse so a corrupt row still raises (filter cannot mask
    corruption).
    """
    for row in read_strict_jsonl(
        path, on_corruption=on_corruption, base_dir=base_dir,
    ):
        normalized = upcast_run_row(row)
        if tool_id is not None and normalized.get("tool_id") != tool_id:
            continue
        yield normalized


def upcast_run_row(row: dict[str, Any]) -> dict[str, Any]:
    """Return a v2-compatible run row without mutating the source row."""
    if not isinstance(row, dict):
        return {}
    normalized = dict(row)
    schema = int(normalized.get("schema_version") or 1)
    normalized["normalized_schema_version"] = 2
    normalized.setdefault("run_ledger_format", "v1" if schema < 2 else "v2")
    normalized.setdefault("artifact_status", "legacy_inline_or_sample_only")
    normalized.setdefault("artifact_ref", None)
    normalized.setdefault("artifact_refs", [normalized["artifact_ref"]] if isinstance(normalized.get("artifact_ref"), dict) else [])
    normalized.setdefault("artifact_hash", None)
    runner = normalized.get("runner")
    if not isinstance(runner, dict):
        runner = {}
        normalized["runner"] = runner
    runner.setdefault("raw_findings_count", len(runner.get("raw_findings_sample") or []) if isinstance(runner.get("raw_findings_sample"), list) else 0)
    runner.setdefault("raw_observations_count", 0)
    return normalized


def raw_findings_count(row: dict[str, Any]) -> int:
    runner = upcast_run_row(row).get("runner")
    return int((runner if isinstance(runner, dict) else {}).get("raw_findings_count") or 0)


def raw_observations_count(row: dict[str, Any]) -> int:
    runner = upcast_run_row(row).get("runner")
    return int((runner if isinstance(runner, dict) else {}).get("raw_observations_count") or 0)


def latest_run_for_tool(
    path: Path,
    *,
    tool_id: str,
    on_corruption: str = "strict",
    base_dir: Path | None = None,
) -> dict[str, Any] | None:
    """Return the LAST row matching ``tool_id`` (or None if absent)."""
    latest: dict[str, Any] | None = None
    for row in read_runs_rows(
        path,
        tool_id=tool_id,
        on_corruption=on_corruption,
        base_dir=base_dir,
    ):
        latest = row
    return latest


# ARIA-HIGH-523 — a run row is an INDEX (ARIA-HIGH-017): the read set a run
# declared is stored once, in the run's own artifact (``payload.read_paths``),
# and the row names it by content address. Inlined, it was 66% of runs.jsonl
# (25.5 of 39.1 MB on 2026-10-16; a test-gap row was 576 KB, 536 KB of it its
# read set), and seven days of such rows outgrew the 64 MiB per-surface publish
# cap, so every aria-auto-cycle publish was refused whole. The writer
# (``tool_health.record_run``) builds the reference with ``read_paths_reference``
# and every reader takes the set from ``run_read_paths``: one shape, one owner.
READ_PATHS_REF_FIELD = "read_paths_ref"
READ_PATHS_POINTER = "/payload/read_paths"


def read_set_digest(paths: list[Any]) -> str:
    """The content address of a read set: sha256 of its canonical JSON."""
    encoded = json.dumps(paths, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def read_paths_reference(paths: list[Any]) -> dict[str, Any]:
    """The row's stand-in for ``paths``, which its run artifact holds at the pointer."""
    return {"count": len(paths), "sha256": read_set_digest(paths), "json_pointer": READ_PATHS_POINTER}


def run_read_paths(row: dict[str, Any], *, base_dir: str | Path | None) -> list[Any]:
    """The read set a run row declares, wherever its writer stored it.

    A row written before ARIA-HIGH-523, a v1 row (no artifact), a row whose
    artifact write failed and the writer's in-memory envelope carry the list
    inline, and it is returned as stored: a compacted pre-fix row still reads
    its five-path sample, as every reader read it before. A row with a
    ``read_paths_ref`` is resolved from its artifact and checked against the
    count and digest the row recorded. A set that cannot be read back is
    refused by name, never read as empty: the row says the set exists.
    """
    inline = row.get("read_paths")
    if isinstance(inline, list):
        return inline
    run_id = row.get("run_id")
    ref = row.get(READ_PATHS_REF_FIELD)
    if not isinstance(ref, dict):
        raise GovernanceError(f"run_read_set_missing:{run_id}: the row carries neither read_paths nor {READ_PATHS_REF_FIELD}")
    if ref.get("json_pointer") != READ_PATHS_POINTER:
        raise GovernanceError(f"run_read_set_pointer_unknown:{run_id}:{ref.get('json_pointer')}")
    artifact = resolve_artifact_payload(row.get("artifact_ref"), base_dir=base_dir)
    payload = artifact.get("payload") if isinstance(artifact, dict) else None
    paths = payload.get("read_paths") if isinstance(payload, dict) else None
    if not isinstance(paths, list):
        raise GovernanceError(f"run_read_set_unavailable:{run_id}: its artifact does not hold the read set")
    if len(paths) != ref.get("count") or read_set_digest(paths) != ref.get("sha256"):
        raise GovernanceError(f"run_read_set_mismatch:{run_id}: the artifact's read set is not the one the row names")
    return paths


__all__ = [
    "read_runs_rows", "latest_run_for_tool", "upcast_run_row", "raw_findings_count", "raw_observations_count",
    "READ_PATHS_REF_FIELD", "READ_PATHS_POINTER", "read_set_digest", "read_paths_reference", "run_read_paths",
]
