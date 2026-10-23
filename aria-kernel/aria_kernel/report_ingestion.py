from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .feedback import add_feedback, build_feedback_event, slug
from .batch_containment import guard_item, with_item_failures
from .ledger import append_declared_jsonl, atomic_write_json, sha256_of_canonical_json
from .phase2_utils import utc_now_iso
from .tool_registry import GovernanceError, ensure_tools_dir
from .workspace import WorkspacePaths, record_workspace_governance


DEFAULT_BACKFILL_LIMIT = 100
LARGE_BACKFILL_THRESHOLD = 500

# The review registry (docs/reviews/_registry/README.md). Every kernel read of
# it goes through read_registry_view (ARIA-HIGH-279), and the view IS the
# registry CLI's projection (MF-1, PROC-HIGH-039): RESOLVED is derived from
# merged ``Closes:`` trailers by tools/gates/finding-registry-projection.ts,
# the one owner of that derivation, so the kernel sees a closure the moment
# the fix merges, as every gate does.
REGISTRY_FINDINGS_RELPATH: tuple[str, ...] = ("docs", "reviews", "_registry", "findings.jsonl")
_REGISTRY_FINDINGS_REF = "/".join(REGISTRY_FINDINGS_RELPATH)
# The registry CLI and the repository-local ts-node that runs it. The kernel
# runs it in exactly one place, run_registry_cli (the view below, and the
# autonomy closure verifier's chain and closure verdicts).
_TS_NODE_RELPATH: tuple[str, ...] = ("node_modules", ".bin", "ts-node")
_REGISTRY_CLI = "tools/gates/finding-registry.ts"
_GATES_TSCONFIG = "tools/gates/tsconfig.json"
_REGISTRY_CLI_TIMEOUT_SECONDS = 300
_PROJECT_JSONL: tuple[str, ...] = ("project", "--format=jsonl")
# findings.jsonl.schema.json `state` enum; pinned against the schema by
# tests/test_report_ingestion_registry_view.py.
REGISTRY_STATES: frozenset[str] = frozenset({"OPEN", "IN-PROGRESS", "RESOLVED", "STALE", "BLOCKED"})


@dataclass(frozen=True)
class RegistryEntry:
    """One finding's projected row and the repo-relative file that holds it."""

    row: dict[str, Any]
    source: str


@dataclass(frozen=True)
class RegistryView:
    """The registry as every kernel reader sees it: one row per finding."""

    entries: tuple[RegistryEntry, ...]

    @property
    def rows(self) -> list[dict[str, Any]]:
        return [entry.row for entry in self.entries]


def read_registry_view(repo_root: str | Path) -> RegistryView:
    """The registry's projection at the checkout, read through its own CLI.

    WHY: ``state: RESOLVED`` in findings.jsonl copied what a merged
    ``Closes:`` trailer records, and only a later reconcile commit refreshed
    the copy, so a reader of the stored state saw every closure late. The
    projection derives it at read time; a second derivation here would be a
    second owner of one fact, so the kernel asks the owner, as
    ``autonomy_closure`` does for the chain.

    WHAT: ``finding-registry.ts project --format=jsonl`` run by the
    repository's own ts-node in ``repo_root``: every row of the working
    tree's registry, RESOLVED where history merged into HEAD closes it.
    Needs the repository's node dependencies and its whole history (the
    kernel lanes provision both; tests/invariants/
    test_kernel_lanes_check_out_full_history.py). Without ts-node, or when the
    projection refuses (a corrupt row, an unreadable or shallow history), it
    raises :class:`RegistryCliRefused` by name: a silent read of the stored
    file, or of truncated history, would report closed findings open.
    An absent registry raises: this checkout is not the repository the kernel
    serves.
    """
    root = Path(repo_root)
    chain = root.joinpath(*REGISTRY_FINDINGS_RELPATH)
    if not chain.is_file():
        raise FileNotFoundError(f"finding_registry_missing:{chain.as_posix()}")
    entries: list[RegistryEntry] = []
    for ordinal, line in enumerate(run_registry_cli(root, _PROJECT_JSONL).splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise GovernanceError(f"finding_registry_projection_unreadable:{ordinal}") from exc
        if not isinstance(row, dict):
            raise GovernanceError(f"finding_registry_projection_unreadable:{ordinal}")
        entries.append(RegistryEntry(row, _REGISTRY_FINDINGS_REF))
    return RegistryView(entries=tuple(entries))


class RegistryCliRefused(GovernanceError):
    """The registry CLI did not run, or refused to answer.

    ``finding_registry_cli_unavailable:<why>`` when the repository's ts-node is
    absent or the process could not run or finish; ``finding_registry_cli_refused:
    <last stderr line>`` when it exited with a code the caller does not read as
    an answer; ``finding_registry_cli_unreadable:<why>`` when its answer is not
    UTF-8. Never a fallback answer: the caller that can fail closed (the
    autonomy closure verifier) maps it to its own verdict, every other caller
    lets it propagate.
    """


def run_registry_cli(
    root: Path,
    args: Sequence[str],
    *,
    stdin: bytes | None = None,
    answer_exit_codes: frozenset[int] = frozenset({0}),
) -> str:
    """``tools/gates/finding-registry.ts <args>`` run in ``root`` by the
    repository's own ts-node: its stdout, or :class:`RegistryCliRefused`.

    WHY: the registry's chain, its projection and every closure verdict have
    one owner, the TypeScript CLI; the kernel asks it rather than transcribing
    it, and asks it through this one runner so the argv, the timeout and what
    counts as a refusal cannot differ between the kernel's callers.

    ``stdin`` is piped to the CLI (``verify --stdin``, ``project --stdin``).
    ``answer_exit_codes`` are the exits whose stdout is the answer: ``{0}``
    for ``project --format=jsonl``; ``{0, 1}`` for the verdict commands, which
    print a verdict either way and exit 1 when it is negative.
    """
    ts_node = root.joinpath(*_TS_NODE_RELPATH)
    if not ts_node.is_file():
        raise RegistryCliRefused(f"finding_registry_cli_unavailable:ts_node_absent:{ts_node.as_posix()}")
    argv = [str(ts_node), "--transpile-only", "--project", _GATES_TSCONFIG, _REGISTRY_CLI, *args]
    try:
        completed = subprocess.run(
            argv, cwd=root, input=stdin, capture_output=True, check=False,
            timeout=_REGISTRY_CLI_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RegistryCliRefused(f"finding_registry_cli_unavailable:{type(exc).__name__}") from exc
    if completed.returncode not in answer_exit_codes:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip().splitlines()
        detail = stderr[-1] if stderr else f"exit {completed.returncode}"
        raise RegistryCliRefused(f"finding_registry_cli_refused:{detail}")
    try:
        return completed.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RegistryCliRefused("finding_registry_cli_unreadable:stdout_not_utf8") from exc


def positive_backfill_limit(value: object) -> int:
    """The one domain check for a backfill limit (ARIA-MEDIUM-230).

    A limit below 1 is out of domain: ``candidates[:-1]`` is every candidate
    but one, and ``-1`` passes the large-backfill guard below, so a negative
    limit ran an unbounded backfill without the confirmation that guard
    demands; zero ingested nothing and reported success. The CLI parses
    ``--limit`` through this same function, so the command line and the scan
    refuse the same values with the same name.
    """
    limit = int(str(value))
    if limit < 1:
        raise ValueError(f"backfill_limit_must_be_positive:{limit}")
    return limit


def report_ingestion_scan(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    backfill_limit: int = DEFAULT_BACKFILL_LIMIT,
    confirm_large_backfill: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    """Ingest the registry's OPEN findings the dedup cache has not seen.

    The registry is read through its projection (``read_registry_view``),
    which refuses a corrupt row by name (Plan 026R §A.5's strict default; the
    tolerant mode went with the second parser, MF-1): a finding a merged
    trailer closed is RESOLVED there and is not ingested as open work.
    """
    registry = paths.repo_root.joinpath(*REGISTRY_FINDINGS_RELPATH)
    cache_path = paths.state_dir / "ingested_findings.json"
    tools_base = Path(tools_root) if tools_root is not None else None
    if not registry.exists():
        record_workspace_governance(
            paths,
            "report_ingestion_skipped",
            {"cycle_id": cycle_id, "reason": "registry_missing", "registry_path": registry.relative_to(paths.repo_root).as_posix()},
        )
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "registry_missing", "ingested_count": 0}

    # ARIA-HIGH-192 — the guard bounds the WORK one call may do, not the size
    # of the registry it caches. The first call only baselines (ingests 0)
    # and every later call ingests at most ``backfill_limit``; guarding on
    # ``len(rows)`` refused the learning hook on every cycle once the
    # registry passed 500 rows, so no Lane-A/B finding ever reached ARIA.
    backfill_limit = positive_backfill_limit(backfill_limit)
    if backfill_limit > LARGE_BACKFILL_THRESHOLD and not (confirm_large_backfill and acknowledge):
        raise ValueError("large_backfill_requires_confirm_large_backfill_and_acknowledge")
    view = read_registry_view(paths.repo_root)
    rows = view.rows

    cache_missing = not cache_path.exists()
    previously_baselined = _has_report_baseline(paths)
    if cache_missing:
        if previously_baselined:
            record_workspace_governance(paths, "report_ingestion_cache_missing", {"cycle_id": cycle_id, "cache_path": cache_path.as_posix()})
        baseline = sorted({_finding_key(row) for row in rows if _finding_key(row)})
        _write_cache(cache_path, baseline)
        _record_cache_event(
            tools_base,
            {
                "cycle_id": cycle_id,
                "event": "baseline_created" if not previously_baselined else "baseline_rebuilt",
                "baseline_count": len(baseline),
                "cache_path": cache_path.as_posix(),
            },
        )
        record_workspace_governance(
            paths,
            "report_ingestion_skipped",
            {
                "cycle_id": cycle_id,
                "reason": "baseline_rebuilt" if previously_baselined else "baseline_created",
                "baseline_count": len(baseline),
            },
        )
        return {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "status": "baselined",
            "cache_missing": True,
            "baseline_count": len(baseline),
            "ingested_count": 0,
        }

    cache = _read_cache(cache_path)
    known = set(cache.get("finding_keys", []))
    candidates = [entry for entry in view.entries if _finding_key(entry.row) and _finding_key(entry.row) not in known]
    if len(candidates) > backfill_limit:
        candidates = candidates[:backfill_limit]

    ingested: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    skipped = 0
    for entry in candidates:
        row = entry.row
        if str(row.get("status") or row.get("state") or "").upper() != "OPEN":
            known.add(_finding_key(row))
            skipped += 1
            continue
        ok, finding_event = guard_item(
            item_failures,
            item_kind="finding",
            item_id=str(_finding_key(row)),
            work=lambda entry=entry: _ingest_one_finding(
                paths, entry.row, source_ref=entry.source, cycle_id=cycle_id, tools_base=tools_base,
            ),
        )
        if not ok or finding_event is None:
            # Deliberately NOT added to `known`. Containment must not consume
            # the item: the dedup cache is now written on every run, so marking
            # a finding seen after failing to ingest it would drop that finding
            # permanently. Left unknown, the next cycle offers it again.
            continue
        known.add(_finding_key(row))
        ingested.append(finding_event)
    _write_cache(cache_path, sorted(known))
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "ingested_count": len(ingested),
        "skipped_count": skipped,
        "cache_path": cache_path.as_posix(),
        "ingested": ingested,
    }, item_failures)


def _ingest_one_finding(
    paths: WorkspacePaths,
    row: dict[str, Any],
    *,
    source_ref: str,
    cycle_id: str,
    tools_base: Path | None,
) -> dict[str, Any]:
    """Turn one registry finding into feedback, an ingestion row, and governance."""
    event = _feedback_event_from_finding(paths, row, source_ref=source_ref, cycle_id=cycle_id)
    add_feedback(paths, event)
    finding_event = {"finding_key": _finding_key(row), "feedback_event_id": event["event_id"], "owner_agent": _owner_agent(row), "severity": _severity(row), "source_refs": _refs(row)}
    _record_ingestion_event(tools_base, {"cycle_id": cycle_id, **finding_event})
    record_workspace_governance(
        paths,
        "agent_report_ingested",
        {
            "cycle_id": cycle_id,
            "finding_key": _finding_key(row),
            "feedback_event_id": event["event_id"],
            "owner_agent": _owner_agent(row),
            "severity": _severity(row),
        },
    )
    return finding_event


def _feedback_event_from_finding(
    paths: WorkspacePaths, row: dict[str, Any], *, source_ref: str, cycle_id: str,
) -> dict[str, Any]:
    # `source_ref` is the file holding the row.
    refs = _refs(row)
    ref = refs[0] if refs else source_ref
    evidence_refs = sorted(dict.fromkeys([*refs, source_ref]))
    args = argparse.Namespace(
        kind="missed_signal",
        summary=str(row.get("summary") or row.get("title") or row.get("message") or "agent report finding"),
        ref=ref,
        concept=str(row.get("concept") or _owner_agent(row)),
        source="external_scanner",
        surface=row.get("surface"),
        failure_mode=str(row.get("failure_mode") or "evidence_gap"),
        parser_kind=row.get("parser_kind"),
        capability_gap_key=row.get("capability_gap_key"),
        cycle_id=cycle_id,
        evidence_ref=evidence_refs,
        evidence_chain=[
            json.dumps(
                {
                    "source_type": "external_scanner",
                    "reference": str(row.get("id") or row.get("finding_id") or _finding_key(row)),
                    "trust_level": "medium",
                },
                sort_keys=True,
            ),
        ],
    )
    return build_feedback_event(args, cycle_id=cycle_id, paths=paths)


def _read_cache(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise GovernanceError(f"report_ingestion_cache_unreadable:{path.as_posix()}:{exc}") from exc
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"report_ingestion_cache_corrupt:{path.as_posix()}:{exc}") from exc
    if not isinstance(payload, dict):
        raise GovernanceError(f"report_ingestion_cache_not_object:{path.as_posix()}")
    if not isinstance(payload.get("finding_keys"), list):
        raise GovernanceError(f"report_ingestion_cache_missing_finding_keys:{path.as_posix()}")
    return payload


def _write_cache(path: Path, keys: list[str]) -> None:
    atomic_write_json(path, {"schema_version": 1, "rebuilt_at": utc_now_iso(), "finding_keys": keys})


def _record_ingestion_event(tools_root: Path | None, payload: dict[str, Any]) -> None:
    if tools_root is None:
        return
    root = ensure_tools_dir(tools_root)
    append_declared_jsonl(
        root / "report-ingestion" / "findings.jsonl",
        {"schema_version": 1, "recorded_at": utc_now_iso(), **payload},
        expected_surface="report_ingestion_findings",
    )


def _record_cache_event(tools_root: Path | None, payload: dict[str, Any]) -> None:
    if tools_root is None:
        return
    root = ensure_tools_dir(tools_root)
    append_declared_jsonl(
        root / "report-ingestion" / "cache-events.jsonl",
        {"schema_version": 1, "recorded_at": utc_now_iso(), **payload},
        expected_surface="report_ingestion_cache_events",
    )


def _has_report_baseline(paths: WorkspacePaths) -> bool:
    from .ledger import read_jsonl

    return any(row.get("kind") == "report_ingestion_skipped" and row.get("details", {}).get("reason") in {"baseline_created", "baseline_rebuilt"} for row in read_jsonl(paths.ledgers["governance"]))


def _finding_key(row: dict[str, Any]) -> str:
    value = row.get("finding_id") or row.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    identity = {"summary": row.get("summary") or row.get("title") or row.get("message"), "refs": _refs(row), "owner_agent": _owner_agent(row)}
    return "finding:" + sha256_of_canonical_json(identity)[:16]


def _owner_agent(row: dict[str, Any]) -> str:
    return slug(str(row.get("owner_agent") or row.get("agent") or row.get("reported_by") or "unknown_agent"))


def _severity(row: dict[str, Any]) -> str:
    return str(row.get("severity") or "unknown").lower()


def _refs(row: dict[str, Any]) -> list[str]:
    raw = row.get("refs") or row.get("evidence_refs") or row.get("paths") or row.get("path") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if isinstance(item, str) and item.strip()]


def list_ingested_findings(paths: WorkspacePaths) -> dict[str, Any]:
    cache_path = paths.state_dir / "ingested_findings.json"
    if not cache_path.exists():
        return {"schema_version": 1, "status": "no_cache", "cache_path": cache_path.as_posix(), "ingested_count": 0, "finding_keys": []}
    payload = _read_cache(cache_path)
    keys = payload.get("finding_keys", []) if isinstance(payload, dict) else []
    return {
        "schema_version": 1,
        "status": "ok",
        "cache_path": cache_path.as_posix(),
        "rebuilt_at": payload.get("rebuilt_at") if isinstance(payload, dict) else None,
        "ingested_count": len(keys),
        "finding_keys": keys,
    }


def import_finding_file(
    paths: WorkspacePaths,
    file_path: str | Path,
    *,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    src = Path(file_path)
    if not src.exists():
        raise FileNotFoundError(f"finding_file_not_found: {src}")
    raw = src.read_text(encoding="utf-8").strip()
    if not raw:
        raise ValueError("finding_file_empty")
    rows: list[dict[str, Any]] = []
    if raw.startswith("["):
        payload = json.loads(raw)
        if isinstance(payload, list):
            rows = [row for row in payload if isinstance(row, dict)]
    elif raw.startswith("{"):
        payload = json.loads(raw)
        if isinstance(payload, dict):
            rows = [payload]
    else:
        for line_no, line in enumerate(raw.splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"finding_file_invalid_jsonl_line_{line_no}: {exc}") from exc
            if isinstance(row, dict):
                rows.append(row)
    if not rows:
        raise ValueError("finding_file_no_rows")
    cache_path = paths.state_dir / "ingested_findings.json"
    cache = _read_cache(cache_path) if cache_path.exists() else {"schema_version": 1, "finding_keys": []}
    known = set(cache.get("finding_keys", []))
    effective_cycle_id = cycle_id or "manual-import"
    ingested: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in rows:
        key = _finding_key(row)
        if not key:
            skipped.append({"reason": "missing_key", "row": row})
            continue
        if key in known:
            skipped.append({"reason": "already_ingested", "finding_key": key})
            continue
        if str(row.get("status") or row.get("state") or "").upper() not in {"OPEN", ""}:
            skipped.append({"reason": "non_open_state", "finding_key": key, "state": row.get("status") or row.get("state")})
            continue
        event = _feedback_event_from_finding(
            paths, row, source_ref=_REGISTRY_FINDINGS_REF, cycle_id=effective_cycle_id,
        )
        add_feedback(paths, event)
        known.add(key)
        ingested.append(
            {
                "finding_key": key,
                "feedback_event_id": event["event_id"],
                "owner_agent": _owner_agent(row),
                "severity": _severity(row),
            },
        )
        record_workspace_governance(
            paths,
            "agent_report_ingested",
            {
                "cycle_id": effective_cycle_id,
                "finding_key": key,
                "feedback_event_id": event["event_id"],
                "owner_agent": _owner_agent(row),
                "severity": _severity(row),
                "source": "manual_import",
                "file": src.as_posix(),
            },
        )
    _write_cache(cache_path, sorted(known))
    return {
        "schema_version": 1,
        "status": "ok",
        "cycle_id": effective_cycle_id,
        "file": src.as_posix(),
        "ingested_count": len(ingested),
        "skipped_count": len(skipped),
        "ingested": ingested,
        "skipped": skipped,
    }
