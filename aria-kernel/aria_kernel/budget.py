from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

# Notional per-model pricing, USD per 1M tokens (input_rate, output_rate).
# WHY this exists: managed-session Claude auth has no per-call dollar bill,
# and the executor used to record a literal estimated_usd=0.0 — which made
# the operator's USD budget caps ($3/cycle, $20/run) structurally toothless
# and the daily-report ROI metric read $0 forever (ORPHAN-HIGH-311, found on
# the FIRST real production cycle: 15.8k in + 27.3k out on claude-fable-5
# attributed as $0.00). Caps must bind on economic value regardless of the
# billing channel; subscription capacity is rate-limited, not free. Rates
# mirror the public Anthropic price list at the time of writing; the row
# keeps model + token counts so any rate revision is re-derivable.
MODEL_PRICING_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5": (10.0, 50.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def estimate_tokens_usd(*, model: str, input_tokens: int, output_tokens: int) -> float:
    """Notional USD for a token pair under MODEL_PRICING_USD_PER_MTOK.

    Model ids may carry date suffixes (``claude-haiku-4-5-20251001``) —
    prefix matching handles them. Unknown models return 0.0; the CALLER is
    responsible for making that visible (governance event), because a silent
    zero is exactly the defect class this function exists to close.
    """
    normalized = (model or "").strip().lower()
    for known, (in_rate, out_rate) in MODEL_PRICING_USD_PER_MTOK.items():
        if normalized == known or normalized.startswith(f"{known}-"):
            return round(
                (max(0, input_tokens) * in_rate + max(0, output_tokens) * out_rate) / 1_000_000,
                6,
            )
    return 0.0


DEFAULT_BUDGET = {
    "schema_version": 1,
    "daily_usd_cap": 5.0,
    "monthly_usd_cap": 100.0,
    "per_action_usd_cap": 1.0,
    "soft_stop_ratio": 0.8,
}


def check_budget(
    *,
    estimated_usd: float,
    action: str,
    base_dir: str | Path | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if estimated_usd < 0:
        raise GovernanceError("estimated_usd must be non-negative")
    active = _normalize_budget(config or {})
    usage = _usage(base_dir)
    daily_after = usage["daily_usd"] + estimated_usd
    monthly_after = usage["monthly_usd"] + estimated_usd
    reasons: list[str] = []
    if estimated_usd > active["per_action_usd_cap"]:
        reasons.append("per-action cap exceeded")
    if daily_after > active["daily_usd_cap"]:
        reasons.append("daily cap exceeded")
    if monthly_after > active["monthly_usd_cap"]:
        reasons.append("monthly cap exceeded")
    soft_stop = (
        daily_after >= active["daily_usd_cap"] * active["soft_stop_ratio"]
        or monthly_after >= active["monthly_usd_cap"] * active["soft_stop_ratio"]
    )
    return {
        "schema_version": 1,
        "action": action,
        "estimated_usd": estimated_usd,
        "allowed": not reasons,
        "soft_stop": soft_stop,
        "reasons": reasons,
        "usage": usage,
        "projected": {"daily_usd": daily_after, "monthly_usd": monthly_after},
        "budget": active,
    }


def record_budget_usage(
    *,
    action: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    estimated_usd: float,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    decision = check_budget(estimated_usd=estimated_usd, action=action, base_dir=base_dir)
    if not decision["allowed"]:
        raise GovernanceError("budget gate blocked usage: " + ", ".join(decision["reasons"]))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "action": action,
        "provider": provider,
        "model": model,
        "input_tokens": _non_negative_int(input_tokens, "input_tokens"),
        "output_tokens": _non_negative_int(output_tokens, "output_tokens"),
        "estimated_usd": estimated_usd,
        "soft_stop": decision["soft_stop"],
    }
    return append_declared_jsonl(
        _budget_ledger(base_dir),
        row,
        expected_surface="cost_budget",
    )


def list_budget_usage(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        _budget_ledger(base_dir),
        expected_surface="cost_budget",
    )


def _usage(base_dir: str | Path | None) -> dict[str, float]:
    now = datetime.now(timezone.utc)
    day = now.date().isoformat()
    month = day[:7]
    daily = 0.0
    monthly = 0.0
    for row in load_declared_jsonl(
        _budget_ledger(base_dir),
        expected_surface="cost_budget",
    ):
        recorded_at = str(row.get("recorded_at", ""))
        amount = row.get("estimated_usd", 0)
        if not isinstance(amount, (int, float)):
            continue
        if recorded_at.startswith(day):
            daily += float(amount)
        if recorded_at.startswith(month):
            monthly += float(amount)
    return {"daily_usd": round(daily, 6), "monthly_usd": round(monthly, 6)}


def _normalize_budget(config: dict[str, Any]) -> dict[str, float | int]:
    merged = {**DEFAULT_BUDGET, **config}
    for key in ("daily_usd_cap", "monthly_usd_cap", "per_action_usd_cap", "soft_stop_ratio"):
        if not isinstance(merged.get(key), (int, float)) or float(merged[key]) < 0:
            raise GovernanceError(f"budget {key} must be a non-negative number")
    if not 0 <= float(merged["soft_stop_ratio"]) <= 1:
        raise GovernanceError("budget soft_stop_ratio must be in [0, 1]")
    return {
        "schema_version": int(merged.get("schema_version", 1)),
        "daily_usd_cap": float(merged["daily_usd_cap"]),
        "monthly_usd_cap": float(merged["monthly_usd_cap"]),
        "per_action_usd_cap": float(merged["per_action_usd_cap"]),
        "soft_stop_ratio": float(merged["soft_stop_ratio"]),
    }


def _budget_ledger(base_dir: str | Path | None) -> Path:
    return ensure_tools_dir(base_dir) / "budget" / "usage.jsonl"


def _non_negative_int(value: int, field: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise GovernanceError(f"{field} must be a non-negative integer")
    return value


# ---------------------------------------------------------------------------
# Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — per-run reservation discipline.
#
# WHY: existing daily/monthly cap (above) bounds long-term spend but not
# per-run cost spikes. With V8's P+C+CR pipeline tripling LLM calls per
# cycle, an uncapped 30-cycle smoke could silently drift past the daily
# cap mid-run. C0 adds a per-RUN cap with cycle-level reservation +
# envelope-level reconciliation, recorded to a separate ledger at
# ``aria-tools/budget-ledger.jsonl`` (hash-chained, append-only).
#
# Fails closed: missing/unknown reservation_token raises
# BudgetReservationMissing; over-cap reservation raises BudgetExhausted.
# No silent "no cap" path.
# ---------------------------------------------------------------------------

import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402

from .file_lock import with_exclusive_lock  # noqa: E402

PER_RUN_BUDGET_LEDGER_FILENAME = "budget-ledger.jsonl"
DEFAULT_MAX_BUDGET_USD_PER_RUN = 20.00
DEFAULT_MAX_BUDGET_USD_PER_CYCLE = 3.00


class BudgetReservationMissing(GovernanceError):
    """Raised when a reservation_token is not on the per-run ledger."""


class BudgetExhausted(GovernanceError):
    """Raised when remaining budget cannot cover the next envelope."""


def _per_run_ledger_path(base_dir: str | Path) -> Path:
    return ensure_tools_dir(base_dir) / PER_RUN_BUDGET_LEDGER_FILENAME


def _per_run_canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _per_run_previous_hash(ledger_path: Path) -> str | None:
    if not ledger_path.exists():
        return None
    with ledger_path.open("r", encoding="utf-8") as fh:
        last_line = None
        for line in fh:
            if line.strip():
                last_line = line
    if last_line is None:
        return None
    try:
        return json.loads(last_line).get("ledger_hash")
    except json.JSONDecodeError:
        return None


def _per_run_append(base_dir: str | Path, row: dict[str, Any]) -> dict[str, Any]:
    ledger_path = _per_run_ledger_path(base_dir)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(ledger_path) + ".lock")
    with with_exclusive_lock(lock_path, timeout_seconds=5.0):
        previous_hash = _per_run_previous_hash(ledger_path)
        body = {k: v for k, v in row.items() if k not in ("ledger_hash", "previous_ledger_hash")}
        body["previous_ledger_hash"] = previous_hash
        body["ledger_hash"] = _per_run_canonical_hash(body)
        with ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(body, ensure_ascii=False) + "\n")
        return body


def _per_run_load(base_dir: str | Path) -> list[dict[str, Any]]:
    ledger_path = _per_run_ledger_path(base_dir)
    if not ledger_path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with ledger_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _per_run_remaining(base_dir: str | Path, cap: float) -> float:
    consumed = 0.0
    for row in _per_run_load(base_dir):
        if row.get("kind") == "envelope_reconciliation":
            try:
                consumed += float(row.get("actual_cost_usd", 0))
            except (TypeError, ValueError):
                continue
    return max(0.0, cap - consumed)


def reserve_cycle_budget(
    *,
    cycle_id: str,
    estimated_cost_usd: float,
    base_dir: str | Path,
    max_budget_usd_per_run: float | None = None,
    max_budget_usd_per_cycle: float | None = None,
) -> str:
    """Reserve cycle budget; return reservation_token (ledger_hash)."""
    if not isinstance(estimated_cost_usd, (int, float)) or estimated_cost_usd <= 0:
        raise GovernanceError(
            f"estimated_cost_usd must be > 0, got {estimated_cost_usd!r}"
        )
    cap = float(
        max_budget_usd_per_run
        if max_budget_usd_per_run is not None
        else os.environ.get("MAX_BUDGET_USD_PER_RUN", DEFAULT_MAX_BUDGET_USD_PER_RUN)
    )
    cycle_cap = float(
        max_budget_usd_per_cycle
        if max_budget_usd_per_cycle is not None
        else os.environ.get("MAX_BUDGET_USD_PER_CYCLE", DEFAULT_MAX_BUDGET_USD_PER_CYCLE)
    )
    if estimated_cost_usd > cycle_cap:
        raise BudgetExhausted(
            f"reserve_cycle_budget: cycle_id={cycle_id} estimated=${estimated_cost_usd:.4f} "
            f"> max_budget_usd_per_cycle=${cycle_cap:.4f}"
        )
    remaining = _per_run_remaining(base_dir, cap)
    if estimated_cost_usd > remaining:
        raise BudgetExhausted(
            f"reserve_cycle_budget: cycle_id={cycle_id} estimated=${estimated_cost_usd:.4f} "
            f"> remaining_run=${remaining:.4f} (cap=${cap:.4f})"
        )
    row = {
        "$schema": "aria/budget-reservation/v1",
        "kind": "cycle_reservation",
        "cycle_id": cycle_id,
        "estimated_cost_usd": float(estimated_cost_usd),
        "max_budget_usd_per_run": cap,
        "max_budget_usd_per_cycle": cycle_cap,
        "recorded_at": utc_now(),
        "schema_version": 1,
    }
    persisted = _per_run_append(base_dir, row)
    return str(persisted["ledger_hash"])


def _find_reservation(base_dir: str | Path, reservation_token: str) -> dict[str, Any] | None:
    for row in _per_run_load(base_dir):
        if row.get("kind") == "cycle_reservation" and row.get("ledger_hash") == reservation_token:
            return row
    return None


def reconcile_envelope_cost(
    *,
    reservation_token: str,
    envelope_id: str,
    actual_cost_usd: float,
    base_dir: str | Path,
) -> dict[str, Any]:
    """Record actual envelope cost against a prior cycle reservation."""
    if not isinstance(actual_cost_usd, (int, float)) or actual_cost_usd < 0:
        raise GovernanceError(
            f"actual_cost_usd must be >= 0, got {actual_cost_usd!r}"
        )
    if _find_reservation(base_dir, reservation_token) is None:
        raise BudgetReservationMissing(
            f"reservation_token={reservation_token[:24]}... not found on per-run ledger"
        )
    row = {
        "$schema": "aria/budget-reconciliation/v1",
        "kind": "envelope_reconciliation",
        "reservation_token": reservation_token,
        "envelope_id": envelope_id,
        "actual_cost_usd": float(actual_cost_usd),
        "recorded_at": utc_now(),
        "schema_version": 1,
    }
    return _per_run_append(base_dir, row)


def check_remaining_budget(
    *,
    reservation_token: str,
    base_dir: str | Path,
) -> float:
    """Reserved - reconciled, for THIS reservation."""
    reservation = _find_reservation(base_dir, reservation_token)
    if reservation is None:
        raise BudgetReservationMissing(
            f"reservation_token={reservation_token[:24]}... not found"
        )
    reserved = float(reservation.get("estimated_cost_usd", 0))
    reconciled = 0.0
    for row in _per_run_load(base_dir):
        if row.get("kind") == "envelope_reconciliation" and row.get("reservation_token") == reservation_token:
            try:
                reconciled += float(row.get("actual_cost_usd", 0))
            except (TypeError, ValueError):
                continue
    return max(0.0, reserved - reconciled)


# =============================================================================
# Plan ARIA-V10.4 — per-pattern cost attribution
# =============================================================================
#
# Closes:
#   * arb MED-008 — upstream wire of `invocation_role` field through
#     llm_bridge + agent_invocations so per-cycle cost rollup
#     attributes spend correctly (primary vs challenger vs cross_review
#     vs implementer)
#   * perf MED-010 — monthly ledger sharding to bound the
#     `cost-report` scan time as months accumulate (1500 rows/year
#     under nominal load × 5 years = 7500 rows; sharded by month =
#     ~125 rows per shard scan)

from datetime import datetime, timezone  # safe-redundant; already imported


# Plan ARIA-V10.4 — closed enum of agent roles for cost attribution.
# Mirrors the V8 + V9 role surface (primary plan + challenger plan +
# cross_review from V8; implementation from V9). Closed-set membership
# pinned by I-V10-COST-03 invariant.
COST_INVOCATION_ROLES: frozenset[str] = frozenset({
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "implementation",
    "judgment",        # V8 judgment_bridge role
    "specialist",      # V6 specialist review role
})


def _cost_attribution_shard(base_dir: str | Path | None) -> Path:
    """Plan ARIA-V10.4 — monthly shard layout
    aria-tools/cost-attribution/<YYYY-MM>.jsonl. Cost-report reads
    only the shards covering the requested time window (perf MED-010).
    """
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    root = ensure_tools_dir(base_dir)
    shard_dir = root / "cost-attribution"
    shard_dir.mkdir(parents=True, exist_ok=True)
    return shard_dir / f"{month}.jsonl"


def record_cost_attribution(
    *,
    cycle_id: str,
    plan_id: str,
    agent_role: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    estimated_usd: float,
    pressure_source_type: str | None = None,
    terminal_state: str | None = None,
    signer_key_fp: str | None = None,
    estimated_input_tokens: int | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V10.4 + V3.1-D — append a per-invocation cost-attribution row.

    Row schema (pinned by I-V10-COST-01 invariant; V3.1-D adds
    signer_key_fp + drift_flag fields):
      {recorded_at, cycle_id, plan_id, agent_role, model,
       input_tokens, output_tokens, estimated_usd,
       pressure_source_type, terminal_state, schema_version=1,
       signer_key_fp, drift_flag}

    agent_role MUST be in COST_INVOCATION_ROLES. Mismatch raises
    GovernanceError.

    Plan ARIA-V3.1-D — signer_key_fp + drift detection (closes
    6-validator audit H-5 cost ledger forgery):

    * signer_key_fp — fingerprint of the cycle's ephemeral
      ed25519 signing key (V9.0-C mint_signing_key output, format
      `SHA256:<base64>`). When None, defaults to the sentinel
      "SHA256:no-key" so the schema invariant `signer_key_fp starts
      with SHA256:` remains stable across legacy V8 cycles + new
      V9+ cycles. Operator-side audit can verify provenance by
      cross-referencing the fingerprint against the cycle's
      aria-debts/keys/<cycle_id>.pub file.

    * drift_flag — Tier-3 detect. When estimated_input_tokens is
      supplied (caller's pre-call cost estimator) and the actual
      input_tokens reported by the LLM provider differs by > 50%,
      drift_flag="usage_block_drift" is recorded + an
      `usage_block_drift_rejected` governance event fires. The row
      is still recorded (not rejected) so the operator audit trail
      keeps the suspicious data point. A future Tier-1 upgrade
      fetches authoritative usage via the Anthropic Console API
      (tracked F-V31.1-cost-receipt).

    Returns the appended row dict.
    """
    if agent_role not in COST_INVOCATION_ROLES:
        raise GovernanceError(
            f"agent_role MUST be in COST_INVOCATION_ROLES "
            f"({sorted(COST_INVOCATION_ROLES)}); got {agent_role!r}"
        )
    if not isinstance(cycle_id, str) or not cycle_id:
        raise GovernanceError("cycle_id must be a non-empty string")
    if not isinstance(plan_id, str) or not plan_id:
        raise GovernanceError("plan_id must be a non-empty string")
    if not isinstance(model, str) or not model:
        raise GovernanceError("model must be a non-empty string")

    # Plan ARIA-V3.1-D-5 — signer_key_fp pinning. Schema invariant
    # requires the SHA256: prefix regardless of whether the cycle
    # had a real key.
    effective_signer_fp = signer_key_fp or "SHA256:no-key"
    if not effective_signer_fp.startswith("SHA256:"):
        raise GovernanceError(
            f"signer_key_fp must start with 'SHA256:'; got "
            f"{effective_signer_fp!r}"
        )

    # Plan ARIA-V3.1-D-3 — usage block drift detection (closes H-5).
    drift_flag: str | None = None
    drift_ratio: float | None = None
    if (
        isinstance(estimated_input_tokens, int)
        and estimated_input_tokens > 0
    ):
        actual = max(0, int(input_tokens))
        delta = abs(actual - estimated_input_tokens)
        drift_ratio = delta / float(estimated_input_tokens)
        if drift_ratio > 0.5:
            drift_flag = "usage_block_drift"

    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "plan_id": plan_id,
        "agent_role": agent_role,
        "model": model,
        "input_tokens": _non_negative_int(input_tokens, "input_tokens"),
        "output_tokens": _non_negative_int(output_tokens, "output_tokens"),
        "estimated_usd": float(estimated_usd),
        "pressure_source_type": pressure_source_type,
        "terminal_state": terminal_state,
        "signer_key_fp": effective_signer_fp,
        "drift_flag": drift_flag,
    }
    # Plan ARIA-V3.1-D-3 — write row FIRST so ensure_tools_dir
    # bootstraps repo_identity.json before the drift governance event
    # lands (preserves ambiguous_tools_root invariant in tool_registry).
    written = append_declared_jsonl(
        _cost_attribution_shard(base_dir),
        row,
        expected_surface="cost_attribution",
    )
    if drift_flag is not None:
        # Best-effort governance event AFTER the row write. The row
        # is still recorded so operator audit captures both the
        # suspicious data point + the drift signal.
        try:
            from .tool_registry import append_tools_governance
            append_tools_governance(
                base_dir, "usage_block_drift_rejected",
                {
                    "cycle_id": cycle_id,
                    "plan_id": plan_id,
                    "agent_role": agent_role,
                    "model": model,
                    "reported_input_tokens": int(input_tokens),
                    "estimated_input_tokens": estimated_input_tokens,
                    "drift_ratio": drift_ratio,
                },
                bypass_profile_gate=True,
            )
        except Exception:
            # Best-effort — cost attribution row already landed.
            pass
    return written


def read_cost_attribution(
    *,
    since_iso: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V10.4 — read cost-attribution rows from monthly shards.

    `since_iso` filters rows by `recorded_at >= since_iso`. None →
    return all rows from all shards.

    Reads only the shards whose filename month is >= since's month
    (perf MED-010 — bounds scan time even after 5+ years of history).
    """
    root = ensure_tools_dir(base_dir)
    shard_dir = root / "cost-attribution"
    if not shard_dir.is_dir():
        return []
    if since_iso:
        since_month = since_iso[:7]  # YYYY-MM
    else:
        since_month = ""
    rows: list[dict[str, Any]] = []
    for shard in sorted(shard_dir.glob("*.jsonl")):
        shard_month = shard.stem  # YYYY-MM
        if shard_month < since_month:
            continue
        for row in load_declared_jsonl(
            shard,
            expected_surface="cost_attribution",
        ):
            if since_iso and str(row.get("recorded_at", "")) < since_iso:
                continue
            rows.append(row)
    return rows


def aggregate_cost_attribution(
    *,
    since_iso: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V10.4 — operator-facing cost-report aggregation.

    Returns:
      {
        "total_usd": float,
        "row_count": int,
        "by_agent_role": {<role>: usd, ...},
        "by_pressure_source": {<source>: usd, ...},
        "by_terminal_state": {<state>: usd, ...},
        "by_model": {<model>: usd, ...},
        "since_iso": since_iso or None,
      }

    Used by `aria-kernel autonomy cost-report --since <window>` CLI.
    """
    rows = read_cost_attribution(since_iso=since_iso, base_dir=base_dir)
    summary = {
        "total_usd": 0.0,
        "row_count": len(rows),
        "by_agent_role": {},
        "by_pressure_source": {},
        "by_terminal_state": {},
        "by_model": {},
        "since_iso": since_iso,
    }
    for r in rows:
        usd = float(r.get("estimated_usd", 0) or 0)
        summary["total_usd"] += usd
        role = r.get("agent_role")
        if role:
            summary["by_agent_role"][role] = summary["by_agent_role"].get(role, 0.0) + usd
        src = r.get("pressure_source_type")
        if src:
            summary["by_pressure_source"][src] = summary["by_pressure_source"].get(src, 0.0) + usd
        ts = r.get("terminal_state")
        if ts:
            summary["by_terminal_state"][ts] = summary["by_terminal_state"].get(ts, 0.0) + usd
        m = r.get("model")
        if m:
            summary["by_model"][m] = summary["by_model"].get(m, 0.0) + usd
    summary["total_usd"] = round(summary["total_usd"], 6)
    for bucket in ("by_agent_role", "by_pressure_source", "by_terminal_state", "by_model"):
        summary[bucket] = {k: round(v, 6) for k, v in summary[bucket].items()}
    return summary
