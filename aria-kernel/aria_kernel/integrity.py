from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import file_hash, load_jsonl, load_index, verify_jsonl
from .tool_registry import covered_tool_ledgers, ensure_tools_dir, tools_contract_version
from .workspace import ensure_workspace, workspace_contract_version, workspace_paths, repo_hash


def verify_integrity(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    workspace_base: str | Path | None = None,
    tools_dir: str | Path | None = None,
) -> dict[str, Any]:
    base_dir = tools_dir if tools_dir is not None else base_dir
    root = ensure_tools_dir(base_dir)
    tools = _verify_tools(root, Path(workspace_root).resolve() if workspace_root is not None else None)
    workspace = (
        _verify_workspace(Path(workspace_root).resolve(), Path(workspace_base) if workspace_base else None, root)
        if workspace_root is not None
        else {"index_path": None, "ledgers": [], "issues": []}
    )
    lifecycle = _verify_cycle_lifecycle(root)
    issues = list(workspace.get("issues", [])) + list(tools.get("issues", []))
    if not lifecycle["valid"]:
        issues.append({"code": "cycle_lifecycle_incomplete", "details": lifecycle})
    status = "ok" if not issues else "drift"
    return {
        "schema_version": 2,
        "status": status,
        "valid": status == "ok",
        "workspace": workspace,
        "tools": tools,
        "ledger_count": len(workspace.get("ledgers", [])) + len(tools.get("ledgers", [])),
        "ledgers": list(workspace.get("ledgers", [])) + list(tools.get("ledgers", [])),
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


def _verify_workspace(repo_root: Path, workspace_base: Path | None, tools_root: Path) -> dict[str, Any]:
    paths = workspace_paths(repo_root, workspace_base)
    if not paths.identity_file.exists() and not any(path.exists() and path.stat().st_size for path in paths.ledgers.values()):
        ensure_workspace(paths)
    issues: list[dict[str, Any]] = []
    ledgers = []
    version = workspace_contract_version(paths)
    if version < 2:
        issues.append({"code": "workspace_migration_required", "version": version})
    if paths.identity_file.exists():
        identity = _read_json(paths.identity_file)
        if identity.get("repo_hash") != repo_hash(repo_root):
            issues.append({"code": "workspace_repo_hash_mismatch", "expected": repo_hash(repo_root), "actual": identity.get("repo_hash")})
    for name, path in paths.ledgers.items():
        result = verify_jsonl(path)
        result["name"] = name
        ledgers.append(result)
        if result.get("valid") is not True:
            issues.append({"code": "workspace_ledger_invalid", "ledger": name, "details": result})
    issues.extend(_index_issues(paths.feedback_index, paths.ledgers, "workspace"))
    tools_identity = _read_json(tools_root / "repo_identity.json")
    bound_hash = tools_identity.get("bound_repo_hash")
    if bound_hash and bound_hash != repo_hash(repo_root):
        issues.append({"code": "tools_repo_hash_mismatch", "expected": repo_hash(repo_root), "actual": bound_hash})
    if version >= 2 and 0 < int(tools_identity.get("aria_tools_contract_version") or 0) < 2:
        issues.append({"code": "workspace_tools_version_mismatch", "workspace_version": version, "tools_version": tools_identity.get("aria_tools_contract_version")})
    return {"index_path": paths.feedback_index.as_posix(), "ledgers": ledgers, "issues": issues}


def _verify_tools(root: Path, repo_root: Path | None) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    ledgers = []
    version = tools_contract_version(root)
    if version < 2:
        issues.append({"code": "tools_migration_required", "version": version})
    identity = _read_json(root / "repo_identity.json")
    if repo_root is not None and identity.get("bound_repo_hash") and identity.get("bound_repo_hash") != repo_hash(repo_root):
        issues.append({"code": "tools_repo_hash_mismatch", "expected": repo_hash(repo_root), "actual": identity.get("bound_repo_hash")})
    for name, path in covered_tool_ledgers(root).items():
        result = verify_jsonl(path)
        result["name"] = name
        ledgers.append(result)
        if result.get("valid") is not True:
            issues.append({"code": "tools_ledger_invalid", "ledger": name, "details": result})
    issues.extend(_index_issues(root / "integrity_index.json", covered_tool_ledgers(root), "tools"))
    return {"index_path": (root / "integrity_index.json").as_posix(), "ledgers": ledgers, "issues": issues}


def _index_issues(index_path: Path, ledgers: dict[str, Path], scope: str) -> list[dict[str, Any]]:
    if not index_path.exists():
        return [{"code": f"{scope}_index_missing", "index_path": index_path.as_posix()}]
    issues = []
    index = load_index(index_path)
    for name, path in ledgers.items():
        expected = index.get("ledger_hashes", {}).get(name)
        actual = file_hash(path)
        if expected != actual:
            issues.append({"code": f"{scope}_index_drift", "ledger": name, "expected": expected, "actual": actual})
    return issues


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = load_index(path)
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}
