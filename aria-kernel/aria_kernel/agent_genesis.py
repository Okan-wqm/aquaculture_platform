from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .capability_gap import latest_capability_gaps
from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


BANNED_PHRASES = (
    "for " + "now",
    "interim " + "solution",
    "tempor" + "ary",
    "good " + "enough",
    "defer" + "red",
    "out " + "of " + "scope",
)
REQUIRED_DRAFT_FIELDS = ("name", "purpose", "scope_globs", "forbidden_globs", "evidence_contract", "output_schema", "validation_fixtures")


def draft_agent_from_gap(
    *,
    gap_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    gap = _find_gap(gap_id, base_dir)
    name = _agent_name(gap)
    draft = {
        "name": name,
        "purpose": gap["title"],
        "scope_globs": _scope_from_evidence(gap.get("evidence_refs", [])),
        "forbidden_globs": ["secrets/**", ".env*", "node_modules/**", "dist/**", "aria-tools/**"],
        "evidence_contract": "Every finding must cite repo paths from scope_globs and include severity.",
        "output_schema": {"required": ["findings", "observations", "evidence_refs"]},
        "validation_fixtures": [
            {"name": "true-positive", "expected": "finding"},
            {"name": "false-positive-guard", "expected": "no_finding"},
            {"name": "scope-violation-guard", "expected": "blocked"},
        ],
        "related_existing_agents": gap.get("related_existing_agents", []),
    }
    _validate_draft(draft)
    content = _render_agent_markdown(draft)
    root = ensure_tools_dir(base_dir)
    draft_path = root / "agent-genesis" / "drafts" / f"{name}.md"
    draft_path.parent.mkdir(parents=True, exist_ok=True)
    draft_path.write_text(content, encoding="utf-8")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "gap_id": gap_id,
        "draft_id": f"draft-{name}",
        "status": "draft_shadow",
        "draft": draft,
        "content": content,
        "draft_path": draft_path.as_posix(),
        "target_path": f".claude/agents/{name}.md",
        "blocked_by": ["operator_approval_required"],
    }
    return append_jsonl(root / "agent-genesis" / "drafts.jsonl", row)


def evaluate_genesis_sandbox(
    *,
    draft_id: str,
    fixture_results: list[dict[str, Any]],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    draft = _find_draft(draft_id, base_dir)
    if len(fixture_results) < 3:
        raise GovernanceError("genesis sandbox requires at least 3 fixture results")
    failed = [result for result in fixture_results if result.get("status") != "pass"]
    duplicate = bool(draft.get("draft", {}).get("related_existing_agents"))
    decision = "duplicate_existing_agent" if duplicate else ("fail" if failed else "pass")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "decision": decision,
        "fixture_results": fixture_results,
        "blocked_by": _sandbox_blockers(decision),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "genesis-sandbox" / "runs.jsonl", row)


def approve_agent_pr(
    *,
    draft_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not operator_approval_ref.strip():
        raise GovernanceError("operator approval ref is required")
    draft = _find_draft(draft_id, base_dir)
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError("agent draft must pass genesis sandbox before PR approval")
    row = dict(draft)
    row["recorded_at"] = utc_now()
    row["status"] = "approved_for_agent_pr"
    row["operator_approval_ref"] = operator_approval_ref
    row["blocked_by"] = []
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "drafts.jsonl", row)


def prepare_agent_pr_lane(
    *,
    draft_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    draft = _find_draft(draft_id, base_dir)
    if draft.get("status") != "approved_for_agent_pr":
        raise GovernanceError("agent draft must be approved_for_agent_pr before PR lane preparation")
    target_path = str(draft.get("target_path") or "")
    name = str(draft.get("draft", {}).get("name") or "")
    sandbox = _latest_sandbox(draft_id, base_dir)
    blockers = []
    if not target_path.startswith(".claude/agents/aria-") or not target_path.endswith(".md"):
        blockers.append("target_path_not_agent_scoped")
    if not name.startswith("aria-"):
        blockers.append("agent_name_not_aria_scoped")
    root = Path(workspace_root).resolve()
    if (root / target_path).exists():
        blockers.append("target_agent_already_exists")
    if draft.get("draft", {}).get("related_existing_agents"):
        blockers.append("related_existing_agent_requires_owner_review")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "draft_id": draft_id,
        "gap_id": draft.get("gap_id"),
        "target_path": target_path,
        "branch": f"aria/agent-genesis/{name}",
        "changed_files": [target_path],
        "sandbox_ref": sandbox.get("ledger_hash") if sandbox else None,
        "operator_approval_ref": draft.get("operator_approval_ref"),
        "status": "ready_for_pr" if not blockers else "blocked",
        "blocked_by": blockers,
        "body_sections": ["Problem", "Evidence", "Solution", "Validation", "Rollback", "Provenance"],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "pr-lanes.jsonl", row)


def list_agent_drafts(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "drafts.jsonl")


def list_genesis_sandbox_runs(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "genesis-sandbox" / "runs.jsonl")


def list_agent_pr_lanes(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "pr-lanes.jsonl")


def _find_gap(gap_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for gap in latest_capability_gaps(base_dir=base_dir):
        if gap.get("gap_id") == gap_id:
            return gap
    raise GovernanceError(f"capability gap not found: {gap_id}")


def _find_draft(draft_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for draft in reversed(list_agent_drafts(base_dir=base_dir)):
        if draft.get("draft_id") == draft_id:
            return draft
    raise GovernanceError(f"agent draft not found: {draft_id}")


def _latest_sandbox(draft_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(list_genesis_sandbox_runs(base_dir=base_dir)):
        if row.get("draft_id") == draft_id:
            return row
    return None


def _agent_name(gap: dict[str, Any]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", str(gap.get("title", "capability-gap")).lower()).strip("-")
    return "aria-" + (base[:48].strip("-") or "capability-gap")


def _scope_from_evidence(evidence_refs: list[str]) -> list[str]:
    scopes = []
    for ref in evidence_refs:
        parts = str(ref).split("/")
        if len(parts) >= 2 and parts[0] in ("apps", "libs"):
            scopes.append(f"{parts[0]}/{parts[1]}/**")
        elif len(parts) >= 3 and parts[0] == "platform":
            scopes.append(f"platform/libs/{parts[2]}/**")
    return sorted(set(scopes)) or ["**/*"]


def _validate_draft(draft: dict[str, Any]) -> None:
    missing = [field for field in REQUIRED_DRAFT_FIELDS if field not in draft]
    if missing:
        raise GovernanceError("agent draft missing fields: " + ", ".join(missing))
    rendered = _render_agent_markdown(draft).lower()
    for phrase in BANNED_PHRASES:
        if phrase in rendered:
            raise GovernanceError(f"agent draft contains banned phrase: {phrase}")
    if not str(draft["name"]).startswith("aria-"):
        raise GovernanceError("generated agent name must start with aria-")
    if len(draft["validation_fixtures"]) < 3:
        raise GovernanceError("agent draft requires at least 3 validation fixtures")


def _render_agent_markdown(draft: dict[str, Any]) -> str:
    scopes = "\n".join(f"- `{scope}`" for scope in draft["scope_globs"])
    forbidden = "\n".join(f"- `{scope}`" for scope in draft["forbidden_globs"])
    fixtures = "\n".join(f"- {item['name']}: {item['expected']}" for item in draft["validation_fixtures"])
    return "\n".join(
        [
            "---",
            f"name: {draft['name']}",
            f"description: {draft['purpose']}",
            "---",
            "",
            "## Purpose",
            str(draft["purpose"]),
            "",
            "## Scope",
            scopes,
            "",
            "## Forbidden Scope",
            forbidden,
            "",
            "## Evidence Contract",
            str(draft["evidence_contract"]),
            "",
            "## Output Schema",
            str(draft["output_schema"]),
            "",
            "## Validation Fixtures",
            fixtures,
            "",
        ],
    )


def _sandbox_blockers(decision: str) -> list[str]:
    if decision == "pass":
        return []
    if decision == "duplicate_existing_agent":
        return ["existing_agent_owner_review_required"]
    return ["sandbox_fixture_failure"]
