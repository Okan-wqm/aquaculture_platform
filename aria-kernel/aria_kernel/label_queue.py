"""The label queue — the sample a human label can bind to.

Typed-judgment plan Phase 6 (ARIA-HIGH-165, ARIA-MEDIUM-172's sibling
F13). Measured: `_sampleable_raw_findings` never re-samples a
``(run_id, finding_id)`` that carries any feedback row, and the batch lane
refuses a verdict outside the sample's items — so once the judges voted on
a finding there was no sample an operator label could bind to, and the
one batch lane that existed wrote ``judgment_group_id = sample_id``, a key
no judge group carries. The queue writes ITS OWN judgment-sample row from
the judge groups themselves (run id, finding id, the judges' group id,
the fingerprint) in three strata, so a label lands on the exact group the
judges voted on and the calibration can read it:

* ``escalated`` — groups the consensus could not settle (the uncertainty
  ledger: `confidence_uncalibrated`, `judge_disagreement`, `low_confidence`,
  `conformal_abstain`); the hard cases, reported by the calibration and
  never the basis of `calibrated` (selection bias, review C3);
* ``auto_closed_random`` — a seeded random draw over the groups a consensus
  DID settle: the stratum the 0.80 gate acts on, and the one that audits it;
* ``pending_random`` — a seeded random draw over single-judge groups.

The pre-filled verdict file carries ``verdict: null`` and
``confirmed_by_operator: false``: an AI verdict is never pre-filled, and
the batch lane refuses a null verdict and an unconfirmed item, so an
unchanged file mints nothing.

ARIA-MEDIUM-276 — a label used as ground truth is collected BLIND and with
its inclusion probability recorded, so a precision estimate built from it
can be unbiased:

* nothing a labeler reads carries the judges' verdicts: neither the
  verdict file nor the sample (published on the state store) embeds the
  votes; the group id joins the label to them afterwards;
* the draw is a stratified simple random sample without replacement — an
  equal share per stratum, then the unfilled slots drawn from every
  stratum's remainder pooled — and each item records the probability it
  had of being drawn (:func:`_inclusion_probabilities`), with the design
  itself on the sample (``sampling_design``); the batch lane copies the
  probability onto the label's provenance;
* a labeler who cannot decide answers ``cannot_judge``
  (``feedback_store.LABEL_ABSTENTION``), recorded on the sample as
  non-response instead of forced into one of the two verdicts.
"""
from __future__ import annotations

import random
from pathlib import Path
from typing import Any

from .calibrated_intelligence import deterministic_seed
from .feedback_store import (
    CALIBRATION_STRATIFIED_STRATEGY,
    FEEDBACK_VERDICTS,
    LABEL_ABSTENTION,
    append_jsonl,
    judgment_samples_path,
    load_feedback,
    load_jsonl,
)
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

LABEL_QUEUE_STRATA: tuple[str, ...] = ("escalated", "auto_closed_random", "pending_random")
ESCALATED_REASONS: tuple[str, ...] = (
    "confidence_uncalibrated", "judge_disagreement", "low_confidence", "conformal_abstain",
)
DEFAULT_LABEL_QUEUE_LIMIT: int = 15


# The design every queue draws under, named on each sample.
SAMPLING_DESIGN_METHOD = "stratified_srswor_then_pooled_remainder_srswor"


def _key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (str(row.get("run_id") or ""), str(row.get("finding_id") or ""), str(row.get("judgment_group_id") or ""))


def _inclusion_probabilities(
    available: dict[str, int], first_draws: dict[str, int], remainder_draws: int,
) -> dict[str, float]:
    """Each stratum's per-item probability of being drawn under the queue's two-phase design.

    Phase one draws ``first_draws[s]`` of the ``available[s]`` items of
    stratum ``s`` without replacement; phase two draws ``remainder_draws``
    items without replacement from the pool of every stratum's undrawn
    items. An item of ``s`` is drawn in phase one with probability
    ``n_s / N_s``, and otherwise lands in a pool of ``M`` items of which
    ``r`` are drawn: ``pi_s = n_s/N_s + (1 - n_s/N_s) * r/M``.
    """
    pool = sum(available[s] - first_draws[s] for s in available)
    later = remainder_draws / pool if pool else 0.0
    return {
        stratum: (first_draws[stratum] / count) + (1 - first_draws[stratum] / count) * later
        for stratum, count in available.items()
        if count
    }


def build_label_queue(
    *, tool_id: str, base_dir: str | Path | None = None, limit: int = DEFAULT_LABEL_QUEUE_LIMIT,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Write one `calibration_stratified` judgment sample and return it with
    the pre-filled verdict file the operator completes."""
    if limit < 1:
        raise GovernanceError(f"label queue limit must be >= 1, got {limit!r}")
    root = ensure_tools_dir(base_dir)
    rows = load_feedback(tool_id=tool_id, base_dir=root)
    judged: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    consensus_keys: set[tuple[str, str, str]] = set()
    human_keys: set[tuple[str, str, str]] = set()
    for row in rows:
        source = row.get("source_type") or "human"
        key = _key(row)
        if not key[0] or not key[1]:
            continue
        if source == "ai_judge":
            judged.setdefault(key, []).append(row)
        elif source == "ai_consensus":
            consensus_keys.add(key)
        elif source == "human":
            human_keys.add(key)
    escalated_keys: set[tuple[str, str, str]] = set()
    uncertainties_path = root / "feedback-consensus-uncertainties.jsonl"
    for entry in (load_jsonl(uncertainties_path) if uncertainties_path.exists() else []):
        for unc in entry.get("uncertainties") or []:
            if isinstance(unc, dict) and unc.get("reason") in ESCALATED_REASONS and unc.get("tool_id") == tool_id:
                escalated_keys.add(_key(unc))
    candidates = {key: votes for key, votes in judged.items() if key not in human_keys}
    strata: dict[str, list[tuple[str, str, str]]] = {
        "escalated": sorted(k for k in candidates if k in escalated_keys),
        "auto_closed_random": sorted(k for k in candidates if k in consensus_keys and k not in escalated_keys),
        "pending_random": sorted(k for k in candidates if k not in consensus_keys and k not in escalated_keys),
    }
    rng = random.Random(deterministic_seed("label-queue", tool_id, cycle_id or "", str(limit)))
    # An equal share per stratum, possibly 0 (a limit below the stratum
    # count): the share used to be at least 1 and the list was then cut to
    # the limit in stratum order, so with `limit=1` the later strata could
    # never be drawn and no probability could describe the cut.
    share = limit // len(LABEL_QUEUE_STRATA)
    chosen: list[tuple[str, tuple[str, str, str]]] = []
    first_draws: dict[str, int] = {}
    for stratum in LABEL_QUEUE_STRATA:
        pool = list(strata[stratum])
        rng.shuffle(pool)
        first_draws[stratum] = min(share, len(pool))
        chosen.extend((stratum, key) for key in pool[:share])
    taken = {key for _s, key in chosen}
    leftovers = [(stratum, key) for stratum in LABEL_QUEUE_STRATA for key in strata[stratum] if key not in taken]
    rng.shuffle(leftovers)
    remainder_draws = min(limit - len(chosen), len(leftovers))
    chosen.extend(leftovers[:remainder_draws])
    available = {stratum: len(keys) for stratum, keys in strata.items()}
    probability = _inclusion_probabilities(available, first_draws, remainder_draws)
    items = []
    for stratum, key in chosen:
        votes = candidates[key]
        # Blind: the judges' votes stay on the feedback ledger, joined by
        # the group id; the item names the group, never what it voted.
        items.append({
            "run_id": key[0], "finding_id": key[1], "judgment_group_id": key[2], "tool_id": tool_id,
            "finding_fingerprint": next((str(v.get("finding_fingerprint")) for v in votes if v.get("finding_fingerprint")), ""),
            "stratum": stratum,
            "inclusion_probability": probability[stratum],
        })
    sample_id = f"labelq-{deterministic_seed('label-queue-id', tool_id, cycle_id or '', utc_now()) % 10**12:012d}"
    sample = {
        "schema_version": 1, "recorded_at": utc_now(), "sample_id": sample_id, "tool_id": tool_id,
        "cycle_id": cycle_id, "strategy": CALIBRATION_STRATIFIED_STRATEGY, "sample_size": limit,
        "min_judged_samples": 0, "status": "pending" if items else "empty", "sampled_count": len(items),
        "strata_available": available,
        "sampling_design": {
            "method": SAMPLING_DESIGN_METHOD,
            "first_draws": first_draws,
            "remainder_pool": len(leftovers),
            "remainder_draws": remainder_draws,
        },
        "items": items,
        "instructions": {
            "verdicts": [*FEEDBACK_VERDICTS, LABEL_ABSTENTION],
            "lane": "aria-kernel feedback record-batch --sample-id <sample_id> --file <verdicts.json>",
            "law": (
                "verdict is null until you decide; answer cannot_judge when the evidence decides neither; "
                "confirmed_by_operator must be true on every item"
            ),
        },
    }
    append_jsonl(judgment_samples_path(root), sample)
    verdict_file = {
        "sample_id": sample_id,
        "verdicts": [
            {"run_id": item["run_id"], "finding_id": item["finding_id"], "judgment_group_id": item["judgment_group_id"],
             "verdict": None, "severity": "medium", "note": "", "confirmed_by_operator": False}
            for item in items
        ],
    }
    return {"schema_version": 1, "sample": sample, "verdict_file": verdict_file}


__all__ = ["DEFAULT_LABEL_QUEUE_LIMIT", "ESCALATED_REASONS", "LABEL_QUEUE_STRATA", "SAMPLING_DESIGN_METHOD",
           "build_label_queue"]
