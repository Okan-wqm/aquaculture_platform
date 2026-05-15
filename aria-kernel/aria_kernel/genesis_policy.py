from __future__ import annotations

import json
from pathlib import Path
from typing import Any


POLICY_KEYS = {
    "schema_version",
    "enable_request_generation",
    "max_requests_per_cycle",
    "materialization_requires_acknowledge",
    "fitness_staleness_threshold_days",
    # Plan ARIA-V3 §B0 + INFRA-CRITICAL-001 — cost caps consumed by
    # ``cost_budget.assert_within_budget`` to gate autonomous spawns.
    "cost_caps_usd",
    # Plan ARIA-V3 §B2 — circuit-breaker failure threshold.
    "circuit_breaker",
}

DEFAULT_FILENAME = "genesis_policy_default.json"
OVERRIDE_RELPATH = "aria-config/genesis_policy.json"


def default_policy() -> dict[str, Any]:
    """Return the package-shipped default policy.

    Why: Phase-4.1 needs a deterministic baseline so missing operator override
    does not silently disable genesis hooks. Defaults keep the loop ON.
    """
    path = Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {key: raw[key] for key in POLICY_KEYS if key in raw}


def load_policy(repo_root: str | Path) -> dict[str, Any]:
    """Merge package defaults with optional operator override.

    Layer 1: aria-kernel/aria_kernel/data/genesis_policy_default.json (always present).
    Layer 2: <repo_root>/aria-config/genesis_policy.json (optional operator override).

    Missing override → defaults only (fail-soft, never disables genesis without intent).
    Unknown override keys are ignored (forward-compat).
    """
    defaults = default_policy()
    override_path = Path(repo_root) / OVERRIDE_RELPATH
    if not override_path.exists():
        return defaults
    try:
        raw = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return defaults
    if not isinstance(raw, dict):
        return defaults
    return merge_with_override(defaults, raw)


def merge_with_override(defaults: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Override-wins merge restricted to known POLICY_KEYS."""
    merged = dict(defaults)
    for key, value in override.items():
        if key in POLICY_KEYS:
            merged[key] = value
    return merged
