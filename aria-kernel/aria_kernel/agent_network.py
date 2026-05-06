from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .agent_priors import _parse_agent  # reuse the local parser; this remains an internal ARIA module boundary.
from .fitness import latest_agent_fitness
from .tool_registry import ensure_tools_dir, utc_now


def agent_network_index(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    repo = Path(workspace_root).resolve()
    root = ensure_tools_dir(base_dir).resolve()
    network_dir = root / "agent-network"
    manifest_path = network_dir / "source-manifest.json"
    index_path = network_dir / "index.json"
    previous = _read_json(manifest_path)
    manifest = _source_manifest(repo, root, previous)
    source_hashes = _source_hashes(manifest)
    if index_path.exists() and previous.get("source_hashes") == source_hashes:
        cached = _read_json(index_path)
        if cached:
            cached["status"] = "cached"
            return cached
    agents = _agents(repo)
    fitness = latest_agent_fitness(base_dir=root)
    fitness_by_agent = {row.get("agent_name"): row for row in fitness}
    maintenance = [agent for agent in agents if agent["path"].startswith(".claude/agents/_maintenance/")]
    legacy = _legacy_agents(repo)
    dispatchable = [
        agent["name"]
        for agent in agents
        if not agent["path"].startswith(".claude/agents/_maintenance/")
    ]
    payload = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "source_hashes": source_hashes,
        "agents": agents,
        "routes": _routing_files(repo),
        "skills": _skill_files(repo),
        "maintenance_agents": [agent["name"] for agent in maintenance],
        "legacy_agents": legacy,
        "dispatchable_agents": sorted(dispatchable),
        "fitness_snapshot": fitness_by_agent,
    }
    payload["index_hash"] = _hash_payload(payload)
    network_dir.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest["source_hashes"] = source_hashes
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    payload["status"] = "rebuilt"
    return payload


def latest_agent_network_hash(*, base_dir: str | Path | None = None) -> str | None:
    path = ensure_tools_dir(base_dir).resolve() / "agent-network" / "index.json"
    if not path.exists():
        return None
    return _read_json(path).get("index_hash")


def _agents(repo: Path) -> list[dict[str, Any]]:
    agents_root = repo / ".claude" / "agents"
    agents = []
    for path in sorted(agents_root.rglob("*.md")) if agents_root.exists() else []:
        if path.name in {"README.md", "INVOCATION-PACK.md"}:
            continue
        parsed = _parse_agent(path, repo)
        if parsed:
            agents.append(parsed)
    return agents


def _legacy_agents(repo: Path) -> list[str]:
    legacy_root = repo / ".claude" / "agents.legacy"
    return sorted(path.relative_to(repo).as_posix() for path in legacy_root.rglob("*.md")) if legacy_root.exists() else []


def _routing_files(repo: Path) -> list[str]:
    shared = repo / ".claude" / "shared"
    return sorted(path.relative_to(repo).as_posix() for path in shared.glob("*routing*.md")) if shared.exists() else []


def _skill_files(repo: Path) -> list[str]:
    skills = repo / ".claude" / "skills"
    return sorted(path.relative_to(repo).as_posix() for path in skills.glob("*.md")) if skills.exists() else []


def _source_manifest(repo: Path, tools_root: Path, previous: dict[str, Any]) -> dict[str, Any]:
    previous_files = previous.get("files", {}) if isinstance(previous.get("files"), dict) else {}
    files: dict[str, dict[str, Any]] = {}
    candidates = []
    for pattern in (".claude/agents/**/*.md", ".claude/shared/*routing*.md", ".claude/skills/*.md"):
        candidates.extend(repo.glob(pattern))
    fitness = tools_root / "fitness" / "agent-fitness.jsonl"
    if fitness.exists():
        candidates.append(fitness)
    for path in sorted({candidate.resolve() for candidate in candidates if candidate.is_file()}):
        rel = path.relative_to(repo).as_posix() if _is_relative_to(path, repo) else path.relative_to(tools_root).as_posix()
        stat = path.stat()
        prior = previous_files.get(rel, {})
        if prior.get("size") == stat.st_size and prior.get("mtime_ns") == stat.st_mtime_ns and prior.get("sha256"):
            digest = prior["sha256"]
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        files[rel] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": digest}
    return {"schema_version": 1, "files": files}


def _source_hashes(manifest: dict[str, Any]) -> dict[str, str]:
    buckets = {"agents": [], "routing": [], "skills": [], "fitness": []}
    for rel, item in sorted(manifest.get("files", {}).items()):
        raw = f"{rel}:{item.get('sha256')}"
        if rel.startswith(".claude/agents/"):
            buckets["agents"].append(raw)
        elif rel.startswith(".claude/shared/"):
            buckets["routing"].append(raw)
        elif rel.startswith(".claude/skills/"):
            buckets["skills"].append(raw)
        elif rel.startswith("fitness/"):
            buckets["fitness"].append(raw)
    return {key: "sha256:" + hashlib.sha256("\n".join(values).encode("utf-8")).hexdigest() for key, values in buckets.items()}


def _hash_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False
