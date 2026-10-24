"""WP-J D-1 — the ONE stability lane: re-ask a judge its own question, blind.

The operator's protocol item 9 (2026-10-18): "a stability check (re-ask)".
A judge whose verdict is not reproducible under its own question is not a
measurement instrument, however calibrated it reads. This module owns the
whole lane — nothing else re-asks a judge:

  * CANDIDATES (``stability_candidates``): the groups whose stability
    matters most — ``judge_fanout.anchor_candidate_groups`` (unanimous
    pairs one arbiter away from ground truth) plus a seeded sample of
    dead-ended escalations (``single_judge`` / ``low_confidence`` groups
    the consensus engine recorded in the uncertainties ledger). WP-J-1's
    decision-questioning-for-findings variant is retired on the record:
    role 'verification' minted 0 envelopes ever.
  * THE RE-ASK (``mint_stability_reasks``): re-mint the judge's ORIGINAL
    envelope verbatim (same prompt, same obligations — read back from the
    request ledger, not re-derived, so the question cannot drift) under a
    ``stability:`` group, with the evidence order shuffled by a seed
    derived from ``(group, seat)``. BLIND by construction: the original
    envelope never carried a verdict, and the re-ask adds none.
    Idempotent per ``(group, seat, seed)`` — the seed is stable forever,
    so every seat is re-asked at most once, and the re-ask's verdict lands
    through the normal judge bridge under the stability group.
  * CADENCE: an explicit function of the MEASURED judgment drain
    (``judgment_drain_per_night`` in the judgment-pipeline policy). With
    the drain measured dead (last judgment-lane mint 2026-10-01, 1382
    stale-anchor refusals) the lane's budget is zero: it HOLDS (records
    ``held:drain_dead``, mints nothing, fails nothing). A stability lane
    that re-asked into a dead drain would only manufacture stale anchors.
  * THE FLIP TABLE (``collect_stability_flips``): when a re-ask verdict
    lands, it is compared with the seat's original verdict and ONE row is
    appended to the flips ledger — the ONE flip table. Its two consumers:
    the weight temper (``calibrated_intelligence.judge_weights_from_
    calibration`` via ``load_flip_rates``) and the promotion bar
    (``finding_promotion`` via ``unstable_anchor_groups``): an ANCHOR that
    flipped is recorded as anchor instability and its finding is not
    promoted. One table, two readers, no second flip accounting.
"""
from __future__ import annotations

import random
from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request, list_agent_invocation_requests
from .calibrated_intelligence import deterministic_seed
from .feedback_store import load_feedback, load_jsonl
from .ledger import append_declared_jsonl, load_declared_jsonl
from .judge_fanout import JUDGE_FANOUT, _existing_judge_dispatches, anchor_candidate_groups
from .request_admission import admit_request
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

STABILITY_GROUP_PREFIX = "stability:"
# The dead-end escalation reasons worth one blind re-ask: a group stuck at
# one judge, and a pair whose confidence never cleared the gate. Other
# uncertainties (evidence refusals, uncalibrated gates) are not stability
# questions — they are evidence and calibration questions with their own
# owners.
DEAD_END_REASONS: tuple[str, ...] = ("single_judge", "low_confidence")
# The measured-drain key the judgment-pipeline policy carries (WP-J C-1).
# Read, never re-measured here: the funnel owns the measurement.
DRAIN_POLICY_KEY = "judgment_drain_per_night"


def stability_flips_path(base_dir: str | Path | None = None) -> Path:
    """The ONE flip table: one row per settled stability re-ask."""
    return ensure_tools_dir(base_dir) / "stability" / "stability-flips.jsonl"


def _stability_group(group_id: str, agent: str, seed: int) -> str:
    """The re-ask's group identity — (group, seat, seed) in one string.

    The seed is derived from (group, seat), so the identity is stable
    across cycles and the fan-out's own ``(group, agent)`` idempotency key
    makes the re-ask once-ever per seat.
    """
    return f"{STABILITY_GROUP_PREFIX}{group_id}:{agent}:{seed & 0xFFFFFFFF:x}"


def stability_budget(*, base_dir: str | Path | None = None, cap: int | None = None,
                     drain: float | None = None) -> tuple[int, str]:
    """How many re-ask envelopes this cycle may mint, and why.

    An explicit function of the MEASURED drain (the WP-J drain gate): the
    lane may never mint more than the drain can carry, and with no
    measured drain it mints nothing. ``cap``/``drain`` override the policy
    for fixtures; production reads the judgment-pipeline policy block the
    funnel owns.
    """
    root = ensure_tools_dir(base_dir)
    if drain is None:
        from .genesis_policy import judgment_pipeline_policy

        try:
            drain = float(judgment_pipeline_policy().get(DRAIN_POLICY_KEY) or 0.0)
        except (OSError, ValueError, KeyError, TypeError):
            drain = 0.0
    budget = int(min(cap if cap is not None else drain, drain))
    if budget <= 0:
        return 0, f"held:drain_{drain!r}"
    return budget, f"drain:{drain}"


def _dead_end_groups(*, base_dir: Path, sample_seed: int, limit: int) -> list[dict[str, Any]]:
    """A seeded sample of dead-ended escalations worth one blind re-ask."""
    path = root_uncertainties_path(base_dir)
    if not path.exists():
        return []
    seen: set[tuple[str, str, str, str]] = set()
    candidates: list[dict[str, Any]] = []
    for logged in load_jsonl(path):
        for item in logged.get("uncertainties") or []:
            reason = str(item.get("reason") or "")
            if reason not in DEAD_END_REASONS:
                continue
            key = (
                str(item.get("tool_id") or ""), str(item.get("run_id") or ""),
                str(item.get("finding_id") or ""), str(item.get("judgment_group_id") or ""),
            )
            if not all(key) or key in seen:
                continue
            seen.add(key)
            candidates.append(item)
    if len(candidates) <= limit:
        return candidates
    rng = random.Random(sample_seed)
    return sorted(rng.sample(candidates, limit), key=lambda c: str(c.get("judgment_group_id")))


def root_uncertainties_path(root: Path) -> Path:
    return root / "feedback-consensus-uncertainties.jsonl"


def stability_candidates(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    dead_end_sample: int = 0,
    dead_end_sample_seed: int = 0,
    demand: int = 0,
) -> list[dict[str, Any]]:
    """Groups whose stability the lane examines, newest obligation first.

    ``judge_fanout.anchor_candidate_groups`` (the anchor arm's own
    targeting: unanimous pairs below the anchor floor) plus, when
    ``dead_end_sample`` > 0, a seeded sample of dead-ended single-judge /
    low-confidence escalations. The re-ask targets the SEATS of these
    groups, one envelope per seat. ``demand`` is passed through to the
    anchor targeting: without it only false-positive pairs (the
    unconditional suppression class) are returned, and a stability lane
    that never examined a true-positive pair would never test the pair
    class that promotes findings.
    """
    root = ensure_tools_dir(base_dir)
    candidates: list[dict[str, Any]] = [
        {
            "tool_id": str(group.get("tool_id") or tool_id),
            "run_id": str(group.get("run_id") or ""),
            "finding_id": str(group.get("finding_id") or ""),
            "judgment_group_id": str(group.get("judgment_group_id") or ""),
            "seats": [str(judge.get("judge_id") or "") for judge in group.get("judges") or []],
            "origin": "anchor_candidate",
        }
        for group in anchor_candidate_groups(tool_id=tool_id, base_dir=root, demand=demand)
    ]
    if dead_end_sample > 0:
        for item in _dead_end_groups(
            base_dir=root, sample_seed=dead_end_sample_seed, limit=dead_end_sample,
        ):
            candidates.append({
                "tool_id": str(item.get("tool_id") or tool_id),
                "run_id": str(item.get("run_id") or ""),
                "finding_id": str(item.get("finding_id") or ""),
                "judgment_group_id": str(item.get("judgment_group_id") or ""),
                "seats": [],  # dead-ends resolve their seats from the ledger below
                "origin": f"dead_end:{item.get('reason')}",
            })
    return candidates


def _original_envelope(root: Path, group_id: str, agent: str) -> dict[str, Any] | None:
    """The judge's original request row — the envelope to re-mint verbatim.

    Latest wins: a seat re-minted by the anchor-stale lane is read at its
    newest envelope, which is the envelope the judge actually answered.
    """
    original = None
    for row in list_agent_invocation_requests(base_dir=root):
        if str(row.get("judgment_group_id") or "") != group_id:
            continue
        if str(row.get("target_agent") or "") != agent:
            continue
        original = row
    return original


def mint_stability_reasks(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
    cap: int | None = None,
    drain: float | None = None,
    dead_end_sample: int = 0,
) -> dict[str, Any]:
    """Re-mint the original judge envelopes under ``stability:`` groups.

    HOLD, never fail: an admission refusal or a dead drain is recorded as
    a held lane (the groups are re-derived next cycle), and the phase that
    calls this stays ``ok`` — the WP-J hold-not-fail discipline.
    """
    root = ensure_tools_dir(base_dir)
    budget, budget_reason = stability_budget(base_dir=root, cap=cap, drain=drain)
    if budget <= 0:
        return {
            "schema_version": 1, "tool_id": tool_id, "cycle_id": cycle_id,
            "held": budget_reason, "minted_count": 0, "minted": [], "skipped": [],
        }
    existing = _existing_judge_dispatches(root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    sample_seed = deterministic_seed("stability-reask", str(cycle_id or ""), tool_id)
    for candidate in stability_candidates(
        tool_id=tool_id, base_dir=root,
        dead_end_sample=dead_end_sample, dead_end_sample_seed=sample_seed,
        demand=budget,
    ):
        group_id = str(candidate.get("judgment_group_id") or "")
        if not group_id:
            continue
        for _role, agent in JUDGE_FANOUT:
            if len(minted) >= budget:
                skipped.append({"judgment_group_id": group_id, "target_agent": agent,
                                "reason": "stability_budget_spent"})
                continue
            seed = deterministic_seed("stability-reask", group_id, agent)
            stability_group = _stability_group(group_id, agent, seed)
            if (stability_group, agent) in existing:
                skipped.append({"judgment_group_id": group_id, "target_agent": agent,
                                "reason": "already_reasked"})
                continue
            original = _original_envelope(root, group_id, agent)
            if original is None:
                # The seat never had an envelope here (a dead-end group's
                # second seat, a pruned ledger): nothing to re-mint.
                skipped.append({"judgment_group_id": group_id, "target_agent": agent,
                                "reason": "original_envelope_missing"})
                continue
            role = str(original.get("role") or "")
            if role not in {r for r, _a in JUDGE_FANOUT}:
                skipped.append({"judgment_group_id": group_id, "target_agent": agent,
                                "reason": "not_a_judge_seat"})
                continue
            admission = admit_request(
                "stability_reask.lane", role, base_dir=root, cycle_id=cycle_id,
            )
            if not admission.admitted:
                skipped.append({"judgment_group_id": group_id, "target_agent": agent,
                                "reason": admission.refusal})
                continue
            # Seed-shuffled evidence order: the question is identical, the
            # ORDER the evidence arrives in is not — an order-dependent
            # verdict is exactly the fragility this lane exists to catch.
            refs = [str(ref) for ref in original.get("evidence_refs") or [] if str(ref).strip()]
            rng = random.Random(seed)
            shuffled = list(refs)
            rng.shuffle(shuffled)
            req = create_agent_invocation_request(
                target_agent=agent,
                role=role,
                suggested_prompt=str(original.get("suggested_prompt") or ""),
                must_satisfy=original.get("must_satisfy") or None,
                allowed_scope=original.get("allowed_scope") or None,
                forbidden_scope=original.get("forbidden_scope") or None,
                evidence_refs=shuffled or None,
                # WP-J B-1 — the method the seat practiced is part of the
                # envelope's identity; the re-ask must not silently change
                # what kind of judge answered.
                agent_method=original.get("agent_method") or None,
                finding_id=str(original.get("finding_id") or ""),
                finding_fingerprint=str(original.get("finding_fingerprint") or ""),
                tool_id=str(original.get("tool_id") or tool_id),
                run_id=str(original.get("run_id") or ""),
                judgment_group_id=stability_group,
                cycle_id=cycle_id,
                target_sha=target_sha,
                base_dir=root,
                admission=admission,
            )
            minted.append({
                "request_id": req.get("request_id"), "role": role,
                "target_agent": agent, "judgment_group_id": group_id,
                "stability_group_id": stability_group, "seed": seed,
            })
            existing.add((stability_group, agent))
    return {
        "schema_version": 1, "tool_id": tool_id, "cycle_id": cycle_id,
        "budget": budget, "budget_reason": budget_reason,
        "minted_count": len(minted), "minted": minted, "skipped": skipped,
    }


def collect_stability_flips(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Compare landed re-ask verdicts to the originals; append ONE table.

    Idempotent per stability group: a group whose flip row exists is never
    re-compared. An anchor-grade original (its consensus row is ground
    truth) that flipped is flagged ``anchor_instability`` — the promotion
    bar refuses that group's finding until the record changes.
    """
    root = ensure_tools_dir(base_dir)
    flips_path = stability_flips_path(root)
    recorded: set[str] = {
        str(row.get("stability_group_id"))
        for row in (
            load_declared_jsonl(flips_path, expected_surface="stability_flips")
            if flips_path.exists() else []
        )
        if row.get("stability_group_id")
    }
    feedback = load_feedback(base_dir=root)
    original_by_judge: dict[tuple[str, str], dict[str, Any]] = {}
    for row in feedback:
        if row.get("source_type") != "ai_judge":
            continue
        gid = str(row.get("judgment_group_id") or "")
        if gid.startswith(STABILITY_GROUP_PREFIX):
            continue
        original_by_judge[(gid, str(row.get("judge_id") or ""))] = row
    anchor_groups: set[str] = set()
    for row in feedback:
        if row.get("source_type") != "ai_consensus":
            continue
        from .feedback_store import is_ground_truth_row

        if is_ground_truth_row(row):
            anchor_groups.add(str(row.get("judgment_group_id") or ""))

    def _split(stability_group: str) -> tuple[str, str]:
        # stability:<group>:<agent>:<seed> — the group may itself contain
        # colons, so split from the ends, not the front.
        body = stability_group[len(STABILITY_GROUP_PREFIX):]
        seed = body.rsplit(":", 1)[-1]
        head = body.rsplit(":", 2)[0]
        agent = head.rsplit(":", 1)[-1]
        return head, agent

    reask_by_stability: dict[str, dict[str, Any]] = {}
    for row in feedback:
        if row.get("source_type") != "ai_judge":
            continue
        gid = str(row.get("judgment_group_id") or "")
        if not gid.startswith(STABILITY_GROUP_PREFIX):
            continue
        reask_by_stability[gid] = row

    fresh: list[dict[str, Any]] = []
    for stability_group, reask in sorted(reask_by_stability.items()):
        if stability_group in recorded:
            continue
        group_id, agent = _split(stability_group)
        original = original_by_judge.get((group_id, str(reask.get("judge_id") or "")))
        if original is None:
            # The original verdict is gone (pruned ledger, judge renamed):
            # a comparison nobody can make is recorded as unprovable, not
            # silently dropped — the flip table must never under-count by
            # being quiet about what it could not read.
            fresh.append({
                "schema_version": 1, "recorded_at": utc_now(),
                "judgment_group_id": group_id, "stability_group_id": stability_group,
                "judge_id": str(reask.get("judge_id") or ""), "flipped": None,
                "anchor_flip": False, "reason": "original_verdict_missing",
            })
            continue
        flipped = str(original.get("verdict") or "") != str(reask.get("verdict") or "")
        anchor = group_id in anchor_groups
        fresh.append({
            "schema_version": 1, "recorded_at": utc_now(),
            "judgment_group_id": group_id, "stability_group_id": stability_group,
            "judge_id": str(reask.get("judge_id") or ""),
            "original_verdict": str(original.get("verdict") or ""),
            "reask_verdict": str(reask.get("verdict") or ""),
            "seed": None if not stability_group.rsplit(":", 1) else stability_group.rsplit(":", 1)[-1],
            "flipped": flipped, "anchor_flip": bool(flipped and anchor),
            "reason": "compared",
        })
    if fresh:
        flips_path.parent.mkdir(parents=True, exist_ok=True)
        for row in fresh:
            # Declared surface (state_manifest 'stability_flips'): the table
            # survives job teardown chained like every published ledger —
            # an unchained append is exactly the row teardown would drop.
            append_declared_jsonl(
                flips_path, row, expected_surface="stability_flips",
            )
    return {
        "schema_version": 1, "recorded_at": utc_now(),
        "examined": len(reask_by_stability), "recorded_count": len(fresh),
        "flip_count": sum(1 for row in fresh if row.get("flipped")),
        "anchor_flip_count": sum(1 for row in fresh if row.get("anchor_flip")),
        "rows": fresh,
    }


def load_flip_rates(*, base_dir: str | Path | None = None) -> dict[str, float]:
    """Per-judge flip rate from the ONE flip table — the temper's only input.

    Unprovable comparisons (``flipped=None``) count in the denominator: a
    re-ask whose original could not be read is still an ask the lane
    spent, and a judge whose flip rate is unknown is not a judge whose
    weight survives untouched.
    """
    root = ensure_tools_dir(base_dir)
    path = stability_flips_path(root)
    asks: dict[str, int] = {}
    flips: dict[str, int] = {}
    for row in (
        load_declared_jsonl(path, expected_surface="stability_flips")
        if path.exists() else []
    ):
        judge_id = str(row.get("judge_id") or "")
        if not judge_id:
            continue
        asks[judge_id] = asks.get(judge_id, 0) + 1
        if row.get("flipped"):
            flips[judge_id] = flips.get(judge_id, 0) + 1
    return {judge_id: flips.get(judge_id, 0) / count for judge_id, count in asks.items()}


def unstable_anchor_groups(*, base_dir: str | Path | None = None) -> set[str]:
    """Groups whose ANCHOR flipped — the promotion bar's reader."""
    root = ensure_tools_dir(base_dir)
    path = stability_flips_path(root)
    return {
        str(row.get("judgment_group_id"))
        for row in (
            load_declared_jsonl(path, expected_surface="stability_flips")
            if path.exists() else []
        )
        if row.get("anchor_flip") and row.get("judgment_group_id")
    }


def mint_stability_reasks_for_all_tools(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
    cap: int | None = None,
    drain: float | None = None,
    dead_end_sample: int = 0,
) -> dict[str, Any]:
    """The cycle-phase driver: every tool's lane, batch-contained."""
    from .tool_registry import list_tools

    root = ensure_tools_dir(base_dir)
    per_tool: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("kind") != "adapter":
            continue
        try:
            result = mint_stability_reasks(
                tool_id=tool_id, base_dir=root, cycle_id=cycle_id,
                target_sha=target_sha, cap=cap, drain=drain,
                dead_end_sample=dead_end_sample,
            )
        except GovernanceError as exc:
            per_tool.append({"tool_id": tool_id, "status": "blocked", "reason": str(exc)[:200]})
            continue
        per_tool.append({
            "tool_id": tool_id,
            "status": "held" if result.get("held") else "dispatched",
            "held": result.get("held"), "minted_count": result.get("minted_count"),
        })
    return {"schema_version": 1, "cycle_id": cycle_id, "tools": per_tool}
