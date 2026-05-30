from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, utc_now, validate_tool_definition


STUB_RUNNER_TOKENS = frozenset({"shadow_runner.py", "noop.py", "echo"})


def compile_registry(
    adapters_dir: str | Path,
    output: str | Path,
    *,
    check: bool = False,
) -> dict[str, Any]:
    """Compile adapter .tool.json manifests into aria-tools/registry.json.

    The manifest directory is the single source for adapter registrations.
    Existing registry timestamps are preserved per tool_id so repeated
    compiles are deterministic. Runner validation is delegated to
    tool_registry.validate_tool_definition(), including npx ts-node argv
    normalization.
    """
    adapters = Path(adapters_dir)
    out = Path(output)
    existing = _load_existing(out)
    existing_by_id = {
        str(tool.get("tool_id")): tool
        for tool in existing.get("tools", [])
        if isinstance(tool, dict) and tool.get("tool_id")
    }
    tools = []
    now = utc_now()
    for manifest_path in sorted(adapters.glob("*.tool.json")):
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise GovernanceError(f"{manifest_path.as_posix()} must contain a JSON object")
        tool_id = str(raw.get("tool_id") or "")
        prior = existing_by_id.get(tool_id, {})
        raw.setdefault("created_at", prior.get("created_at") or now)
        raw.setdefault("updated_at", prior.get("updated_at") or raw["created_at"])
        compiled = validate_tool_definition(raw)
        compiled["created_at"] = raw["created_at"]
        compiled["updated_at"] = raw["updated_at"]
        _reject_stub_runner(compiled, manifest_path)
        tools.append(compiled)
    registry = {"schema_version": 2, "tools": tools}
    if check:
        if _canonical(existing) != _canonical(registry):
            raise GovernanceError(
                f"registry_drift: {out.as_posix()} does not match manifests under {adapters.as_posix()}"
            )
        return registry
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return registry


def _load_existing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 2, "tools": []}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise GovernanceError(f"{path.as_posix()} must contain a JSON object")
    payload.setdefault("tools", [])
    return payload


def _canonical(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _reject_stub_runner(tool: dict[str, Any], manifest_path: Path) -> None:
    runner = tool.get("runner") or {}
    argv = runner.get("argv") or []
    if not isinstance(argv, list):
        return
    for part in argv:
        if not isinstance(part, str):
            continue
        if any(token in part for token in STUB_RUNNER_TOKENS):
            raise GovernanceError(
                f"stub_runner_rejected: {manifest_path.as_posix()} tool_id={tool.get('tool_id')}"
            )
