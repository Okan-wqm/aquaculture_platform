"""Plan 025 §A — guarantee >=2 distinct judges per sampled finding.

``generate_judgment_sample`` produces a human worklist, not judge dispatch: it
mints no ``judge_id``, no ``judgment_group_id``, no envelopes. So for tool
findings the kernel never fanned out to two judges — a finding could get 0/1
``ai_judge`` row and sit as ``single_judge`` forever
(``feedback_store.generate_ai_consensus`` requires >=2 unique judges), starving
consensus and calibration of data.

This module turns each sampled finding into TWO judge invocation envelopes
(``aria-evidence-judge`` + ``aria-adversarial-judge``) sharing one
``judgment_group_id`` with distinct ``judge_id``, so consensus can fire by
construction once the judges respond. Idempotent: ``create_agent_invocation_request``
returns the existing request for identical args, and a finding whose group is
already dispatched is skipped.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request
from .ledger import load_declared_jsonl
from .tool_registry import ensure_tools_dir


# Two distinct judge roles → two distinct judge_ids on the same finding. The
# kernel's consensus gate needs exactly this to ever fire on a tool finding.
JUDGE_FANOUT: tuple[tuple[str, str], ...] = (
    ("evidence_judgment", "aria-evidence-judge"),
    ("adversarial_judgment", "aria-adversarial-judge"),
)


def _group_id(item: dict[str, Any]) -> str:
    return f"judge:{item.get('tool_id')}:{item.get('run_id')}:{item.get('finding_id')}"


def _render_prompt(item: dict[str, Any]) -> str:
    return (
        "Judge whether this adapter finding is a true_positive or false_positive.\n"
        f"finding_id: {item.get('finding_id')}\n"
        f"rule: {item.get('rule')}\n"
        f"severity: {item.get('severity')}\n"
        f"path: {item.get('path')}\n"
        f"message: {item.get('message')}\n"
        "Return verdict true_positive|false_positive with file:line evidence."
    )


def _evidence_refs(item: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    path = str(item.get("path") or "")
    if path:
        refs.append(path)
    for ev in item.get("evidence") or []:
        if isinstance(ev, str) and ev.strip():
            refs.append(ev)
    return refs


def _existing_judge_groups(root: Path) -> set[str]:
    try:
        rows = load_declared_jsonl(
            root / "agent-invocations" / "requests.jsonl",
            expected_surface="agent_invocation_requests",
        )
    except Exception:
        return set()
    return {str(r.get("judgment_group_id")) for r in rows if r.get("judgment_group_id")}


def dispatch_judges_for_sample(
    *,
    sample: dict[str, Any],
    base_dir: str | Path | None = None,
    target_sha: str | None = None,
) -> dict[str, Any]:
    """Mint two judge envelopes per finding in a judgment sample.

    Returns a summary; the envelopes are picked up asynchronously by the
    dispatcher (claim_and_dispatch_one), so the resulting ai_judge rows — and
    thus consensus — land in a later tick, not this one.
    """
    root = ensure_tools_dir(base_dir)
    items = sample.get("items") or []
    existing = _existing_judge_groups(root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        group = _group_id(item)
        if group in existing:
            skipped.append({"judgment_group_id": group, "reason": "already_dispatched"})
            continue
        prompt = _render_prompt(item)
        refs = _evidence_refs(item)
        for role, agent in JUDGE_FANOUT:
            req = create_agent_invocation_request(
                target_agent=agent,
                role=role,
                suggested_prompt=prompt,
                must_satisfy=[{"id": "verdict", "criterion": "Return true_positive or false_positive with file:line evidence"}],
                allowed_scope=["**"],
                evidence_refs=refs or None,
                finding_id=str(item.get("finding_id") or ""),
                tool_id=str(item.get("tool_id") or ""),
                run_id=str(item.get("run_id") or ""),
                judgment_group_id=group,
                cycle_id=sample.get("cycle_id"),
                target_sha=target_sha,
                base_dir=root,
            )
            minted.append({
                "request_id": req.get("request_id"),
                "role": role,
                "target_agent": agent,
                "judgment_group_id": group,
            })
        existing.add(group)
    return {"schema_version": 1, "minted_count": len(minted), "minted": minted, "skipped": skipped}
