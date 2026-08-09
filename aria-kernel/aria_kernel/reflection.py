from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .governance_reader import read_governance_rows
from .ledger import append_jsonl, load_jsonl_verified
from .snapshot import file_counts_from_payload
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def run_reflection(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    convergence_result: dict[str, Any] | None = None,
    review_result: dict[str, Any] | None = None,
    pedagogy_lint_result: dict[str, Any] | None = None,
    skill_genesis_result: dict[str, Any] | None = None,
    calibration_result: dict[str, Any] | None = None,
    proactive_result: dict[str, Any] | None = None,
    cycle_runner_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Plan ARIA-V5 §3f v2 — reflection schema v1 → v2 additive bump.
    # Three optional kwargs let the autonomy orchestrator inject its
    # post-drain Gate A (convergence) and Gate B (review) verdicts
    # plus the V5.3 pedagogy-lint snapshot into the reflection row.
    # When ANY of the three is None, the corresponding sub-object is
    # emitted as null in the JSON — direct CLI callers
    # (``aria-kernel cycle run``) preserve the legacy v1 contract
    # while the orchestrator path produces a v2-shaped row.
    # Backward compatibility: all existing reflection consumers use
    # ``.get(key, default)`` access (verified by Plan v2 §3f
    # Validator 1); v1 readers tolerate the new fields transparently.
    # Plan ARIA-V3.2 §2b hotfix (F-010 subfinding D2) — reflection
    # MUST operate on an absolute ``base_dir`` so
    # ``_gate_activity_summary`` reads from the canonical
    # aria-tools/governance.jsonl, NOT a shadow tree created by
    # tool_registry.tools_dir()'s CWD-relative fallback.
    #
    # The V3.2 first-attempt RAISED on relative paths, but the
    # CLI's normal path (`cycle.py:397` → ``base_dir=root`` where
    # ``root`` traces back to ``Path('aria-tools')``) passes a
    # relative literal — the strict raise broke every cycle in
    # the operator-replay path. The hotfix converts the strict
    # raise to a non-destructive ``.resolve()`` so relative
    # becomes absolute deterministically against the current cwd
    # WITHOUT rejecting the call.
    #
    # The DEEPER CWD-shadow-tree class (when cwd is wrong) is the
    # blast-radius case tracked under Plan ARIA-V3.3 §2 (F-010-D4).
    # The Tier-1 ``tools_dir`` rewrite there does walk-up-to-find-
    # bound-identity which closes the shadow-tree class entirely.
    # Invariants I-V3.2-04..06 lock this hotfix's contract.
    if base_dir is not None:
        base_dir = Path(base_dir).resolve()
    root = ensure_tools_dir(base_dir)
    # Plan 026R §A.2 — hot-path consumers move from `load_jsonl` (silent
    # accept of tampered / hashless rows) to `load_jsonl_verified` which
    # raises `LedgerIntegrityError` on chain mismatch, missing
    # `ledger_hash`, or canonical drift. All four ledgers below are
    # written via `append_jsonl` so every row is hash-chained at write
    # time; a strict read here is the read-side gate that catches mid-
    # flight tamper or partial-write visible to a reader.
    all_runs = load_jsonl_verified(runs_path(base_dir))
    runs = [row for row in all_runs if row.get("cycle_id") == cycle_id]
    tool_runtime = _tool_runtime_table(runs, all_runs, cycle_id)
    pressure_payload = _load_pressure(root, cycle_id)
    pressures = pressure_payload.get("summary", {})
    auto_merge_decisions = [
        row
        for row in load_jsonl_verified(root / "auto-merge-decisions.jsonl")
        if row.get("cycle_id") == cycle_id
    ]
    beliefs = _latest_by_id(
        load_jsonl_verified(root / "memory" / "beliefs.jsonl"), "belief_id"
    )
    top_pressures = pressure_payload.get("pressures", [])[:3] if isinstance(pressure_payload.get("pressures"), list) else []
    committed = _committed_findings_and_debts(root, repo_root_override=repo_root)
    human_required = _human_required_summary(root)
    gate_activity = _gate_activity_summary(root)
    reflection = {
        # Plan ARIA-V7 §3 Phase 7.7 — schema_version v2 → v3
        # (additive bump). New optional sub-objects (skill_genesis,
        # calibration, cycle_runner) carry the V7.4 + V7.6 + V7.1
        # producer outputs. v2 readers tolerate the new fields
        # via `.get(key, default)` access (validated by V5.4
        # consumer audit; same pattern applies to v3).
        "schema_version": 3,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "coverage": _coverage(root, cycle_id),
        "tool_run_count": len(runs),
        "ok_run_count": sum(1 for run in runs if run.get("status") == "ok"),
        "failed_run_count": sum(1 for run in runs if run.get("status") != "ok"),
        "operator_facing_findings": sum(len(run.get("emitted_findings", [])) for run in runs),
        "operator_facing_observations": sum(len(run.get("emitted_observations", [])) for run in runs),
        "suppressed_shadow_findings": sum(run.get("runner", {}).get("raw_findings_count", 0) for run in runs)
        - sum(len(run.get("emitted_findings", [])) for run in runs),
        "invalid_evidence_count": _invalid_evidence_count(runs),
        "snapshot_outside_path_count": _snapshot_outside_path_count(runs),
        "tool_runtime": tool_runtime,
        "belief_summary": _belief_summary(beliefs),
        "pressure_summary": pressures,
        "top_pressures": top_pressures,
        "tool_health": _tool_health(runs),
        "auto_merge_summary": _auto_merge_summary(auto_merge_decisions),
        "committed_findings": committed["findings"],
        "committed_debts": committed["debts"],
        "human_required": human_required,
        "gate_activity": gate_activity,
        # Plan ARIA-V5 §3f v2 — convergence + review + pedagogy sub-
        # objects. Direct CLI path (no orchestrator kwargs) emits
        # null; orchestrator path populates with real verdicts so
        # the daily report covers the full cycle including Gate A
        # and Gate B outcomes.
        "convergence": _build_convergence_telemetry(
            convergence_result, review_result,
        ),
        "pedagogy": _build_pedagogy_telemetry(pedagogy_lint_result),
        # Plan ARIA-V7 §3 Phase 7.7 — V7 producer telemetry. Direct
        # CLI path (no orchestrator kwargs) emits null sentinels;
        # orchestrator path populates with real producer outputs.
        "skill_genesis": skill_genesis_result if skill_genesis_result else None,
        "calibration": calibration_result if calibration_result else None,
        "proactive": proactive_result if proactive_result else None,
        "cycle_runner": cycle_runner_result if cycle_runner_result else None,
        "next_cycle_plan": [
            {
                "pressure_id": item.get("pressure_id"),
                "recommended_action": item.get("recommended_action"),
                "candidate_tools": item.get("candidate_tools", []),
                # Carried so the queue writer below can refuse a blocked
                # pressure; without this key the projection silently
                # laundered the blocked state back into schedulable work.
                "blocked_by": item.get("blocked_by", []),
            }
            for item in top_pressures
        ],
    }
    append_jsonl(root / "reflections.jsonl", reflection)
    _write_daily_report(root, reflection)
    # Plan 026R §F.2 — also enqueue next_cycle_plan items into the
    # bounded scheduler queue so the §F.1 autonomy orchestrator can
    # drain them at the start of the following cycle. Pre-§F.2 the
    # items existed only in the reflection JSONL row + text report —
    # no machine-readable queue for the orchestrator to consume.
    # The queue caps depth via ARIA_NEXT_CYCLE_QUEUE_DEPTH (default 32);
    # items beyond the cap return None and are silently dropped at the
    # writer side (queue-bloat protection — orchestrator drain is the
    # only sink). Pressure_id is the queue's idempotency key surface.
    from .next_cycle_queue import append_pending as _enqueue_next_cycle
    for item in reflection.get("next_cycle_plan", []):
        pressure_id = item.get("pressure_id")
        if not isinstance(pressure_id, str) or not pressure_id:
            continue
        # A blocked pressure is operator-facing work, not schedulable work.
        # Enqueuing one mints an agent request that can never run — the
        # planner's first accepted response traced a queue item that had been
        # re-enqueued this way every cycle since 2026-08-08.
        if item.get("blocked_by"):
            continue
        _enqueue_next_cycle(
            base_dir=root,
            source_cycle_id=cycle_id,
            pressure_id=pressure_id,
            recommended_action=item.get("recommended_action"),
            candidate_tools=list(item.get("candidate_tools") or []),
        )
    return reflection


def _load_pressure(root: Path, cycle_id: str) -> dict[str, Any]:
    path = root / "pressure" / f"{cycle_id}.json"
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _resolve_repo_root(tools_root: Path) -> Path | None:
    """Read the bound repo_root from the tools-dir identity file.

    Reflection is invoked with `base_dir` = tools-root only, but committed
    findings/debts live under the repo root (`aria-findings/`, `aria-debts/`).
    Use the bound identity to locate them; return None if the binding is
    unset (no committed surfaces to report).
    """
    identity_path = tools_root / "repo_identity.json"
    if not identity_path.exists():
        return None
    try:
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    bound = identity.get("bound_repo_root")
    if not bound:
        return None
    candidate = Path(bound)
    return candidate if candidate.exists() else None


def _gate_activity_summary(tools_root: Path, *, window_hours: int = 24) -> dict[str, Any]:
    """Plan 017 Phase 6.2 — aggregate governance event counts by kind.

    Walks aria-tools/governance.jsonl, partitions events by `kind`, and
    returns top-N counts plus a 24h-window subset (events recorded within
    the last `window_hours`). The daily report renders this so the
    operator can see at a glance which gates fired in the cycle window.
    """
    governance = tools_root / "governance.jsonl"
    if not governance.exists():
        return {"total_events": 0, "by_kind": {}, "recent_24h": {}}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    by_kind: dict[str, int] = {}
    recent: dict[str, int] = {}
    # Plan 026R §A.3 — strict governance.jsonl reader for gate-activity
    # summary. Pre-§A.3 silent-skip on corrupt rows would understate
    # gate activity (operator dashboard misled). Strict raises via the
    # governance_reader contract.
    total = 0
    for row in read_governance_rows(governance, base_dir=tools_root):
        kind = str(row.get("kind") or "?")
        by_kind[kind] = by_kind.get(kind, 0) + 1
        total += 1
        ts_str = row.get("ts")
        if isinstance(ts_str, str):
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except ValueError:
                ts = None
            if ts is not None and ts >= cutoff:
                recent[kind] = recent.get(kind, 0) + 1
    return {
        "total_events": total,
        "by_kind": dict(sorted(by_kind.items(), key=lambda kv: kv[1], reverse=True)),
        "recent_24h": dict(sorted(recent.items(), key=lambda kv: kv[1], reverse=True)),
        "window_hours": window_hours,
    }


def _human_required_summary(tools_root: Path) -> dict[str, Any]:
    """Plan 016 Faz D9 — surface the HUMAN_REQUIRED ledger at the top of daily reports.

    Returns: {open: <int>, breaching_sla: <int>, items: [<sorted by deadline>...]}.
    """
    from .human_required import list_human_required

    items = list_human_required(base_dir=tools_root, include_resolved=False)
    if not items:
        return {"open": 0, "breaching_sla": 0, "items": []}
    now = datetime.now(timezone.utc)
    breaching = 0
    for item in items:
        deadline = item.get("sla_deadline")
        if not isinstance(deadline, str):
            continue
        try:
            dt = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt < now:
            breaching += 1
    return {"open": len(items), "breaching_sla": breaching, "items": items[:5]}


def _normalize_finding_status(row: dict[str, Any]) -> str | None:
    """Plan ARIA-V3.1 §2b — schema normalization for finding rows.

    Pre-V3.1 the corpus carries TWO schema variants:
      * F-001..F-007 use ``status: "OPEN" | "WITHDRAWN" | "RESOLVED"``
      * F-008..F-009 use ``state: "OPEN" | "RESOLVED"``
    Both encode the same state-machine vocabulary; the aggregator
    must read whichever field is populated. The normalised value is
    written back to ``row["status"]`` so downstream consumers see one
    field regardless of source schema.
    """
    status = row.get("status")
    if status is None:
        status = row.get("state")
    if status is not None:
        row["status"] = status
    return status


def _scan_findings_filesystem(findings_dir: Path) -> dict[str, Any]:
    """Plan ARIA-V3.1 §2b — single-SSoT filesystem scan.

    The previous ``_index.json`` snapshot pattern accumulated drift
    (F-008 + F-009 invisible to the daily report; DEBT-001 stuck at
    OPEN seven days after retirement). V3.1 pivots: each ``F-*.json``
    file IS the authoritative state; the aggregator re-derives the
    summary on every reflection cycle. ``_index.json`` remains for
    external-tool consumption but is NEVER on the critical path.
    """
    empty = {"total": 0, "open": 0, "recent": []}
    if not findings_dir.exists() or not findings_dir.is_dir():
        return dict(empty)
    rows: list[dict[str, Any]] = []
    for path in sorted(findings_dir.glob("F-*.json")):
        # Plan ARIA-V3.1 §2b — _index.json is gitignored from the
        # scan (its filename does not match F-*.json), so a
        # mistakenly-named index file cannot pollute the corpus.
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(row, dict):
            continue
        _normalize_finding_status(row)
        rows.append(row)
    return {
        "total": len(rows),
        "open": sum(1 for r in rows if r.get("status") == "OPEN"),
        "recent": sorted(
            rows, key=lambda r: r.get("created_at", ""), reverse=True
        )[:5],
    }


def _scan_debts_filesystem(debts_dir: Path) -> dict[str, Any]:
    """Plan ARIA-V3.1 §2b — single-SSoT filesystem scan for debts.

    Same pivot rationale as findings. Debts use a single
    ``current_status`` field across the corpus, so no schema
    normalization is required.
    """
    empty = {"total": 0, "open": 0, "overdue": 0, "recent": []}
    if not debts_dir.exists() or not debts_dir.is_dir():
        return dict(empty)
    rows: list[dict[str, Any]] = []
    for path in sorted(debts_dir.glob("DEBT-*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(row, dict):
            continue
        rows.append(row)
    now = datetime.now(timezone.utc)
    open_rows = [
        r for r in rows
        if r.get("current_status") in {"OPEN", "IN_PROGRESS"}
    ]
    overdue = 0
    for row in open_rows:
        due_iso = row.get("due_date")
        if not due_iso:
            continue
        try:
            due = datetime.fromisoformat(str(due_iso).replace("Z", "+00:00"))
        except ValueError:
            continue
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        if due < now:
            overdue += 1
    return {
        "total": len(rows),
        "open": len(open_rows),
        "overdue": overdue,
        "recent": sorted(
            rows, key=lambda r: r.get("due_date", ""), reverse=False
        )[:5],
    }


def _committed_findings_and_debts(
    tools_root: Path,
    *,
    repo_root_override: str | Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Plan ARIA-V3.1 §2b — filesystem-scan SSoT for findings + debts.

    Pre-V3.1 this function read ``aria-findings/_index.json`` +
    ``aria-debts/_index.json`` as authoritative snapshots. Both
    indexes accumulated drift relative to disk (the V3 plan added
    F-008 + F-009 + retired DEBT-2026-05-08-001, but the index
    files were last regenerated 2026-05-08 and 2026-05-11 — the
    fresh-run daily report under-reported by 2 findings + showed
    a retired debt as still open).

    V3.1 pivots: each ``F-*.json`` and ``DEBT-*.json`` file IS the
    authoritative state. The aggregator re-derives the summary
    from a filesystem scan on every reflection cycle. The cost is
    O(file count) per cycle (≤30 files in practice); the gain is
    a single SSoT with no index-sync debt.

    ``repo_root_override`` lets a worktree-aware caller (e.g.
    cycle.py running on snowball when tools-dir was first bound by
    main) point at the active worktree directly. Without it, fall
    back to the recorded binding.
    """
    empty_findings = {"total": 0, "open": 0, "recent": []}
    empty_debts = {"total": 0, "open": 0, "overdue": 0, "recent": []}
    if repo_root_override is not None:
        candidate = Path(repo_root_override)
        repo_root = candidate if candidate.exists() else None
    else:
        repo_root = _resolve_repo_root(tools_root)
    if repo_root is None:
        return {"findings": empty_findings, "debts": empty_debts}

    findings_summary = _scan_findings_filesystem(
        repo_root / "aria-findings"
    )
    debts_summary = _scan_debts_filesystem(repo_root / "aria-debts")
    return {"findings": findings_summary, "debts": debts_summary}


def _build_convergence_telemetry(
    convergence_result: dict[str, Any] | None,
    review_result: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Plan ARIA-V5 §3f v2 — assemble the reflection ``convergence``
    sub-object from orchestrator-supplied Gate A + Gate B results.

    Returns ``None`` when BOTH inputs are None — preserves direct
    CLI path's legitimately-skipped semantics. When either is
    supplied, returns a v2-shaped sub-object with ``pre_impl``
    (Gate A) + ``post_impl`` (Gate B) blocks.

    Field schema (operator-facing, all int/str types):
      pre_impl.rounds_count, arbiter_verdict, gaps_found_count,
              plan_id, token_cost_estimate,
              resumed_from_persistence, convergence_id
      post_impl.rounds_count, review_verdict, gaps_found_count,
                impl_artifacts_ref, auto_merge_blocked_by
    """
    if convergence_result is None and review_result is None:
        return None
    pre_impl: dict[str, Any] | None = None
    if convergence_result is not None:
        pre_impl = {
            "rounds_count": int(convergence_result.get("rounds_count", 0)),
            "arbiter_verdict": str(
                convergence_result.get("arbiter_verdict", "split"),
            ),
            "gaps_found_count": len(
                convergence_result.get("unsatisfied_items", []),
            ),
            "plan_id": convergence_result.get("plan_id"),
            "token_cost_estimate": int(
                convergence_result.get("token_cost_estimate", 0),
            ),
            "resumed_from_persistence": bool(
                convergence_result.get("resumed_from_persistence", False),
            ),
            "convergence_id": convergence_result.get("convergence_id"),
        }
    post_impl: dict[str, Any] | None = None
    if review_result is not None:
        verdict = str(review_result.get("review_verdict", "gaps_open"))
        post_impl = {
            "rounds_count": int(review_result.get("rounds_count", 0)),
            "review_verdict": verdict,
            "gaps_found_count": len(review_result.get("gaps_found", [])),
            "impl_artifacts_ref": review_result.get("impl_artifacts_ref"),
            "auto_merge_blocked_by": (
                None if verdict == "no_gaps" else f"review_{verdict}"
            ),
        }
    return {"pre_impl": pre_impl, "post_impl": post_impl}


def _build_pedagogy_telemetry(
    pedagogy_lint_result: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Plan ARIA-V5 §3f v2 — assemble the reflection ``pedagogy``
    sub-object from V5.3 pedagogy-lint output.

    Returns ``None`` until V5.3 (commit C4) wires the lint
    runner. Once C4 lands, ``pedagogy_lint_result`` carries
    ``lint_pass_rate`` (float), ``violation_count`` (int), and
    ``agents_scanned`` (int) — the three operational metrics
    surfaced via ``/aria-status`` per Plan v2 §7.
    """
    if pedagogy_lint_result is None:
        return None
    return {
        "lint_pass_rate": float(
            pedagogy_lint_result.get("lint_pass_rate", 0.0),
        ),
        "violation_count": int(
            pedagogy_lint_result.get("violation_count", 0),
        ),
        "agents_scanned": int(
            pedagogy_lint_result.get("agents_scanned", 0),
        ),
    }


def _render_convergence_section(reflection: dict[str, Any]) -> list[str]:
    """Plan ARIA-V5 §3f v2 — render the daily report's Convergence
    section. Gated on ``schema_version >= 2`` AND a non-null
    ``convergence`` sub-object. Returns an empty list otherwise so
    the report layout is unchanged for v1-shaped rows.
    """
    if int(reflection.get("schema_version", 1)) < 2:
        return []
    convergence = reflection.get("convergence")
    if not convergence:
        return []
    pre = convergence.get("pre_impl")
    post = convergence.get("post_impl")
    lines = ["## Convergence", ""]
    if pre is not None:
        lines.extend([
            f"- Pre-impl rounds: {pre.get('rounds_count', 0)}",
            f"- Arbiter verdict: {pre.get('arbiter_verdict', '?')}",
            f"- Pre-impl gaps: {pre.get('gaps_found_count', 0)}",
            f"- Plan: {pre.get('plan_id', '?')}",
            f"- Resumed from persistence: {pre.get('resumed_from_persistence', False)}",
            "",
        ])
    if post is not None:
        lines.extend([
            f"- Post-impl rounds: {post.get('rounds_count', 0)}",
            f"- Review verdict: {post.get('review_verdict', '?')}",
            f"- Post-impl gaps: {post.get('gaps_found_count', 0)}",
            f"- Auto-merge blocked by: {post.get('auto_merge_blocked_by') or '(unblocked)'}",
            "",
        ])
    return lines


def _render_pedagogy_section(reflection: dict[str, Any]) -> list[str]:
    """Plan ARIA-V5 §3f v2 — render the daily report's Pedagogy
    section. Gated on ``schema_version >= 2`` AND a non-null
    ``pedagogy`` sub-object (V5.3 lint emits this).
    """
    if int(reflection.get("schema_version", 1)) < 2:
        return []
    pedagogy = reflection.get("pedagogy")
    if not pedagogy:
        return []
    return [
        "## Pedagogy",
        "",
        f"- Lint pass rate: {pedagogy.get('lint_pass_rate', 0.0):.2%}",
        f"- Violations: {pedagogy.get('violation_count', 0)}",
        f"- Agents scanned: {pedagogy.get('agents_scanned', 0)}",
        "",
    ]


def _render_calibration_section(reflection: dict[str, Any]) -> list[str]:
    """Plan 024 §A — render the daily report's Judge Calibration section.
    Gated on a non-null ``calibration`` sub-object (the per-cycle
    judge_calibration phase emits it)."""
    calibration = reflection.get("calibration")
    if not calibration:
        return []
    judges = calibration.get("judges") or []
    degraded = calibration.get("degraded_judges") or []
    lines = [
        "## Judge Calibration",
        "",
        f"- Judges scored: {calibration.get('judged_judges', 0)}",
        f"- Degraded (precision < {calibration.get('precision_floor', 0.0)}): "
        f"{', '.join(degraded) if degraded else 'none'}",
    ]
    for j in judges:
        lines.append(
            f"  - {j.get('judge_id')}: precision={j.get('precision')} "
            f"recall={j.get('recall')} n={j.get('samples')} [{j.get('status')}]"
        )
    lines.append("")
    return lines


def _render_proactive_section(reflection: dict[str, Any]) -> list[str]:
    """Plan 027 §D3 — render the daily report's Proactive Priorities section:
    the impact x opportunity ranking of where to invest next, shown even when
    no reactive pressure fired."""
    proactive = reflection.get("proactive")
    if not proactive:
        return []
    top = proactive.get("top") or []
    if not top:
        return []
    lines = [
        "## Proactive Priorities (impact x opportunity)",
        "",
        f"- Calibration degraded: {proactive.get('calibration_degraded', False)}",
    ]
    for t in top:
        reasons = ", ".join(t.get("reasons") or []) or "—"
        lines.append(
            f"  - {t.get('tool_id')}: priority={t.get('priority')} "
            f"(impact={t.get('impact')} x opportunity={t.get('opportunity')}) [{reasons}]"
        )
    lines.append("")
    return lines


def _write_daily_report(root: Path, reflection: dict[str, Any]) -> None:
    day = str(reflection["recorded_at"])[:10]
    path = root / "reports" / "daily" / f"{day}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    file_counts = file_counts_from_payload(reflection.get("coverage", {}))
    hr = reflection.get("human_required") or {"open": 0, "breaching_sla": 0, "items": []}
    hr_open = hr.get("open", 0)
    hr_breach = hr.get("breaching_sla", 0)
    ga = reflection.get("gate_activity") or {"total_events": 0, "by_kind": {}, "recent_24h": {}, "window_hours": 24}
    ga_recent = ga.get("recent_24h") or {}
    top_recent = list(ga_recent.items())[:8]
    lines = [
        f"# ARIA Daily Report {day}",
        "",
        "## Gate Activity",
        "",
        f"- Total governance events: {ga.get('total_events', 0)}",
        f"- Events in last {ga.get('window_hours', 24)}h: {sum(ga_recent.values())}",
        *(
            [f"  - {kind}: {count}" for kind, count in top_recent]
            or ["  - (no governance events in window)"]
        ),
        "",
        "## HUMAN_REQUIRED",
        "",
        f"- Open: {hr_open}",
        f"- Breaching SLA: {hr_breach}",
        *(
            [
                f"- {item.get('request_id')} [{item.get('severity')}] sla {item.get('sla_deadline')} — {item.get('reason', '')[:80]}"
                for item in hr.get("items") or []
            ]
            or ["- (no operator-triage queue items)"]
        ),
        "",
        "## Coverage",
        "",
        f"- Git tracked: {file_counts.get('git_tracked', 0)}",
        f"- Working-tree: {file_counts.get('working_tree', 0)}",
        f"- Allowed: {file_counts.get('allowed', 0)}",
        f"- Generated: {file_counts.get('generated', 0)}",
        f"- Fated: {file_counts.get('fated', 0)}",
        f"- Discovery complete: {reflection['coverage'].get('complete', False)}",
        f"- Snapshot mode: {reflection['coverage'].get('snapshot_mode', 'unknown')}",
        f"- Dirty snapshot: {reflection['coverage'].get('dirty_snapshot', False)}",
        f"- Dirty path count: {reflection['coverage'].get('dirty_path_count', 0)}",
        "",
        "## Beliefs",
        "",
        f"- Total: {reflection['belief_summary'].get('total', 0)}",
        f"- Supported: {reflection['belief_summary'].get('supported', 0)}",
        "",
        "## Stale / Revalidation",
        "",
        f"- Needs revalidation: {reflection['belief_summary'].get('needs_revalidation', 0)}",
        f"- Stale: {reflection['belief_summary'].get('stale', 0)}",
        "",
        "## Top Pressures",
        "",
        *[
            f"- {item.get('pressure_id')}: {item.get('score')} - {item.get('reason')}"
            for item in reflection.get("top_pressures", [])
        ],
        "",
        "## Tool Health",
        "",
        f"- Cycle: `{reflection['cycle_id']}`",
        f"- Tool runs: {reflection['tool_run_count']}",
        f"- OK runs: {reflection['ok_run_count']}",
        f"- Failed runs: {reflection['failed_run_count']}",
        f"- Operator-facing findings: {reflection['operator_facing_findings']}",
        f"- Operator-facing observations: {reflection['operator_facing_observations']}",
        f"- Suppressed SHADOW findings: {reflection['suppressed_shadow_findings']}",
        f"- Invalid evidence count: {reflection['invalid_evidence_count']}",
        f"- Snapshot outside path count: {reflection['snapshot_outside_path_count']}",
        f"- Pressure: {reflection['pressure_summary']}",
        "",
        "### Raw Adapter Runtime",
        "",
        "| Tool | Raw findings | Raw observations | Emitted findings | Emitted observations | Suppressed SHADOW findings | Invalid evidence | Delta vs previous cycle |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        *[
            "| {tool_id} | {raw_findings} | {raw_observations} | {emitted_findings} | {emitted_observations} | {suppressed_shadow_findings} | {invalid_evidence_count} | {raw_finding_delta_vs_prev_cycle} |".format(**row)
            for row in reflection.get("tool_runtime", [])
        ],
        "",
        "## Auto-Merge",
        "",
        f"- Eligible: {reflection['auto_merge_summary'].get('eligible', 0)}",
        f"- Blocked: {reflection['auto_merge_summary'].get('blocked', 0)}",
        f"- Merged: {reflection['auto_merge_summary'].get('merged', 0)}",
        f"- Failed: {reflection['auto_merge_summary'].get('failed', 0)}",
        "",
        # Plan ARIA-V5 §3f v2 — Convergence + Pedagogy sections render
        # only when reflection schema_version >= 2 AND the orchestrator
        # supplied verdicts. Direct CLI path emits null sub-objects so
        # the sections appear empty / are skipped entirely.
        *_render_convergence_section(reflection),
        *_render_pedagogy_section(reflection),
        *_render_calibration_section(reflection),
        *_render_proactive_section(reflection),
        "## Committed Findings",
        "",
        f"- Total: {reflection.get('committed_findings', {}).get('total', 0)}",
        f"- Open: {reflection.get('committed_findings', {}).get('open', 0)}",
        *(
            [f"- Recent: {row.get('finding_id')} [{row.get('severity')}] ({row.get('claim_type')}) — {row.get('claim_summary', '')[:80]}"
             for row in reflection.get('committed_findings', {}).get('recent', [])]
            or ["- (no committed findings yet)"]
        ),
        "",
        "## Open Debts",
        "",
        f"- Total: {reflection.get('committed_debts', {}).get('total', 0)}",
        f"- Open: {reflection.get('committed_debts', {}).get('open', 0)}",
        f"- Overdue: {reflection.get('committed_debts', {}).get('overdue', 0)}",
        *(
            [f"- {row.get('debt_id')} [{row.get('severity')}] due {row.get('due_date', '')} — owner {row.get('permanent_fix_owner')} (originating {row.get('originating_finding_id')})"
             for row in reflection.get('committed_debts', {}).get('recent', [])]
            or ["- (no committed debts yet)"]
        ),
        "",
        "## Next Cycle Plan",
        "",
        *[
            f"- {item.get('pressure_id')}: {item.get('recommended_action')}"
            for item in reflection.get("next_cycle_plan", [])
        ],
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def _coverage(root: Path, cycle_id: str) -> dict[str, Any]:
    path = root / "discovery" / cycle_id / "COMPLETION_PROOF.json"
    if not path.exists():
        return {}
    import json

    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _belief_summary(beliefs: list[dict[str, Any]]) -> dict[str, int]:
    statuses = ["supported", "contradicted", "needs_revalidation", "stale", "withdrawn"]
    summary = {"total": len(beliefs)}
    for status in statuses:
        summary[status] = sum(1 for belief in beliefs if belief.get("status") == status)
    return summary


def _tool_health(runs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "tools": sorted({str(run.get("tool_id")) for run in runs if run.get("tool_id")}),
        "quarantine_signals": sum(1 for run in runs if run.get("status") in ("evidence_error", "scope_violation")),
    }


def _tool_runtime_table(
    runs: list[dict[str, Any]],
    all_runs: list[dict[str, Any]],
    cycle_id: str,
) -> list[dict[str, Any]]:
    rows = []
    for run in sorted(runs, key=lambda item: str(item.get("tool_id"))):
        tool_id = str(run.get("tool_id") or "")
        raw_findings = int(run.get("runner", {}).get("raw_findings_count") or 0)
        raw_observations = int(run.get("runner", {}).get("raw_observations_count") or 0)
        emitted_findings = len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0
        emitted_observations = len(run.get("emitted_observations", [])) if isinstance(run.get("emitted_observations"), list) else 0
        previous = _previous_tool_run(all_runs, tool_id, cycle_id)
        previous_raw = int(previous.get("runner", {}).get("raw_findings_count") or 0) if previous else 0
        rows.append(
            {
                "tool_id": tool_id,
                "raw_findings": raw_findings,
                "raw_observations": raw_observations,
                "emitted_findings": emitted_findings,
                "emitted_observations": emitted_observations,
                "suppressed_shadow_findings": max(0, raw_findings - emitted_findings),
                "invalid_evidence_count": _invalid_evidence_count([run]),
                "snapshot_outside_path_count": _snapshot_outside_path_count([run]),
                "raw_finding_delta_vs_prev_cycle": raw_findings - previous_raw,
                "previous_cycle_id": previous.get("cycle_id") if previous else None,
            },
        )
    return rows


def _invalid_evidence_count(runs: list[dict[str, Any]]) -> int:
    return sum(1 for run in runs for error in _validation_errors(run) if str(error.get("code", "")).endswith("_outside_snapshot") or str(error.get("code")) in {"read_path_outside_snapshot", "evidence_outside_snapshot"})


def _snapshot_outside_path_count(runs: list[dict[str, Any]]) -> int:
    paths = set()
    for run in runs:
        for error in _validation_errors(run):
            if str(error.get("code", "")).endswith("_outside_snapshot") or str(error.get("code")) in {"read_path_outside_snapshot", "evidence_outside_snapshot"}:
                path = error.get("path")
                if isinstance(path, str) and path:
                    paths.add(path)
    return len(paths)


def _validation_errors(run: dict[str, Any]) -> list[dict[str, Any]]:
    errors = run.get("evidence_validation", {}).get("errors", [])
    return [error for error in errors if isinstance(error, dict)] if isinstance(errors, list) else []


def _previous_tool_run(all_runs: list[dict[str, Any]], tool_id: str, cycle_id: str) -> dict[str, Any] | None:
    previous = [
        run
        for run in all_runs
        if run.get("tool_id") == tool_id and run.get("cycle_id") != cycle_id and str(run.get("cycle_id")) < cycle_id
    ]
    return previous[-1] if previous else None


def _auto_merge_summary(decisions: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "eligible": sum(1 for row in decisions if row.get("decision") == "eligible"),
        "blocked": sum(1 for row in decisions if row.get("decision") == "blocked"),
        "merged": sum(1 for row in decisions if row.get("decision") == "merged"),
        "failed": sum(1 for row in decisions if row.get("decision") == "failed"),
    }


def _latest_by_id(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        value = row.get(key)
        if isinstance(value, str) and value:
            latest[value] = row
    return list(latest.values())
