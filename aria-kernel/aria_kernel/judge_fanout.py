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

# E14 — the arbiter that the `consensus_arbitration` role always named and
# nothing ever minted. The fan-out above guarantees two judges; when those two
# disagree the mechanical gate (`feedback_store.generate_ai_consensus`) records
# a `judge_disagreement` uncertainty and the finding's verdict stops there. The
# arbiter is the tie-break: it reads the two verdicts, applies the same
# consensus gate the kernel applies, and its answer lands in the SAME judgment
# group as a third calibrated vote, so a weighted gate can settle the finding.
CONSENSUS_ARBITRATION_ROLE: str = "consensus_arbitration"
CONSENSUS_ARBITER_AGENT: str = "aria-consensus-arbiter"


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


def _existing_judge_dispatches(root: Path) -> set[tuple[str, str]]:
    """Already-minted (judgment_group_id, target_agent) pairs. Keyed per-agent
    (not per-group) so a group left with only one judge — e.g. the second mint
    raised mid-loop last cycle — gets its missing judge minted next run instead
    of being skipped forever and starving consensus."""
    try:
        rows = load_declared_jsonl(
            root / "agent-invocations" / "requests.jsonl",
            expected_surface="agent_invocation_requests",
        )
    except Exception:
        return set()
    return {
        (str(r.get("judgment_group_id")), str(r.get("target_agent")))
        for r in rows
        if r.get("judgment_group_id") and r.get("target_agent")
    }


def dispatch_judges_for_sample(
    *,
    sample: dict[str, Any],
    base_dir: str | Path | None = None,
    target_sha: str | None = None,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    """Mint two judge envelopes per finding in a judgment sample.

    Returns a summary; the envelopes are picked up asynchronously by the
    dispatcher (claim_and_dispatch_one), so the resulting ai_judge rows — and
    thus consensus — land in a later tick, not this one.

    ``repo_root`` is the workspace the findings were produced against. Without
    it the mint cannot read the cited files, so the E17-b evidence excerpts —
    the whole reason two judges no longer have to open the same file twice —
    never attach on the one lane that dispatches two judges per finding. The
    caller already resolves this workspace for ``target_sha``; passing it here
    is what makes the packing fire in production rather than only in tests.
    """
    root = ensure_tools_dir(base_dir)
    items = sample.get("items") or []
    existing = _existing_judge_dispatches(root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        group = _group_id(item)
        prompt = _render_prompt(item)
        refs = _evidence_refs(item)
        for role, agent in JUDGE_FANOUT:
            if (group, agent) in existing:
                skipped.append({"judgment_group_id": group, "target_agent": agent, "reason": "already_dispatched"})
                continue
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
                context_repo_root=repo_root,
            )
            minted.append({
                "request_id": req.get("request_id"),
                "role": role,
                "target_agent": agent,
                "judgment_group_id": group,
            })
            existing.add((group, agent))
    return {"schema_version": 1, "minted_count": len(minted), "minted": minted, "skipped": skipped}


def split_verdict_groups(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Judgment groups where >=2 judges voted and their verdicts disagree.

    Mirrors the grouping in ``feedback_store.generate_ai_consensus`` (same
    key, same ``ai_judge`` filter) rather than re-deriving a second notion of
    "the same finding": a group that this function calls split is exactly the
    group that function calls ``judge_disagreement``. Groups that already
    carry an ``ai_consensus`` row are settled and never returned.
    """
    from .feedback_store import load_feedback

    rows = load_feedback(tool_id=tool_id, base_dir=base_dir)
    settled = {
        (str(r.get("run_id")), str(r.get("finding_id")), str(r.get("judgment_group_id") or ""))
        for r in rows
        if r.get("source_type") == "ai_consensus"
    }
    grouped: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = {}
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        run_id = str(row.get("run_id") or "")
        finding_id = str(row.get("finding_id") or "")
        judge_id = str(row.get("judge_id") or "")
        group_id = str(row.get("judgment_group_id") or "")
        if not run_id or not finding_id or not judge_id:
            continue
        # Last row per judge wins, exactly as the consensus engine does: a
        # judge that re-submitted must not be counted as two voters.
        grouped.setdefault((run_id, finding_id, group_id), {})[judge_id] = row

    splits: list[dict[str, Any]] = []
    for (run_id, finding_id, group_id), by_judge in sorted(grouped.items()):
        if (run_id, finding_id, group_id) in settled:
            continue
        if len(by_judge) < 2:
            continue
        verdicts = {str(row.get("verdict") or "") for row in by_judge.values()}
        if len(verdicts) < 2:
            continue
        splits.append({
            "tool_id": tool_id,
            "run_id": run_id,
            "finding_id": finding_id,
            "judgment_group_id": group_id,
            "judges": [
                {
                    "judge_id": judge_id,
                    "verdict": row.get("verdict"),
                    "confidence": row.get("confidence"),
                    "rationale": row.get("rationale") or row.get("note"),
                    "evidence_refs": [
                        ref for ref in (row.get("evidence_refs") or [])
                        if isinstance(ref, str) and ref.strip()
                    ],
                }
                for judge_id, row in sorted(by_judge.items())
            ],
        })
    return splits


def _render_arbiter_prompt(split: dict[str, Any]) -> str:
    lines = [
        "Two independent judges disagree about this adapter finding. Arbitrate.",
        f"tool_id: {split.get('tool_id')}",
        f"run_id: {split.get('run_id')}",
        f"finding_id: {split.get('finding_id')}",
        f"judgment_group_id: {split.get('judgment_group_id')}",
        "Judge verdicts:",
    ]
    for judge in split.get("judges") or []:
        lines.append(
            f"- {judge.get('judge_id')}: verdict={judge.get('verdict')} "
            f"confidence={judge.get('confidence')} rationale={str(judge.get('rationale') or '')[:300]}"
        )
    lines.append(
        "Aggregate the supplied verdicts under the consensus gate (>=2 unique "
        "judges, agreement, mean confidence >=0.80). Return details.consensus "
        "with verdict true_positive|false_positive, confidence, and the "
        "evidence you relied on; return the uncertainty reason instead when "
        "the gate cannot be met. Do not re-judge the finding from scratch."
    )
    return "\n".join(lines)


def dispatch_arbiter_for_split_verdicts(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
) -> dict[str, Any]:
    """Mint ONE arbiter envelope per split judgment group.

    Idempotent on the same key the judge fan-out uses — ``(judgment_group_id,
    target_agent)`` read back from the request ledger — so a group whose
    arbiter is still in flight is not asked again next cycle, and a group whose
    arbiter already answered is settled by the consensus engine, not by a
    second envelope.
    """
    root = ensure_tools_dir(base_dir)
    existing = _existing_judge_dispatches(root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for split in split_verdict_groups(tool_id=tool_id, base_dir=root):
        group = str(split.get("judgment_group_id") or "")
        if (group, CONSENSUS_ARBITER_AGENT) in existing:
            skipped.append({
                "judgment_group_id": group,
                "target_agent": CONSENSUS_ARBITER_AGENT,
                "reason": "already_dispatched",
            })
            continue
        refs = sorted({
            ref
            for judge in split.get("judges") or []
            for ref in judge.get("evidence_refs") or []
        })
        req = create_agent_invocation_request(
            target_agent=CONSENSUS_ARBITER_AGENT,
            role=CONSENSUS_ARBITRATION_ROLE,
            suggested_prompt=_render_arbiter_prompt(split),
            must_satisfy=[{
                "id": "consensus",
                "criterion": (
                    "Aggregate the supplied judge verdicts and return "
                    "details.consensus, or the uncertainty reason when the "
                    "consensus gate cannot be met"
                ),
            }],
            allowed_scope=["**"],
            evidence_refs=refs or None,
            finding_id=str(split.get("finding_id") or ""),
            tool_id=tool_id,
            run_id=str(split.get("run_id") or ""),
            judgment_group_id=group,
            cycle_id=cycle_id,
            target_sha=target_sha,
            base_dir=root,
        )
        minted.append({
            "request_id": req.get("request_id"),
            "role": CONSENSUS_ARBITRATION_ROLE,
            "target_agent": CONSENSUS_ARBITER_AGENT,
            "judgment_group_id": group,
        })
        existing.add((group, CONSENSUS_ARBITER_AGENT))
    return {"schema_version": 1, "minted_count": len(minted), "minted": minted, "skipped": skipped}


def pending_arbitration_group_ids(
    *,
    base_dir: str | Path | None = None,
) -> set[str]:
    """Judgment groups whose arbiter request has not reached a terminal state.

    The consensus-escalation sweep reads this to keep a split OUT of the
    HUMAN_REQUIRED queue while its arbitration is still in flight: arbitration
    first, the operator as the fallback. Without it a split verdict would raise
    an escalation AND an arbitration for the same group in the same cycle —
    two authorities on one question, which is the duplicate the role hygiene
    pass exists to remove.
    """
    from .agent_invocations import derive_request_state, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES

    pending: set[str] = set()
    for row in list_agent_invocation_requests(
        base_dir=base_dir, role=CONSENSUS_ARBITRATION_ROLE,
    ):
        group = str(row.get("judgment_group_id") or "")
        request_id = str(row.get("request_id") or "")
        if not group or not request_id:
            continue
        if derive_request_state(request_id=request_id, base_dir=base_dir) not in TERMINAL_REQUEST_STATES:
            pending.add(group)
    return pending
