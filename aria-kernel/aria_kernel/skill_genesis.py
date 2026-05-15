from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .draft_intent import (
    BANNED_PHRASES_DEFAULT,
    AcceptanceTest,
    SkillDraftIntent,
)
from .draft_pii_filter import mask_pii_in_intent
from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


# Plan ARIA-V3 §A3 — skill grammar contract (required sections in
# the rendered body). Locked by I-V3-07b. Adding a section requires
# matching draft_validator update + I-V3-07b parametrization.
_SKILL_REQUIRED_SECTIONS: tuple[str, ...] = (
    "Validation checklist",
)


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
    """Plan 026R §E.3 — skill genesis chain: draft requires request.

    Pre-§E.3 a draft_skill call accepted any request_id string — no
    check that a matching skill-genesis request row existed. Genesis
    chain integrity demands every draft trace to a real request;
    silent acceptance lets a skill enter the pipeline with no
    audit-trail anchor.
    """
    request = _find_request(request_id, base_dir)
    if request is None:
        raise GovernanceError(
            f"skill_draft_request_not_found: request_id={request_id!r}"
        )
    if not re.match(r"^[a-z][a-z0-9-]{1,80}$", name or ""):
        raise GovernanceError("skill name is invalid")
    if not owners or not handoff_agents:
        raise GovernanceError("skill draft requires owners and handoff agents")
    # Plan ARIA-V3 §A3 — kernel emits the SkillDraftIntent (grammar),
    # not the rendered markdown. Body synthesis is delegated to the
    # drafter via worker_executor.py. ``draft.body`` is populated
    # after a passing drafter run + grammar validation.
    intent = _render_skill(
        name=name,
        description=description,
        owners=owners,
        handoff_agents=handoff_agents,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": f"skill-draft-{name}",
        "request_id": request_id,
        "name": name,
        "target_path": intent.target_path,
        "intent": intent.to_dict(),
        "body": None,
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

    Plan 026R §E.3 — chain: sandbox requires a matching draft row.

    Two input modes (mutually exclusive):
    - markdown_path: parse `## Fixture: <id>` blocks from skill markdown content (preferred).
    - checklist_results: explicit JSON array — kept for backward compat (deprecated).

    Both paths require at least MIN_FIXTURES (3) entries; failure entries flip
    decision to "fail" without bypassing the minimum-count guard.
    """
    # Plan 026R §E.3 — chain enforcement.
    if _find_draft(draft_id, base_dir) is None:
        raise GovernanceError(
            f"skill_sandbox_draft_not_found: draft_id={draft_id!r}"
        )
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
    if draft is None:
        raise GovernanceError(
            f"skill_materialize_draft_not_found: draft_id={draft_id!r}"
        )
    # Plan 026R §E.3 — chain: materialise requires a passing sandbox.
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError(
            f"skill_materialize_requires_passing_sandbox: "
            f"draft_id={draft_id!r} sandbox={sandbox}"
        )
    dispatch = _find_dispatch(assignment_id, base_dir)
    worktree = Path(str(dispatch.get("worktree_path") or ""))
    if not worktree.is_absolute():
        worktree = Path(workspace_root).resolve() / worktree
    if not worktree.exists():
        raise GovernanceError("dispatch_worktree_missing")
    target_path = str(draft.get("target_path") or "")
    if not target_path.startswith(".claude/skills/") or not target_path.endswith(".md"):
        raise GovernanceError("target_path_not_skill_scoped")
    # Plan ARIA-V3 §A3 — body comes from the drafter; kernel does
    # not synthesise markdown. Materialize refuses fail-closed when
    # the drafter has not produced a validated body yet.
    body = draft.get("body")
    if not isinstance(body, str) or not body.strip():
        raise GovernanceError(
            f"skill_materialize_requires_drafter_body: draft_id={draft_id!r} "
            f"has no validated body yet (drafter run pending or failed)"
        )
    target = worktree / target_path
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(body, encoding="utf-8")
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


def _render_skill(
    *,
    name: str,
    description: str,
    owners: list[str],
    handoff_agents: list[str],
) -> SkillDraftIntent:
    """Plan ARIA-V3 §A3 + I-V3-12b — return the grammar, not the body.

    The skill body (markdown including `## Fixture: <id>` blocks the
    sandbox parses) is synthesised by ``worker_executor.py`` drafter
    mode and validated against this intent via
    ``draft_validator.validate_body_against_intent`` before
    materialisation. PII masking applied before the intent reaches
    Claude (AUDITTRAIL-HIGH-008).
    """
    intent = SkillDraftIntent(
        intent_kind="skill",
        intent_id=f"intent-skill-{name}",
        name=name,
        target_path=f".claude/skills/{name}.md",
        description=description,
        required_sections=_SKILL_REQUIRED_SECTIONS,
        owners=tuple(owners),
        handoff_agents=tuple(handoff_agents),
        shadow_period_days=14,
        precision_threshold=0.85,
        acceptance_tests=(
            AcceptanceTest(
                name="true-positive",
                expected="finding_emitted",
                description="canonical true-positive fixture",
            ),
            AcceptanceTest(
                name="false-positive-guard",
                expected="no_finding",
                description="false-positive suppression test",
            ),
            AcceptanceTest(
                name="handoff-resolves",
                expected="handoff_dispatch_recorded",
                description="post-emit handoff to declared agents",
            ),
        ),
        evidence_allowlist=tuple(),
        diff_classifier_lane="L3-snowball",
    )
    return mask_pii_in_intent(intent)  # type: ignore[return-value]


def _find_request(
    request_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — chain anchor lookup for draft_skill."""
    for row in reversed(list_skill_genesis(base_dir=base_dir, kind="requests")):
        if row.get("request_id") == request_id:
            return row
    return None


def _find_draft(
    draft_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — return None on miss instead of raising, so the
    callers (sandbox_skill, materialize_skill) can emit specific
    chain-violation errors rather than the generic legacy raise."""
    for row in reversed(list_skill_genesis(base_dir=base_dir, kind="drafts")):
        if row.get("draft_id") == draft_id:
            return row
    return None


def _latest_sandbox(
    draft_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — return the latest sandbox row for a draft_id."""
    latest: dict[str, Any] | None = None
    for row in list_skill_genesis(base_dir=base_dir, kind="sandbox"):
        if row.get("draft_id") == draft_id:
            latest = row
    return latest


def _find_dispatch(assignment_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "dispatch" / "requests.jsonl")):
        if row.get("assignment_id") == assignment_id:
            return row
    raise GovernanceError(f"dispatch request not found: {assignment_id}")


def _id(prefix: str, value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:48] or "skill"
    return f"{prefix}-{slug}"
