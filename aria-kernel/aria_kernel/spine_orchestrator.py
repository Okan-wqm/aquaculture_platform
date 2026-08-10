"""Plan 020 Phase 4 — fresh spine orchestrator.

WHY this module exists
----------------------
Pre-Plan-020, `architecture_spine_gate._check_auth_security` (and any other
adapter-backed invariant) read the LATEST adapter run from runs.jsonl with
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
- refresh_spine_adapters(...) snapshots the current repo state, then for
  each of the 5 spine adapters checks whether its latest run row matches
  (a) the current repo_state_id AND (b) is younger than freshness_max_age_
  seconds. If either condition fails, the adapter is re-executed via
  tool_runner.run_tool. If both pass, the cached run is reused.
- architecture_spine_gate.take_baseline / take_postcheck call this
  orchestrator BEFORE running invariant checks (require_fresh_adapter_runs
  default True). The invariant readers downstream (e.g. _check_auth_security)
  now read freshly-produced rows by construction.
- emit `spine_orchestrator_refresh_complete` governance event with
  {repo_state_id, run_ids: {adapter_id: run_id}, fresh_count, cached_count}.

5-adapter scope (Plan v3.3 §Phase 4.A)
--------------------------------------
- security-boundary-adapter   (auth_security invariant backing)
- tenant-scoping-adapter      (tenant_scoping invariant backing)
- schema-drift-adapter        (schema_entity invariant backing)
- event-contracts-adapter     (event_contracts invariant backing)
- test-gap-adapter            (Plan 020 Phase 4.0 binding — meta surface)

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

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .runtime_profile import enforce_profile_for_write
from .snapshot import build_repo_snapshot
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
)
from .tool_runner import run_tool

# 5-adapter spine scope. Order is fixed so audit reviewers can pattern-
# match the sequence of run_ids in the orchestrator complete event.
SPINE_ADAPTER_IDS: tuple[str, ...] = (
    "security-boundary-adapter",
    "tenant-scoping-adapter",
    "schema-drift-adapter",
    "event-contracts-adapter",
    "test-gap-adapter",
    # Plan 020 Phase 10 — agent harness security adapter feeds the
    # harness_security invariant added in architecture_spine_gate.
    # Refresh chokepoint must include it so the spine baseline reads a
    # fresh row when require_fresh_adapter_runs=True.
    "agent-harness-security-adapter",
)

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
    failure as the new baseline. §E.1 also requires the cached row
    to carry a successful status in
    ``{"pass", "ok", "completed"}``; any other status (or missing)
    forces a re-run.
    """
    if not run_row:
        return False
    status = str(run_row.get("status") or "").lower()
    if status not in {"pass", "ok", "completed"}:
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
    """Re-run any spine adapter whose latest run is stale (or repo_state_id
    drifted), re-use the cached run otherwise. Always emits the
    spine_orchestrator_refresh_complete governance event.

    Returns:
      {
        repo_state_id,
        run_ids: {adapter_id: run_id, ...},
        fresh_count,           # number of adapters re-executed
        cached_count,          # number reusing the existing latest row
        adapter_states: [{adapter_id, status, run_id, repo_state_id,
                          recorded_at, source: 'cached'|'fresh'|'failed'}, ...]
      }

    Raises GovernanceError when the active runtime profile blocks the
    spine_orchestrator surface (frozen) or tool_runs (frozen|observe).
    """
    if freshness_max_age_seconds <= 0:
        raise GovernanceError("freshness_max_age_seconds must be positive")
    if max_workers <= 0:
        raise GovernanceError("max_workers must be positive")
    if not adapter_ids:
        raise GovernanceError("adapter_ids must not be empty")

    enforce_profile_for_write("spine_orchestrator", base_dir=base_dir)

    workspace = Path(workspace_root).resolve()
    repo_snapshot = build_repo_snapshot(
        workspace_root=workspace, mode="committed", enforce_clean=False,
    )
    target_repo_state_id = repo_snapshot.get("repo_state_id")
    cycle = cycle_id or "spine-orchestrator-refresh"

    root = ensure_tools_dir(base_dir)
    runs_path = root / "runs.jsonl"
    now = datetime.now(timezone.utc)

    # Pre-compute decision rows: (adapter_id, latest_run_or_None,
    # is_fresh) so the parallel/serial dispatch only has to RUN
    # the stale ones.
    decisions: list[tuple[str, dict[str, Any] | None, bool]] = []
    for adapter_id in adapter_ids:
        latest = _latest_run_for_adapter(runs_path, adapter_id)
        fresh = (
            latest is not None
            and _is_fresh(
                run_row=latest,
                target_repo_state_id=target_repo_state_id,
                freshness_max_age_seconds=freshness_max_age_seconds,
                now=now,
            )
        )
        decisions.append((adapter_id, latest, fresh))

    adapter_states: list[dict[str, Any]] = []
    run_ids: dict[str, str] = {}
    fresh_count = 0
    cached_count = 0

    stale_adapters = [(aid, latest) for (aid, latest, fresh) in decisions if not fresh]

    def _run_one(adapter_id: str) -> tuple[str, dict[str, Any]]:
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
            return adapter_id, result
        except Exception as exc:  # noqa: BLE001 — caller wants per-adapter failure isolation
            # Plan 024 v3 §B-7 — exception fallback synthesizes both the
            # legacy top-level `status` field (preserves existing
            # callers) AND the envelope/health_decision split that
            # spine_orchestrator H-6 reads after this commit.
            return adapter_id, {
                "status": "failed",
                "error": str(exc),
                "envelope": {"status": "failed", "error": str(exc), "run_id": ""},
                "health_decision": None,
            }

    fresh_results: dict[str, dict[str, Any]] = {}
    if stale_adapters:
        if max_workers == 1:
            for adapter_id, _latest in stale_adapters:
                aid, result = _run_one(adapter_id)
                fresh_results[aid] = result
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = [
                    pool.submit(_run_one, adapter_id)
                    for adapter_id, _ in stale_adapters
                ]
                for fut in as_completed(futures):
                    aid, result = fut.result()
                    fresh_results[aid] = result

    # Plan 024 v3 §H-6 — fresh-spine status whitelist. Pre-fix the
    # filter `if status == 'failed'` blacklisted only the literal
    # "failed" string; everything else (including 'crash',
    # 'schema_error', 'tool_unhealthy', 'output_unparseable',
    # 'budget_exceeded') counted as fresh. The whitelist below names
    # the canonical envelope-side success vocabulary explicitly so an
    # unknown status raises GovernanceError rather than silently
    # polluting fresh-spine signal with broken results.
    _FRESH_PASS_STATUSES = frozenset({"pass", "ok"})
    _FRESH_EXCLUDE_STATUSES = frozenset({
        "fail", "failed", "crash", "schema_error", "tool_unhealthy",
        "output_unparseable", "budget_exceeded", "error",
        "environment_unavailable",
    })

    for adapter_id, latest, fresh in decisions:
        if fresh and latest is not None:
            cached_count += 1
            run_ids[adapter_id] = str(latest.get("run_id", ""))
            adapter_states.append({
                "adapter_id": adapter_id,
                "status": str(latest.get("status", "ok")),
                "run_id": str(latest.get("run_id", "")),
                "repo_state_id": (latest.get("repo_snapshot") or {}).get("repo_state_id"),
                "recorded_at": str(latest.get("recorded_at", "")),
                "source": "cached",
            })
            continue
        run = fresh_results.get(adapter_id) or {}
        # Plan 024 v3 §B-7 — read envelope status (canonical 'ok|crash|
        # ...' vocabulary) instead of the registry health_decision
        # status (ACTIVE|SHADOW|QUARANTINED). Pre-fix the spine
        # orchestrator looked at registry status which made every
        # registered tool count as fresh regardless of envelope outcome.
        envelope = run.get("envelope") or {}
        status = str(envelope.get("status") or run.get("status", "failed"))
        run_id = str(envelope.get("run_id") or run.get("run_id", ""))
        run_ids[adapter_id] = run_id
        if status in _FRESH_EXCLUDE_STATUSES:
            adapter_states.append({
                "adapter_id": adapter_id,
                "status": status,
                "run_id": run_id,
                "repo_state_id": target_repo_state_id,
                "recorded_at": "",
                "source": "failed",
                "error": str(envelope.get("error") or run.get("error", "")),
            })
        elif status in _FRESH_PASS_STATUSES:
            fresh_count += 1
            adapter_states.append({
                "adapter_id": adapter_id,
                "status": status,
                "run_id": run_id,
                "repo_state_id": (run.get("repo_snapshot") or envelope.get("repo_snapshot") or {}).get("repo_state_id") or target_repo_state_id,
                "recorded_at": str(run.get("recorded_at", "")),
                "source": "fresh",
            })
        else:
            # Plan 024 v3 §H-6 — unknown status is fail-loud; the
            # status enum is shared with cli.py:_TOOL_RUN_EXIT_CODES
            # so a future tool_runner status addition must register
            # in both vocabularies.
            raise GovernanceError(
                f"spine_orchestrator_unknown_run_status: {status!r} "
                f"(adapter_id={adapter_id!r})"
            )

    summary = {
        "repo_state_id": target_repo_state_id,
        "run_ids": run_ids,
        "fresh_count": fresh_count,
        "cached_count": cached_count,
        "adapter_states": adapter_states,
        "freshness_max_age_seconds": freshness_max_age_seconds,
        "cycle_id": cycle,
    }
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "spine_orchestrator_refresh_complete",
        summary,
    )
    return summary


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
    "SPINE_ADAPTER_IDS",
    "DEFAULT_FRESHNESS_MAX_AGE_SECONDS",
    "refresh_spine_adapters",
    "latest_orchestrator_refresh",
]
