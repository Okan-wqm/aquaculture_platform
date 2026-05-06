from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, file_hash, write_index
from .workspace import governance_event, repo_hash


SCHEMA_VERSION = 2
TOOL_STATUSES = (
    "DRAFT",
    "SANDBOX",
    "SHADOW",
    "ACTIVE",
    "CALIBRATE",
    "QUARANTINED",
    "ARCHIVED",
)
TOOL_KINDS = ("adapter", "skill", "llm_amplified_skill")
RUNNER_REQUIRED_STATUSES = ("SANDBOX", "SHADOW", "ACTIVE", "CALIBRATE")
RUNNER_TYPES = ("subprocess",)
REQUIRED_TOOL_FIELDS = (
    "tool_id",
    "kind",
    "version",
    "status",
    "declared_scope",
    "output_schema",
    "fixture_set",
    "health_thresholds",
    "allowed_read_globs",
    "forbidden_read_globs",
    "claim_types",
    "owner",
    "schema_version",
)

DEFAULT_HEALTH_THRESHOLDS = {
    "precision_min": 0.85,
    "non_critical_false_positives_30d": 3,
    "critical_false_positives": 0,
    "crash_rate_last_10": 0.2,
}


class GovernanceError(ValueError):
    """Raised when a tool governance rule rejects an operation."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def tools_dir(path: str | os.PathLike[str] | None = None) -> Path:
    return Path(path or os.environ.get("ARIA_TOOLS_DIR", "aria-tools"))


def registry_path(base_dir: str | os.PathLike[str] | None = None) -> Path:
    return tools_dir(base_dir) / "registry.json"


def ensure_tools_dir(base_dir: str | os.PathLike[str] | None = None) -> Path:
    root = tools_dir(base_dir)
    root.mkdir(parents=True, exist_ok=True)
    _guard_tools_lock(root)
    identity_file = root / "repo_identity.json"
    if not identity_file.exists():
        if _tools_has_covered_state(root):
            raise GovernanceError("ambiguous_tools_root")
        identity = {
            "aria_tools_contract_version": 2,
            "bound_repo_hash": None,
            "bound_repo_root": None,
            "schema_version": 2,
        }
        _prepare_tools_dirs(root)
        _atomic_write_json(identity_file, identity)
        append_tools_governance(
            root,
            "tools_root_bootstrapped",
            {"tools_dir": root.as_posix(), "schema_version": 2, "bound_repo_hash": None},
        )
    _prepare_tools_dirs(root)
    update_tools_index(root)
    return root


def ensure_tools_binding(
    base_dir: str | os.PathLike[str] | None = None,
    *,
    workspace_root: str | os.PathLike[str] | None = None,
) -> Path:
    root = ensure_tools_dir(base_dir)
    if workspace_root is None:
        return root
    repo_root = Path(workspace_root).resolve()
    identity_file = root / "repo_identity.json"
    identity = json.loads(identity_file.read_text(encoding="utf-8"))
    expected_hash = repo_hash(repo_root)
    if identity.get("bound_repo_hash") in (None, ""):
        identity["bound_repo_hash"] = expected_hash
        identity["bound_repo_root"] = str(repo_root)
        identity["aria_tools_contract_version"] = 2
        identity["schema_version"] = 2
        _atomic_write_json(identity_file, identity)
        append_tools_governance(root, "tools_root_bound", {"bound_repo_hash": expected_hash, "bound_repo_root": str(repo_root)})
    return root


def tools_contract_version(base_dir: str | os.PathLike[str] | None = None) -> int:
    identity_file = tools_dir(base_dir) / "repo_identity.json"
    if not identity_file.exists():
        return 0
    try:
        identity = json.loads(identity_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return int(identity.get("aria_tools_contract_version") or identity.get("schema_version") or 1)


def require_tools_v2(base_dir: str | os.PathLike[str] | None = None) -> None:
    if tools_contract_version(base_dir) < 2:
        raise GovernanceError("tools_migration_required")


def covered_tool_ledgers(root: Path) -> dict[str, Path]:
    ledgers = {
        "runs": root / "runs.jsonl",
        "health": root / "health.jsonl",
        "cycles": root / "cycles.jsonl",
        "governance": root / "governance.jsonl",
    }
    optional = {
        "problem_clusters": root / "problem_clusters.jsonl",
        "triage_decisions": root / "triage" / "decisions.jsonl",
        "dispatch_requests": root / "dispatch" / "requests.jsonl",
        "worker_results": root / "dispatch" / "worker-results.jsonl",
        "verification_results": root / "dispatch" / "verification-results.jsonl",
        "agent_fitness": root / "fitness" / "agent-fitness.jsonl",
    }
    for name, path in optional.items():
        if path.exists():
            ledgers[name] = path
    return ledgers


def update_tools_index(root: Path) -> None:
    index: dict[str, Any] = {}
    file_hashes: dict[str, str] = {}
    state_path = root / "migration_state.json"
    if state_path.exists():
        file_hashes["migration_state"] = file_hash(state_path)
    since_path = root / "since_migration_events.jsonl"
    if since_path.exists():
        file_hashes["since_migration_events.jsonl"] = file_hash(since_path)
    if file_hashes:
        index["file_hashes"] = file_hashes
    write_index(root / "integrity_index.json", index, covered_tool_ledgers(root))


def append_tools_governance(
    base_dir: str | os.PathLike[str] | Path,
    kind: str,
    details: dict[str, Any],
) -> dict[str, Any]:
    root = Path(base_dir)
    root.mkdir(parents=True, exist_ok=True)
    row = append_jsonl(root / "governance.jsonl", governance_event(kind=kind, details=details))
    update_tools_index(root)
    return row


def _prepare_tools_dirs(root: Path) -> None:
    (root / "fixtures").mkdir(parents=True, exist_ok=True)
    for path in covered_tool_ledgers(root).values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)


def _tools_has_covered_state(root: Path) -> bool:
    if (root / "integrity_index.json").exists():
        return True
    return any(path.exists() and path.stat().st_size > 0 for path in covered_tool_ledgers(root).values())


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _guard_tools_lock(root: Path) -> None:
    lock_path = root / "tools.lock"
    if not lock_path.exists():
        return
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8") or "{}")
        started = datetime.fromisoformat(str(payload.get("started_at", "")).replace("Z", "+00:00"))
    except (OSError, ValueError, json.JSONDecodeError):
        started = datetime.fromtimestamp(0, timezone.utc)
        payload = {}
    age = (datetime.now(timezone.utc) - started.astimezone(timezone.utc)).total_seconds()
    pid = int(payload.get("pid") or 0)
    if age >= 120 and (pid <= 0 or not _pid_exists(pid)):
        try:
            lock_path.unlink()
            append_tools_governance(
                root,
                "lock_reaped",
                {"stale_lock_pid": pid, "lock_age_seconds": int(age), "reaped_by_pid": os.getpid()},
            )
            return
        except FileNotFoundError:
            return
    raise GovernanceError("tools_root_locked")


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def load_registry(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    path = registry_path(base_dir)
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "tools": []}
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("tools"), list):
        raise GovernanceError(f"{path} must contain an object with a tools array")
    return data


def save_registry(
    registry: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> None:
    ensure_tools_dir(base_dir)
    path = registry_path(base_dir)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(registry, handle, indent=2, sort_keys=True)
        handle.write("\n")


def validate_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(tool, dict):
        raise GovernanceError("tool definition must be a JSON object")
    missing = [field for field in REQUIRED_TOOL_FIELDS if field not in tool]
    if missing:
        raise GovernanceError(f"tool definition missing required field(s): {', '.join(missing)}")

    candidate = deepcopy(tool)
    _require_string(candidate, "tool_id")
    _require_string(candidate, "version")
    _require_string(candidate, "owner")

    if candidate["kind"] not in TOOL_KINDS:
        raise GovernanceError(f"unknown tool kind: {candidate['kind']}")
    if candidate["status"] not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {candidate['status']}")
    if not candidate["declared_scope"]:
        raise GovernanceError("declared_scope must not be empty")
    if not isinstance(candidate["output_schema"], dict) or not candidate["output_schema"]:
        raise GovernanceError("output_schema must be a non-empty object")
    _validate_output_schema(candidate["output_schema"])
    if not candidate["fixture_set"]:
        raise GovernanceError("fixture_set must not be empty")
    if not isinstance(candidate["health_thresholds"], dict):
        raise GovernanceError("health_thresholds must be an object")
    if not isinstance(candidate["allowed_read_globs"], list) or not candidate["allowed_read_globs"]:
        raise GovernanceError("allowed_read_globs must be a non-empty array")
    if not isinstance(candidate["forbidden_read_globs"], list):
        raise GovernanceError("forbidden_read_globs must be an array")
    if not isinstance(candidate["claim_types"], list) or not candidate["claim_types"]:
        raise GovernanceError("claim_types must be a non-empty array")
    if "default_input" in candidate and not isinstance(candidate["default_input"], dict):
        raise GovernanceError("default_input must be a JSON object when provided")

    thresholds = dict(DEFAULT_HEALTH_THRESHOLDS)
    thresholds.update(candidate["health_thresholds"])
    candidate["health_thresholds"] = thresholds
    if candidate["status"] in RUNNER_REQUIRED_STATUSES and "runner" not in candidate:
        raise GovernanceError(f"{candidate['status']} tool requires runner configuration")
    if "runner" in candidate:
        candidate["runner"] = validate_runner_definition(candidate["runner"])
    candidate.setdefault("created_at", utc_now())
    candidate["updated_at"] = utc_now()
    return candidate


def validate_runner_definition(runner: Any) -> dict[str, Any]:
    if not isinstance(runner, dict):
        raise GovernanceError("runner must be a JSON object")
    candidate = deepcopy(runner)
    if candidate.get("type") not in RUNNER_TYPES:
        raise GovernanceError(f"unknown runner type: {candidate.get('type')}")
    argv = candidate.get("argv")
    if not isinstance(argv, list) or not argv:
        raise GovernanceError("runner.argv must be a non-empty array")
    if not all(isinstance(part, str) and part.strip() for part in argv):
        raise GovernanceError("runner.argv must contain only non-empty strings")
    if len(argv) >= 2 and argv[0] == "npx" and argv[1] == "ts-node":
        candidate["argv"] = ["node", "./node_modules/ts-node/dist/bin.js", *argv[2:]]
    cwd = candidate.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        raise GovernanceError("runner.cwd must be a non-empty string")
    cwd_path = Path(cwd)
    if cwd_path.is_absolute() or ".." in cwd_path.parts:
        raise GovernanceError("runner.cwd must be relative to the workspace root and must not escape it")
    timeout_ms = candidate.get("timeout_ms")
    if not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GovernanceError("runner.timeout_ms must be a positive integer")
    if not isinstance(candidate.get("stdin_json"), bool):
        raise GovernanceError("runner.stdin_json must be a boolean")
    return candidate


def register_tool(
    tool: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    candidate = validate_tool_definition(tool)
    registry = load_registry(base_dir)
    existing = [t for t in registry["tools"] if t.get("tool_id") == candidate["tool_id"]]
    if existing:
        registry["tools"] = [
            candidate if t.get("tool_id") == candidate["tool_id"] else t for t in registry["tools"]
        ]
    else:
        registry["tools"].append(candidate)
    registry["schema_version"] = SCHEMA_VERSION
    save_registry(registry, base_dir)
    return candidate


def get_tool(
    tool_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    for tool in load_registry(base_dir)["tools"]:
        if tool.get("tool_id") == tool_id:
            return deepcopy(tool)
    raise GovernanceError(f"tool not found: {tool_id}")


def list_tools(
    status: str | None = None,
    base_dir: str | os.PathLike[str] | None = None,
) -> list[dict[str, Any]]:
    if status is not None and status not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {status}")
    tools = load_registry(base_dir)["tools"]
    if status is not None:
        tools = [tool for tool in tools if tool.get("status") == status]
    return deepcopy(tools)


def update_tool(
    tool_id: str,
    updates: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    registry = load_registry(base_dir)
    updated: dict[str, Any] | None = None
    next_tools = []
    for tool in registry["tools"]:
        if tool.get("tool_id") == tool_id:
            merged = dict(tool)
            merged.update(updates)
            merged["updated_at"] = utc_now()
            updated = merged
            next_tools.append(merged)
        else:
            next_tools.append(tool)
    if updated is None:
        raise GovernanceError(f"tool not found: {tool_id}")
    registry["tools"] = next_tools
    save_registry(registry, base_dir)
    return deepcopy(updated)


def transition_tool(
    tool_id: str,
    target_status: str,
    *,
    reason: str,
    base_dir: str | os.PathLike[str] | None = None,
    root_cause_note: str | None = None,
    fixture_update_ref: str | None = None,
    fixture_suite_passed: bool = False,
    operator_approval: bool = False,
    precision: float | None = None,
    critical_false_positives: int = 0,
    evidence_chains_valid: bool = False,
) -> dict[str, Any]:
    if target_status not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {target_status}")
    if not reason:
        raise GovernanceError("transition reason is required")

    tool = get_tool(tool_id, base_dir)
    if target_status in RUNNER_REQUIRED_STATUSES and "runner" not in tool:
        raise GovernanceError(f"{target_status} tool requires runner configuration")
    current = tool["status"]
    if current == "QUARANTINED" and target_status == "CALIBRATE":
        if not root_cause_note or not fixture_update_ref:
            raise GovernanceError(
                "QUARANTINED -> CALIBRATE requires root_cause_note and fixture_update_ref",
            )
    if current == "CALIBRATE" and target_status == "SHADOW" and not fixture_suite_passed:
        raise GovernanceError("CALIBRATE -> SHADOW requires fixture_suite_passed")
    if target_status == "ACTIVE":
        threshold = float(tool["health_thresholds"].get("precision_min", 0.85))
        if current == "CALIBRATE":
            raise GovernanceError("CALIBRATE tools must pass through SHADOW before ACTIVE")
        if current == "SHADOW":
            if precision is None or precision < threshold:
                raise GovernanceError("SHADOW -> ACTIVE requires precision above threshold")
            if critical_false_positives > 0:
                raise GovernanceError("SHADOW -> ACTIVE requires zero critical false positives")
            if not evidence_chains_valid or not operator_approval:
                raise GovernanceError(
                    "SHADOW -> ACTIVE requires valid evidence chains and operator approval",
                )

    return update_tool(
        tool_id,
        {
            "status": target_status,
            "last_transition": {
                "at": utc_now(),
                "from": current,
                "to": target_status,
                "reason": reason,
            },
        },
        base_dir,
    )


def _require_string(tool: dict[str, Any], field: str) -> None:
    if not isinstance(tool.get(field), str) or not tool[field].strip():
        raise GovernanceError(f"{field} must be a non-empty string")


def _validate_output_schema(schema: dict[str, Any]) -> None:
    required = schema.get("required")
    if required is not None and (
        not isinstance(required, list)
        or not all(isinstance(field, str) and field.strip() for field in required)
    ):
        raise GovernanceError("output_schema.required must be an array of non-empty strings")
