"""Plan 020 Phase 2 — context budget gate (role-based caps + audit ledger).

WHY this module exists
----------------------
ARIA dispatches work to 80+ agent .md files (root + _maintenance + product-
audit), each declaring a `tools:` allowlist + body content + transitive
`@.claude/knowledge/...` references. Pre-Plan-020 there was no audit between
"this request looks small" and "this request actually fills 80 % of Claude's
context window". Once a planner packet exceeds the role-class cap the agent
either silently drops earlier reasoning (cache eviction) or rejects the call
late in the pipeline. Either way the dispatch is wasted compute + dollars.

Phase 2 fixes that with a pre-dispatch audit:
- Estimate request + agent .md + knowledge bookmarks token cost.
- Compare against a role-based cap table (judges 0.35, planners 0.55,
  executors 0.45, emergency 0.65, domain reviewers 0.45, default 0.40).
- Write the audit row to aria-tools/context-audits.jsonl (Plan 020 surface).
- Emit context_budget_audited (always) + context_budget_exceeded (cap aimed)
  governance events.
- enforce_context_budget raises GovernanceError on cap aimed; audit_dispatch_
  context returns the breakdown without raising (read-only audit path).

WHY role-based caps (operator gap correction over single-cap)
-------------------------------------------------------------
A single 0.40 cap rejected legitimate planner packets that needed cross-review
context (3-5 evidence chains × 8K tokens each). A judge packet conversely had
no business loading 50 % of the window. Role-based caps keep judges lean and
let planners breathe.

cap categories (Plan v3.3 §Phase 2.A):
- judges                (evidence/adversarial/consensus)        0.35
- planners              (primary/challenger/cross_review)       0.55
- executors             (implementation/gap_closure)            0.45
- emergency             (architectural_arbitration/HUMAN_REQ)   0.65
- domain reviewers      (auth/access/tenant)                    0.45
- change_intelligence/goldset_curation/maintenance_utility      0.40
- default fallback      (unknown role)                          0.40

Read path safety
----------------
audit_dispatch_context resolves the agent .md path via the SHARED
agent_resolver.resolve_agent_md_path utility (kernel-bound maintenance
agents under .claude/agents/_maintenance/ are reachable). Knowledge
@-references are resolved against repo_root; missing knowledge files are
treated as 0-token contributions (logged in the warnings list rather than
raising).

Default context window
----------------------
DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000 reflects the 200K window; operator
override via context_window_tokens_override kwarg.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .agent_resolver import resolve_agent_md_path
from .ledger import append_declared_jsonl, load_declared_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    utc_now,
)

# ---------------------------------------------------------------------
# Default context window. 200K matches Claude default; operators on the
# 1M extended-context release override via context_window_tokens_override.
DEFAULT_CONTEXT_WINDOW_TOKENS: int = 200_000

# Role-cap policy (Plan v3.3 §Phase 2.A). Frozen-as-tuple keys keep the
# table explicit; default fallback is the strictest 0.40.
ROLE_CAP_MAP: dict[str, float] = {
    # Judges (Plan 016 Faz C4 envelope wraps)
    "evidence_judgment": 0.35,
    "adversarial_judgment": 0.35,
    "consensus_arbitration": 0.35,
    # Planners
    "primary_plan": 0.55,
    "challenger_plan": 0.55,
    "cross_review": 0.55,
    # Executors
    "implementation": 0.45,
    "gap_closure": 0.45,
    # Emergency (operator-driven escalations)
    "architectural_arbitration": 0.65,
    "human_required_packet": 0.65,
    # Domain reviewers (dispatched as packet kinds, not kernel ROLES)
    "auth_security_review": 0.45,
    "access_boundary_review": 0.45,
    "tenant_isolation_review": 0.45,
    # Other kernel ROLES
    "change_intelligence": 0.40,
    "goldset_curation": 0.40,
    "maintenance_utility": 0.40,
    "verification": 0.40,
    "implementation_review": 0.40,
    "gap_finding": 0.40,
}
DEFAULT_ROLE_CAP: float = 0.40


CONTEXT_AUDITS_FILENAME = "context-audits.jsonl"

# Bookmark reference parser for the doc families agent .md preambles carry.
# Plan v3.3 §Agent system invocation: ".md files reference [knowledge]
# via @.claude/knowledge/... lines — these are READER BOOKMARKS only".
# E17-d — widened beyond @.claude/knowledge/: every ARIA judge/planner
# preamble also cold-reads @docs/aria/{SPEC,CONTRACTS,PIPELINES}.md (plus
# @docs/adr/ references) — ~138KB of static docs per spawn — and the
# original regex made exactly that biggest cost INVISIBLE to the audit.
# Same resolution + tokenization path; measurement only, the cap semantics
# are unchanged (a preamble that genuinely overflows its role cap should
# fail the audit rather than hide from it).
_KNOWLEDGE_REF_RE = re.compile(
    r"@((?:\.claude/knowledge|docs/aria|docs/adr)/[\w./\-]+)"
)


def estimate_tokens(text: str) -> int:
    """Estimate token count for a piece of text.

    Uses tiktoken cl100k_base when available (pip install tiktoken in CI),
    else char/4 ceil fallback. The fallback is intentionally rough — its job
    is to flag obvious overruns, not to predict billing dollars.
    """
    if not text:
        return 0
    try:
        import tiktoken  # type: ignore[import-not-found]
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except Exception:
        # Char/4 ceil — deterministic, dependency-free fallback.
        return -(-len(text) // 4)


def _read_agent_md(target_agent: str, repo_root: Path) -> tuple[str, Path | None]:
    md_path = resolve_agent_md_path(target_agent, repo_root)
    if md_path is None:
        return "", None
    try:
        return md_path.read_text(encoding="utf-8"), md_path
    except OSError:
        return "", md_path


def _knowledge_refs(text: str) -> list[str]:
    """Extract unique @-bookmark refs (.claude/knowledge, docs/aria, docs/adr)."""
    return list(dict.fromkeys(match.group(1) for match in _KNOWLEDGE_REF_RE.finditer(text)))


def _read_knowledge(refs: list[str], repo_root: Path) -> tuple[int, list[str]]:
    """Read referenced knowledge files; return (total_tokens, missing_refs)."""
    total = 0
    missing: list[str] = []
    for ref in refs:
        path = repo_root / ref
        if not path.exists():
            missing.append(ref)
            continue
        try:
            total += estimate_tokens(path.read_text(encoding="utf-8"))
        except OSError:
            missing.append(ref)
    return total, missing


def _request_text(request: Any) -> str:
    """Coerce a request payload into a single text blob for token estimation."""
    if request is None:
        return ""
    if isinstance(request, str):
        return request
    if isinstance(request, dict):
        # Concatenate the canonical fields a dispatch request commonly
        # carries: suggested_prompt + must_satisfy items + evidence refs.
        parts: list[str] = []
        for key in ("suggested_prompt", "prompt", "input", "body", "summary", "rationale"):
            v = request.get(key)
            if isinstance(v, str):
                parts.append(v)
        ms = request.get("must_satisfy")
        if isinstance(ms, list):
            for entry in ms:
                if isinstance(entry, str):
                    parts.append(entry)
                elif isinstance(entry, dict):
                    parts.append(json.dumps(entry, sort_keys=True))
        evid = request.get("evidence_refs") or request.get("evidence")
        if isinstance(evid, list):
            parts.extend(str(x) for x in evid)
        return "\n".join(p for p in parts if p)
    # Fallback: JSON serialise.
    try:
        return json.dumps(request, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(request)


def _resolve_cap(role: str, role_cap_override: dict[str, float] | None) -> float:
    """Pick a cap for the dispatch role.

    role_cap_override always wins; ROLE_CAP_MAP next; DEFAULT_ROLE_CAP last.
    Caps are stored as fractions of the context window in [0.0, 1.0].
    """
    if role_cap_override is not None and role in role_cap_override:
        cap = float(role_cap_override[role])
    elif role in ROLE_CAP_MAP:
        cap = ROLE_CAP_MAP[role]
    else:
        cap = DEFAULT_ROLE_CAP
    if not (0.0 < cap <= 1.0):
        raise GovernanceError(
            f"role cap for {role!r} must be in (0.0, 1.0], got {cap!r}"
        )
    return cap


def audit_dispatch_context(
    *,
    request: Any,
    target_agent: str,
    role: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    context_window_tokens_override: int | None = None,
    role_cap_override: dict[str, float] | None = None,
    write_ledger: bool = True,
) -> dict[str, Any]:
    """Audit the token cost of a planned dispatch.

    Returns a breakdown dict; does NOT raise on cap aimed (read-only audit
    path). Use enforce_context_budget for the rejecting variant.

    Persisted (when write_ledger=True):
    - aria-tools/context-audits.jsonl (Plan 020 surface).
    - aria-tools/governance.jsonl context_budget_audited event.

    Frozen-aware: the write path routes through
    enforce_profile_for_write('context_audits', ...) so frozen profiles
    refuse the audit append (consistent with the no-write invariant).
    """
    repo_path = Path(repo_root or Path.cwd()).resolve()
    request_tokens = estimate_tokens(_request_text(request))
    agent_md_text, agent_md_path = _read_agent_md(target_agent, repo_path)
    agent_tokens = estimate_tokens(agent_md_text)
    knowledge_refs = _knowledge_refs(agent_md_text)
    knowledge_tokens, missing_refs = _read_knowledge(knowledge_refs, repo_path)
    total = request_tokens + agent_tokens + knowledge_tokens
    window = int(context_window_tokens_override or DEFAULT_CONTEXT_WINDOW_TOKENS)
    if window <= 0:
        raise GovernanceError(
            f"context_window_tokens_override must be positive, got {window!r}"
        )
    percent = total / window
    cap = _resolve_cap(role, role_cap_override)
    biggest = sorted(
        [
            {"surface": "request", "tokens": request_tokens},
            {"surface": "agent_md", "tokens": agent_tokens, "path": str(agent_md_path) if agent_md_path else None},
            {"surface": "knowledge", "tokens": knowledge_tokens, "refs": knowledge_refs},
        ],
        key=lambda row: row["tokens"],
        reverse=True,
    )[:5]

    audit_row: dict[str, Any] = {
        "$schema": "aria/context-audit/v1",
        "schema_version": 1,
        "audited_at": utc_now(),
        "target_agent": target_agent,
        "role": role,
        "context_window_tokens": window,
        "request_token_estimate": request_tokens,
        "agent_token_estimate": agent_tokens,
        "knowledge_token_estimate": knowledge_tokens,
        "total_estimate": total,
        "percent_of_context_window": round(percent, 6),
        "cap_applied": cap,
        "cap_breached": percent > cap,
        "biggest_files": biggest,
        "missing_knowledge_refs": missing_refs,
        "agent_md_resolved": str(agent_md_path) if agent_md_path else None,
    }

    if not write_ledger:
        return audit_row

    enforce_profile_for_write("context_audits", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    stored_audit = append_declared_jsonl(
        root / CONTEXT_AUDITS_FILENAME,
        audit_row,
        expected_surface="context_audits",
    )
    append_tools_governance(
        root,
        "context_budget_audited",
        {
            "target_agent": target_agent,
            "role": role,
            "total_estimate": total,
            "percent_of_context_window": audit_row["percent_of_context_window"],
            "cap_applied": cap,
            "cap_breached": audit_row["cap_breached"],
        },
    )
    return stored_audit


def enforce_context_budget(
    *,
    request: Any,
    target_agent: str,
    role: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    context_window_tokens_override: int | None = None,
    role_cap_override: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Audit the dispatch + raise if the role-class cap is breached.

    On breach:
    - audit_row written to context-audits.jsonl (so the breach is auditable).
    - context_budget_exceeded governance event emitted with role + cap +
      observed percent.
    - GovernanceError('context_budget_exceeded: ...') raised.

    Returns the audit row when within cap.
    """
    audit_row = audit_dispatch_context(
        request=request,
        target_agent=target_agent,
        role=role,
        base_dir=base_dir,
        repo_root=repo_root,
        context_window_tokens_override=context_window_tokens_override,
        role_cap_override=role_cap_override,
        write_ledger=True,
    )
    if not audit_row["cap_breached"]:
        return audit_row
    root = ensure_tools_dir(base_dir)
    append_tools_governance(
        root,
        "context_budget_exceeded",
        {
            "target_agent": target_agent,
            "role": role,
            "cap_applied": audit_row["cap_applied"],
            "percent_observed": audit_row["percent_of_context_window"],
            "total_estimate": audit_row["total_estimate"],
            "context_window_tokens": audit_row["context_window_tokens"],
        },
    )
    raise GovernanceError(
        f"context_budget_exceeded: role={role!r} cap={audit_row['cap_applied']:.2f} "
        f"observed={audit_row['percent_of_context_window']:.4f} "
        f"target_agent={target_agent!r}"
    )


def list_context_audits(
    *,
    base_dir: str | Path | None = None,
    target_agent: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """List recorded context audits (newest last). Optional target_agent filter."""
    from .tool_registry import ensure_tools_dir_readonly
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = root / CONTEXT_AUDITS_FILENAME
    if not path.exists():
        return []
    # Plan 026R §A.3 — strict JSONL reader (was silent-skip). A corrupt
    # context-audit row surfaces as GovernanceError; legitimate
    # operator partial-recovery callsites use on_corruption="tolerant".
    rows: list[dict[str, Any]] = []
    for row in load_declared_jsonl(
        path,
        expected_surface="context_audits",
        verify=True,
    ):
        if target_agent is not None and row.get("target_agent") != target_agent:
            continue
        rows.append(row)
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


__all__ = [
    "DEFAULT_CONTEXT_WINDOW_TOKENS",
    "ROLE_CAP_MAP",
    "DEFAULT_ROLE_CAP",
    "CONTEXT_AUDITS_FILENAME",
    "estimate_tokens",
    "audit_dispatch_context",
    "enforce_context_budget",
    "list_context_audits",
]
