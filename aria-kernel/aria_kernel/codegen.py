from __future__ import annotations

import fnmatch
import hashlib
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_FORBIDDEN_GLOBS = (
    ".github/**",
    "aria-kernel/aria_kernel/**",
    "infra/**",
    "secrets/**",
    ".env*",
    "**/migrations/**",
)


def record_code_change_plan(
    *,
    proposal_id: str,
    worktree_path: str,
    intended_files: list[str],
    allowed_globs: list[str],
    pre_hashes: dict[str, str],
    post_hashes: dict[str, str],
    validation_refs: list[str],
    forbidden_globs: list[str] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if not proposal_id.strip() or not worktree_path.strip():
        raise GovernanceError("code change plan requires proposal_id and worktree_path")
    files = _normalize_paths(intended_files)
    allowed = _normalize_globs(allowed_globs)
    forbidden = _normalize_globs(list(DEFAULT_FORBIDDEN_GLOBS) + (forbidden_globs or []))
    if not files:
        raise GovernanceError("code change plan requires intended_files")
    if not allowed:
        raise GovernanceError("code change plan requires allowed_globs")
    blockers = _scope_blockers(files, allowed, forbidden)
    if not validation_refs:
        blockers.append("validation_refs_required")
    if not pre_hashes or not post_hashes:
        blockers.append("pre_post_hashes_required")
    if sorted(pre_hashes) != sorted(post_hashes):
        blockers.append("pre_post_hash_file_mismatch")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "code_change_plan_id": _plan_id(proposal_id, files),
        "proposal_id": proposal_id,
        "worktree_path": worktree_path,
        "intended_files": files,
        "allowed_globs": allowed,
        "forbidden_globs": forbidden,
        "pre_hashes": pre_hashes,
        "post_hashes": post_hashes,
        "validation_refs": validation_refs,
        "status": "ready_for_review" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "codegen" / "code-change-plans.jsonl", row)


def list_code_change_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "codegen" / "code-change-plans.jsonl")


def _scope_blockers(files: list[str], allowed_globs: list[str], forbidden_globs: list[str]) -> list[str]:
    blockers = []
    for path in files:
        if any(fnmatch.fnmatch(path, pattern) for pattern in forbidden_globs):
            blockers.append(f"forbidden_path:{path}")
        if not any(fnmatch.fnmatch(path, pattern) for pattern in allowed_globs):
            blockers.append(f"outside_allowed_scope:{path}")
    return blockers


def _normalize_paths(paths: list[str]) -> list[str]:
    return sorted({_strip_relative_prefix(str(path).replace("\\", "/")) for path in paths if isinstance(path, str) and path.strip()})


def _normalize_globs(patterns: list[str]) -> list[str]:
    return sorted({_strip_relative_prefix(str(pattern).replace("\\", "/")) for pattern in patterns if isinstance(pattern, str) and pattern.strip()})


def _strip_relative_prefix(value: str) -> str:
    value = value.strip()
    while value.startswith("./"):
        value = value[2:]
    return value


def _plan_id(proposal_id: str, files: list[str]) -> str:
    digest = hashlib.sha256(f"{proposal_id}:{'|'.join(files)}".encode("utf-8")).hexdigest()[:12]
    return f"codegen-{digest}"
