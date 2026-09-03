"""Kernel-computed EVAL_WINDOW → ACTIVE superiority proof (Z3d).

WHY this module exists: `validate_transition` gated the ACTIVE promotion on
`evidence["eval_window_passed"]` — a CALLER-SUPPLIED, UNVERIFIED bool
(ORPHAN 630 class). Any caller could promote an agent by asserting the very
thing the gate existed to measure. The proof is now computed HERE, from the
same ledgers replay reads, and injected into the evidence by
`record_transition` — the caller's opinion no longer reaches the gate.

Two measured components:

* **Window superiority** — `agent_eval.compare_eval_windows` (the program's
  own success test, reused not rewritten): the promotion window must be
  `improved`. `insufficient_evidence`, `flat`, `regressed` all refuse —
  a promotion that cannot show measured improvement is not a promotion.
* **Duel superiority** — when `knowledge-graph/duel-ratings.jsonl` carries
  at least `min_duel_matches` decided duels involving the candidate, its
  Bradley-Terry rating must top every opponent it faced. Fewer matches →
  the duel component reports `not_evaluated` and the window alone decides
  (a thin duel ledger must not block the lane that FEEDS it).

Small on purpose — operator preference 2026-08-11: files stay short.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_eval import compare_eval_windows
from .calibrated_intelligence import bradley_terry
from .genesis_policy import SUPERIORITY_DEFAULTS, superiority_policy
from .ledger import load_jsonl
from .tool_registry import ensure_tools_dir

# A direction verdict that found material risks is a WIN for the reviewer
# of that direction (their scrutiny landed) and a LOSS for the reviewed
# plan's author. "agreed" duels are draws and carry no BT signal.
_WIN_VERDICTS = frozenset({"material_risks_present", "partial_coverage"})


def duel_observations(
    *, base_dir: str | Path | None = None
) -> list[dict[str, str]]:
    """Fold duel-ledger rows into Bradley-Terry {winner, loser} pairs."""
    root = ensure_tools_dir(base_dir)
    path = root / "knowledge-graph" / "duel-ratings.jsonl"
    observations: list[dict[str, str]] = []
    for row in load_jsonl(path) if path.exists() else []:
        primary = str(row.get("primary_agent") or "")
        challenger = str(row.get("challenger_agent") or "")
        if not primary or not challenger:
            continue
        verdicts = row.get("verdicts_by_direction") or {}
        if verdicts.get("primary_to_challenger") in _WIN_VERDICTS:
            observations.append({"winner": primary, "loser": challenger})
        if verdicts.get("challenger_to_primary") in _WIN_VERDICTS:
            observations.append({"winner": challenger, "loser": primary})
    return observations


def compute_eval_window_superiority(
    *,
    entity_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    """Deterministic promotion proof for one candidate.

    Returns a dict with `passed` (bool) + `reasons` (list) + the full
    window comparison and duel component, so the lifecycle row that
    carries it is recomputable from ledgers alone.
    """
    policy = superiority_policy(repo_root) if repo_root is not None else dict(SUPERIORITY_DEFAULTS)
    window = compare_eval_windows(
        target_agent=entity_id,
        base_dir=base_dir,
        window_days=int(policy["window_days"]),
    )
    reasons: list[str] = []
    if window["verdict"] != "improved":
        reasons.append(f"window_not_improved:{window['verdict']}")

    observations = duel_observations(base_dir=base_dir)
    involved = [
        o for o in observations if entity_id in (o["winner"], o["loser"])
    ]
    min_matches = int(policy["min_duel_matches"])
    duel: dict[str, Any]
    if len(involved) < min_matches:
        duel = {
            "status": "not_evaluated",
            "matches": len(involved),
            "min_duel_matches": min_matches,
        }
    else:
        ratings = bradley_terry(observations)
        own = ratings.get(entity_id, 0.0)
        opponents = sorted(
            {o["winner"] for o in involved} | {o["loser"] for o in involved}
        )
        opponents.remove(entity_id)
        top_opponent = max((ratings.get(op, 0.0) for op in opponents), default=0.0)
        duel = {
            "status": "evaluated",
            "matches": len(involved),
            "rating": own,
            "top_opponent_rating": top_opponent,
            "opponents": opponents,
        }
        if own <= top_opponent:
            reasons.append("duel_rating_not_superior")

    return {
        "schema_version": 1,
        "entity_id": entity_id,
        "window": window,
        "duel": duel,
        "passed": not reasons,
        "reasons": reasons,
    }
