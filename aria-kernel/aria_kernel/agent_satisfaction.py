from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .ledger import atomic_write_json, load_jsonl, read_jsonl
from .batch_containment import guard_item, with_item_failures
from .phase2_utils import record_workspace_governance_once, utc_now_iso
from .pressure import append_pressure_state_event, effective_workspace_pressures
from .workspace import WorkspacePaths


def agent_satisfaction_scan(paths: WorkspacePaths, *, cycle_id: str, tools_root: str | Path | None = None) -> dict[str, Any]:
    item_failures: list[dict[str, Any]] = []
    agents, unreadable = _scan_agents(paths.repo_root, item_failures)
    previous = _read_agent_index(paths)
    first_index = not (paths.state_dir / "agent_index.json").exists()
    removals = _removed_agents(previous, agents, unreadable=unreadable) if not first_index else []
    satisfied = _satisfy_pressures(paths, cycle_id, agents, tools_root=tools_root)
    for row in removals:
        # One unrecordable removal must not hide the removals after it: the
        # agent index is rewritten below either way, so a lost row means an
        # agent vanished from the index with nothing in governance saying so.
        guard_item(
            item_failures,
            item_kind="agent_removal",
            item_id=str(row.get("path") or ""),
            work=lambda row=row: record_workspace_governance_once(
                paths,
                "agent_removed",
                {
                    "agent_path": row["path"],
                    "removed_at_cycle": cycle_id,
                    "addressed_pressures": row.get("addresses_pressure", []),
                },
            ),
        )
    # ARIA-LOW-480 — an agent whose file still exists but could not be read this
    # cycle keeps its previous index row: dropping it would make the index
    # claim a removal the governance ledger (rightly) never recorded.
    indexed = sorted(
        [*agents, *(row for row in previous if str(row.get("path")) in unreadable)],
        key=lambda row: str(row.get("path")),
    )
    _write_agent_index(paths, indexed)
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "indexed_count": len(indexed),
        "removed_count": len(removals),
        "satisfied_count": len(satisfied),
        "first_index": first_index,
    }, item_failures)


def _scan_one_agent(path: Path, rel: str) -> dict[str, Any]:
    content = path.read_text(encoding="utf-8")
    return {
        "path": rel,
        "addresses_pressure": _parse_addresses_pressure(content),
        "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "indexed_at": utc_now_iso(),
    }


def _scan_agents(
    repo_root: Path, item_failures: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], set[str]]:
    """Index rows of the readable agents, and the rel paths that failed.

    One unreadable or malformed agent file (e.g. unclosed frontmatter) costs
    its own row, named in ``item_failures``, never the whole hook. The
    failed paths are returned because the file still EXISTS: callers must
    not read its absence from the rows as a removal.
    """
    candidates: list[Path] = []
    for pattern in (".claude/agents/*.md", ".claude/agents/product-audit/*.md", "agents/aria-*.md"):
        candidates.extend(sorted(repo_root.glob(pattern)))
    rows: list[dict[str, Any]] = []
    unreadable: set[str] = set()
    for path in sorted({item.resolve() for item in candidates if item.is_file()}):
        rel = path.relative_to(repo_root.resolve()).as_posix()
        ok, row = guard_item(
            item_failures,
            item_kind="agent_scan",
            item_id=rel,
            work=lambda path=path, rel=rel: _scan_one_agent(path, rel),
        )
        if ok:
            rows.append(row)
        else:
            unreadable.add(rel)
    return rows, unreadable


def _parse_addresses_pressure(content: str) -> list[str]:
    if not content.startswith("---\n"):
        return []
    end = content.find("\n---", 4)
    if end == -1:
        raise ValueError("agent_frontmatter_unclosed")
    frontmatter = content[4:end].splitlines()
    values: list[str] = []
    index = 0
    while index < len(frontmatter):
        line = frontmatter[index]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        if stripped.startswith("addresses_pressure:"):
            raw = stripped.split(":", 1)[1].strip()
            if raw.startswith("[") and raw.endswith("]"):
                values.extend(item.strip().strip("\"'") for item in raw[1:-1].split(",") if item.strip())
                index += 1
                continue
            if raw:
                values.append(raw.strip("\"'"))
                index += 1
                continue
            index += 1
            while index < len(frontmatter):
                item = frontmatter[index].strip()
                if not item:
                    index += 1
                    continue
                if not item.startswith("- "):
                    break
                values.append(item[2:].strip().strip("\"'"))
                index += 1
            continue
        index += 1
    invalid = [value for value in values if not value.startswith("PE-")]
    if invalid:
        raise ValueError("agent_frontmatter_invalid_pressure_id")
    return sorted(dict.fromkeys(values))


def _satisfy_pressures(
    paths: WorkspacePaths,
    cycle_id: str,
    agents: list[dict[str, Any]],
    *,
    tools_root: str | Path | None,
) -> list[dict[str, Any]]:
    pressures = {str(row.get("event_id") or row.get("pressure_id")): row for row in effective_workspace_pressures(paths)}
    address_events = _address_events(paths)
    genesis_paths = _genesis_agent_paths(Path(tools_root)) if tools_root is not None else set()
    satisfied: list[dict[str, Any]] = []
    for agent in agents:
        agent_path = str(agent["path"])
        for pressure_id in agent.get("addresses_pressure", []):
            pressure = pressures.get(pressure_id)
            if not pressure or pressure.get("effective_state") in {"closed", "satisfied"}:
                continue
            evidence = _agent_evidence(agent_path, pressure_id, address_events, genesis_paths)
            if evidence is None:
                continue
            state = append_pressure_state_event(
                paths,
                pressure=pressure,
                to_state="satisfied",
                reason="skill_satisfaction_evidence",
                cycle_id=cycle_id,
                evidence_refs=[evidence["evidence_ref"]],
                feedback_event_ids=[],
                details={
                    "pressure_event_id": pressure_id,
                    "agent_path": agent_path,
                    "evidence_kind": evidence["evidence_kind"],
                    "evidence_ref": evidence["evidence_ref"],
                },
            )
            record_workspace_governance_once(
                paths,
                "pressure_satisfied_by_skill",
                {
                    "pressure_event_id": pressure_id,
                    "agent_path": agent_path,
                    "evidence_kind": evidence["evidence_kind"],
                    "evidence_ref": evidence["evidence_ref"],
                },
            )
            satisfied.append(state)
    return satisfied


def _agent_evidence(
    agent_path: str,
    pressure_id: str,
    address_events: list[dict[str, Any]],
    genesis_paths: set[str],
) -> dict[str, str] | None:
    if agent_path in genesis_paths:
        return {"evidence_kind": "agent_genesis", "evidence_ref": f"agent:{agent_path}"}
    for event in address_events:
        details = event.get("details", {})
        if details.get("pressure_event_id") != pressure_id:
            continue
        if agent_path not in details.get("changed_files", []):
            continue
        return {"evidence_kind": "commit_trailer_addressed", "evidence_ref": f"git:commit:{details.get('commit_sha')}"}
    return None


def _address_events(paths: WorkspacePaths) -> list[dict[str, Any]]:
    return [row for row in read_jsonl(paths.ledgers["governance"]) if row.get("kind") == "pressure_addresses_recorded"]


def _genesis_agent_paths(tools_root: Path) -> set[str]:
    rows = load_jsonl(tools_root / "agent-genesis" / "pr-lanes.jsonl")
    return {
        str(row.get("target_path"))
        for row in rows
        if row.get("status") == "ready_for_pr" and isinstance(row.get("target_path"), str)
    }


def _read_agent_index(paths: WorkspacePaths) -> list[dict[str, Any]]:
    path = paths.state_dir / "agent_index.json"
    if not path.exists():
        return []
    payload = path.read_text(encoding="utf-8")
    import json

    data = json.loads(payload)
    agents = data.get("agents", [])
    return agents if isinstance(agents, list) else []


def _write_agent_index(paths: WorkspacePaths, agents: list[dict[str, Any]]) -> None:
    atomic_write_json(
        paths.state_dir / "agent_index.json",
        {"schema_version": 1, "indexed_at": utc_now_iso(), "agents": agents},
    )


def _removed_agents(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    *,
    unreadable: set[str],
) -> list[dict[str, Any]]:
    present = {str(row.get("path")) for row in current} | unreadable
    return [row for row in previous if str(row.get("path")) not in present]
