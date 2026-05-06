from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FIXTURE_RE = re.compile(r"^##\s+Fixture:\s*(.+)$", re.MULTILINE)
MIN_FIXTURES = 3


def request_skill_genesis(
    *,
    capability_gap_key: str,
    title: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not capability_gap_key.strip() or not title.strip():
        raise GovernanceError("capability_gap_key and title are required")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "request_id": _id("skill-request", capability_gap_key),
        "capability_gap_key": capability_gap_key,
        "title": title,
        "status": "requested",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "requests.jsonl", row)


def draft_skill(
    *,
    request_id: str,
    name: str,
    description: str,
    owners: list[str],
    handoff_agents: list[str],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not re.match(r"^[a-z][a-z0-9-]{1,80}$", name or ""):
        raise GovernanceError("skill name is invalid")
    if not owners or not handoff_agents:
        raise GovernanceError("skill draft requires owners and handoff agents")
    content = _render_skill(name=name, description=description, owners=owners, handoff_agents=handoff_agents)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": f"skill-draft-{name}",
        "request_id": request_id,
        "name": name,
        "target_path": f".claude/skills/{name}.md",
        "content": content,
        "status": "draft_shadow",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "drafts.jsonl", row)


def parse_fixture_blocks(markdown: str) -> list[dict[str, Any]]:
    """Extract `## Fixture: <id>` headers as structured pass-results.

    L1-safe: regex over Markdown structural markers only — no instruction
    execution, no body parsing.
    """
    ids = [match.group(1).strip() for match in FIXTURE_RE.finditer(markdown)]
    return [{"fixture_id": fid, "status": "pass"} for fid in ids if fid]


def sandbox_skill(
    *,
    draft_id: str,
    checklist_results: list[dict[str, Any]] | None = None,
    markdown_path: str | Path | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Validate a skill draft against fixture coverage.

    Two input modes (mutually exclusive):
    - markdown_path: parse `## Fixture: <id>` blocks from skill markdown content (preferred).
    - checklist_results: explicit JSON array — kept for backward compat (deprecated).

    Both paths require at least MIN_FIXTURES (3) entries; failure entries flip
    decision to "fail" without bypassing the minimum-count guard.
    """
    if markdown_path is not None and checklist_results is not None:
        raise GovernanceError("provide either markdown_path or checklist_results, not both")
    if markdown_path is not None:
        path = Path(markdown_path)
        if not path.exists():
            raise GovernanceError(f"markdown_path not found: {markdown_path}")
        checklist_results = parse_fixture_blocks(path.read_text(encoding="utf-8"))
    if checklist_results is None:
        raise GovernanceError("skill sandbox requires markdown_path or checklist_results")
    if len(checklist_results) < MIN_FIXTURES:
        raise GovernanceError(
            f"skill sandbox requires at least {MIN_FIXTURES} fixture entries (## Fixture: <id> blocks or checklist results)"
        )
    failed = [row for row in checklist_results if row.get("status") != "pass"]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "decision": "fail" if failed else "pass",
        "checklist_results": checklist_results,
        "source": "markdown" if markdown_path is not None else "checklist_json",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "sandbox.jsonl", row)


def materialize_skill(
    *,
    draft_id: str,
    assignment_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    acknowledge: bool = False,
    run_invariants: bool = False,
) -> dict[str, Any]:
    if not acknowledge:
        raise GovernanceError("materialize_skill_requires_acknowledge")
    draft = _find_draft(draft_id, base_dir)
    dispatch = _find_dispatch(assignment_id, base_dir)
    worktree = Path(str(dispatch.get("worktree_path") or ""))
    if not worktree.is_absolute():
        worktree = Path(workspace_root).resolve() / worktree
    if not worktree.exists():
        raise GovernanceError("dispatch_worktree_missing")
    target_path = str(draft.get("target_path") or "")
    if not target_path.startswith(".claude/skills/") or not target_path.endswith(".md"):
        raise GovernanceError("target_path_not_skill_scoped")
    target = worktree / target_path
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(str(draft.get("content") or ""), encoding="utf-8")
    tmp.replace(target)
    status = "accepted"
    validation = None
    if run_invariants:
        completed = subprocess.run(["npm", "run", "invariants:full"], cwd=worktree, text=True, capture_output=True, check=False)
        validation = {"returncode": completed.returncode, "stdout": completed.stdout[-4000:], "stderr": completed.stderr[-4000:]}
        if completed.returncode != 0:
            subprocess.run(["git", "restore", "--", target_path], cwd=worktree, text=True, capture_output=True, check=False)
            status = "rejected"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "assignment_id": assignment_id,
        "worktree_path": worktree.as_posix(),
        "target_path": target_path,
        "status": status,
        "validation": validation,
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "materializations.jsonl", row)


def list_skill_genesis(*, base_dir: str | Path | None = None, kind: str = "drafts") -> list[dict[str, Any]]:
    filename = {
        "requests": "requests.jsonl",
        "drafts": "drafts.jsonl",
        "sandbox": "sandbox.jsonl",
        "materializations": "materializations.jsonl",
    }.get(kind, "drafts.jsonl")
    return load_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / filename)


def _render_skill(*, name: str, description: str, owners: list[str], handoff_agents: list[str]) -> str:
    return "\n".join(
        [
            "---",
            f"name: {name}",
            f"description: {description}",
            "type: skill",
            "version: 0.1.0",
            f"owners: [{', '.join(owners)}]",
            "handoff:",
            f"  on_complete_invoke: [{', '.join(handoff_agents)}]",
            "---",
            "",
            "## Validation checklist",
            "- true-positive fixture passes",
            "- false-positive guard passes",
            "- handoff resolves",
            "",
        ],
    )


def _find_draft(draft_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(list_skill_genesis(base_dir=base_dir, kind="drafts")):
        if row.get("draft_id") == draft_id:
            return row
    raise GovernanceError(f"skill draft not found: {draft_id}")


def _find_dispatch(assignment_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "dispatch" / "requests.jsonl")):
        if row.get("assignment_id") == assignment_id:
            return row
    raise GovernanceError(f"dispatch request not found: {assignment_id}")


def _id(prefix: str, value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:48] or "skill"
    return f"{prefix}-{slug}"
