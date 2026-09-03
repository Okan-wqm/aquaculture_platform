"""Plan 032 Faz 032h — skill curation as PROPOSALS, materialization rollback, shadow comparison.

WHY: a curator that archives or merges skills on its own judgment is the
auto-promotion this programme refuses (principle 4). WHAT: the curator only
READS — the skills directory, the agent files that reference skills, the
work journal that shows which skill files agents actually opened — and
writes proposals (`PROPOSE_ARCHIVE` / `PROPOSE_MERGE`) with their evidence
to a declared ledger. A person decides; the decision is a row too. Rollback
puts a materialized skill file back and says so on the same ledger. Shadow
comparison measures a draft against the incumbent it would replace, from
sandbox rows only.
"""
from __future__ import annotations

import hashlib
import math
import re
import subprocess
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

SKILLS_RELDIR = ".claude/skills"
AGENTS_RELDIR = ".claude/agents"
CURATION_KINDS: tuple[str, ...] = ("PROPOSE_ARCHIVE", "PROPOSE_MERGE")
CURATION_DECISIONS: tuple[str, ...] = ("accepted", "rejected")
CURATION_SURFACE = "skill_curation_proposals"
CURATION_RELPATH: tuple[str, ...] = ("skill-genesis", "curation-proposals.jsonl")
MATERIALIZATIONS_RELPATH: tuple[str, ...] = ("skill-genesis", "materializations.jsonl")
SHADOW_VERDICTS: tuple[str, ...] = ("no_incumbent", "candidate_unsandboxed", "candidate_not_worse", "candidate_worse")
DEFAULT_SIMILARITY = 0.85
DEFAULT_UNUSED_DAYS = 30
_WORD = re.compile(r"[a-z][a-z0-9_-]{2,}")
_STOP = frozenset("the and for with that this from into your when then than are you use not but can all any has have will should must".split())


def _tokens(text: str) -> Counter[str]:
    return Counter(w for w in _WORD.findall(text.lower()) if w not in _STOP)


def _cosine(a: Counter[str], b: Counter[str]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(a[k] * b[k] for k in a if k in b)
    return dot / (math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values())))


def inventory_skills(workspace_root: str | Path, *, base_dir: str | Path | None = None, unused_days: int = DEFAULT_UNUSED_DAYS,
                     now: datetime | None = None) -> list[dict[str, Any]]:
    """Every skill file with its usage evidence: agent references + journal reads."""
    root = Path(workspace_root).resolve()
    skills_dir = root / SKILLS_RELDIR
    if not skills_dir.is_dir():
        return []
    agents = {p.name: p.read_text(encoding="utf-8", errors="replace") for p in sorted((root / AGENTS_RELDIR).glob("*.md"))} if (root / AGENTS_RELDIR).is_dir() else {}
    reads: Counter[str] = Counter()
    if base_dir is not None:
        from .hooks import WORK_JOURNAL_RELPATH, WORK_JOURNAL_SURFACE

        path = ensure_tools_dir(base_dir).joinpath(*WORK_JOURNAL_RELPATH)
        if path.exists():
            cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=unused_days)
            for row in load_declared_jsonl(path, expected_surface=WORK_JOURNAL_SURFACE):
                try:
                    stamp = datetime.fromisoformat(str(row.get("recorded_at")).replace("Z", "+00:00"))
                except ValueError:
                    continue
                if stamp < cutoff:
                    continue
                for touched in row.get("files_touched") or []:
                    if SKILLS_RELDIR in str(touched):
                        reads[Path(str(touched)).name] += 1
    out: list[dict[str, Any]] = []
    for path in sorted(skills_dir.glob("*.md")):
        text = path.read_text(encoding="utf-8", errors="replace")
        rel = f"{SKILLS_RELDIR}/{path.name}"
        referenced_by = sorted(name for name, body in agents.items() if rel in body or f"skills/{path.name}" in body)
        out.append({
            "name": path.stem, "path": rel, "bytes": len(text.encode("utf-8")),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "referenced_by_agents": referenced_by, "journal_reads": reads.get(path.name, 0),
            "is_index": path.name.lower() == "readme.md", "_tokens": _tokens(text),
        })
    return out


def proposals_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*CURATION_RELPATH)


def list_curation_proposals(*, base_dir: str | Path | None = None, open_only: bool = False) -> list[dict[str, Any]]:
    path = proposals_path(base_dir)
    rows = load_declared_jsonl(path, expected_surface=CURATION_SURFACE) if path.exists() else []
    decided = {r.get("proposal_id") for r in rows if r.get("event") == "decided"}
    proposals = [r for r in rows if r.get("event") == "proposed"]
    return [p for p in proposals if p.get("proposal_id") not in decided] if open_only else proposals


def _signature(kind: str, subjects: list[str]) -> str:
    return "sha256:" + hashlib.sha256(f"{kind}|{'|'.join(sorted(subjects))}".encode("utf-8")).hexdigest()[:20]


def propose_curation(workspace_root: str | Path, *, base_dir: str | Path | None, similarity_threshold: float = DEFAULT_SIMILARITY,
                     unused_days: int = DEFAULT_UNUSED_DAYS, now: datetime | None = None) -> list[dict[str, Any]]:
    """Write PROPOSE_* rows with evidence. Never touches a skill file."""
    root = ensure_tools_dir(base_dir)
    inventory = inventory_skills(workspace_root, base_dir=root, unused_days=unused_days, now=now)
    existing = {r.get("signature") for r in list_curation_proposals(base_dir=root)}
    candidates: list[dict[str, Any]] = []
    for skill in inventory:
        if skill["is_index"] or skill["referenced_by_agents"] or skill["journal_reads"]:
            continue
        candidates.append({
            "kind": "PROPOSE_ARCHIVE", "subjects": [skill["path"]],
            "evidence": {"referenced_by_agents": [], "journal_reads_last_days": unused_days, "journal_reads": 0, "sha256": skill["sha256"]},
            "rationale": f"no agent file references {skill['path']} and no agent opened it in the last {unused_days} days",
        })
    for i, left in enumerate(inventory):
        for right in inventory[i + 1:]:
            if left["is_index"] or right["is_index"]:
                continue
            score = _cosine(left["_tokens"], right["_tokens"])
            if score >= similarity_threshold:
                candidates.append({
                    "kind": "PROPOSE_MERGE", "subjects": [left["path"], right["path"]],
                    "evidence": {"token_cosine": round(score, 3), "threshold": similarity_threshold, "sha256": [left["sha256"], right["sha256"]]},
                    "rationale": f"{left['name']} and {right['name']} share {round(score * 100)}% of their vocabulary",
                })
    written: list[dict[str, Any]] = []
    path = proposals_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    for candidate in candidates:
        signature = _signature(candidate["kind"], candidate["subjects"])
        if signature in existing:
            continue
        row = {"schema_version": 1, "recorded_at": utc_now(), "event": "proposed", "proposal_id": f"cur-{signature[7:]}",
               "signature": signature, **candidate}
        append_declared_jsonl(path, row, expected_surface=CURATION_SURFACE)
        append_tools_governance(root, "skill_curation_proposed", {"proposal_id": row["proposal_id"], "kind": candidate["kind"], "subjects": candidate["subjects"]})
        written.append(row)
        existing.add(signature)
    return written


def decide_curation(proposal_id: str, *, decision: str, operator_approval_ref: str, base_dir: str | Path | None = None, note: str = "") -> dict[str, Any]:
    if decision not in CURATION_DECISIONS:
        raise ValueError(f"decision must be one of {CURATION_DECISIONS}")
    if not operator_approval_ref.strip():
        raise ValueError("operator_approval_ref is required — curation decisions are a person's")
    root = ensure_tools_dir(base_dir)
    open_ids = {p["proposal_id"] for p in list_curation_proposals(base_dir=root, open_only=True)}
    if proposal_id not in open_ids:
        raise ValueError(f"{proposal_id} is not an open proposal")
    row = {"schema_version": 1, "recorded_at": utc_now(), "event": "decided", "proposal_id": proposal_id, "decision": decision,
           "operator_approval_ref": operator_approval_ref, "note": note[:500]}
    append_declared_jsonl(proposals_path(root), row, expected_surface=CURATION_SURFACE)
    append_tools_governance(root, "skill_curation_decided", {"proposal_id": proposal_id, "decision": decision, "operator_approval_ref": operator_approval_ref})
    return row


def _materializations(root: Path) -> list[dict[str, Any]]:
    from .skill_genesis import load_jsonl

    return load_jsonl(root.joinpath(*MATERIALIZATIONS_RELPATH))


def rollback_skill_materialization(*, draft_id: str, base_dir: str | Path | None, operator_approval_ref: str, workspace_root: str | Path | None = None) -> dict[str, Any]:
    """Put the materialized skill file back (tracked → `git restore`, new → delete); ledger + governance."""
    if not operator_approval_ref.strip():
        raise GovernanceError("skill_rollback_requires_operator_approval_ref")
    root = ensure_tools_dir(base_dir)
    rows = [r for r in _materializations(root) if r.get("draft_id") == draft_id]
    if not rows:
        raise GovernanceError(f"skill_rollback_no_materialization:{draft_id}")
    latest = rows[-1]
    if latest.get("status") == "rolled_back":
        raise GovernanceError(f"skill_rollback_already_rolled_back:{draft_id}")
    worktree = Path(workspace_root) if workspace_root is not None else Path(str(latest.get("worktree_path") or ""))
    target_path = str(latest.get("target_path") or "")
    if not target_path.startswith(f"{SKILLS_RELDIR}/"):
        raise GovernanceError("skill_rollback_target_not_skill_scoped")
    target = worktree / target_path
    action = "absent"
    if target.exists():
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", target_path], cwd=str(worktree), capture_output=True, text=True, check=False)
        if tracked.returncode == 0:
            restored = subprocess.run(["git", "restore", "--source=HEAD", "--", target_path], cwd=str(worktree), capture_output=True, text=True, check=False)
            if restored.returncode != 0:
                raise GovernanceError(f"skill_rollback_git_restore_failed:{restored.stderr.strip()[:200]}")
            action = "restored_from_head"
        else:
            target.unlink()
            action = "deleted_untracked"
    from .skill_genesis import append_jsonl

    row = {"schema_version": 1, "recorded_at": utc_now(), "draft_id": draft_id, "assignment_id": latest.get("assignment_id"),
           "worktree_path": worktree.as_posix(), "target_path": target_path, "status": "rolled_back", "rollback_action": action,
           "rolled_back_from": latest.get("materialize_event_id"), "operator_approval_ref": operator_approval_ref}
    stored = append_jsonl(root.joinpath(*MATERIALIZATIONS_RELPATH), row)
    append_tools_governance(root, "skill_materialization_rolled_back", {"draft_id": draft_id, "target_path": target_path, "action": action,
                                                                         "operator_approval_ref": operator_approval_ref})
    return stored


def shadow_compare(*, draft_id: str, workspace_root: str | Path, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Candidate (latest sandbox row) vs incumbent (fixture blocks of the file it replaces)."""
    from .skill_genesis import _find_draft, _latest_sandbox, parse_fixture_blocks

    root = ensure_tools_dir(base_dir)
    draft = _find_draft(draft_id, root)
    if draft is None:
        raise GovernanceError(f"skill_shadow_draft_not_found:{draft_id}")
    target_path = str(draft.get("target_path") or "")
    sandbox = _latest_sandbox(draft_id, root)
    candidate = {"sandboxed": sandbox is not None, "decision": (sandbox or {}).get("decision"),
                 "fixtures": int((sandbox or {}).get("fixture_count") or len((sandbox or {}).get("results") or []) or 0)}
    incumbent_path = Path(workspace_root) / target_path
    incumbent: dict[str, Any] = {"exists": incumbent_path.exists(), "fixtures": 0}
    if incumbent_path.exists():
        incumbent["fixtures"] = len(parse_fixture_blocks(incumbent_path.read_text(encoding="utf-8", errors="replace")))
    if not candidate["sandboxed"]:
        verdict = "candidate_unsandboxed"
    elif not incumbent["exists"]:
        verdict = "no_incumbent"
    elif candidate["decision"] == "pass" and candidate["fixtures"] >= incumbent["fixtures"]:
        verdict = "candidate_not_worse"
    else:
        verdict = "candidate_worse"
    result = {"draft_id": draft_id, "target_path": target_path, "candidate": candidate, "incumbent": incumbent, "verdict": verdict}
    append_tools_governance(root, "skill_shadow_compared", result)
    return result


__all__ = ["CURATION_DECISIONS", "CURATION_KINDS", "CURATION_RELPATH", "CURATION_SURFACE", "DEFAULT_SIMILARITY", "DEFAULT_UNUSED_DAYS",
           "SHADOW_VERDICTS", "decide_curation", "inventory_skills", "list_curation_proposals", "propose_curation",
           "proposals_path", "rollback_skill_materialization", "shadow_compare"]
