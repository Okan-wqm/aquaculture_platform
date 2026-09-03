from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


REQUIRED_KERNEL_VALIDATIONS = (
    "python-suite",
    "adapter-tests",
    "integrity-verify",
    "shadow-cycle",
    "validation-engine-self-test",
)


def request_kernel_change(
    *,
    changed_files: list[str],
    operator_approval_ref: str,
    validation_refs: list[str],
    full_shadow_cycle_ref: str,
    rollback_plan: str,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not changed_files or not all(path.startswith("aria-kernel/aria_kernel/") for path in changed_files):
        raise GovernanceError("kernel change requests may only target aria-kernel/aria_kernel/**")
    if not operator_approval_ref.strip():
        raise GovernanceError("kernel change request requires operator approval")
    if not validation_refs or len(validation_refs) < len(REQUIRED_KERNEL_VALIDATIONS):
        raise GovernanceError("kernel change request requires full validation evidence refs")
    if not full_shadow_cycle_ref.strip() or not rollback_plan.strip():
        raise GovernanceError("kernel change request requires shadow cycle ref and rollback plan")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "changed_files": changed_files,
        "operator_approval_ref": operator_approval_ref,
        "validation_refs": validation_refs,
        "full_shadow_cycle_ref": full_shadow_cycle_ref,
        "rollback_plan": rollback_plan,
        "decision": "authorized_for_pr_only",
        "auto_merge_allowed": False,
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "kernel-change" / "requests.jsonl", row, expected_surface="kernel_change_requests")


def list_kernel_change_requests(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "kernel-change" / "requests.jsonl")
