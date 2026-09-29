"""Plan 024 §A — closed-loop judge calibration.

ARIA's trust rests on the judge → consensus chain, yet nothing measured whether
the judges are right. ``tool_health.compute_metrics`` scores the ADAPTER
(``tool_health.py`` precision), and a full grep shows no ``judge_id``-keyed
precision anywhere. This module fills that gap WITHOUT re-invoking any LLM: it
joins every ``ai_judge`` verdict to the ground-truth verdict on the same finding
and scores each ``judge_id`` over the accumulated feedback ledger.

Ground truth for a judge = an operator row or an ANCHOR consensus row (JJ-1:
>= 3 judges) on the same ``(run_id, finding_id, judgment_group_id)`` the judge
also voted on — the exact join ``generate_ai_consensus`` already uses to form
consensus. ``human`` outranks ``ai_consensus`` when both exist.

Why the anchor floor matters HERE most of all: a 2-judge consensus is formed
from the very judges being scored, so grading them against it graded each
judge partly against itself and rewarded agreement rather than correctness.

Cheap by construction: precision / recall / calibration come from verdicts and
confidences ALREADY recorded. NOTE on recall: this is recall over *surfaced*
findings only (the judge voted, and a ground truth exists). True
gold-set-replay recall — re-invoking judges on known findings they never saw —
needs LLM re-invocation and is tracked for Plan 025 (ARIA-024-D1).

G-2 — INDEPENDENCE IS MEASURED HERE, NOT ASSUMED UPSTREAM. Marginal precision
per judge says nothing about whether two judges are two OBSERVERS. The two
routine judges share a model and an effort tier, and ``judge_fanout`` renders
one prompt for both roles, so their agreement can be a property of the
renderer rather than of the finding. That matters most in this module,
because an ANCHOR is what promotes agreement to ground truth: correlated
judges manufacture the truth they are then scored against, and the score
comes back flattering. ``convergence_drainer``'s ``verify_independence`` is
STRUCTURAL (different agent id, different text) and cannot see this.

So the same ``_group_key`` pass that scores judges also measures every
unordered PAIR over the questions both answered: observed agreement,
chance-expected agreement, Cohen kappa. Kappa above the agreement ceiling
means one observer wearing two names — their anchors stop counting as ground
truth here, and ``judge_weights_from_calibration`` (the single consumer)
divides their weight so the pair can never carry two independent votes. The
pair axis rides beside ``judges[]`` on the same ledger row as
``judge_pairs[]``: no new ledger, no second read of the feedback store.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    append_jsonl,
    is_ground_truth_row,
    load_feedback,
)
from .tool_registry import ensure_tools_dir, utc_now


DEFAULT_MIN_SAMPLES: int = 10
DEFAULT_PRECISION_FLOOR: float = 0.7
# Mirrors judge_replay.REPLAY_GROUP_PREFIX (kept local to avoid an import cycle).
# Organic calibration must exclude gold-set replay verdicts that live under this
# group, or a judge's everyday precision/recall is corrupted by its replay run.
_REPLAY_GROUP_PREFIX: str = "replay:"

# G-2 — the pair axis needs its own sample floor, and it is NOT ``min_samples``.
# That floor counts a judge's ground-truth-backed verdicts; a pair is measured
# on the questions BOTH judges answered, a strictly smaller set. Measured on
# the published ledger (`git show origin/aria/state:tools/operator-feedback
# .jsonl`, 2026-08-20): 8 ai_judge rows over 6 judgments, of which 2 carried
# both judges. Eight is the window ``conformal_threshold`` already chose, for
# the same reason: below it the statistic is fitted to noise, and an
# independence claim fitted to noise is worse than no claim, because the anchor
# rule and the vote weights would both act on it.
DEFAULT_PAIR_MIN_OBSERVATIONS: int = 8

# Cohen kappa above this reads as ONE observer wearing two names. Kappa is
# CHANCE-CORRECTED, which is why the ceiling can sit this high without firing on
# an honest fleet: two judges who both answer "true_positive" to nearly
# everything agree constantly, and expected agreement subtracts exactly that
# base rate, leaving kappa near 0. 0.80 is the conventional "almost perfect"
# floor (Landis-Koch); at or below it each judge still carries information the
# other lacks, above it the second vote is the first vote re-rendered.
DEFAULT_AGREEMENT_CEILING: float = 0.8


def calibration_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "calibration" / "judge-calibration.jsonl"


def _group_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("run_id") or ""),
        str(row.get("finding_id") or ""),
        str(row.get("judgment_group_id") or ""),
    )


def _judge_votes_by_group(
    rows: list[dict[str, Any]],
) -> dict[tuple[str, str, str], dict[str, str]]:
    """Judge verdicts keyed by the judgment the judges shared.

    Last write wins per (judgment, judge) — the same reading
    ``generate_ai_consensus`` uses when it groups verdicts, so the pair axis
    and the consensus engine can never disagree about what a judge said on a
    question he answered twice.
    """
    votes: dict[tuple[str, str, str], dict[str, str]] = {}
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        judge_id = str(row.get("judge_id") or "")
        verdict = str(row.get("verdict") or "")
        if not judge_id or not verdict:
            continue
        votes.setdefault(_group_key(row), {})[judge_id] = verdict
    return votes


def _cohen_kappa(paired: list[tuple[str, str]]) -> tuple[float, float, float]:
    """(observed, chance-expected, kappa) over one pair's co-answered questions.

    Degenerate marginals — expected agreement 1.0, reached only when both
    judges gave ONE identical verdict to every shared question — make the
    textbook ratio 0/0. Reporting 0.0 there is the kappa paradox reading as
    INDEPENDENCE for the most redundant fleet observable: two judges that never
    once differed. Their kappa is the observed agreement, which on that branch
    is exactly 1.0, and the ceiling then treats them as the one observer they
    have proven themselves to be.
    """
    n = len(paired)
    observed = sum(1 for left, right in paired if left == right) / n
    categories = sorted({verdict for observation in paired for verdict in observation})
    left_counts = dict.fromkeys(categories, 0)
    right_counts = dict.fromkeys(categories, 0)
    for left, right in paired:
        left_counts[left] += 1
        right_counts[right] += 1
    expected = sum((left_counts[c] / n) * (right_counts[c] / n) for c in categories)
    if expected >= 1.0:
        return observed, expected, observed
    kappa = (observed - expected) / (1.0 - expected)
    return observed, expected, max(-1.0, min(1.0, kappa))


def _judge_pair_agreement(
    votes_by_group: dict[tuple[str, str, str], dict[str, str]],
    *,
    min_observations: int,
    agreement_ceiling: float,
) -> list[dict[str, Any]]:
    """One row per unordered judge pair: how much of their agreement is chance.

    The ceiling is applied HERE, once, and written onto the row as ``status``.
    Every later reader — this module's anchor rule, the operator report — reads
    that decision instead of re-deriving it, so the threshold has one owner
    rather than three copies drifting apart.
    """
    paired: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for votes in votes_by_group.values():
        judges = sorted(votes)
        for index, left in enumerate(judges):
            for right in judges[index + 1:]:
                paired.setdefault((left, right), []).append((votes[left], votes[right]))

    pairs: list[dict[str, Any]] = []
    for (left, right), observations in sorted(paired.items()):
        observed, expected, kappa = _cohen_kappa(observations)
        measured = len(observations) >= min_observations
        pairs.append({
            "judge_a": left,
            "judge_b": right,
            "co_observations": len(observations),
            "observed_agreement": round(observed, 3),
            "expected_agreement": round(expected, 3),
            # None until the pair has answered enough of the same questions.
            # The weight consumer keys on this ABSENCE, never on the status
            # string below, so "is this pair measured yet" stays a producer
            # decision with a single owner.
            "kappa": round(kappa, 3) if measured else None,
            "status": (
                "correlated" if measured and kappa > agreement_ceiling
                else "independent" if measured
                else "insufficient_data"
            ),
        })
    return pairs


def _correlated_observers(pairs: list[dict[str, Any]]) -> dict[str, str]:
    """judge_id -> observer id, collapsing every above-ceiling pair into one.

    Union-find rather than pairwise bookkeeping, because redundancy is
    transitive exactly where it costs: three judges rendered from one prompt
    are one observer, not three judges with three separate excuses.
    """
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for pair in pairs:
        if pair.get("status") != "correlated":
            continue
        left_root = find(str(pair.get("judge_a") or ""))
        right_root = find(str(pair.get("judge_b") or ""))
        if left_root != right_root:
            parent[max(left_root, right_root)] = min(left_root, right_root)
    return {judge: find(judge) for judge in sorted(parent)}


def _build_ground_truth(
    rows: list[dict[str, Any]],
    *,
    votes_by_group: dict[tuple[str, str, str], dict[str, str]],
    observer_of: dict[str, str],
) -> tuple[dict[tuple[str, str, str], str], set[tuple[str, str, str]]]:
    """Best ground-truth verdict per finding. human beats ai_consensus.

    G-2 — an ANCHOR claims three judges agreed and none dissented, and that
    claim buys ground-truth authority only if the three are three OBSERVERS.
    When the measured pair axis has collapsed two of them into one, the row is
    a 2-observer consensus wearing a 3-judge badge, and it is refused here
    rather than handed back to the judges who produced it as the standard they
    are scored against. Operator rows are untouched: a human verdict is ground
    truth unconditionally (JJ-2), so the fleet always keeps a truth source its
    own agreement cannot manufacture.

    The refusal fires only on MEASURED redundancy — an unmeasured pair leaves
    ``observer_of`` empty and every anchor stands, which is why this is inert
    on today's ledger and wakes up exactly when the evidence arrives.
    """
    truth: dict[tuple[str, str, str], tuple[str, str]] = {}
    invalidated: set[tuple[str, str, str]] = set()
    for row in rows:
        # JJ-1 — one predicate, five readers (see feedback_store).
        if not is_ground_truth_row(row):
            continue
        source = row.get("source_type") or "human"
        verdict = str(row.get("verdict") or "")
        if not verdict:
            continue
        key = _group_key(row)
        if source == "ai_consensus":
            voters = votes_by_group.get(key) or {}
            observers = {observer_of.get(judge, judge) for judge in voters}
            if voters and len(observers) < ANCHOR_MIN_JUDGE_COUNT:
                invalidated.add(key)
                continue
        existing = truth.get(key)
        # Feedback is append-only; an operator can correct an earlier call with a
        # later row. Last-write-wins within precedence: a later `human` always
        # overrides, a later `ai_consensus` overrides only when no `human` exists.
        if existing is None:
            truth[key] = (verdict, source)
        elif source == "human":
            truth[key] = (verdict, source)
        elif source == "ai_consensus" and existing[1] != "human":
            truth[key] = (verdict, source)
    return {key: verdict for key, (verdict, _src) in truth.items()}, invalidated


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def compute_judge_calibration(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    precision_floor: float = DEFAULT_PRECISION_FLOOR,
    pair_min_observations: int = DEFAULT_PAIR_MIN_OBSERVATIONS,
    agreement_ceiling: float = DEFAULT_AGREEMENT_CEILING,
    judgment_group_prefix: str | None = None,
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth and persist a row.

    Positive class = ``true_positive``. Per judge: precision, recall, accuracy,
    and a calibration signal (mean confidence on correct vs wrong calls). A
    judge with >= ``min_samples`` ground-truth-backed verdicts whose precision
    drops below ``precision_floor`` is reported ``degraded`` — the operator-
    visible, detectable signal that the cheap-tier judgment is slipping.

    ``judgment_group_prefix`` isolates a subset of verdicts by their
    ``judgment_group_id`` — Plan 025 §C passes ``"replay:"`` to score the
    gold-set replay independently from organic surfaced verdicts.

    G-2 adds a PAIR axis over the same rows and the same ``_group_key``:
    ``judge_pairs[]`` carries, per unordered judge pair, the questions both
    answered, their observed agreement, the agreement chance alone predicts,
    and Cohen kappa. Two consequences, both mechanical. A pair above
    ``agreement_ceiling`` counts as ONE observer, so an anchor that needed it
    twice to reach ``ANCHOR_MIN_JUDGE_COUNT`` stops being ground truth
    (``anchors_invalidated_by_correlation``). And the single consumer of this
    row, ``calibrated_intelligence.judge_weights_from_calibration``, divides a
    correlated judge's weight by its measured redundancy, so agreeing twice no
    longer outvotes an independent judge by arithmetic. Per-judge precision,
    recall and accuracy are computed exactly as before.
    """
    rows = load_feedback(base_dir=base_dir)
    if judgment_group_prefix is not None:
        rows = [
            r for r in rows
            if str(r.get("judgment_group_id") or "").startswith(judgment_group_prefix)
        ]
    else:
        # Organic calibration excludes gold-set replay verdicts (Plan 025 §C),
        # which live under the 'replay:' group — folding them into a judge's
        # everyday buckets corrupts its precision/recall and the degraded signal
        # that proactive prioritization + the operator report consume.
        rows = [
            r for r in rows
            if not str(r.get("judgment_group_id") or "").startswith(_REPLAY_GROUP_PREFIX)
        ]
    # Order is load-bearing: the pair axis needs no ground truth (judges are
    # compared to EACH OTHER), and the anchor rule needs the pair axis, so
    # measuring independence first is what breaks the circle in which judges
    # certified their own agreement as the truth they were then scored against.
    votes_by_group = _judge_votes_by_group(rows)
    judge_pairs = _judge_pair_agreement(
        votes_by_group,
        min_observations=pair_min_observations,
        agreement_ceiling=agreement_ceiling,
    )
    observer_of = _correlated_observers(judge_pairs)
    truth, invalidated_anchors = _build_ground_truth(
        rows, votes_by_group=votes_by_group, observer_of=observer_of,
    )

    agg: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        judge_id = str(row.get("judge_id") or "")
        judge_verdict = str(row.get("verdict") or "")
        if not judge_id or not judge_verdict:
            continue
        truth_verdict = truth.get(_group_key(row))
        if truth_verdict is None:
            continue
        bucket = agg.setdefault(
            judge_id,
            {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "n": 0, "correct": 0,
             "conf_correct": [], "conf_wrong": []},
        )
        bucket["n"] += 1
        correct = judge_verdict == truth_verdict
        if correct:
            bucket["correct"] += 1
        if truth_verdict == "true_positive":
            bucket["tp" if judge_verdict == "true_positive" else "fn"] += 1
        else:  # truth false_positive
            bucket["fp" if judge_verdict == "true_positive" else "tn"] += 1
        conf = row.get("confidence")
        if isinstance(conf, (int, float)):
            bucket["conf_correct" if correct else "conf_wrong"].append(float(conf))

    judges: list[dict[str, Any]] = []
    degraded: list[str] = []
    for judge_id, b in sorted(agg.items()):
        precision = round(b["tp"] / max(b["tp"] + b["fp"], 1), 3)
        recall = round(b["tp"] / max(b["tp"] + b["fn"], 1), 3)
        accuracy = round(b["correct"] / max(b["n"], 1), 3)
        if b["n"] < min_samples:
            status = "insufficient_data"
        elif precision < precision_floor:
            status = "degraded"
        else:
            status = "ok"
        if status == "degraded":
            degraded.append(judge_id)
        judges.append({
            "judge_id": judge_id,
            "samples": b["n"],
            "precision": precision,
            "recall": recall,
            "accuracy": accuracy,
            "true_positive": b["tp"],
            "false_positive": b["fp"],
            "false_negative": b["fn"],
            "true_negative": b["tn"],
            "mean_confidence_correct": _mean(b["conf_correct"]),
            "mean_confidence_wrong": _mean(b["conf_wrong"]),
            "status": status,
        })

    result = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "min_samples": min_samples,
        "precision_floor": precision_floor,
        "judged_judges": len(judges),
        "degraded_judges": degraded,
        "judges": judges,
        "pair_min_observations": pair_min_observations,
        "agreement_ceiling": agreement_ceiling,
        "judge_pairs": judge_pairs,
        "correlated_pair_count": sum(
            1 for pair in judge_pairs if pair["status"] == "correlated"
        ),
        # The number an operator should read as "this fleet was grading its own
        # homework": anchors refused because the judges behind them were not
        # independent observers.
        "anchors_invalidated_by_correlation": len(invalidated_anchors),
    }
    path = calibration_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, result)
    return result
