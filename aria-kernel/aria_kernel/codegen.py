from __future__ import annotations

import fnmatch
import hashlib
import subprocess
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


def record_generated_diff_packet(
    *,
    code_change_plan_id: str,
    unified_diff: str,
    changed_files: list[str],
    rationale: str,
    validation_commands: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    run_apply_check: bool = False,
) -> dict[str, Any]:
    plan = _find_plan(code_change_plan_id, base_dir)
    if plan.get("status") != "ready_for_review":
        raise GovernanceError("generated diff requires a ready_for_review code change plan")
    files = _normalize_paths(changed_files)
    if not files or not unified_diff.strip() or not rationale.strip():
        raise GovernanceError("generated diff packet requires changed_files, unified_diff, and rationale")
    if not validation_commands or not all(isinstance(item, str) and item.strip() for item in validation_commands):
        raise GovernanceError("generated diff packet requires validation_commands")
    diff_files = _paths_from_unified_diff(unified_diff)
    blockers = []
    if set(files) != set(diff_files):
        blockers.append("changed_files_do_not_match_unified_diff")
    intended = set(plan.get("intended_files", []))
    for path in files:
        if path not in intended:
            blockers.append(f"outside_code_change_plan:{path}")
    blockers.extend(_scope_blockers(files, plan.get("allowed_globs", []), plan.get("forbidden_globs", [])))
    apply_check = {"status": "skipped"}
    if run_apply_check and not blockers:
        apply_check = _git_apply_check(Path(str(plan["worktree_path"])), unified_diff)
        if apply_check["status"] != "ok":
            blockers.append("git_apply_check_failed")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "generated_diff_packet_id": _packet_id(code_change_plan_id, unified_diff),
        "code_change_plan_id": code_change_plan_id,
        "proposal_id": plan.get("proposal_id"),
        "worktree_path": plan.get("worktree_path"),
        "changed_files": files,
        "diff_file_paths": diff_files,
        "unified_diff_hash": _sha256(unified_diff.encode("utf-8")),
        "unified_diff": unified_diff,
        "rationale": rationale,
        "validation_commands": validation_commands,
        "apply_check": apply_check,
        "status": "ready_for_candidate_worktree" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "codegen" / "generated-diff-packets.jsonl", row)


def list_generated_diff_packets(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "codegen" / "generated-diff-packets.jsonl")


def apply_generated_diff_packet(
    *,
    generated_diff_packet_id: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    require_clean_worktree: bool = True,
) -> dict[str, Any]:
    packet = _find_packet(generated_diff_packet_id, base_dir)
    blockers: list[str] = []
    if packet.get("status") != "ready_for_candidate_worktree":
        blockers.append("generated_diff_packet_not_ready")
    worktree_path = Path(str(packet.get("worktree_path") or "")).resolve()
    if not worktree_path.exists() or not worktree_path.is_dir():
        blockers.append("worktree_path_missing")
    elif require_clean_worktree and _git_status(worktree_path):
        blockers.append("candidate_worktree_not_clean")
    changed_files = _normalize_paths(packet.get("changed_files", []))
    pre_hashes = _file_hashes(worktree_path, changed_files) if worktree_path.exists() else {}
    apply_result = {"status": "skipped"}
    if not blockers:
        apply_result = _git_apply(worktree_path, str(packet["unified_diff"]))
        if apply_result["status"] != "ok":
            blockers.append("git_apply_failed")
    post_hashes = _file_hashes(worktree_path, changed_files) if worktree_path.exists() else {}
    git_diff = _git_diff(worktree_path, changed_files) if worktree_path.exists() else ""
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "generated_diff_packet_id": packet.get("generated_diff_packet_id"),
        "generated_diff_packet_ref": generated_diff_packet_id,
        "code_change_plan_id": packet.get("code_change_plan_id"),
        "proposal_id": packet.get("proposal_id"),
        "worktree_path": worktree_path.as_posix(),
        "changed_files": changed_files,
        "pre_hashes": pre_hashes,
        "post_hashes": post_hashes,
        "git_diff_hash": _sha256(git_diff.encode("utf-8")),
        "apply_result": apply_result,
        "status": "patch_applied" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "codegen" / "generated-diff-applications.jsonl", row)


def list_generated_diff_applications(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "codegen" / "generated-diff-applications.jsonl")


def _find_plan(code_change_plan_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for plan in reversed(list_code_change_plans(base_dir=base_dir)):
        if plan.get("code_change_plan_id") == code_change_plan_id or plan.get("ledger_hash") == code_change_plan_id:
            return plan
    raise GovernanceError(f"code change plan not found: {code_change_plan_id}")


def _find_packet(generated_diff_packet_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for packet in reversed(list_generated_diff_packets(base_dir=base_dir)):
        if (
            packet.get("generated_diff_packet_id") == generated_diff_packet_id
            or packet.get("ledger_hash") == generated_diff_packet_id
        ):
            return packet
    raise GovernanceError(f"generated diff packet not found: {generated_diff_packet_id}")


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


def _packet_id(code_change_plan_id: str, unified_diff: str) -> str:
    digest = hashlib.sha256(f"{code_change_plan_id}:{unified_diff}".encode("utf-8")).hexdigest()[:12]
    return f"diff-{digest}"


def _paths_from_unified_diff(unified_diff: str) -> list[str]:
    paths: set[str] = set()
    for line in unified_diff.splitlines():
        if line.startswith("+++ b/"):
            paths.add(_strip_relative_prefix(line[6:].split("\t", 1)[0]))
        elif line.startswith("--- a/"):
            paths.add(_strip_relative_prefix(line[6:].split("\t", 1)[0]))
    paths.discard("/dev/null")
    return sorted(paths)


def _git_apply_check(worktree_path: Path, unified_diff: str) -> dict[str, Any]:
    if not worktree_path.exists() or not worktree_path.is_dir():
        return {"status": "failed", "reason": "worktree_path_missing"}
    completed = subprocess.run(
        ["git", "apply", "--check"],
        cwd=worktree_path,
        input=_patch_text(unified_diff),
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "status": "ok" if completed.returncode == 0 else "failed",
        "exit_code": completed.returncode,
        "stderr_hash": _sha256((completed.stderr or "").encode("utf-8")),
    }


def _git_apply(worktree_path: Path, unified_diff: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["git", "apply"],
        cwd=worktree_path,
        input=_patch_text(unified_diff),
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "status": "ok" if completed.returncode == 0 else "failed",
        "exit_code": completed.returncode,
        "stderr_hash": _sha256((completed.stderr or "").encode("utf-8")),
    }


def _git_status(worktree_path: Path) -> str:
    completed = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=worktree_path,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError("unable to inspect candidate worktree status")
    return completed.stdout.strip()


def _git_diff(worktree_path: Path, changed_files: list[str]) -> str:
    completed = subprocess.run(
        ["git", "diff", "--", *changed_files],
        cwd=worktree_path,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout or ""


def _file_hashes(worktree_path: Path, changed_files: list[str]) -> dict[str, str]:
    hashes = {}
    for path in changed_files:
        full_path = worktree_path / path
        if not full_path.exists() or not full_path.is_file():
            hashes[path] = "missing"
        else:
            hashes[path] = _sha256(full_path.read_bytes())
    return hashes


def _patch_text(unified_diff: str) -> str:
    return unified_diff if unified_diff.endswith("\n") else unified_diff + "\n"


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
