"""Plan 026R §A.3 — runs.jsonl strict reader (closes ORPHAN-HIGH-061).

Pre-§A.3 four+ callsites of ``aria-tools/runs.jsonl`` each repeated
the silent-skip ``except json.JSONDecodeError: continue`` pattern:

* ``spine_orchestrator._latest_adapter_run`` (lines 105-120)
* ``architecture_spine_gate._check_auth_security`` (lines 280-310)
* ``architecture_spine_gate._check_harness_security`` (lines 332-360)
* (plus historical callsites prior to Plan 024)

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

from pathlib import Path
from typing import Any, Iterator

from .strict_jsonl_reader import read_strict_jsonl


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


__all__ = ["read_runs_rows", "latest_run_for_tool", "upcast_run_row", "raw_findings_count", "raw_observations_count"]
