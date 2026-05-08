"""Plan 020 Phase 2 + Phase 11 — shared agent path resolver.

WHY this is a shared utility (not duplicated)
---------------------------------------------
Phase 2 (context_budget_gate.audit_dispatch_context) needs to read the agent
.md file's frontmatter `tools:` block + body length to estimate context tokens.
Phase 11 (surface_manifest_validator.validate_target_agent_existence) needs to
confirm every whitelist entry has a real file on disk. Both phases must follow
the same lookup order — root first, then `_maintenance/`, then
`product-audit/`. A copy-pasted resolver would drift the moment one phase adds
a new agent directory; the shared utility keeps both phases honest.

Lookup order (operator gap correction)
--------------------------------------
1. .claude/agents/<target>.md           — domain reviewers (auth-security-expert,
                                          access-boundary-auditor, ...).
2. .claude/agents/_maintenance/<target>.md
                                          — kernel-bound maintenance agents
                                          (aria-primary-planner, aria-
                                          challenger-planner, aria-prompt-
                                          writer). Operator gap fix: a root-
                                          only resolver missed these and falsely
                                          flagged them as missing-file.
3. .claude/agents/product-audit/<target>.md
                                          — Lane-B product-audit roster
                                          (product-audit-orchestrator, etc.).

First match wins. None returned when no candidate exists.
"""
from __future__ import annotations

from pathlib import Path

# Search order (left-to-right) for resolve_agent_md_path. The order is the
# Plan 020 v3.3 §Phase 2 + §Phase 11 contract; do NOT rearrange without
# updating both phases' tests.
_AGENT_MD_DIRECTORIES: tuple[tuple[str, ...], ...] = (
    (".claude", "agents"),
    (".claude", "agents", "_maintenance"),
    (".claude", "agents", "product-audit"),
)


def resolve_agent_md_path(target_agent: str, repo_root: Path) -> Path | None:
    """Return the first .md file matching <target_agent> across the agent dirs.

    Returns None when no candidate exists in any directory. Caller decides
    whether None is a hard failure (Phase 11 validator) or a soft fallback
    (Phase 2 context-budget audit returning a zero token estimate).
    """
    target = (target_agent or "").strip()
    if not target:
        return None
    if "/" in target or ".." in target:
        # Path-traversal guard — target_agent is a name, not a path.
        return None
    for parts in _AGENT_MD_DIRECTORIES:
        candidate = repo_root.joinpath(*parts, f"{target}.md")
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


__all__ = ["resolve_agent_md_path"]
