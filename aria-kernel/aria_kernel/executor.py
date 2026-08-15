from __future__ import annotations

import fnmatch
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .apply_engine import list_apply_actions
from .ci import list_ci_failures
from .codegen import record_code_change_plan, record_generated_diff_packet
from .ledger import append_declared_jsonl, load_declared_jsonl
from .proposal import get_proposal
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import run_validation_commands


EXECUTOR_STATUSES = ("DRAFT", "SHADOW", "CALIBRATE", "ACTIVE", "QUARANTINED")
APPLY_STATUSES = ("CALIBRATE", "ACTIVE")
REVIEW_SEVERITIES = ("high", "critical")
DEFAULT_FORBIDDEN_GLOBS = (
    ".github/**",
    ".aria-tools/**",
    "aria-tools/**",
    "aria-kernel/aria_kernel/**",
    "infra/**",
    "secrets/**",
    ".env*",
    "**/.env*",
    "**/migrations/**",
)

_EXECUTOR_SURFACE_BY_FILENAME: dict[str, str] = {
    "registry.jsonl": "executor_registry",
    "packets.jsonl": "executor_packets",
    "diff-reviews.jsonl": "executor_diff_reviews",
    "prompts.jsonl": "executor_prompts",
    "applications.jsonl": "executor_applications",
    "locks.jsonl": "executor_locks",
    "retries.jsonl": "executor_retries",
    "operator-takeovers.jsonl": "executor_operator_takeovers",
    "flaky-fingerprints.jsonl": "executor_flaky_fingerprints",
}


def _executor_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if concrete.parent.name != "executor":
        return None
    return _EXECUTOR_SURFACE_BY_FILENAME.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _executor_surface_name(path)
    if surface is None:
        raise GovernanceError(f"executor_append_unknown_surface:{path.as_posix()}")
    return append_declared_jsonl(path, record, expected_surface=surface)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _executor_surface_name(path)
    if surface is None:
        raise GovernanceError(f"executor_load_unknown_surface:{path.as_posix()}")
    return load_declared_jsonl(path, expected_surface=surface)
SUPPRESSION_PATTERNS = (
    "skip test",
    "skip the test",
    "delete the test",
    "remove the test",
    "disable workflow",
    "disable the workflow",
    "workflow_dispatch only",
    "lower threshold",
    "reduce threshold",
    "mark false positive",
    "mark fp",
    "ignore failure",
    "allow failure",
    "continue-on-error",
    "branch protection",
)
PACKET_REQUIRED_FIELDS = (
    "proposal_id",
    "ci_failure_ids",
    "root_failure_family",
    "source_agent",
    "model",
    "prompt_hash",
    "prompt_excerpt",
    "repo_evidence_refs",
    "workflow_evidence_refs",
    "intended_files",
    "allowed_globs",
    "changed_files",
    "unified_diff",
    "rationale",
    "risk_notes",
)
MAX_AUTO_RETRIES_PER_FAMILY = 2
MAX_AUTO_RETRIES_PER_PR = 4
PROMPT_FULL_THRESHOLD = 4096


def register_executor(
    payload: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_executor_registration(payload)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "source_agent": str(payload["source_agent"]),
        "owner": str(payload["owner"]),
        "status": str(payload["status"]),
        "allowed_globs": _string_list(payload.get("allowed_globs")),
        "forbidden_globs": _string_list(payload.get("forbidden_globs")),
        "max_files_per_packet": int(payload["max_files_per_packet"]),
        "requires_diff_review_for": _review_rule(payload.get("requires_diff_review_for")),
        "can_review": bool(payload.get("can_review")),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "executor" / "registry.jsonl", row)


def record_executor_packet(
    packet: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    _validate_packet_shape(packet)
    proposal_id = str(packet["proposal_id"])
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    if proposal.get("status") != "approved_for_apply":
        raise GovernanceError("executor packet requires an approved_for_apply proposal")
    source_agent = str(packet["source_agent"])
    executor = _registered_executor(source_agent, base_dir)
    if executor.get("status") == "QUARANTINED":
        raise GovernanceError("quarantined executor cannot submit packets")
    if _active_lock(proposal_id, base_dir):
        raise GovernanceError("proposal_inflight_locked")
    failures = [_failure_by_id(str(item), base_dir) for item in _string_list(packet.get("ci_failure_ids"))]
    validation_commands = _proposal_validation_commands(proposal)
    packet_validation = _string_list(packet.get("validation_commands"))
    if packet_validation and not set(packet_validation).issubset(set(validation_commands)):
        raise GovernanceError("validation_commands_must_be_proposal_bound")

    unified_diff = str(packet["unified_diff"])
    changed_files = _normalize_paths(_string_list(packet.get("changed_files")))
    diff_files = _paths_from_unified_diff(unified_diff)
    intended_files = _normalize_paths(_string_list(packet.get("intended_files")))
    packet_allowed = _normalize_globs(_string_list(packet.get("allowed_globs")))
    effective_severity = _derive_effective_severity(proposal=proposal, failures=failures, changed_files=changed_files)
    prompt_ref = _record_full_prompt_if_needed(packet, base_dir)
    blockers = _packet_blockers(
        packet=packet,
        executor=executor,
        failures=failures,
        validation_commands=validation_commands,
        changed_files=changed_files,
        diff_files=diff_files,
        intended_files=intended_files,
        packet_allowed=packet_allowed,
    )
    packet_id = _packet_id(proposal_id, source_agent, unified_diff)
    review_required = _review_required(effective_severity, executor)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "packet_id": packet_id,
        "proposal_id": proposal_id,
        "ci_failure_ids": [failure["ci_failure_id"] for failure in failures],
        "failure_fingerprints": sorted({str(failure.get("failure_fingerprint") or "") for failure in failures if failure.get("failure_fingerprint")}),
        "root_failure_family": str(packet["root_failure_family"]),
        "source_agent": source_agent,
        "executor_status": executor.get("status"),
        "model": str(packet["model"]),
        "prompt_hash": str(packet["prompt_hash"]),
        "prompt_excerpt": _scrub_text(str(packet["prompt_excerpt"]))[:4096],
        "prompt_full_ref": prompt_ref,
        "repo_evidence_refs": _string_list(packet.get("repo_evidence_refs")),
        "workflow_evidence_refs": _string_list(packet.get("workflow_evidence_refs")),
        "intended_files": intended_files,
        "allowed_globs": packet_allowed,
        "changed_files": changed_files,
        "diff_file_paths": diff_files,
        "unified_diff_hash": _sha256(unified_diff.encode("utf-8")),
        "unified_diff": unified_diff,
        "rationale": _scrub_text(str(packet["rationale"])),
        "risk_notes": _scrub_text(str(packet["risk_notes"])),
        "validation_commands": validation_commands,
        "declared_severity": packet.get("severity"),
        "effective_severity": effective_severity,
        "review_required": review_required,
        "review_required_count": _required_review_count(effective_severity, review_required),
        "status": "ready_for_apply" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    stored = append_jsonl(ensure_tools_dir(base_dir) / "executor" / "packets.jsonl", row)
    if not blockers:
        _acquire_lock(proposal_id=proposal_id, packet_id=packet_id, base_dir=base_dir, cycle_id=cycle_id)
    return stored


def review_executor_diff(
    *,
    packet_id: str,
    reviewer: str,
    verdict: str,
    evidence_refs: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    packet = get_executor_packet(packet_id=packet_id, base_dir=base_dir)
    # Plan 022 §C-6 — separation-of-duties enforcement at the kernel
    # boundary. Pre-Plan-022 the executor allowed the same agent that
    # produced a packet to also review it.
    # Plan 023 v3 §A-3 — normalize before compare. Pre-fix this used
    # exact-string `==`, so a source_agent="Codex-Executor" reviewer=
    # "codex-executor" (case-only diff) bypassed the self-review block;
    # NBSP / unicode-confusable variants (Codex‑Executor with U+2011)
    # also passed. Post-fix: NFC-normalize + casefold + strip both
    # sides so case / whitespace / unicode-fold variants are caught.
    import unicodedata as _ud
    def _norm(s: str) -> str:
        return _ud.normalize("NFC", s).strip().casefold()
    source_agent_raw = str(packet.get("source_agent") or "")
    reviewer_raw = str(reviewer or "")
    source_agent_norm = _norm(source_agent_raw)
    reviewer_norm = _norm(reviewer_raw)
    if source_agent_norm and source_agent_norm == reviewer_norm:
        raise GovernanceError(
            f"self_review_violation: reviewer={reviewer!r} is the same agent "
            f"that produced packet={packet_id!r} (source_agent={source_agent_raw!r}; "
            f"normalized form matched). Plan 016 separation-of-duties contract "
            f"requires a different reviewer."
        )
    reviewer_row = _registered_executor(reviewer, base_dir)
    if reviewer_row.get("can_review") is not True:
        raise GovernanceError("reviewer_must_be_registered")
    if verdict not in ("approved", "rejected"):
        raise GovernanceError("diff review verdict must be approved or rejected")
    if not evidence_refs or not all(isinstance(item, str) and item.strip() for item in evidence_refs):
        raise GovernanceError("diff review requires evidence refs")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "packet_id": packet_id,
        "proposal_id": packet.get("proposal_id"),
        "reviewer": reviewer,
        "verdict": verdict,
        "evidence_refs": _string_list(evidence_refs),
        "effective_severity": packet.get("effective_severity"),
        "status": "recorded",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "executor" / "diff-reviews.jsonl", row)


def apply_executor_packet(
    *,
    packet_id: str,
    workspace_root: str | Path,
    change_id: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    execute: bool = False,
) -> dict[str, Any]:
    """Apply a reviewed executor packet, validating through the one path.

    ``change_id`` and ``runner_identity`` are required even when
    ``execute`` is False: an application that cannot name the change it
    belongs to, or the identity that would run it, is not something the
    lane should be planning either. The ``commit_sha`` is NOT a
    parameter — it is read from the candidate worktree's HEAD, because
    the commit a run validated is a fact about the tree, never a claim
    a caller gets to make.
    """
    packet = get_executor_packet(packet_id=packet_id, base_dir=base_dir)
    if not isinstance(change_id, str) or not change_id.strip():
        raise GovernanceError("executor_apply_change_id_required")
    if not isinstance(runner_identity, str) or not runner_identity.strip():
        raise GovernanceError("executor_apply_runner_identity_required")
    if packet.get("status") != "ready_for_apply":
        raise GovernanceError("executor packet is not ready_for_apply")
    executor = _registered_executor(str(packet["source_agent"]), base_dir)
    if executor.get("status") not in APPLY_STATUSES:
        raise GovernanceError("executor status cannot apply packets")
    _require_active_lock(packet, base_dir)
    if _has_flaky_suspect(packet, base_dir):
        return _record_application(packet, base_dir, cycle_id, execute, status="blocked", blocked_by=["flaky_suspect_requires_review"])
    review_blockers = _review_blockers(packet, base_dir)
    if review_blockers:
        return _record_application(packet, base_dir, cycle_id, execute, status="blocked", blocked_by=review_blockers)

    worktree = _application_worktree(packet, workspace_root, base_dir)
    apply_check = _git_apply_check(worktree, str(packet["unified_diff"]))
    if apply_check["status"] != "ok":
        return _record_application(
            packet,
            base_dir,
            cycle_id,
            execute,
            status="blocked",
            blocked_by=["git_apply_check_failed"],
            apply_check=apply_check,
        )
    pre_hashes = _file_hashes(worktree, packet["changed_files"])
    post_hashes = _post_hashes_after_temp_apply(worktree, packet["changed_files"], str(packet["unified_diff"]))
    code_plan = record_code_change_plan(
        proposal_id=str(packet["proposal_id"]),
        worktree_path=worktree.as_posix(),
        intended_files=list(packet["intended_files"]),
        allowed_globs=list(packet["allowed_globs"]),
        pre_hashes=pre_hashes,
        post_hashes=post_hashes,
        validation_refs=[str(packet["ledger_hash"])],
        forbidden_globs=list(DEFAULT_FORBIDDEN_GLOBS),
        cycle_id=cycle_id,
        base_dir=base_dir,
    )
    diff_packet = record_generated_diff_packet(
        code_change_plan_id=str(code_plan["code_change_plan_id"]),
        unified_diff=str(packet["unified_diff"]),
        changed_files=list(packet["changed_files"]),
        rationale=str(packet["rationale"]),
        validation_commands=list(packet["validation_commands"]),
        run_apply_check=True,
        cycle_id=cycle_id,
        base_dir=base_dir,
    )
    if diff_packet.get("status") != "ready_for_candidate_worktree":
        return _record_application(
            packet,
            base_dir,
            cycle_id,
            execute,
            status="blocked",
            blocked_by=list(diff_packet.get("blocked_by", [])),
            apply_check=apply_check,
            code_change_plan_ref=code_plan.get("ledger_hash"),
            generated_diff_packet_ref=diff_packet.get("ledger_hash"),
        )
    if not execute:
        return _record_application(
            packet,
            base_dir,
            cycle_id,
            execute,
            status="planned",
            apply_check=apply_check,
            code_change_plan_ref=code_plan.get("ledger_hash"),
            generated_diff_packet_ref=diff_packet.get("ledger_hash"),
        )
    _git_apply(worktree, str(packet["unified_diff"]))
    validation = run_validation_commands(
        commands=list(packet["validation_commands"]),
        workspace_root=worktree,
        change_id=change_id,
        commit_sha=_git(worktree, ["rev-parse", "HEAD"]),
        runner_identity=runner_identity,
        change_author_identity=change_author_identity,
        cycle_id=cycle_id,
        validation_plan_id=str(packet["proposal_id"]),
        require_clean_worktree=False,
        base_dir=base_dir,
    )
    status = "ready_for_retry" if validation.get("status") == "ok" else "blocked"
    blockers = [] if status == "ready_for_retry" else ["candidate_validation_not_green"]
    return _record_application(
        packet,
        base_dir,
        cycle_id,
        execute,
        status=status,
        blocked_by=blockers,
        apply_check=apply_check,
        code_change_plan_ref=code_plan.get("ledger_hash"),
        generated_diff_packet_ref=diff_packet.get("ledger_hash"),
        validation_ref=validation.get("ledger_hash"),
    )


def retry_pr(
    *,
    packet_id: str,
    pr_number: int,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    execute: bool = False,
) -> dict[str, Any]:
    packet = get_executor_packet(packet_id=packet_id, base_dir=base_dir)
    application = _latest_application(packet_id, base_dir)
    if not application or application.get("status") != "ready_for_retry":
        raise GovernanceError("executor retry requires a ready_for_retry application")
    _require_active_lock(packet, base_dir)
    root = Path(workspace_root).resolve()
    branch = _git(root, ["branch", "--show-current"])
    if not branch.startswith("aria/"):
        raise GovernanceError("executor retry requires an aria/... branch")
    takeover = _operator_takeover(root, packet, pr_number, base_dir)
    if takeover:
        raise GovernanceError("operator_takeover_requires_new_approval")
    family_count = _retry_count(pr_number=pr_number, root_failure_family=str(packet["root_failure_family"]), base_dir=base_dir)
    pr_count = _retry_count(pr_number=pr_number, root_failure_family=None, base_dir=base_dir)
    if family_count >= MAX_AUTO_RETRIES_PER_FAMILY:
        raise GovernanceError("retry_family_budget_exceeded")
    if pr_count >= MAX_AUTO_RETRIES_PER_PR:
        raise GovernanceError("retry_pr_budget_exceeded")
    changed_files = list(packet.get("changed_files", []))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "packet_id": packet_id,
        "application_ref": application.get("ledger_hash"),
        "proposal_id": packet.get("proposal_id"),
        "pr_number": pr_number,
        "branch": branch,
        "ci_failure_ids": packet.get("ci_failure_ids", []),
        "root_failure_family": packet.get("root_failure_family"),
        "previous_head_sha": _git(root, ["rev-parse", "HEAD"]),
        "changed_files": changed_files,
        "dry_run": not execute,
        "status": "planned" if not execute else "retried",
        "commit_sha": None,
    }
    if execute:
        _git(root, ["add", *changed_files])
        _git(root, ["commit", "-m", f"ARIA remediation: {packet.get('proposal_id')}"])
        row["commit_sha"] = _git(root, ["rev-parse", "HEAD"])
        _git(root, ["push", "-u", "origin", branch])
        _release_lock(str(packet["proposal_id"]), packet_id, base_dir, cycle_id, reason="retry_pushed")
    return append_jsonl(ensure_tools_dir(base_dir) / "executor" / "retries.jsonl", row)


def executor_status(
    *,
    pr_number: int | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    retries = load_jsonl(root / "executor" / "retries.jsonl")
    if pr_number is not None:
        retries = [row for row in retries if row.get("pr_number") == pr_number]
    return {
        "schema_version": 1,
        "pr_number": pr_number,
        "registry": load_jsonl(root / "executor" / "registry.jsonl"),
        "packets": load_jsonl(root / "executor" / "packets.jsonl"),
        "applications": load_jsonl(root / "executor" / "applications.jsonl"),
        "retries": retries,
        "locks": load_jsonl(root / "executor" / "locks.jsonl"),
        "flaky_fingerprints": load_jsonl(root / "executor" / "flaky-fingerprints.jsonl"),
    }


def _canonical_packet_id(row: dict[str, Any]) -> str | None:
    """Plan 023 v3 §A-9 — read-time packet-id canonicalization.

    Pre-Plan-023 get_executor_packet() accepted EITHER packet_id OR
    ledger_hash as the lookup key. The dual-key acceptance lets future
    drift mask review-blocker misses: a row written under ledger_hash
    might be looked up via packet_id and not found, or vice versa.

    Plan 023 v3 §A-9 — append-only-safe canonicalization:
      * Returns row["packet_id"] if present (canonical).
      * Falls back to row["ledger_hash"] for legacy rows that pre-date
        the canonical-only write contract.
      * Returns None when neither is present.

    Append-only discipline preserved: legacy rows on disk are read
    through this helper without mutation. New writes carry packet_id
    (enforced at write sites). The dual-key OR-equality at the lookup
    site is replaced by a single-key match against the canonical id.
    """
    packet_id = row.get("packet_id")
    if isinstance(packet_id, str) and packet_id.strip():
        return packet_id
    ledger_hash = row.get("ledger_hash")
    if isinstance(ledger_hash, str) and ledger_hash.strip():
        return ledger_hash
    return None


def get_executor_packet(*, packet_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "executor" / "packets.jsonl")):
        # Plan 023 v3 §A-9 — single-key match through the read-time
        # canonicalization helper. Pre-fix the inline `... or
        # ledger_hash == packet_id` alias accommodation could mask
        # future drift; the helper centralizes the legacy fallback so
        # only one place needs to change when legacy rows are
        # eventually all migrated.
        if _canonical_packet_id(row) == packet_id:
            return row
    raise GovernanceError(f"executor packet not found: {packet_id}")


def _validate_executor_registration(payload: dict[str, Any]) -> None:
    required = ("source_agent", "owner", "status", "allowed_globs", "max_files_per_packet")
    missing = [field for field in required if field not in payload]
    if missing:
        raise GovernanceError("executor registration missing fields: " + ", ".join(missing))
    if str(payload.get("status")) not in EXECUTOR_STATUSES:
        raise GovernanceError("unknown executor status")
    if not _string_list(payload.get("allowed_globs")):
        raise GovernanceError("executor registration requires allowed_globs")
    if not isinstance(payload.get("max_files_per_packet"), int) or int(payload["max_files_per_packet"]) <= 0:
        raise GovernanceError("executor max_files_per_packet must be positive")


def _validate_packet_shape(packet: dict[str, Any]) -> None:
    if not isinstance(packet, dict):
        raise GovernanceError("executor packet must be a JSON object")
    missing = [field for field in PACKET_REQUIRED_FIELDS if field not in packet]
    if missing:
        raise GovernanceError("executor packet missing fields: " + ", ".join(missing))
    for field in ("proposal_id", "root_failure_family", "source_agent", "model", "prompt_hash", "prompt_excerpt", "unified_diff", "rationale", "risk_notes"):
        if not isinstance(packet.get(field), str) or not str(packet[field]).strip():
            raise GovernanceError(f"executor packet {field} must be a non-empty string")
    for field in ("ci_failure_ids", "repo_evidence_refs", "workflow_evidence_refs", "intended_files", "allowed_globs", "changed_files"):
        if not _string_list(packet.get(field)):
            raise GovernanceError(f"executor packet {field} must be a non-empty string array")
    if bool(packet.get("prompt_truncated")) and not (packet.get("prompt_full_ref") or packet.get("prompt_full")):
        raise GovernanceError("prompt_full_ref_required")


def _registered_executor(source_agent: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "executor" / "registry.jsonl")):
        if row.get("source_agent") == source_agent:
            return row
    raise GovernanceError(f"executor is not registered: {source_agent}")


def _failure_by_id(ci_failure_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(list_ci_failures(base_dir=base_dir)):
        if row.get("ci_failure_id") == ci_failure_id:
            return row
    raise GovernanceError(f"CI failure not found: {ci_failure_id}")


def _proposal_validation_commands(proposal: dict[str, Any]) -> list[str]:
    commands = proposal.get("validation_scope", {}).get("commands", [])
    if not isinstance(commands, list) or not all(isinstance(item, str) and item.strip() for item in commands):
        raise GovernanceError("approved proposal has no validation_scope.commands")
    return [str(item) for item in commands]


def _packet_blockers(
    *,
    packet: dict[str, Any],
    executor: dict[str, Any],
    failures: list[dict[str, Any]],
    validation_commands: list[str],
    changed_files: list[str],
    diff_files: list[str],
    intended_files: list[str],
    packet_allowed: list[str],
) -> list[str]:
    blockers: list[str] = []
    if set(changed_files) != set(diff_files):
        blockers.append("changed_files_do_not_match_unified_diff")
    if len(changed_files) > int(executor.get("max_files_per_packet") or 0):
        blockers.append("max_files_per_packet_exceeded")
    registry_allowed = _normalize_globs(_string_list(executor.get("allowed_globs")))
    forbidden = _normalize_globs(list(DEFAULT_FORBIDDEN_GLOBS) + _string_list(executor.get("forbidden_globs")))
    for path in changed_files:
        if path not in intended_files:
            blockers.append(f"outside_intended_files:{path}")
        if not _matches_any(path, packet_allowed):
            blockers.append(f"outside_packet_allowed_scope:{path}")
        if not _matches_any(path, registry_allowed):
            blockers.append(f"outside_executor_allowed_scope:{path}")
        if _matches_any(path, forbidden):
            blockers.append(f"forbidden_path:{path}")
        if "/migrations/" in path or path.endswith("Migration.ts"):
            blockers.append("migration_requires_dedicated_lane")
    if _suppression_violation(packet):
        blockers.append("suppression_policy_violation")
    if _flaky_suspect_for_failures(failures, base_dir=None):
        blockers.append("flaky_suspect_requires_review")
    if not validation_commands:
        blockers.append("proposal_validation_commands_required")
    return blockers


def _record_full_prompt_if_needed(packet: dict[str, Any], base_dir: str | Path | None) -> str | None:
    if isinstance(packet.get("prompt_full_ref"), str) and packet["prompt_full_ref"].strip():
        return str(packet["prompt_full_ref"])
    prompt_full = packet.get("prompt_full")
    if not isinstance(prompt_full, str) or len(prompt_full) <= PROMPT_FULL_THRESHOLD:
        return None
    prompt_hash = _sha256(prompt_full.encode("utf-8"))
    row = append_jsonl(
        ensure_tools_dir(base_dir) / "executor" / "prompts.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "prompt_hash": prompt_hash,
            "source_agent": packet.get("source_agent"),
            "model": packet.get("model"),
            "prompt_full": _scrub_text(prompt_full),
        },
    )
    return str(row["ledger_hash"])


def _derive_effective_severity(*, proposal: dict[str, Any], failures: list[dict[str, Any]], changed_files: list[str]) -> str:
    text = " ".join(
        [
            str(proposal.get("title") or ""),
            str(proposal.get("problem") or ""),
            str(proposal.get("proposed_change") or ""),
            " ".join(str(failure.get(key) or "") for failure in failures for key in ("workflow", "job", "step", "root_cause_classification", "log_excerpt")),
            " ".join(changed_files),
        ],
    ).lower()
    if any(token in text for token in ("tenant", "auth bypass", "secret", "billing", "payment", "protected_environment_gate")):
        return "critical"
    if any(path.startswith(("apps/", "libs/", "platform/libs/", "web/")) and "/src/" in path for path in changed_files):
        return "high"
    if any(str(failure.get("root_cause_classification")) in ("test_contract_regression", "workflow_infra_failure", "dependency_or_env_failure") for failure in failures):
        return "medium"
    if changed_files and all(path.startswith("docs/") or path.endswith(".md") for path in changed_files):
        return "low"
    return "medium"


def _review_required(effective_severity: str, executor: dict[str, Any]) -> bool:
    registry_rule = _review_rule(executor.get("requires_diff_review_for"))
    return effective_severity in REVIEW_SEVERITIES or "all" in registry_rule or effective_severity in registry_rule


def _required_review_count(effective_severity: str, review_required: bool) -> int:
    if not review_required:
        return 0
    if effective_severity == "critical":
        return 2
    return 1


def _review_blockers(packet: dict[str, Any], base_dir: str | Path | None) -> list[str]:
    if not packet.get("review_required"):
        return []
    reviews = [
        row
        for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "diff-reviews.jsonl")
        if row.get("packet_id") == packet.get("packet_id")
    ]
    if any(row.get("verdict") == "rejected" for row in reviews):
        return ["diff_review_rejected"]
    approved_reviewers = {str(row.get("reviewer")) for row in reviews if row.get("verdict") == "approved"}
    required = int(packet.get("review_required_count") or 1)
    if len(approved_reviewers) < required:
        return ["diff_review_required"]
    return []


def _record_application(
    packet: dict[str, Any],
    base_dir: str | Path | None,
    cycle_id: str | None,
    execute: bool,
    *,
    status: str,
    blocked_by: list[str] | None = None,
    apply_check: dict[str, Any] | None = None,
    code_change_plan_ref: str | None = None,
    generated_diff_packet_ref: str | None = None,
    validation_ref: str | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "packet_id": packet.get("packet_id"),
        "proposal_id": packet.get("proposal_id"),
        "source_agent": packet.get("source_agent"),
        "execute": execute,
        "status": status,
        "blocked_by": sorted(set(blocked_by or [])),
        "apply_check": apply_check or {"status": "skipped"},
        "code_change_plan_ref": code_change_plan_ref,
        "generated_diff_packet_ref": generated_diff_packet_ref,
        "validation_ref": validation_ref,
    }
    stored = append_jsonl(ensure_tools_dir(base_dir) / "executor" / "applications.jsonl", row)
    if status == "blocked" and "diff_review_required" not in set(blocked_by or []):
        _release_lock(str(packet["proposal_id"]), str(packet["packet_id"]), base_dir, cycle_id, reason="application_blocked")
    return stored


def _application_worktree(packet: dict[str, Any], workspace_root: str | Path, base_dir: str | Path | None) -> Path:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == packet.get("proposal_id") and action.get("worktree_path"):
            candidate = Path(str(action["worktree_path"])).resolve()
            if candidate.exists():
                return candidate
    return Path(workspace_root).resolve()


def _git_apply_check(worktree: Path, unified_diff: str) -> dict[str, Any]:
    completed = subprocess.run(["git", "apply", "--check"], cwd=worktree, input=unified_diff, capture_output=True, text=True, check=False)
    return {
        "status": "ok" if completed.returncode == 0 else "failed",
        "exit_code": completed.returncode,
        "stderr_hash": _sha256((completed.stderr or "").encode("utf-8")),
    }


def _git_apply(worktree: Path, unified_diff: str) -> None:
    completed = subprocess.run(["git", "apply"], cwd=worktree, input=unified_diff, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "git apply failed")


def _post_hashes_after_temp_apply(worktree: Path, changed_files: list[str], unified_diff: str) -> dict[str, str]:
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        for relative in changed_files:
            source = worktree / relative
            target = tmp / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.exists():
                shutil.copy2(source, target)
        completed = subprocess.run(["git", "apply"], cwd=tmp, input=unified_diff, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise GovernanceError(completed.stderr.strip() or "temporary patch application failed")
        return _file_hashes(tmp, changed_files)


def _file_hashes(root: Path, paths: list[str]) -> dict[str, str]:
    hashes = {}
    for relative in paths:
        path = root / relative
        if path.exists() and path.is_file():
            hashes[relative] = _sha256(path.read_bytes())
        else:
            hashes[relative] = "sha256:missing"
    return hashes


def _acquire_lock(*, proposal_id: str, packet_id: str, base_dir: str | Path | None, cycle_id: str | None) -> dict[str, Any]:
    if _active_lock(proposal_id, base_dir):
        raise GovernanceError("proposal_inflight_locked")
    return append_jsonl(
        ensure_tools_dir(base_dir) / "executor" / "locks.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "proposal_id": proposal_id,
            "packet_id": packet_id,
            "status": "acquired",
        },
    )


def _release_lock(proposal_id: str, packet_id: str, base_dir: str | Path | None, cycle_id: str | None, *, reason: str) -> dict[str, Any]:
    return append_jsonl(
        ensure_tools_dir(base_dir) / "executor" / "locks.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "proposal_id": proposal_id,
            "packet_id": packet_id,
            "status": "released",
            "reason": reason,
        },
    )


def _active_lock(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    latest = None
    for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "locks.jsonl"):
        if row.get("proposal_id") == proposal_id:
            latest = row
    if latest and latest.get("status") == "acquired":
        return latest
    return None


def _require_active_lock(packet: dict[str, Any], base_dir: str | Path | None) -> None:
    lock = _active_lock(str(packet.get("proposal_id")), base_dir)
    if not lock or lock.get("packet_id") != packet.get("packet_id"):
        raise GovernanceError("executor_operation_requires_active_lock")


def _latest_application(packet_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "executor" / "applications.jsonl")):
        if row.get("packet_id") == packet_id:
            return row
    return None


def _retry_count(*, pr_number: int, root_failure_family: str | None, base_dir: str | Path | None) -> int:
    count = 0
    for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "retries.jsonl"):
        if row.get("pr_number") != pr_number or row.get("status") not in ("retried", "planned"):
            continue
        if root_failure_family is None or row.get("root_failure_family") == root_failure_family:
            count += 1
    return count


def _operator_takeover(root: Path, packet: dict[str, Any], pr_number: int, base_dir: str | Path | None) -> bool:
    retries = [
        row
        for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "retries.jsonl")
        if row.get("pr_number") == pr_number and row.get("commit_sha")
    ]
    if not retries:
        return False
    last = str(retries[-1]["commit_sha"])
    current = _git(root, ["rev-parse", "HEAD"])
    if current == last:
        return False
    message = _git(root, ["log", "-1", "--pretty=%s"])
    if message.startswith("ARIA remediation:"):
        return False
    append_jsonl(
        ensure_tools_dir(base_dir) / "executor" / "operator-takeovers.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "proposal_id": packet.get("proposal_id"),
            "packet_id": packet.get("packet_id"),
            "pr_number": pr_number,
            "previous_aria_commit": last,
            "observed_head_sha": current,
            "status": "operator_takeover",
        },
    )
    return True


def _has_flaky_suspect(packet: dict[str, Any], base_dir: str | Path | None) -> bool:
    suspects = {row.get("failure_fingerprint") for row in _refresh_flaky_fingerprints(base_dir=base_dir)}
    return any(fingerprint in suspects for fingerprint in packet.get("failure_fingerprints", []))


def _refresh_flaky_fingerprints(*, base_dir: str | Path | None) -> list[dict[str, Any]]:
    existing = {
        row.get("failure_fingerprint")
        for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "flaky-fingerprints.jsonl")
    }
    by_fingerprint: dict[str, dict[str, set[str]]] = {}
    for failure in list_ci_failures(base_dir=base_dir):
        fingerprint = str(failure.get("failure_fingerprint") or "")
        if not fingerprint:
            continue
        bucket = by_fingerprint.setdefault(fingerprint, {"cycles": set(), "prs": set()})
        if failure.get("cycle_id"):
            bucket["cycles"].add(str(failure.get("cycle_id")))
        if failure.get("pr_number") is not None:
            bucket["prs"].add(str(failure.get("pr_number")))
    rows = []
    for fingerprint, counts in sorted(by_fingerprint.items()):
        if fingerprint in existing:
            rows.extend(
                row
                for row in load_jsonl(ensure_tools_dir(base_dir) / "executor" / "flaky-fingerprints.jsonl")
                if row.get("failure_fingerprint") == fingerprint
            )
            continue
        if len(counts["cycles"]) >= 3 or len(counts["prs"]) >= 3:
            rows.append(
                append_jsonl(
                    ensure_tools_dir(base_dir) / "executor" / "flaky-fingerprints.jsonl",
                    {
                        "schema_version": 1,
                        "recorded_at": utc_now(),
                        "failure_fingerprint": fingerprint,
                        "cycle_count": len(counts["cycles"]),
                        "pr_count": len(counts["prs"]),
                        "status": "flaky_suspect",
                    },
                ),
            )
    return load_jsonl(ensure_tools_dir(base_dir) / "executor" / "flaky-fingerprints.jsonl")


def _flaky_suspect_for_failures(failures: list[dict[str, Any]], base_dir: str | Path | None) -> bool:
    if base_dir is None:
        return False
    suspects = {row.get("failure_fingerprint") for row in _refresh_flaky_fingerprints(base_dir=base_dir)}
    return any(failure.get("failure_fingerprint") in suspects for failure in failures)


def _suppression_violation(packet: dict[str, Any]) -> bool:
    text = json.dumps(packet, sort_keys=True).lower()
    return any(pattern in text for pattern in SUPPRESSION_PATTERNS)


def _review_rule(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise GovernanceError("requires_diff_review_for must be a string or array")
    rules = [str(item) for item in value if str(item) in ("all", "low", "medium", "high", "critical")]
    return sorted(set(rules))


def _paths_from_unified_diff(unified_diff: str) -> list[str]:
    paths = set()
    for line in unified_diff.splitlines():
        if line.startswith("+++ b/"):
            paths.add(_strip_relative_prefix(line[6:].split("\t", 1)[0]))
        elif line.startswith("--- a/"):
            paths.add(_strip_relative_prefix(line[6:].split("\t", 1)[0]))
    paths.discard("/dev/null")
    return sorted(paths)


def _normalize_paths(paths: list[str]) -> list[str]:
    return sorted({_strip_relative_prefix(path.replace("\\", "/")) for path in paths if path.strip()})


def _normalize_globs(patterns: list[str]) -> list[str]:
    return sorted({_strip_relative_prefix(pattern.replace("\\", "/")) for pattern in patterns if pattern.strip()})


def _strip_relative_prefix(value: str) -> str:
    value = value.strip()
    while value.startswith("./"):
        value = value[2:]
    return value


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item).replace("\\", "/") for item in value if isinstance(item, str) and item.strip()})


def _scrub_text(value: str) -> str:
    value = re.sub(r"(?i)(password|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[^'\"\s]+", r"\1=[REDACTED]", value)
    value = re.sub(r"AKIA[0-9A-Z]{16}", "AWS_ACCESS_KEY_REDACTED", value)
    value = re.sub(r"(?i)bearer\s+[a-z0-9._-]+", "Bearer [REDACTED]", value)
    return value


def _packet_id(proposal_id: str, source_agent: str, unified_diff: str) -> str:
    digest = hashlib.sha256(f"{proposal_id}:{source_agent}:{unified_diff}".encode("utf-8")).hexdigest()[:12]
    return f"executor-packet-{digest}"


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _git(cwd: Path, args: list[str]) -> str:
    completed = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "git command failed")
    return completed.stdout.strip()
