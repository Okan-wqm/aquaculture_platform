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

# JJ-1 (ORPHAN-HIGH-731) - the SECOND reason to mint the arbiter: not a
# split, an ANCHOR. The split arm above only ever fires when the two judges
# disagree, so a consensus that will become ground truth was, until now,
# exactly the case nobody examined - agreement was treated as proof instead
# of as the thing to test. The anchor mint asks the arbiter to REFUTE a
# unanimous pair; surviving that is what promotes the row to ground truth
# (feedback_store.is_ground_truth_row). Same role, same agent, same
# (judgment_group_id, target_agent) idempotency key as the split arm, so a
# group can never carry two arbiters for two reasons.


def _finding_key(item: dict[str, Any]) -> str:
    """The run-independent identity of the finding being judged."""
    return str(item.get("finding_fingerprint") or item.get("finding_id") or "")


def _group_id(item: dict[str, Any]) -> str:
    """Y2 (ORPHAN-704) — the judgment group is keyed by the FINDING, not the run.

    The shipped key folded ``run_id`` in, so every nightly adapter run
    re-minted fresh envelopes for findings already sitting in the queue —
    462 minted, 42 accepted, 296 dead of anchor staleness in one week. With
    the run out of the key, the (group, agent) dedupe below becomes
    cross-night: a finding is asked once and re-examined only by the E9
    decision-questioning lane, which exists for exactly that.
    """
    return f"judge:{item.get('tool_id')}:{_finding_key(item)}"


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


def _judged_pairs(root: Path, tool_id: str) -> set[tuple[str, str]]:
    """(finding_key, judge_id) pairs that already carry an ai_judge verdict.

    A finding a judge has ALREADY answered must not be re-minted by the
    nightly fan-out regardless of ledger key drift — re-sampling closed
    verdicts is the decision-questioning lane's deliberate act, not the
    sampler's accident. Fingerprint preferred, finding_id fallback for
    rows recorded before fingerprints were threaded.
    """
    from .feedback_store import load_feedback

    pairs: set[tuple[str, str]] = set()
    try:
        rows = load_feedback(tool_id=tool_id, base_dir=root)
    except Exception:
        return pairs
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        key = str(row.get("finding_fingerprint") or row.get("finding_id") or "")
        judge = str(row.get("judge_id") or "")
        if key and judge:
            pairs.add((key, judge))
    return pairs


def pending_judge_counts(*, base_dir: str | Path | None = None) -> dict[str, int]:
    """Y2 (ORPHAN-704) — live (non-terminal) envelope count per judge role.

    Bounded to the anchor window: anything older is ANCHOR_STALE by
    definition, so deriving its state would only re-prove it dead.
    """
    from datetime import datetime, timedelta, timezone

    from .agent_invocations import derive_request_states, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES

    root = ensure_tools_dir(base_dir)
    horizon = datetime.now(timezone.utc) - timedelta(days=4)
    counts: dict[str, int] = {role: 0 for role, _ in JUDGE_FANOUT}
    # ORPHAN-HIGH-794 — one batch derivation instead of a per-row derive
    # (each of which reloaded all three ledgers — the OOM churn class).
    states = derive_request_states(base_dir=root)
    for row in list_agent_invocation_requests(base_dir=root):
        role = str(row.get("role") or "")
        if role not in counts:
            continue
        created = str(row.get("created_at") or "")
        try:
            created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            created_dt = None
        if created_dt is not None and created_dt < horizon:
            continue
        state = states.get(str(row.get("request_id")), "PENDING")
        if state not in TERMINAL_REQUEST_STATES:
            counts[role] += 1
    return counts


def dispatch_judges_for_sample(
    *,
    sample: dict[str, Any],
    base_dir: str | Path | None = None,
    target_sha: str | None = None,
    repo_root: str | Path | None = None,
    max_pending_per_role: int | None = None,
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
    # Y2 (ORPHAN-704) — backlog gate: when the executor's drain is behind,
    # minting more envelopes only manufactures anchor-stale corpses. The
    # ceiling is per role; freshly minted envelopes count toward it within
    # this call so one large sample cannot blow through the cap.
    pending = pending_judge_counts(base_dir=root) if max_pending_per_role is not None else {}
    judged: dict[str, set[tuple[str, str]]] = {}
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        group = _group_id(item)
        prompt = _render_prompt(item)
        refs = _evidence_refs(item)
        tool_id = str(item.get("tool_id") or "")
        if tool_id not in judged:
            judged[tool_id] = _judged_pairs(root, tool_id)
        finding_key = _finding_key(item)
        for role, agent in JUDGE_FANOUT:
            if (group, agent) in existing:
                skipped.append({"judgment_group_id": group, "target_agent": agent, "reason": "already_dispatched"})
                continue
            if (finding_key, agent) in judged[tool_id]:
                skipped.append({"judgment_group_id": group, "target_agent": agent, "reason": "already_judged"})
                continue
            if max_pending_per_role is not None and pending.get(role, 0) >= max_pending_per_role:
                skipped.append({
                    "judgment_group_id": group, "target_agent": agent,
                    "reason": "mint_skipped_backlog",
                    "pending": pending.get(role, 0),
                    "max_pending_per_role": max_pending_per_role,
                })
                continue
            req = create_agent_invocation_request(
                target_agent=agent,
                role=role,
                suggested_prompt=prompt,
                must_satisfy=[{"id": "verdict", "criterion": "Return true_positive or false_positive with file:line evidence"}],
                allowed_scope=["**"],
                evidence_refs=refs or None,
                finding_id=str(item.get("finding_id") or ""),
                # ORPHAN-HIGH-765 — thread the sampler's fingerprint onto the
                # mint so the verdict bridge can source identity from the
                # request (D1) instead of trusting the judge to echo it.
                finding_fingerprint=str(item.get("finding_fingerprint") or ""),
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
            if max_pending_per_role is not None:
                pending[role] = pending.get(role, 0) + 1
    return {"schema_version": 1, "minted_count": len(minted), "minted": minted, "skipped": skipped}


def _judge_rows_by_group(
    tool_id: str,
    base_dir: str | Path | None,
) -> tuple[
    dict[tuple[str, str, str], dict[str, dict[str, Any]]],
    dict[tuple[str, str, str], int],
]:
    """(votes-by-judge, settled-judge-count) per judgment group.

    Mirrors the grouping in ``feedback_store.generate_ai_consensus`` (same
    key, same ``ai_judge`` filter) rather than re-deriving a second notion of
    "the same finding": a group this module calls split is exactly the group
    that engine calls ``judge_disagreement``. The settled map carries the
    judge_count of the consensus already recorded (0 when none), which is
    what lets the split arm skip settled groups while the anchor arm targets
    the ones settled BELOW the anchor floor.
    """
    from .feedback_store import consensus_judge_count, load_feedback

    rows = load_feedback(tool_id=tool_id, base_dir=base_dir)
    settled: dict[tuple[str, str, str], int] = {}
    grouped: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = {}
    for row in rows:
        key = (
            str(row.get("run_id") or ""),
            str(row.get("finding_id") or ""),
            str(row.get("judgment_group_id") or ""),
        )
        if row.get("source_type") == "ai_consensus":
            settled[key] = max(settled.get(key, 0), consensus_judge_count(row))
            continue
        if row.get("source_type") != "ai_judge":
            continue
        judge_id = str(row.get("judge_id") or "")
        if not key[0] or not key[1] or not judge_id:
            continue
        # Last row per judge wins, exactly as the consensus engine does: a
        # judge that re-submitted must not be counted as two voters.
        grouped.setdefault(key, {})[judge_id] = row
    return grouped, settled


def split_verdict_groups(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Judgment groups where >=2 judges voted and their verdicts disagree.

    Groups that already carry an ``ai_consensus`` row are settled and never
    returned.
    """
    grouped, settled = _judge_rows_by_group(tool_id, base_dir)

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
        minted.append(_mint_arbiter(
            root,
            tool_id=tool_id,
            group=split,
            prompt=_render_arbiter_prompt(split),
            criterion=(
                "Aggregate the supplied judge verdicts and return "
                "details.consensus, or the uncertainty reason when the "
                "consensus gate cannot be met"
            ),
            cycle_id=cycle_id,
            target_sha=target_sha,
        ))
        existing.add((group, CONSENSUS_ARBITER_AGENT))
    return {"schema_version": 1, "minted_count": len(minted), "minted": minted, "skipped": skipped}


def _mint_arbiter(
    root: Path,
    *,
    tool_id: str,
    group: dict[str, Any],
    prompt: str,
    criterion: str,
    cycle_id: str | None,
    target_sha: str | None,
) -> dict[str, Any]:
    """One arbiter envelope. Shared by the split arm and the anchor arm so a
    change to the arbiter's contract cannot land on one lane only."""
    group_id = str(group.get("judgment_group_id") or "")
    refs = sorted({
        ref
        for judge in group.get("judges") or []
        for ref in judge.get("evidence_refs") or []
    })
    req = create_agent_invocation_request(
        target_agent=CONSENSUS_ARBITER_AGENT,
        role=CONSENSUS_ARBITRATION_ROLE,
        suggested_prompt=prompt,
        must_satisfy=[{"id": "consensus", "criterion": criterion}],
        allowed_scope=["**"],
        evidence_refs=refs or None,
        finding_id=str(group.get("finding_id") or ""),
        tool_id=tool_id,
        run_id=str(group.get("run_id") or ""),
        judgment_group_id=group_id,
        cycle_id=cycle_id,
        target_sha=target_sha,
        base_dir=root,
    )
    return {
        "request_id": req.get("request_id"),
        "role": CONSENSUS_ARBITRATION_ROLE,
        "target_agent": CONSENSUS_ARBITER_AGENT,
        "judgment_group_id": group_id,
    }


# The literal first line of the ANCHOR brief. The anchor arm and the split
# arm share one role (``consensus_arbitration``) and one agent, and the two
# ask for OPPOSITE behaviour — aggregate vs. judge afresh. The mode marker is
# what lets the agent contract state both without either being prose the
# model has to infer: `.claude/agents/aria-consensus-arbiter.md` keys its
# ANCHOR ARBITRATION MODE section on this exact string, and
# test_jj1_anchor_consensus pins that the two stay in step.
ANCHOR_MODE_MARKER: str = "MODE: anchor_refutation"


def _render_anchor_prompt(group: dict[str, Any]) -> str:
    """The arbiter's ANCHOR brief: refute, do not ratify.

    Deliberately NOT the split brief. Asking a third judge to "aggregate two
    agreeing verdicts" produces a rubber stamp, and a rubber stamp promoted
    to ground truth is worse than no third judge at all - it launders the
    pair's blind spot into repository truth. The anchor brief withholds
    nothing but demands an INDEPENDENT verdict with its own evidence.
    """
    lines = [
        ANCHOR_MODE_MARKER,
        "Two independent judges AGREE about this adapter finding. Their "
        "agreement is about to become repository ground truth (it will "
        "suppress findings, quarantine rules and score judges), so it must "
        "survive one attempt to refute it.",
        f"tool_id: {group.get('tool_id')}",
        f"run_id: {group.get('run_id')}",
        f"finding_id: {group.get('finding_id')}",
        f"judgment_group_id: {group.get('judgment_group_id')}",
        "Prior judge verdicts:",
    ]
    for judge in group.get("judges") or []:
        lines.append(
            f"- {judge.get('judge_id')}: verdict={judge.get('verdict')} "
            f"confidence={judge.get('confidence')} "
            f"rationale={str(judge.get('rationale') or '')[:300]}"
        )
    lines.append(
        "Judge the finding YOURSELF from the repository, then say whether the "
        "prior verdicts survive. Return details.consensus with verdict "
        "true_positive|false_positive, confidence, and the file:line evidence "
        "you relied on. Disagreeing is a correct answer — and it is a "
        "CONSEQUENTIAL one: a verdict you refuse to back can never reach "
        "anchor grade, because the kernel counts the judges who AGREED with "
        "the settled verdict, not the judges who voted. Do NOT restate the "
        "prior rationales as your own."
    )
    return "\n".join(lines)


def anchor_candidate_groups(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    demand: int = 0,
) -> list[dict[str, Any]]:
    """Unanimous 2-judge groups that must be re-examined by the arbiter.

    Two demands, and only two, because the arbiter costs an LLM call:

    * a ``false_positive`` verdict is UNCONDITIONAL - that is the row that
      suppresses a finding class forever, and suppression is the one
      consequence no later evidence can undo;
    * ``demand`` is the readiness shortfall (how many more anchors the tool
      needs before its precision counts as judged, JJ-2a). Once the tool has
      enough anchors the demand is zero and routine consensus stays 2-judge -
      the cost bound is a consequence of the gate, not a separate knob.

    Split groups are NOT returned: they belong to
    ``dispatch_arbiter_for_split_verdicts``, which mints the same arbiter for
    the same group key.
    """
    from .feedback_store import ANCHOR_MIN_JUDGE_COUNT

    grouped, settled = _judge_rows_by_group(tool_id, base_dir)
    remaining = max(int(demand), 0)
    candidates: list[dict[str, Any]] = []
    for (run_id, finding_id, group_id), by_judge in sorted(grouped.items()):
        if len(by_judge) < 2 or len(by_judge) >= ANCHOR_MIN_JUDGE_COUNT:
            continue
        if settled.get((run_id, finding_id, group_id), 0) >= ANCHOR_MIN_JUDGE_COUNT:
            continue
        verdicts = {str(row.get("verdict") or "") for row in by_judge.values()}
        if len(verdicts) != 1:
            continue
        verdict = verdicts.pop()
        if verdict != "false_positive":
            if remaining <= 0:
                continue
        remaining = max(remaining - 1, 0)
        candidates.append({
            "tool_id": tool_id,
            "run_id": run_id,
            "finding_id": finding_id,
            "judgment_group_id": group_id,
            "verdict": verdict,
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
    return candidates


def dispatch_arbiter_for_anchor_groups(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
) -> dict[str, Any]:
    """JJ-1 - mint the third judge that turns agreement into an ANCHOR.

    The readiness shortfall is derived here, not passed in, so the mint and
    the gate can never disagree about how many anchors a tool still owes.
    Idempotent on the same ``(judgment_group_id, target_agent)`` key the
    split arm uses.
    """
    from .feedback_store import (
        ANCHOR_PROMOTION_MIN_JUDGMENTS,
        anchor_group_keys,
    )

    root = ensure_tools_dir(base_dir)
    existing = _existing_judge_dispatches(root)
    demand = max(
        ANCHOR_PROMOTION_MIN_JUDGMENTS
        - len(anchor_group_keys(tool_id=tool_id, base_dir=root)),
        0,
    )
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for candidate in anchor_candidate_groups(
        tool_id=tool_id, base_dir=root, demand=demand,
    ):
        group = str(candidate.get("judgment_group_id") or "")
        if (group, CONSENSUS_ARBITER_AGENT) in existing:
            skipped.append({
                "judgment_group_id": group,
                "target_agent": CONSENSUS_ARBITER_AGENT,
                "reason": "already_dispatched",
            })
            continue
        minted.append(_mint_arbiter(
            root,
            tool_id=tool_id,
            group=candidate,
            prompt=_render_anchor_prompt(candidate),
            criterion=(
                "Judge the finding independently and return details.consensus "
                "with your own file:line evidence; disagreement with the prior "
                "judges is a valid answer"
            ),
            cycle_id=cycle_id,
            target_sha=target_sha,
        ))
        existing.add((group, CONSENSUS_ARBITER_AGENT))
    return {
        "schema_version": 1,
        "anchor_demand": demand,
        "minted_count": len(minted),
        "minted": minted,
        "skipped": skipped,
    }


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
