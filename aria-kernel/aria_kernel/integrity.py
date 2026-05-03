from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import verify_jsonl
from .tool_registry import ensure_tools_dir


def verify_integrity(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    ledgers = sorted(path for path in root.rglob("*.jsonl") if path.is_file())
    results = [verify_jsonl(path) for path in ledgers]
    return {
        "schema_version": 1,
        "valid": all(result.get("valid") is True for result in results),
        "ledger_count": len(results),
        "ledgers": results,
    }
