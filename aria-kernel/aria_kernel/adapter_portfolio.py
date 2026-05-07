"""Plan 016 Faz F1+F2 — adapter portfolio MVP + parse-window signature.

Plan 016 Faz F1 names eight adapters as the operational MVP:
  Tenant-scoping, Event-contracts, Schema-drift, Banned-phrase,
  NATS cert-CN, CQRS, Outbox, Dual-alias.

Five of these (Tenant-scoping, Event-contracts, Schema-drift, NATS
cert-CN, plus Migration-runner from earlier work) already exist in
`aria-tools/registry.json` with an empty-stub `shadow_runner.py`. This
module ships the remaining four (Banned-phrase, CQRS, Outbox,
Dual-alias) using the same shadow-stub pattern + a fixture directory
shape so the eight Plan-016-named adapters all carry the same SHADOW
discipline.

Plan 016 Faz F2 demands a `parse_window_signature` (stable hash of
the adapter's parser declaration) and a `freshness_window_hours`
(default 168h = 7 days). Both let the kernel decide when an adapter's
last SHADOW run is stale enough to require revalidation. This module
adds both fields to the registry rows for every MVP adapter without
breaking the existing required-field contract — they are stored as
`extra` keys on each row, deserialised by the new helpers below.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .tool_registry import (
    DEFAULT_HEALTH_THRESHOLDS,
    GovernanceError,
    SCHEMA_VERSION,
    load_registry,
    register_tool,
)


DEFAULT_FRESHNESS_WINDOW_HOURS = 168  # Plan 016 §Recursive impact and freshness gates.


# Each adapter is described once; the registry row is built from this dict.
# The four newly-shipped adapters intentionally point at the same shadow_runner
# stub other adapters use — Plan F1 ships SHADOW evidence and the fixture
# scaffolding; the actual parser logic lands per-adapter as separate commits.
_MVP_ADAPTERS: tuple[dict[str, Any], ...] = (
    {
        "tool_id": "banned-phrase-adapter",
        "claim_types": ["banned_phrase"],
        "declared_scope": ["**/*.md", "**/*.ts", "**/*.py"],
        "default_input": {"roots": ["docs", "apps", "libs", "platform", "aria-findings"]},
        "owner": "platform",
    },
    {
        "tool_id": "cqrs-adapter",
        "claim_types": ["cqrs_layer_skip"],
        "declared_scope": ["apps/**/*.ts", "platform/libs/cqrs/**/*.ts"],
        "default_input": {"roots": ["apps", "platform/libs/cqrs"]},
        "owner": "platform",
    },
    {
        "tool_id": "outbox-adapter",
        "claim_types": ["outbox_emission"],
        "declared_scope": ["apps/**/outbox/**/*.ts", "platform/libs/outbox/**/*.ts"],
        "default_input": {"roots": ["apps", "platform/libs/outbox"]},
        "owner": "platform",
    },
    {
        "tool_id": "dual-alias-adapter",
        "claim_types": ["dual_alias_drift"],
        "declared_scope": ["libs/backend-common/**/*.ts", "tsconfig*.json"],
        "default_input": {"roots": ["libs/backend-common"]},
        "owner": "platform",
    },
)

PLAN_016_MVP_TOOL_IDS = (
    "tenant-scoping-adapter",
    "event-contracts-adapter",
    "schema-drift-adapter",
    "banned-phrase-adapter",
    "nats-cert-identity-adapter",
    "cqrs-adapter",
    "outbox-adapter",
    "dual-alias-adapter",
)


def parse_window_signature(declaration: dict[str, Any]) -> str:
    """Stable SHA-256 hash of the parser-declaration tuple.

    The signature changes ONLY when the parser's declared scope, claim
    types, or input roots change — not when the underlying repo content
    changes. This is what the kernel uses to decide whether a recorded
    SHADOW run still matches the current adapter declaration.

    Returns: "sha256:<hex>" of a canonical JSON over (declared_scope,
    claim_types, default_input.roots, allowed_read_globs,
    forbidden_read_globs).
    """
    fields = {
        "declared_scope": sorted(declaration.get("declared_scope", []) or []),
        "claim_types": sorted(declaration.get("claim_types", []) or []),
        "default_input_roots": sorted(
            (declaration.get("default_input") or {}).get("roots", []) or []
        ),
        "allowed_read_globs": sorted(declaration.get("allowed_read_globs", []) or []),
        "forbidden_read_globs": sorted(declaration.get("forbidden_read_globs", []) or []),
    }
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _build_adapter_row(spec: dict[str, Any]) -> dict[str, Any]:
    """Compose a full registry row from the compact MVP spec above."""
    declared_scope = spec["declared_scope"]
    row = {
        "tool_id": spec["tool_id"],
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "schema_version": SCHEMA_VERSION,
        "owner": spec["owner"],
        "claim_types": spec["claim_types"],
        "declared_scope": declared_scope,
        "default_input": spec.get("default_input", {}),
        "allowed_read_globs": declared_scope,
        "forbidden_read_globs": [
            ".git/**",
            "node_modules/**",
            "dist/**",
            "aria-tools/**",
        ],
        "fixture_set": f"tools/aria-poc/fixtures/{spec['tool_id'].replace('-adapter', '')}",
        "health_thresholds": dict(DEFAULT_HEALTH_THRESHOLDS),
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "runner": {
            "type": "subprocess",
            "argv": ["python3", "shadow_runner.py", spec["tool_id"]],
            "cwd": "tools/aria-poc",
            "stdin_json": True,
            "timeout_ms": 15000,
        },
    }
    # F2 fields:
    row["parse_window_signature"] = parse_window_signature(row)
    row["freshness_window_hours"] = DEFAULT_FRESHNESS_WINDOW_HOURS
    return row


def register_mvp_adapters(
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Idempotently register the four missing Plan 016 MVP adapters.

    Existing adapters in registry.json are NOT touched here — Faz F2's
    parse_window_signature and freshness_window_hours additions for
    the already-registered adapters are landed by `backfill_window_metadata`.

    Returns: {"registered": [...], "skipped_existing": [...]}.
    """
    registry = load_registry(base_dir)
    existing_ids = {t.get("tool_id") for t in registry.get("tools", [])}
    registered: list[str] = []
    skipped: list[str] = []
    for spec in _MVP_ADAPTERS:
        tid = spec["tool_id"]
        if tid in existing_ids:
            skipped.append(tid)
            continue
        register_tool(_build_adapter_row(spec), base_dir=base_dir)
        registered.append(tid)
    return {"registered": registered, "skipped_existing": skipped}


def backfill_window_metadata(
    *,
    base_dir: str | Path | None = None,
    freshness_hours: int = DEFAULT_FRESHNESS_WINDOW_HOURS,
) -> dict[str, Any]:
    """Add `parse_window_signature` + `freshness_window_hours` to every adapter
    in the registry that lacks them. Idempotent: a row that already carries
    these fields with the current signature is left untouched.
    """
    if freshness_hours <= 0:
        raise GovernanceError("freshness_hours must be positive")
    registry = load_registry(base_dir)
    updated: list[str] = []
    untouched: list[str] = []
    rebuilt: list[dict[str, Any]] = []
    for tool in registry.get("tools", []):
        if tool.get("kind") != "adapter":
            rebuilt.append(tool)
            continue
        current_sig = parse_window_signature(tool)
        needs_update = (
            tool.get("parse_window_signature") != current_sig
            or tool.get("freshness_window_hours") != freshness_hours
        )
        if needs_update:
            tool = dict(tool)
            tool["parse_window_signature"] = current_sig
            tool["freshness_window_hours"] = freshness_hours
            updated.append(str(tool.get("tool_id")))
        else:
            untouched.append(str(tool.get("tool_id")))
        rebuilt.append(tool)
    registry["tools"] = rebuilt
    registry["schema_version"] = SCHEMA_VERSION
    from .tool_registry import save_registry

    save_registry(registry, base_dir)
    return {"updated": updated, "untouched": untouched}


def list_mvp_status(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Return the Plan 016 MVP coverage map: which named adapters are
    registered, which are missing, and per-adapter signature + freshness."""
    registry = load_registry(base_dir)
    by_id = {t.get("tool_id"): t for t in registry.get("tools", [])}
    rows: list[dict[str, Any]] = []
    missing: list[str] = []
    for tid in PLAN_016_MVP_TOOL_IDS:
        tool = by_id.get(tid)
        if tool is None:
            missing.append(tid)
            continue
        rows.append(
            {
                "tool_id": tid,
                "status": tool.get("status"),
                "parse_window_signature": tool.get("parse_window_signature"),
                "freshness_window_hours": tool.get("freshness_window_hours"),
                "fixture_set": tool.get("fixture_set"),
            }
        )
    return {
        "expected_count": len(PLAN_016_MVP_TOOL_IDS),
        "registered_count": len(rows),
        "missing": missing,
        "tools": rows,
    }
