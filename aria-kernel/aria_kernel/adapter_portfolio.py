"""Plan 016 Faz F1+F2 — adapter portfolio status.

Plan 016 Faz F1 names eight adapters as the operational MVP:
  Tenant-scoping, Event-contracts, Schema-drift, Banned-phrase,
  NATS cert-CN, CQRS, Outbox, Dual-alias.

ARIA-MEDIUM-378 — this module used to REGISTER four of them (Banned-phrase,
CQRS, Outbox, Dual-alias) from rows of its own, every row running the no-op
``shadow_runner.py``. That was a second declaration source beside the
manifests: only the ``adapter-portfolio register-mvp`` command wrote those
rows, no workflow ran it, ``registry_compiler`` refuses a stub runner, and the
cycle's manifest sync (``cycle._phase_tool_manifest_sync``) reads only
``tools/aria-adapters/*.tool.json``. The four parsers that existed were
therefore never run outside tests. Each now has a manifest with its real
runner, the manifests are the only declaration, and this module only reports
which named adapters the registry holds
(``tests/test_adapter_registry_completeness.py`` pins it).

Plan 016 Faz F2 demands a `parse_window_signature` (stable hash of
the adapter's parser declaration) and a `freshness_window_hours`
(default 168h = 7 days). Both let the kernel decide when an adapter's
last SHADOW run is stale enough to require revalidation. E13-C11 moved
their ownership out of this module: the fields live in the adapter
manifests (`tools/aria-adapters/*.tool.json`) and are defaulted +
derived by `tool_registry.validate_tool_definition` on every write
path, so a manifest recompile can no longer delete them. The former
runtime patcher (`backfill_window_metadata`) is deleted — a row that
only exists after runtime patching and dies on recompile is not
metadata, it is decoration.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import load_registry


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
