from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import load_jsonl, verify_jsonl
from .tool_registry import ensure_tools_dir


def verify_integrity(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    ledgers = sorted(path for path in root.rglob("*.jsonl") if path.is_file())
    results = [verify_jsonl(path) for path in ledgers]
    lifecycle = _verify_cycle_lifecycle(root)
    return {
        "schema_version": 1,
        "valid": all(result.get("valid") is True for result in results) and lifecycle["valid"],
        "ledger_count": len(results),
        "ledgers": results,
        "cycle_lifecycle": lifecycle,
    }


def _verify_cycle_lifecycle(root: Path) -> dict[str, Any]:
    terminal_events = {"completed", "failed", "stopped"}
    open_cycles: dict[str, dict[str, Any]] = {}
    terminals: dict[str, dict[str, Any]] = {}
    for row in load_jsonl(root / "cycles.jsonl"):
        cycle_id = str(row.get("cycle_id") or "")
        event = str(row.get("event") or "")
        if not cycle_id:
            continue
        if event == "started":
            open_cycles[cycle_id] = row
        elif event in terminal_events:
            terminals[cycle_id] = row
            open_cycles.pop(cycle_id, None)
    incomplete = [
        {
            "cycle_id": cycle_id,
            "started_at": row.get("at"),
            "reason": "cycle has started event without terminal event",
        }
        for cycle_id, row in sorted(open_cycles.items())
        if cycle_id not in terminals
    ]
    return {
        "valid": not incomplete,
        "incomplete_count": len(incomplete),
        "incomplete_cycles": incomplete,
    }
