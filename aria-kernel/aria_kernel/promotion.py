from __future__ import annotations

from pathlib import Path
from typing import Any

from .fixture_runner import latest_fixture_status
from .readiness import adapter_active_readiness, is_zero_finding_stable_shadow_run
from .tool_registry import GovernanceError, get_tool, transition_tool


def promote_tool(
    tool_id: str,
    target_status: str,
    *,
    reason: str,
    operator_approval_ref: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    fixture_status = latest_fixture_status(tool_id, base_dir=base_dir)
    fixture_passed = fixture_status["current_tool_passed"]
    if target_status == "SHADOW" and tool["status"] == "CALIBRATE" and not fixture_passed:
        raise GovernanceError("CALIBRATE -> SHADOW requires the latest fixture suite to pass for the current tool version and manifest hash")
    if target_status == "ACTIVE":
        # C7/E8 — ONE promotion gate, two authorities. The operator path
        # (approval ref) and the autonomous path (V6.4 auto-promote token)
        # both pass the SAME readiness gate below; they differ only in who
        # vouches. Pre-C7 the token had a producer, a consumer predicate in
        # transition_tool, a policy block, four invariant tests — and no
        # caller: the entire V6.4 autonomous-promotion lane was dead wire.
        # The policy default (enabled=False, profile allowlist) keeps the
        # autonomous authority operator-gated at the POLICY level, which is
        # the E7 boundary: ARIA may act alone only where the operator has
        # said so in genesis-policy, and the token's HMAC binds that
        # decision to this workspace.
        auto_promote_token: str | None = None
        if not operator_approval_ref:
            from .adapter_calibration import (
                AutoPromoteIneligibleError,
                compute_auto_promote_token,
            )
            from .runtime_profile import get_profile

            try:
                auto_promote_token = compute_auto_promote_token(
                    tool_id=tool_id,
                    base_dir=base_dir,
                    profile=get_profile(base_dir=base_dir),
                )
            except AutoPromoteIneligibleError as exc:
                raise GovernanceError(
                    "SHADOW -> ACTIVE requires operator approval ref "
                    f"(auto-promote ineligible: {exc})"
                ) from exc
        readiness = adapter_active_readiness(tool_id, base_dir=base_dir)
        if not readiness["active_ready"]:
            blockers = ", ".join(readiness["blocked_by"])
            raise GovernanceError(f"SHADOW -> ACTIVE readiness blocked: {blockers}")
        return transition_tool(
            tool_id,
            target_status,
            reason=reason,
            base_dir=base_dir,
            operator_approval=bool(operator_approval_ref),
            auto_promote_token=auto_promote_token,
            precision=1.0 if readiness["zero_finding_lane"] else readiness["precision"],
            critical_false_positives=readiness["critical_false_positives"],
            evidence_chains_valid=True,
        )
    return transition_tool(
        tool_id,
        target_status,
        reason=reason,
        base_dir=base_dir,
        fixture_suite_passed=fixture_passed,
    )


def attempt_auto_promotions(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """C7/E8 — the auto-promote token's first production caller.

    Runs after the calibration reporter (which persists the precision
    history the token gates on): every SHADOW adapter gets ONE promotion
    attempt through `promote_tool`'s shared gate. An ineligible adapter is
    RECORDED and skipped — ineligibility is the policy working, not an
    error; the night continues. With the policy default (enabled=False)
    this is a per-tool no-op that says so out loud, which is exactly the
    honest state until the operator flips the policy.
    """
    from .tool_registry import append_tools_governance, ensure_tools_dir, list_tools

    root = ensure_tools_dir(base_dir)
    promoted: list[str] = []
    ineligible: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("kind") != "adapter" or tool.get("status") != "SHADOW":
            continue
        try:
            promote_tool(
                tool_id,
                "ACTIVE",
                reason=f"auto_promote: policy gates green (cycle {cycle_id})",
                base_dir=root,
            )
            promoted.append(tool_id)
        except GovernanceError as exc:
            ineligible.append({"tool_id": tool_id, "reason": str(exc)[:300]})
    result = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "promoted": promoted,
        "ineligible_count": len(ineligible),
        "ineligible": ineligible[:10],
    }
    if promoted:
        append_tools_governance(
            root,
            "adapter_auto_promoted",
            {"cycle_id": cycle_id, "tool_ids": promoted},
        )
    return result


def is_clean_shadow_run(run: dict[str, Any]) -> bool:
    return is_zero_finding_stable_shadow_run(run)
