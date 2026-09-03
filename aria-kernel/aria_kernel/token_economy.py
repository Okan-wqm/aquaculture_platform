"""Plan 032 Faz 032i — token economy: tokens per ACCEPTED result, effort governor, cap calibration.

WHY: usage is recorded per spawn (usage_ledger) and acceptance per result,
but nothing joins them — the only metric that matters for economy is
"how many tokens did an accepted result cost", per agent and role. WHAT:
`usage_per_accepted_result` joins the two ledgers; `recommend_efforts`
turns a sustained overrun into a ONE-RUNG effort downgrade recommendation
(never below `medium`, never for a role the operator excluded), recorded
on `economy/recommendations.jsonl`; `effective_effort` is what the
executor asks before a spawn. Cap calibration is an observation row: the
`context_budget_gate` caps change only through a commit.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl, read_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

EFFORT_LADDER: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
EFFORT_FLOOR = "medium"
RECOMMENDATIONS_SURFACE = "economy_recommendations"
RECOMMENDATIONS_RELPATH: tuple[str, ...] = ("economy", "recommendations.jsonl")
RECOMMENDATION_KINDS: tuple[str, ...] = ("effort", "cap_calibration")
RECOMMENDATION_ACTIONS: tuple[str, ...] = ("downgrade", "hold")
DEFAULT_WINDOW_DAYS = 14
DEFAULT_MIN_SPAWNS = 5
DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD = 400_000
DEFAULT_RECOMMENDATION_TTL_DAYS = 7
EXCLUDED_ROLES: tuple[str, ...] = ("human_required_packet",)
EFFORT_DOWNGRADED_EVENT = "effort_downgraded_by_economy"
_TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


@dataclass(frozen=True)
class UsageStat:
    target_agent: str
    role: str
    spawns: int
    accepted: int
    tokens_total: int
    tokens_per_accepted: float | None

    def to_dict(self) -> dict[str, Any]:
        return {"target_agent": self.target_agent, "role": self.role, "spawns": self.spawns, "accepted": self.accepted,
                "tokens_total": self.tokens_total, "tokens_per_accepted": self.tokens_per_accepted}


def _parse(stamp: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def usage_per_accepted_result(*, base_dir: str | Path | None = None, window_days: int = DEFAULT_WINDOW_DAYS, now: datetime | None = None) -> list[UsageStat]:
    root = ensure_tools_dir(base_dir)
    stamp = now or datetime.now(timezone.utc)
    cutoff = stamp - timedelta(days=window_days)
    usage_path = root / "knowledge-graph" / "context-usage.jsonl"
    results_path = root / "agent-invocations" / "results.jsonl"
    accepted_requests: set[str] = set()
    if results_path.exists():
        for row in load_declared_jsonl(results_path, expected_surface="agent_invocation_results"):
            if row.get("status") == "accepted":
                accepted_requests.add(str(row.get("request_id")))
    spawns: dict[tuple[str, str], int] = defaultdict(int)
    tokens: dict[tuple[str, str], int] = defaultdict(int)
    accepted: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in (read_jsonl(usage_path) if usage_path.exists() else []):
        when = _parse(row.get("recorded_at"))
        if when is not None and when < cutoff:
            continue
        key = (str(row.get("target_agent") or ""), str(row.get("role") or ""))
        spawns[key] += 1
        tokens[key] += sum(int(row.get(f) or 0) for f in _TOKEN_FIELDS if isinstance(row.get(f), (int, float)))
        rid = str(row.get("request_id") or "")
        if rid in accepted_requests:
            accepted[key].add(rid)
    stats = []
    for key in sorted(spawns):
        n_acc = len(accepted[key])
        stats.append(UsageStat(target_agent=key[0], role=key[1], spawns=spawns[key], accepted=n_acc, tokens_total=tokens[key],
                               tokens_per_accepted=(tokens[key] / n_acc) if n_acc else None))
    return stats


def recommendations_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*RECOMMENDATIONS_RELPATH)


def read_recommendations(base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = recommendations_path(base_dir)
    return load_declared_jsonl(path, expected_surface=RECOMMENDATIONS_SURFACE) if path.exists() else []


def lower_effort(effort: str) -> str:
    if effort not in EFFORT_LADDER:
        return effort
    index = EFFORT_LADDER.index(effort)
    floor = EFFORT_LADDER.index(EFFORT_FLOOR)
    return EFFORT_LADDER[max(floor, index - 1)]


def recommend_efforts(stats: list[UsageStat], *, threshold_tokens: float = DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD,
                      min_spawns: int = DEFAULT_MIN_SPAWNS) -> list[dict[str, Any]]:
    """One recommendation per (agent, role) with enough evidence."""
    out: list[dict[str, Any]] = []
    for stat in stats:
        if stat.spawns < min_spawns or stat.role in EXCLUDED_ROLES:
            continue
        if stat.accepted == 0:
            action, reason = "downgrade", f"{stat.spawns} spawns, no accepted result in window"
        elif stat.tokens_per_accepted is not None and stat.tokens_per_accepted > threshold_tokens:
            action, reason = "downgrade", f"{int(stat.tokens_per_accepted)} tokens per accepted result > {int(threshold_tokens)}"
        else:
            action, reason = "hold", "within threshold"
        out.append({"kind": "effort", "target_agent": stat.target_agent, "role": stat.role, "action": action, "reason": reason,
                    "evidence": stat.to_dict(), "threshold_tokens": threshold_tokens})
    return out


def calibrate_role_caps(stats: list[UsageStat], *, context_window_tokens: int = 200_000) -> list[dict[str, Any]]:
    """Observation only: what share of the window each role actually needed."""
    from .context_budget_gate import DEFAULT_ROLE_CAP, ROLE_CAP_MAP

    out: list[dict[str, Any]] = []
    for stat in stats:
        if stat.spawns == 0:
            continue
        observed = (stat.tokens_total / stat.spawns) / context_window_tokens
        configured = ROLE_CAP_MAP.get(stat.role, DEFAULT_ROLE_CAP)
        out.append({"kind": "cap_calibration", "role": stat.role, "target_agent": stat.target_agent, "configured_cap": configured,
                    "observed_share": round(observed, 3), "delta": round(observed - configured, 3), "spawns": stat.spawns})
    return out


def record_recommendations(rows: list[dict[str, Any]], *, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*RECOMMENDATIONS_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    stored = []
    for row in rows:
        if row.get("kind") not in RECOMMENDATION_KINDS:
            raise ValueError(f"unknown recommendation kind {row.get('kind')!r}")
        if row.get("kind") == "effort" and row.get("action") not in RECOMMENDATION_ACTIONS:
            raise ValueError(f"unknown recommendation action {row.get('action')!r}")
        stored.append(append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=RECOMMENDATIONS_SURFACE))
    if any(r.get("action") == "downgrade" for r in rows):
        append_tools_governance(root, "economy_downgrade_recommended", {
            "targets": [f"{r['target_agent']}/{r['role']}" for r in rows if r.get("action") == "downgrade"]})
    return stored


def effective_effort(profile_effort: str, *, target_agent: str, role: str, base_dir: str | Path | None,
                     ttl_days: int = DEFAULT_RECOMMENDATION_TTL_DAYS, now: datetime | None = None, request_id: str | None = None) -> str:
    """The effort a spawn runs at: the profile's, or one rung lower while a fresh downgrade stands."""
    if base_dir is None:
        return profile_effort
    stamp = now or datetime.now(timezone.utc)
    latest: dict[str, Any] | None = None
    for row in read_recommendations(base_dir):
        if row.get("kind") == "effort" and row.get("target_agent") == target_agent and row.get("role") == role:
            latest = row
    if latest is None or latest.get("action") != "downgrade":
        return profile_effort
    when = _parse(latest.get("recorded_at"))
    if when is None or stamp - when > timedelta(days=ttl_days):
        return profile_effort
    lowered = lower_effort(profile_effort)
    if lowered != profile_effort:
        append_tools_governance(ensure_tools_dir(base_dir), EFFORT_DOWNGRADED_EVENT, {
            "request_id": request_id, "target_agent": target_agent, "role": role, "from_effort": profile_effort, "to_effort": lowered,
            "reason": latest.get("reason"), "recommended_at": latest.get("recorded_at")})
    return lowered


__all__ = ["DEFAULT_MIN_SPAWNS", "DEFAULT_RECOMMENDATION_TTL_DAYS", "DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD", "DEFAULT_WINDOW_DAYS",
           "EFFORT_DOWNGRADED_EVENT", "EFFORT_FLOOR", "EFFORT_LADDER", "EXCLUDED_ROLES", "RECOMMENDATIONS_RELPATH",
           "RECOMMENDATIONS_SURFACE", "RECOMMENDATION_ACTIONS", "RECOMMENDATION_KINDS", "UsageStat", "calibrate_role_caps",
           "effective_effort", "lower_effort", "read_recommendations", "recommend_efforts", "recommendations_path",
           "record_recommendations", "usage_per_accepted_result"]
