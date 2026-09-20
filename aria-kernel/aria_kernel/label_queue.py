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
"""
from __future__ import annotations

import random
from pathlib import Path
from typing import Any

from .calibrated_intelligence import deterministic_seed
from .feedback_store import (
    CALIBRATION_STRATIFIED_STRATEGY,
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


def _key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (str(row.get("run_id") or ""), str(row.get("finding_id") or ""), str(row.get("judgment_group_id") or ""))


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
    share = max(1, limit // len(LABEL_QUEUE_STRATA))
    chosen: list[tuple[str, tuple[str, str, str]]] = []
    for stratum in LABEL_QUEUE_STRATA:
        pool = list(strata[stratum])
        rng.shuffle(pool)
        chosen.extend((stratum, key) for key in pool[:share])
    if len(chosen) < limit:
        taken = {key for _s, key in chosen}
        leftovers = [(stratum, key) for stratum in LABEL_QUEUE_STRATA for key in strata[stratum] if key not in taken]
        rng.shuffle(leftovers)
        chosen.extend(leftovers[: limit - len(chosen)])
    chosen = chosen[:limit]
    items = []
    for stratum, key in chosen:
        votes = candidates[key]
        items.append({
            "run_id": key[0], "finding_id": key[1], "judgment_group_id": key[2], "tool_id": tool_id,
            "finding_fingerprint": next((str(v.get("finding_fingerprint")) for v in votes if v.get("finding_fingerprint")), ""),
            "stratum": stratum,
            "judge_verdicts": [
                {"judge_id": v.get("judge_id"), "verdict": v.get("verdict"), "confidence": v.get("confidence"),
                 "evidence_refs": list(v.get("evidence_refs") or [])}
                for v in votes
            ],
        })
    sample_id = f"labelq-{deterministic_seed('label-queue-id', tool_id, cycle_id or '', utc_now()) % 10**12:012d}"
    sample = {
        "schema_version": 1, "recorded_at": utc_now(), "sample_id": sample_id, "tool_id": tool_id,
        "cycle_id": cycle_id, "strategy": CALIBRATION_STRATIFIED_STRATEGY, "sample_size": limit,
        "min_judged_samples": 0, "status": "pending" if items else "empty", "sampled_count": len(items),
        "strata_available": {stratum: len(keys) for stratum, keys in strata.items()},
        "items": items,
        "instructions": {
            "verdicts": ["true_positive", "false_positive"],
            "lane": "aria-kernel feedback record-batch --sample-id <sample_id> --file <verdicts.json>",
            "law": "verdict is null until you decide; confirmed_by_operator must be true on every item",
        },
    }
    append_jsonl(judgment_samples_path(root), sample)
    verdict_file = {
        "sample_id": sample_id,
        "verdicts": [
            {"run_id": item["run_id"], "finding_id": item["finding_id"], "judgment_group_id": item["judgment_group_id"],
             "stratum": item["stratum"], "verdict": None, "severity": "medium", "note": "",
             "confirmed_by_operator": False}
            for item in items
        ],
    }
    return {"schema_version": 1, "sample": sample, "verdict_file": verdict_file}


__all__ = ["DEFAULT_LABEL_QUEUE_LIMIT", "ESCALATED_REASONS", "LABEL_QUEUE_STRATA", "build_label_queue"]
