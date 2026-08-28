"""JJ-2b (ORPHAN-HIGH-732) — the producer that asks the panel to promote.

``promote_tool(..., panel_approval_ref=...)`` would be dead wire without a
caller that MAKES panel refs, and a promotion authority nobody exercises is
the same defect class as the auto-promote token before C7: a gate with a
consumer, a policy and four tests, and no producer.

The ref is not invented here. It is the ``request_id`` of a HUMAN_REQUIRED
record that an independent agent panel RESOLVED — the Y7/Y8 vocabulary
(``human_required_adjudication``): three distinct principals, quorum resolve,
zero "cannot tell" votes, principal disjointness verified against the claims
ledger. The executor below runs from the fold itself, so it always passes a
real ref — but that is a property of THIS caller, not a gate, and the gate is
what matters: ``promotion_veto.resolve_panel_approval`` re-derives the panel
approval from the record file (exists, resolved, resolved_by=agent_panel,
panel_outcome=resolved, kind=tool_promotion, context.tool_id matches) at BOTH
arm time and token-mint time, so a ref that names no adjudication — or names
one the panel REFUSED — promotes nothing no matter who supplies it.

``panel_outcome`` earns its place separately from the rest. A refusal closes
the record too (that is how the sweep stops re-asking a settled question), so
every other clause in that list is satisfied by a rejection: the refused ref
armed the veto window and the next settle activated the adapter the panel had
just turned down.

Kernel-scoped adapters get an escalation too, under a context kind the panel
is NOT permitted to adjudicate, so they land in the operator queue and stay
there. That is the one place a human is still required, and it is required
positively (a record exists and waits) rather than by omission.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, ensure_tools_dir, list_tools


PROMOTION_CONTEXT_KIND: str = "tool_promotion"
# Deliberately NOT in ADJUDICABLE_CONTEXT_KINDS — an unadmitted kind is
# irreducible by construction there, which is exactly the behaviour a
# control-plane-scoped adapter needs.
KERNEL_SCOPE_CONTEXT_KIND: str = "tool_promotion_kernel_scope"

# One panel question per adapter, ever. A re-ask after a refusal or a veto is
# the decision-questioning lane's deliberate act (E9), not the sweep's
# accident — the same rule the judge fan-out follows for closed verdicts.
def _escalation_id(tool_id: str) -> str:
    # Dash, not colon: the id doubles as the human-required FILENAME and the
    # artifact uploader rejects ':' in paths (ORPHAN-714).
    return f"promote-{hashlib.sha256(tool_id.encode()).hexdigest()[:16]}"


def sweep_promotable_adapters_for_adjudication(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Every promotion-ready SHADOW adapter becomes ONE panel question."""
    from .human_required import _human_required_path, record_human_required
    from .promotion_veto import pending_promotion, tool_scope_touches_kernel
    from .readiness import adapter_active_readiness

    root = ensure_tools_dir(base_dir)
    opened: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("kind") != "adapter" or tool.get("status") != "SHADOW":
            continue
        escalation_id = _escalation_id(tool_id)
        if _human_required_path(root, escalation_id).exists():
            skipped.append({"tool_id": tool_id, "reason": "already_escalated"})
            continue
        if pending_promotion(tool_id=tool_id, base_dir=root) is not None:
            skipped.append({"tool_id": tool_id, "reason": "veto_window_already_armed"})
            continue
        # batch_containment: one adapter's refusal (unreadable readiness, a
        # frozen-profile write gate) costs that adapter, never the sweep.
        try:
            readiness = adapter_active_readiness(tool_id, base_dir=root)
            if not readiness["active_ready"]:
                skipped.append({"tool_id": tool_id, "reason": "not_active_ready"})
                continue
            kernel_scoped = tool_scope_touches_kernel(tool)
            record_human_required(
                request_id=escalation_id,
                severity="MEDIUM",
                reason=(
                    f"adapter {tool_id!r} is promotion-ready (precision="
                    f"{readiness['precision']}, anchors="
                    f"{readiness['anchor_judged_count']}); "
                    + (
                        "scope touches aria-kernel/** so the operator must approve"
                        if kernel_scoped else
                        "panel approval opens a 24h operator veto window"
                    )
                ),
                context={
                    "kind": KERNEL_SCOPE_CONTEXT_KIND if kernel_scoped else PROMOTION_CONTEXT_KIND,
                    "tool_id": tool_id,
                    "precision": readiness["precision"],
                    "anchor_judged_count": readiness["anchor_judged_count"],
                    "evidence_refs": [f"aria-tools/runs.jsonl#{tool_id}"],
                    "cycle_id": cycle_id,
                },
                base_dir=root,
            )
        except GovernanceError as exc:
            skipped.append({"tool_id": tool_id, "reason": str(exc)[:200]})
            continue
        opened.append({"tool_id": tool_id, "escalation_id": escalation_id})
    return {"status": "ok", "opened": opened, "skipped": skipped}


def execute_tool_promotion_panel_approval(
    *,
    escalation_id: str,
    record: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The panel's resolve quorum arms the operator veto window.

    Called by the adjudication fold AFTER the record resolves, mirroring
    ``agent_genesis.execute_genesis_panel_approval``. It does NOT activate
    the tool: ``promote_tool`` returns the pending record and
    ``promotion_veto.settle_pending_promotions`` activates a later cycle.
    """
    from .promotion import promote_tool

    root = ensure_tools_dir(base_dir)
    tool_id = str((record.get("context") or {}).get("tool_id") or "")
    if not tool_id:
        raise GovernanceError("tool_promotion_panel_approval_missing_tool_id")
    return promote_tool(
        tool_id,
        "ACTIVE",
        reason=f"panel approved promotion (adjudication {escalation_id})",
        panel_approval_ref=escalation_id,
        base_dir=root,
    )


__all__ = [
    "KERNEL_SCOPE_CONTEXT_KIND",
    "PROMOTION_CONTEXT_KIND",
    "execute_tool_promotion_panel_approval",
    "sweep_promotable_adapters_for_adjudication",
]
