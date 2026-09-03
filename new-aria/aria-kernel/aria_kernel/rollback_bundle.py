from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


def record_rollback_bundle(
    bundle: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_rollback_bundle",
        **dict(bundle),
    }
    row.setdefault("row_id", row.get("rollback_bundle_id"))
    _require_common(row, "rollback_bundle")
    if not str(row.get("rollback_bundle_id") or "").strip():
        raise GovernanceError("rollback_bundle_id_required")
    if not str(row.get("rollback_plan_sha256") or "").startswith("sha256:"):
        raise GovernanceError("rollback_bundle_plan_hash_required")
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "rollback-bundles.jsonl",
        row,
        expected_surface="enterprise_rollback_bundles",
    )


def record_rollback_simulation(
    simulation: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_rollback_simulation",
        **dict(simulation),
    }
    row.setdefault("row_id", row.get("rollback_simulation_id"))
    _require_common(row, "rollback_simulation")
    if not str(row.get("rollback_bundle_id") or "").strip():
        raise GovernanceError("rollback_simulation_bundle_id_required")
    if row.get("status") != "passed":
        raise GovernanceError("rollback_simulation_must_pass")
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "rollback-simulations.jsonl",
        row,
        expected_surface="enterprise_rollback_simulations",
    )


def verify_rollback_bundle(
    *,
    pr_number: int,
    head_sha: str,
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    bundles = load_declared_jsonl(
        root / "enterprise" / "rollback-bundles.jsonl",
        expected_surface="enterprise_rollback_bundles",
    )
    simulations = load_declared_jsonl(
        root / "enterprise" / "rollback-simulations.jsonl",
        expected_surface="enterprise_rollback_simulations",
    )
    bundle = next(
        (
            row for row in reversed(bundles)
            if row.get("pr_number") == pr_number
            and row.get("head_sha") == head_sha
            and row.get("readiness_claim_id") == readiness_claim_id
        ),
        None,
    )
    if bundle is None:
        raise GovernanceError("rollback_bundle_required_for_merge")
    simulation = next(
        (
            row for row in reversed(simulations)
            if row.get("pr_number") == pr_number
            and row.get("head_sha") == head_sha
            and row.get("readiness_claim_id") == readiness_claim_id
            and row.get("rollback_bundle_id") == bundle.get("rollback_bundle_id")
            and row.get("status") == "passed"
        ),
        None,
    )
    if simulation is None:
        raise GovernanceError("rollback_simulation_required_for_merge")
    return {
        "valid": True,
        "rollback_bundle_id": bundle.get("rollback_bundle_id"),
        "rollback_bundle_ledger_hash": bundle.get("ledger_hash"),
        "rollback_simulation_ledger_hash": simulation.get("ledger_hash"),
    }


def _require_common(row: dict[str, Any], label: str) -> None:
    required = ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id")
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError(f"{label}_missing_fields:" + ",".join(missing))


__all__ = [
    "record_rollback_bundle",
    "record_rollback_simulation",
    "verify_rollback_bundle",
]
