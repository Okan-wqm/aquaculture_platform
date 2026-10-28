"""WP-J D-1 — outcome truth: a judged defect's mechanical outcome becomes
a feedback row that can score the judges.

WHY. Every ground-truth reader in the kernel scores judges against verdicts
the judge fleet itself produced (human rows aside — and the operator said
there will be none: "Ben uzman değilim"). The operator's alternative,
stated 2026-10-18, is machine-verifiable OUTCOME signals: "the fix's
red-first test, and a merged change that was not reverted". Those signals
already exist, each in its own ledger with its own owner:

  * ``repo_finding_events`` — ``finding_reproduced`` (a red run of a bound
    recipe CONFIRMS the defect, ``finding.record_finding_reproduction``) and
    ``finding_fix_verified`` (the SAME recipe re-runs green,
    ``finding.record_finding_fix_verification``);
  * ``change-ledger`` + ``pr-lifecycle.jsonl`` — the fix's change chain and
    its merge lineage (merge_record.merged_rows_by_change folds the attestation);
  * ``enterprise/self-reverts.jsonl`` — ARIA reverting its own merge.

Nothing joined them onto the judgment group that promoted the finding, so
outcome truth never existed as a scoreable row. This module is that join,
and ONLY that join: every rule above stays with its owner (the same-recipe
law is RE-CHECKED here structurally, not re-owned — the event producer
already refuses a mismatched recipe at append time; a reader that re-trusted
the pair without checking would grade a green run of a DIFFERENT recipe as
a fix).

WHAT MINTS. One ``source_type="outcome"`` row per ``(judgment_group_id,
consensus_run_id)`` — the join identity every promotions row already
carries (finding_promotion.promotion_row) — exactly when:

  * the consensus it promotes settled ``true_positive`` (an outcome can
    CONFIRM a defect that demonstrably existed; a false-positive consensus
    has no mechanical outcome proof — refuting a non-defect is the canary
    lane's constructed job, never this organic one);
  * the promoted finding ran RED under a recipe and verified GREEN under
    the SAME recipe;
  * a change chain exists for that finding whose merge is on the ledger
    and no self-revert row exists for that merge's ``revert:<sha>`` key
    (an unresolved revert attempt is not "not reverted" — fail closed).

SCOPE. The row widens CALIBRATION only: ``outcome`` is not in
``GROUND_TRUTH_SOURCE_TYPES``, so suppression, goldset admission and
promotion readiness keep refusing it (judge_calibration.
is_calibration_truth_row is the scoring-only sibling predicate, JJ-1
amended on the record there). Judges are scored AGAINST the outcome; the
outcome never acts as authority over a finding.

LOUD SKIPS. Every promotion row that does not mint is returned with a
named reason. A dead join must be visible, not a zero.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import load_feedback, load_jsonl, promotions_path, record_operator_feedback
from .tool_registry import ensure_tools_dir, utc_now

# The one source type this module mints; admitted by feedback_store's
# FEEDBACK_SOURCE_TYPES in the same commit as this first mint (the red test
# is the mint being refused before the widening).
OUTCOME_SOURCE_TYPE = "outcome"
# record_operator_feedback requires a judge_id on every non-human row; the
# named producer identity says WHO vouched — here, the mechanical join.
OUTCOME_TRUTH_JUDGE_ID = "aria-outcome-truth"


def _outcome_key(row: dict[str, Any]) -> tuple[str, str, str]:
    """The judgment-lane join identity an outcome row must land under."""
    return (
        str(row.get("run_id") or ""),
        str(row.get("finding_id") or ""),
        str(row.get("judgment_group_id") or ""),
    )


def _merged_not_reverted(tools_root: Path, finding_id: str) -> str | None:
    """Why the finding's fix is NOT (merged and not reverted), or None when it is.

    One law per owner, imported not copied: the change chain from
    ``change_ledger``, the merged row (with its lineage attestation folded)
    from ``merge_record.merged_rows_by_change``, the revert record from the
    ``self_revert`` ledger. Any self-revert row on the merge's key —
    terminal OR retried — disqualifies: a revert in flight is not a fix
    that held.
    """
    from .change_ledger import list_change_chains
    from .ledger import load_declared_jsonl
    from .merge_record import merged_rows_by_change
    from .self_revert import SELF_REVERTS_SURFACE, self_reverts_path

    chains = list_change_chains(finding_id=finding_id, base_dir=tools_root)
    if not chains:
        return "not_merged"
    index = merged_rows_by_change(tools_root)
    revert_rows = (
        load_declared_jsonl(self_reverts_path(tools_root), expected_surface=SELF_REVERTS_SURFACE)
        if self_reverts_path(tools_root).exists() else []
    )
    reverted_keys = {str(row.get("key") or "") for row in revert_rows}
    for chain in chains:
        merged = index.get(str(chain.get("planned", {}).get("change_id") or ""))
        if merged is None:
            continue
        merge_sha = str(merged.get("merge_sha") or "")
        if merge_sha and f"revert:{merge_sha}" in reverted_keys:
            return "self_reverted"
        return None
    return "not_merged"


def _red_then_green_reason(doc: dict[str, Any]) -> str | None:
    """Why the finding is NOT red-then-green same-recipe, or None when it is.

    Structural re-check of the two laws the event producers enforce at
    append time (``finding.record_finding_reproduction`` and
    ``finding.record_finding_fix_verification``): both blocks present, and the recipe
    that ran red is the recipe that verified green.
    """
    reproduction = doc.get("reproduction")
    verification = doc.get("fix_verification")
    if not isinstance(reproduction, dict):
        return "not_reproduced"
    if not isinstance(verification, dict):
        return "fix_not_verified"
    if str(reproduction.get("recipe_ref") or "") != str(verification.get("recipe_ref") or ""):
        return "recipe_mismatch"
    return None


def mint_outcome_truth(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Join promoted consensus to mechanical outcome; mint one row per join.

    Idempotent per ``(judgment_group_id, consensus_run_id)``: the join key
    an outcome row lands under already contains both, so an existing row
    answers before the ledgers are re-walked.
    """
    from .finding import _replay_findings

    root = ensure_tools_dir(base_dir)
    feedback = load_feedback(base_dir=root)
    consensus_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    existing_outcome: set[tuple[str, str, str]] = set()
    for row in feedback:
        if row.get("source_type") == "ai_consensus":
            # Last row per key wins, the same discipline the calibration
            # truth join applies to an append-only ledger: a group re-settled
            # (the anchor-upgrade flow) is read at its latest verdict.
            consensus_by_key[
                (str(row.get("judgment_group_id") or ""), str(row.get("run_id") or ""))
            ] = row
        elif row.get("source_type") == OUTCOME_SOURCE_TYPE:
            existing_outcome.add(_outcome_key(row))
    findings = _replay_findings(Path(repo_root).resolve())
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    promotions = load_jsonl(promotions_path(root)) if promotions_path(root).exists() else []

    def _skip(group: str, consensus_run: str, finding_id: str, reason: str) -> None:
        skipped.append({
            "judgment_group_id": group, "consensus_run_id": consensus_run,
            "finding_id": finding_id, "reason": reason,
        })

    for promotion in promotions:
        group = str(promotion.get("judgment_group_id") or "")
        consensus_run = str(promotion.get("consensus_run_id") or "")
        finding_id = str(promotion.get("finding_id") or "")
        if not group or not consensus_run:
            _skip(group, consensus_run, finding_id, "promotion_missing_join_keys")
            continue
        consensus = consensus_by_key.get((group, consensus_run))
        if consensus is None:
            _skip(group, consensus_run, finding_id, "consensus_row_missing")
            continue
        key = (consensus_run, str(consensus.get("finding_id") or ""), group)
        if key in existing_outcome:
            _skip(group, consensus_run, finding_id, "already_minted")
            continue
        if str(consensus.get("verdict") or "") != "true_positive":
            _skip(group, consensus_run, finding_id, "consensus_not_true_positive")
            continue
        doc = findings.get(finding_id)
        if doc is None:
            _skip(group, consensus_run, finding_id, "promoted_finding_unreadable")
            continue
        red_green = _red_then_green_reason(doc)
        if red_green is not None:
            _skip(group, consensus_run, finding_id, red_green)
            continue
        merged = _merged_not_reverted(root, finding_id)
        if merged is not None:
            _skip(group, consensus_run, finding_id, merged)
            continue
        row = record_operator_feedback(
            tool_id=str(consensus.get("tool_id") or ""),
            run_id=consensus_run,
            finding_id=str(consensus.get("finding_id") or ""),
            verdict="true_positive",
            severity=str(consensus.get("severity") or "medium"),
            note=(
                "outcome truth: defect reproduced red and verified green under "
                f"recipe {doc['reproduction'].get('recipe_ref')}; fix merged and not self-reverted "
                f"(finding {finding_id})"
            ),
            source_type=OUTCOME_SOURCE_TYPE,
            judge_id=OUTCOME_TRUTH_JUDGE_ID,
            judgment_group_id=group,
            finding_fingerprint=str(consensus.get("finding_fingerprint") or "") or None,
            base_dir=root,
        )
        minted.append(row)
        existing_outcome.add(key)
    return {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "considered": len(promotions),
        "minted_count": len(minted),
        "minted": minted,
        "skipped": skipped,
    }
