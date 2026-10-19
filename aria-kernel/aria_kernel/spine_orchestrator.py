"""Plan 020 Phase 4 — fresh spine orchestrator.

WHY this module exists
----------------------
Pre-Plan-020, the spine gate's adapter-backed invariant readers (the
deleted ``_check_auth_security`` and ``_check_harness_security``) read the
LATEST adapter run from runs.jsonl with
no freshness guarantee. The "latest" row could be 12 hours old, taken
against a different commit, run on a different worktree — and the spine
gate would happily report "auth invariant unchanged from baseline" even
though the adapter was never re-executed against the current commit.

Operator gap #1 (Plan v3.3 §Phase 4 PROBLEM): the failure mode is
"yesterday's auth-clean run validates today's broken commit". An audit
reviewer reading the spine baseline cannot tell from the persisted row
whether the underlying adapter executed five minutes ago against the
current `repo_state_id` or five hours ago against a stale snapshot.

Phase 4 fixes that with a fresh-orchestrator chokepoint:
- refresh_spine_adapters(...) snapshots the WORKING TREE, then for each
  spine adapter checks whether its latest run row (a) carries the recorded
  status ``ok``, (b) matches the current repo_state_id AND (c) is younger
  than freshness_max_age_seconds. If any condition fails, the adapter is
  re-executed via tool_runner.run_tool. If all pass, the cached run is
  reused. A QUARANTINED adapter is not run, an unregistered one cannot be;
  both are named in ``adapter_states``.
- architecture_spine_gate.take_baseline / take_postcheck call this
  orchestrator BEFORE running invariant checks (require_fresh_adapter_runs
  default True) and measure the stored rows it RETURNS, never a newer row
  another caller recorded in runs.jsonl since (ARIA-HIGH-525).
- emit `spine_orchestrator_refresh_complete` governance event with
  {repo_state_id, run_ids: {adapter_id: run_id}, fresh_count, cached_count,
  adapter_states}; the return adds the recorded rows (``adapter_runs``) and
  the manifest versions (``adapter_versions``) the refresh ran on.

ARIA-MEDIUM-516 — what the refresh runs, keys and trusts
--------------------------------------------------------
- The adapter set is the gate's one declaration,
  ``architecture_spine_gate.SPINE_ADAPTER_IDS`` (derived from
  ``SPINE_INVARIANTS``). This module used to keep its own list, which named
  ``schema-drift-adapter`` (no manifest exists) and ``test-gap-adapter`` (no
  invariant reads it, 900 s of budget per refresh).
- The cache key is a WORKING-TREE snapshot: the adapters read the working
  tree, while the committed snapshot it used to take hashes ``git show
  HEAD:<path>``, so an uncommitted edit inside the window was served a run
  that never read it.
- A run is classified by the status ``record_run`` stored (run_tool returns
  the stored row): only ``ok`` is fresh; any other ``tool_health.RUN_STATUSES``
  value is ``failed``; anything else is a GovernanceError.
- The adapters get their manifest ``default_input`` (roots) because run_tool
  merges it; tenant-scoping and security-boundary used to exit 1 on every
  refresh without it.

Frozen-aware
------------
spine_orchestrator is in PLAN_020_WRITE_SURFACES; the orchestrator emits a
governance event so the gate fires at the start. Frozen profiles cannot
refresh adapters (run_tool itself is gated), so under frozen the
orchestrator either returns the cached run set unchanged (when
require_fresh=False) or raises GovernanceError (when require_fresh=True).
The architecture_spine_gate.take_baseline kwarg path (Phase 4.B) honours
that — frozen baseline reads cached rows; standard/strict baselines
re-run.

Concurrency
-----------
5 adapter invocations run sequentially by default (max_workers=1).
Operators set max_workers > 1 for parallel runs; we keep the default
serial because each adapter individually invokes a TS subprocess that
spawns its own worker pool — stacking N parallel adapters can pin the
runner host and produce flaky timing-sensitive runs in CI.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .architecture_spine_gate import SPINE_ADAPTER_IDS
from .runtime_profile import enforce_profile_for_write
from .snapshot import build_repo_snapshot
from .tool_health import RUN_STATUSES
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    list_tools,
)
from .tool_runner import run_tool

# The one success status of tool_health.RUN_STATUSES.
_FRESH_STATUS = "ok"

DEFAULT_FRESHNESS_MAX_AGE_SECONDS: int = 600


def _parse_iso(timestamp: str | None) -> datetime | None:
    if not timestamp:
        return None
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _latest_run_for_adapter(
    runs_path: Path,
    adapter_id: str,
) -> dict[str, Any] | None:
    # Plan 026R §A.3 — strict runs.jsonl reader (closes ORPHAN-061
    # silent-skip). A corrupt row in the runs ledger surfaces as a
    # GovernanceError instead of degrading to "no adapter run found"
    # which would silently mask spine staleness.
    from .runs_reader import latest_run_for_tool
    return latest_run_for_tool(runs_path, tool_id=adapter_id)


def _is_fresh(
    *,
    run_row: dict[str, Any],
    target_repo_state_id: str | None,
    freshness_max_age_seconds: int,
    now: datetime,
) -> bool:
    """Plan 026R §E.1 — status-aware freshness check.

    Pre-§E.1 the predicate considered only repo_state_id + age, so a
    cached FAILED adapter run (``status: crash``,
    ``status: budget_exceeded``, ``status: schema_error``) would
    satisfy "fresh" and the spine orchestrator would re-use the
    failure as the new baseline. The cached row must carry the stored
    status ``ok``, the only success value of ``tool_health.RUN_STATUSES``
    (ARIA-MEDIUM-516: ``pass`` and ``completed`` were accepted here and
    no run can carry either); any other status forces a re-run.
    """
    if run_row["status"] != _FRESH_STATUS:
        return False
    snapshot = run_row.get("repo_snapshot") or {}
    rsid = snapshot.get("repo_state_id")
    if target_repo_state_id is not None and rsid != target_repo_state_id:
        return False
    recorded_at = _parse_iso(run_row.get("recorded_at"))
    if recorded_at is None:
        return False
    age = (now - recorded_at.astimezone(timezone.utc)).total_seconds()
    return age <= freshness_max_age_seconds


def refresh_spine_adapters(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path,
    freshness_max_age_seconds: int = DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
    cycle_id: str | None = None,
    max_workers: int = 1,
    adapter_ids: tuple[str, ...] = SPINE_ADAPTER_IDS,
) -> dict[str, Any]:
    """Re-run any spine adapter whose latest run is not a fresh ``ok`` run of
    the current working tree, re-use the cached run otherwise. Always emits
    the spine_orchestrator_refresh_complete governance event.

    Returns the event's summary plus the rows it ran on:
      {
        repo_state_id,
        run_ids: {adapter_id: run_id},   # every adapter with a recorded run
        fresh_count,                     # adapters re-executed, stored ok
        cached_count,                    # adapters reusing their latest row
        adapter_states: [{adapter_id, status, run_id, repo_state_id,
                          recorded_at, source}, ...],
          # source: cached | fresh | failed | quarantined | unregistered
        freshness_max_age_seconds, cycle_id,
        adapter_runs: {adapter_id: stored runs.jsonl row},  # not in the event
        adapter_versions: {adapter_id: manifest version},   # not in the event
      }

    Raises GovernanceError when the active runtime profile blocks the
    spine_orchestrator surface (frozen) or tool_runs (frozen|observe), and
    when a stored status is outside tool_health.RUN_STATUSES.
    """
    if freshness_max_age_seconds <= 0:
        raise GovernanceError("freshness_max_age_seconds must be positive")
    if max_workers <= 0:
        raise GovernanceError("max_workers must be positive")
    if not adapter_ids:
        raise GovernanceError("adapter_ids must not be empty")

    enforce_profile_for_write("spine_orchestrator", base_dir=base_dir)

    workspace = Path(workspace_root).resolve()
    # The key the cache is checked against is the working tree, the bytes
    # the adapters read (ARIA-MEDIUM-516); the same snapshot travels into
    # every run below, so a run's recorded repo_state_id is this key.
    repo_snapshot = build_repo_snapshot(
        workspace_root=workspace, mode="working-tree", enforce_clean=False,
    )
    target_repo_state_id = repo_snapshot["repo_state_id"]
    cycle = cycle_id or "spine-orchestrator-refresh"

    root = ensure_tools_dir(base_dir)
    runs_path = root / "runs.jsonl"
    now = datetime.now(timezone.utc)
    registered = {str(tool["tool_id"]): tool for tool in list_tools(base_dir=root)}

    # Keyed by adapter, emitted in adapter_ids order: the order is fixed so
    # audit reviewers can pattern-match the sequence in the complete event.
    states: dict[str, dict[str, Any]] = {}
    adapter_runs: dict[str, dict[str, Any]] = {}
    adapter_versions: dict[str, str] = {}
    fresh_count = 0
    cached_count = 0
    to_run: list[str] = []

    def _not_run(adapter_id: str, source: str, error: str | None = None) -> None:
        states[adapter_id] = {
            "adapter_id": adapter_id, "status": None, "run_id": None,
            "repo_state_id": target_repo_state_id, "recorded_at": None, "source": source,
        }
        if error is not None:
            states[adapter_id]["error"] = error

    def _with_row(adapter_id: str, row: dict[str, Any], source: str) -> None:
        adapter_runs[adapter_id] = row
        state = {
            "adapter_id": adapter_id,
            "status": row["status"],
            "run_id": str(row["run_id"]),
            "repo_state_id": row["repo_snapshot"]["repo_state_id"],
            "recorded_at": row["recorded_at"],
            "source": source,
        }
        if source == "failed":
            state["error"] = f"run_status:{row['status']}"
        states[adapter_id] = state

    for adapter_id in adapter_ids:
        tool = registered.get(adapter_id)
        if tool is None:
            # run_tool could only refuse it ("tool not found"): name it.
            _not_run(adapter_id, "unregistered")
            continue
        adapter_versions[adapter_id] = str(tool["version"])
        if tool["status"] == "QUARANTINED":
            # The normal runner refuses a quarantined tool; the gate reads
            # this state as an excluded, named invariant.
            _not_run(adapter_id, "quarantined")
            continue
        latest = _latest_run_for_adapter(runs_path, adapter_id)
        if latest is not None and _is_fresh(
            run_row=latest,
            target_repo_state_id=target_repo_state_id,
            freshness_max_age_seconds=freshness_max_age_seconds,
            now=now,
        ):
            cached_count += 1
            _with_row(adapter_id, latest, "cached")
            continue
        to_run.append(adapter_id)

    def _run_one(adapter_id: str) -> tuple[str, dict[str, Any] | None, str | None]:
        try:
            result = run_tool(
                tool_id=adapter_id,
                input_payload={
                    "cycle_id": cycle,
                    "repo_snapshot": repo_snapshot,
                },
                cycle_id=cycle,
                workspace_root=workspace,
                base_dir=base_dir,
            )
        except Exception as exc:  # noqa: BLE001 — caller wants per-adapter failure isolation
            # Nothing was recorded for this adapter: no row, the reason only.
            return adapter_id, None, str(exc)
        # Plan 024 v3 §B-7 — "envelope" is the row record_run stored.
        return adapter_id, result["envelope"], None

    outcomes: dict[str, tuple[dict[str, Any] | None, str | None]] = {}
    if max_workers == 1:
        for adapter_id in to_run:
            aid, row, error = _run_one(adapter_id)
            outcomes[aid] = (row, error)
    elif to_run:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(_run_one, adapter_id) for adapter_id in to_run]
            for fut in as_completed(futures):
                aid, row, error = fut.result()
                outcomes[aid] = (row, error)

    # Plan 024 v3 §H-6 — classified by the STORED status: ``ok`` is fresh,
    # every other tool_health.RUN_STATUSES value is a failed run, and a value
    # outside the vocabulary is fail-loud rather than silently fresh.
    for adapter_id in to_run:
        row, error = outcomes[adapter_id]
        if row is None:
            _not_run(adapter_id, "failed", error)
            continue
        status = row["status"]
        if status == _FRESH_STATUS:
            fresh_count += 1
            _with_row(adapter_id, row, "fresh")
        elif status in RUN_STATUSES:
            _with_row(adapter_id, row, "failed")
        else:
            raise GovernanceError(
                f"spine_orchestrator_unknown_run_status: {status!r} "
                f"(adapter_id={adapter_id!r})"
            )

    ordered_runs = {adapter_id: adapter_runs[adapter_id] for adapter_id in adapter_ids if adapter_id in adapter_runs}
    summary = {
        "repo_state_id": target_repo_state_id,
        "run_ids": {adapter_id: str(row["run_id"]) for adapter_id, row in ordered_runs.items()},
        "fresh_count": fresh_count,
        "cached_count": cached_count,
        "adapter_states": [states[adapter_id] for adapter_id in adapter_ids],
        "freshness_max_age_seconds": freshness_max_age_seconds,
        "cycle_id": cycle,
    }
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "spine_orchestrator_refresh_complete",
        summary,
    )
    # The rows are the gate's input; the ledger keeps the summary only.
    return {
        **summary,
        "adapter_runs": ordered_runs,
        "adapter_versions": adapter_versions,
    }


def latest_orchestrator_refresh(
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Read the most recent spine_orchestrator_refresh_complete event."""
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return None
    # Plan 026R §A.3 — strict governance.jsonl reader. Pre-§A.3 the
    # silent-skip on corrupt rows would mis-report "no orchestrator
    # refresh ever ran" when a single ledger row was unparseable;
    # ``read_governance_rows`` raises GovernanceError on corrupt rows
    # via the §H-7 diagnostic sink.
    from .governance_reader import read_governance_rows
    gov = root / "governance.jsonl"
    last: dict[str, Any] | None = None
    for row in read_governance_rows(gov, base_dir=root):
        if row.get("kind") == "spine_orchestrator_refresh_complete":
            last = row
    return last


__all__ = [
    "DEFAULT_FRESHNESS_MAX_AGE_SECONDS",
    "refresh_spine_adapters",
    "latest_orchestrator_refresh",
]
