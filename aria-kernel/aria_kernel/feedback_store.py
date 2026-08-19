from __future__ import annotations

import json
import hashlib
import fnmatch
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, append_jsonl as append_chained_jsonl
from .ledger import load_jsonl as load_chained_jsonl
from .ledger import rewrite_jsonl as rewrite_chained_jsonl
from .runtime_artifacts import resolve_finding_from_artifact, run_ledger_format
from .runs_reader import read_runs_rows
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FEEDBACK_VERDICTS = ("true_positive", "false_positive")

# ORPHAN-CRITICAL-735 — the CLOSED vocabulary of consensus-uncertainty
# reasons. Every _consensus_uncertainty call site below uses a member;
# the agent-arbiter bridge (judgment_bridge) validates against THIS
# tuple, so the deterministic engine and the agent lane cannot drift
# apart on what counts as a legitimate non-verdict outcome.
CONSENSUS_UNCERTAINTY_REASONS = (
    "conformal_abstain",
    "evidence_not_repo_verified",
    "judge_disagreement",
    "low_confidence",
    "missing_confidence",
    "single_judge",
)
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
FEEDBACK_SOURCE_TYPES = ("human", "ai_judge", "ai_consensus")
JUDGMENT_STRATEGIES = ("stratified_by_uncertainty", "stratified_by_rule", "random")
DEFAULT_MIN_JUDGED_SAMPLES = 10
CONSENSUS_MIN_CONFIDENCE = 0.80

# JJ-1 (ORPHAN-HIGH-731) - the ANCHOR class of consensus.
#
# WHY: a 2-judge consensus is two opinions that happened to agree; nothing
# ever examined the agreement itself. Every reader that treats a consensus
# row as GROUND TRUTH - false-positive suppression, rule_health quarantine,
# goldset proposal, judge calibration - was therefore scoring the judge
# fleet against the fleet's own unexamined pair, so one correlated blind
# spot in those two judges became permanent repository "truth".
#
# An ANCHOR is a consensus that survived a THIRD judge (the arbiter, minted
# even when the first two agree - that mint IS the judges-judging-judges
# requirement). SURVIVED, not outvoted: the arbiter is minted to REFUTE the
# pair, so counting him as backing when he refused to back is the thesis
# inverted. Routine consensus stays 2-judge because the arbiter costs an
# LLM call and the adapter-precision lane (tool_health.compute_metrics)
# deliberately reads the looser set (ORPHAN-CRITICAL-643). The difference is
# carried EXPLICITLY on the row as (judge_count, judges_voted) - how many
# AGREED and how many VOTED - never re-derived per reader, so "is this
# ground truth?" has exactly one answer everywhere.
ANCHOR_MIN_JUDGE_COUNT = 3
GROUND_TRUTH_SOURCE_TYPES = ("human", "ai_consensus")

# JJ-2 (ORPHAN-HIGH-732) - how many ANCHOR judgments a tool must accumulate
# before its precision counts as judged for promotion. Higher than
# rule_health.MIN_JUDGED_FOR_QUARANTINE (3) because promotion is the more
# consequential act - quarantining a rule stops noise, promoting an adapter
# starts writing to the operator's queue - and it deliberately equals the
# 5-run stability window the same readiness gate already demands, so a tool
# cannot become promotable on evidence thinner than its own runtime proof.
# Read by readiness (the gate) and by judge_fanout (the mint demand), which
# is why it lives beside the ledger both of them read.
ANCHOR_PROMOTION_MIN_JUDGMENTS = 5


def _row_count(row: dict[str, Any], field: str) -> int:
    """A non-negative integer count off a ledger row, or 0 when unprovable.

    Fail-closed on absence, for the same reason readiness treats an
    unprovable timestamp as stale: a row minted before JJ-1 carries neither
    count, and ground-truth authority must never be inferred from a field
    that was never written.
    """
    count = row.get(field)
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return 0
    return count


def consensus_judge_count(row: dict[str, Any]) -> int:
    """How many judges a feedback row can PROVE stood behind it.

    AGREEMENT-scoped, not attendance-scoped: only judges whose own verdict
    equals the verdict this row settled on. The pre-fix writer counted every
    judge who VOTED, which inverted the whole anchor thesis - under the
    weighted lane a 2-1 majority settled at 3, so the arbiter minted
    SPECIFICALLY TO REFUTE a pair became the third credential that promoted
    the pair's verdict to ground truth and suppressed the finding class
    forever. The judge that disagreed can never again be counted as backing.
    """
    return _row_count(row, "judge_count")


def consensus_judges_voted(row: dict[str, Any]) -> int:
    """How many judges VOTED on the question this row settled.

    Written beside ``judge_count`` (never derived from it) so the two facts
    the anchor rule needs - how many agreed, and whether anyone dissented -
    are both on the row instead of re-derived per reader. Absence reads as
    0, which makes the anchor predicate below fail closed for any row that
    cannot say who else looked.
    """
    return _row_count(row, "judges_voted")


def is_ground_truth_row(row: dict[str, Any]) -> bool:
    """JJ-1 - may this feedback row act as GROUND TRUTH?

    The operator is ACCEPTED but never REQUIRED (JJ-2): a human row is
    ground truth unconditionally, an ai_consensus row only as an ANCHOR.
    A missing source_type is the bootstrap corpus's human label - the
    default this ledger has always carried.

    An ANCHOR is agreement that SURVIVED a refutation attempt: at least
    ANCHOR_MIN_JUDGE_COUNT judges agreed AND no judge who voted dissented.
    Agreement that merely OUTVOTED a dissenter still settles the finding for
    the adapter-precision lane (tool_health.compute_metrics reads the looser
    set) and for nothing else - a contested question is not repository truth,
    and the row that suppresses a finding class forever is the last place to
    accept a majority over a live objection.
    """
    source_type = row.get("source_type") or "human"
    if source_type not in GROUND_TRUTH_SOURCE_TYPES:
        return False
    if source_type == "human":
        return True
    agreed = consensus_judge_count(row)
    return agreed >= ANCHOR_MIN_JUDGE_COUNT and consensus_judges_voted(row) == agreed


def _judgment_key(row: dict[str, Any]) -> tuple[str, str, str]:
    """The (run, finding, group) identity every judgment lane already keys on."""
    return (
        str(row.get("run_id") or ""),
        str(row.get("finding_id") or ""),
        str(row.get("judgment_group_id") or ""),
    )


def anchor_group_keys(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
) -> set[tuple[str, str, str]]:
    """Distinct judgments this tool holds ANCHOR-grade consensus on.

    Keyed by judgment, not by row: an anchor upgrade appends a new consensus
    row over its own 2-judge predecessor (see generate_ai_consensus), so
    counting rows would count one settled question twice.
    """
    return {
        _judgment_key(row)
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if row.get("source_type") == "ai_consensus" and is_ground_truth_row(row)
    }


def operator_group_keys(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
) -> set[tuple[str, str, str]]:
    """Distinct judgments this tool carries a HUMAN verdict on."""
    return {
        _judgment_key(row)
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if (row.get("source_type") or "human") == "human"
    }


def findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "findings.jsonl"


def feedback_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def judgment_samples_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "judgment-samples.jsonl"


def raw_findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "raw-findings.jsonl"


def promotions_path(base_dir: str | Path | None = None) -> Path:
    """D3 — fingerprint → committed-finding memory (finding_promotion writes)."""
    return ensure_tools_dir(base_dir) / "promotions.jsonl"


def _promoted_fingerprints(base_dir: str | Path | None) -> set[str]:
    # D3 (K4 symmetry) — the TRUE-positive analog of confirmed-FP
    # suppression: a fingerprint with a committed finding is settled and
    # must never be re-judged; before this, the same real finding was
    # re-sampled and re-judged every single cycle forever.
    path = promotions_path(base_dir)
    return {
        str(row.get("finding_fingerprint"))
        for row in (load_jsonl(path) if path.exists() else [])
        if row.get("finding_fingerprint")
    }


def record_raw_findings_for_run(
    run: dict[str, Any],
    findings: list[Any] | None = None,
    base_dir: str | Path | None = None,
) -> None:
    raw_findings = findings if isinstance(findings, list) else run.get("runner", {}).get("raw_findings_sample", [])
    if not isinstance(raw_findings, list) or not raw_findings:
        return
    confirmed_false_positives = _confirmed_false_positive_fingerprints(base_dir)
    # Plan 023 v3 §C-6 — scope-out mutation also marks raw findings as
    # invalid_evidence. Plan 022 §C-5 added scope_out_mutations to the
    # runner envelope and triggered immediate quarantine via
    # immediate_quarantine_reason; the raw findings the run produced
    # still landed here with status='raw' because the existing mapping
    # only checked run.status. A scope-escape adapter's findings are a
    # security signal, not a sampling source — re-flag them as invalid.
    runner_block = run.get("runner") or {}
    has_scope_out = bool(runner_block.get("scope_out_mutations"))
    for finding_index, finding in enumerate(raw_findings):
        if not isinstance(finding, dict):
            continue
        fingerprint = finding_fingerprint(run["tool_id"], finding)
        suppressed = confirmed_false_positives.get(fingerprint)
        status = "raw"
        if run.get("status") in ("evidence_error", "scope_violation") or has_scope_out:
            status = "invalid_evidence"
        elif suppressed:
            status = "suppressed_false_positive"
        row = {
            "schema_version": 2 if run.get("artifact_ref") else 1,
            "recorded_at": utc_now(),
            "tool_id": run["tool_id"],
            "run_id": run["run_id"],
            "cycle_id": run.get("cycle_id"),
            "finding_id": finding.get("id"),
            "finding_fingerprint": fingerprint,
            "evidence_hash": evidence_hash_for_finding(finding),
            "status": status,
            "suppressed_by_feedback": suppressed,
            "artifact_ref": run.get("artifact_ref"),
            "artifact_hash": run.get("artifact_hash"),
            "adapter_version": run.get("adapter_version") or run.get("tool_id"),
            "redaction_status": "none",
            "reason_code": "artifact_backed_raw_finding" if run.get("artifact_ref") else "legacy_inline_or_sample_only",
            "json_pointer": f"/payload/raw_findings/{finding_index}",
        }
        if run_ledger_format(base_dir) != "v2":
            row["finding"] = finding
        append_jsonl(raw_findings_path(base_dir), row)


def record_findings_for_run(run: dict[str, Any], base_dir: str | Path | None = None) -> None:
    findings = run.get("emitted_findings", [])
    if not isinstance(findings, list) or not findings:
        return
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        fingerprint = finding_fingerprint(run["tool_id"], finding)
        suppressed = _confirmed_false_positive_fingerprints(base_dir).get(fingerprint)
        # E15-a — mint-time service dimension, derived from the paths the
        # finding itself cites (operator direction: findings organised by
        # microservice, so per-service audits and service-specific agents
        # have an axis to stand on).
        from .service_dimension import finding_dimension_paths, service_dimension

        dimension = service_dimension(finding_dimension_paths(finding))
        append_jsonl(
            findings_path(base_dir),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "tool_id": run["tool_id"],
                "run_id": run["run_id"],
                "finding_id": finding.get("id"),
                "status": "suppressed_false_positive" if suppressed else "open",
                "finding_fingerprint": fingerprint,
                "suppressed_by_feedback": suppressed,
                "service": dimension["service"],
                "services": dimension["services"],
                "finding": finding,
            },
        )
        # Every LIVE finding also lands in the calibration seeding ledger,
        # which is the pool the operator labels from. `record_seeding_finding`
        # existed with zero production callers, so the pool was permanently
        # empty and the bootstrap's own operator workflow began at a ledger
        # nothing ever filled. Suppressed FPs are excluded — the operator
        # already spoke about those.
        if not suppressed:
            try:
                from .calibration_bootstrap import record_seeding_finding
                record_seeding_finding(
                    tool_id=str(run["tool_id"]),
                    finding={**finding, "finding_fingerprint": fingerprint, "run_id": run["run_id"]},
                    base_dir=base_dir,
                )
            except GovernanceError:
                # Seeding refusal (e.g. duplicate fingerprint) must not cost
                # the finding record itself.
                pass


def mark_findings_need_revalidation(tool_id: str, base_dir: str | Path | None = None) -> int:
    rows = load_jsonl(findings_path(base_dir))
    updated = 0
    next_rows: list[dict[str, Any]] = []
    for row in rows:
        if row.get("tool_id") == tool_id and row.get("status") == "open":
            row = dict(row)
            row["status"] = "needs_revalidation"
            row["updated_at"] = utc_now()
            updated += 1
        next_rows.append(row)
    rewrite_jsonl(findings_path(base_dir), next_rows)
    return updated


def list_findings(
    *,
    tool_id: str | None = None,
    status: str | None = None,
    service: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(findings_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    if status is not None:
        rows = [row for row in rows if row.get("status") == status]
    if service is not None:
        # E15-a — legacy rows carry no mint-time dimension; derive at
        # read time from the same collector the mint uses, so old and
        # new rows can never disagree about their own service. The
        # shared row reader (E15-c) keeps this filter and the
        # service-auditor targeting trigger on one derivation.
        from .service_dimension import services_for_finding_row

        rows = [row for row in rows if service in services_for_finding_row(row)]
    return rows


def record_operator_feedback(
    *,
    tool_id: str,
    run_id: str,
    finding_id: str,
    verdict: str,
    severity: str,
    note: str,
    affected_belief_ids: list[str] | None = None,
    source_type: str = "human",
    judge_id: str | None = None,
    model: str | None = None,
    prompt_hash: str | None = None,
    confidence: float | None = None,
    rationale: str | None = None,
    evidence_refs: list[str] | None = None,
    judgment_group_id: str | None = None,
    finding_fingerprint: str | None = None,
    judge_count: int | None = None,
    judges_voted: int | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if verdict not in FEEDBACK_VERDICTS:
        raise GovernanceError(f"unknown feedback verdict: {verdict}")
    if severity not in FEEDBACK_SEVERITIES:
        raise GovernanceError(f"unknown feedback severity: {severity}")
    if source_type not in FEEDBACK_SOURCE_TYPES:
        raise GovernanceError(f"unknown feedback source_type: {source_type}")
    if affected_belief_ids is not None and not _valid_string_list(affected_belief_ids):
        raise GovernanceError("affected_belief_ids must be an array of non-empty strings")
    if evidence_refs is not None and not _valid_string_list(evidence_refs):
        raise GovernanceError("evidence_refs must be an array of non-empty strings")
    if confidence is not None and (not isinstance(confidence, (int, float)) or confidence < 0 or confidence > 1):
        raise GovernanceError("confidence must be between 0 and 1")
    if source_type != "human" and (not judge_id or not judge_id.strip()):
        raise GovernanceError("AI feedback requires judge_id")
    for _name, _value in (("judge_count", judge_count), ("judges_voted", judges_voted)):
        if _value is not None and (
            isinstance(_value, bool) or not isinstance(_value, int) or _value < 1
        ):
            raise GovernanceError(f"{_name} must be a positive integer")
    # JJ-1 (ORPHAN-HIGH-731) - Tier 1: a consensus row that cannot say how
    # many judges backed it is UNWRITABLE. The alternative (absent field read
    # as "unknown") puts the fail-closed burden on every downstream reader
    # forever, and the pre-JJ-1 ledger proved readers forget: five separate
    # ground-truth consumers each re-decided source eligibility on their own.
    #
    # judges_voted joins it under the SAME rule: "three judges agreed" and
    # "three judges agreed and a fourth objected" are different facts, and a
    # row that cannot tell them apart cannot be allowed to claim it survived
    # refutation. Requiring both makes the anchor predicate readable off the
    # row instead of guessed from a missing field.
    if source_type == "ai_consensus" and (judge_count is None or judges_voted is None):
        raise GovernanceError(
            "ai_consensus feedback requires judge_count and judges_voted"
        )
    if judge_count is not None and judges_voted is not None and judges_voted < judge_count:
        raise GovernanceError(
            "judges_voted must be >= judge_count (agreement cannot exceed attendance)"
        )
    row = {
        "schema_version": 2,
        "recorded_at": utc_now(),
        "tool_id": tool_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "verdict": verdict,
        "severity": severity,
        "note": note,
        "affected_belief_ids": affected_belief_ids or [],
        "source_type": source_type,
        "judge_id": judge_id,
        "model": model,
        "prompt_hash": prompt_hash,
        "confidence": confidence,
        "rationale": rationale,
        "evidence_refs": evidence_refs or [],
        "judgment_group_id": judgment_group_id,
        "finding_fingerprint": finding_fingerprint,
        "judge_count": judge_count,
        "judges_voted": judges_voted,
    }
    append_jsonl(feedback_path(base_dir), row)
    return row


def record_operator_feedback_batch(
    *,
    sample_id: str,
    verdict_payload: Any,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    sample = _sample_by_id(sample_id, base_dir)
    if sample is None:
        raise GovernanceError(f"unknown judgment sample: {sample_id}")
    verdicts = verdict_payload.get("verdicts") if isinstance(verdict_payload, dict) else verdict_payload
    if not isinstance(verdicts, list):
        raise GovernanceError("batch verdict file must be an array or an object with verdicts array")
    sample_items = sample.get("items", [])
    if not isinstance(sample_items, list):
        raise GovernanceError("judgment sample has invalid items")
    by_key = {
        _batch_key(item): item
        for item in sample_items
        if isinstance(item, dict) and item.get("run_id") and item.get("finding_id")
    }
    by_finding_id: dict[str, list[dict[str, Any]]] = {}
    for item in sample_items:
        if isinstance(item, dict) and item.get("finding_id"):
            by_finding_id.setdefault(str(item.get("finding_id")), []).append(item)
    seen: set[tuple[str, str]] = set()
    normalized = []
    for verdict in verdicts:
        if not isinstance(verdict, dict):
            raise GovernanceError("batch verdict entries must be JSON objects")
        key = _resolve_batch_verdict_key(verdict, by_finding_id)
        if key not in by_key:
            raise GovernanceError(f"batch verdict does not match sample item: {key[0]} {key[1]}")
        if key in seen:
            raise GovernanceError(f"duplicate batch verdict for sample item: {key[0]} {key[1]}")
        seen.add(key)
        normalized.append((verdict, by_key[key]))
    missing = sorted(set(by_key) - seen)
    if missing:
        first = missing[0]
        raise GovernanceError(f"batch verdict missing sample item: {first[0]} {first[1]}")

    rows = []
    for verdict, item in normalized:
        rows.append(
            record_operator_feedback(
                tool_id=str(item.get("tool_id") or sample.get("tool_id") or ""),
                run_id=str(item.get("run_id") or ""),
                finding_id=str(item.get("finding_id") or ""),
                verdict=str(verdict.get("verdict") or ""),
                severity=str(verdict.get("severity") or item.get("severity") or "medium"),
                note=str(verdict.get("note") or verdict.get("rationale") or "batch operator verdict"),
                affected_belief_ids=_optional_string_list(verdict.get("affected_belief_ids")),
                evidence_refs=_optional_string_list(verdict.get("evidence_refs")) or _evidence_refs_from_item(item),
                rationale=str(verdict.get("rationale") or ""),
                judgment_group_id=str(verdict.get("judgment_group_id") or sample_id),
                finding_fingerprint=str(item.get("finding_fingerprint") or ""),
                base_dir=base_dir,
            ),
        )
    stored_sample = dict(sample)
    stored_sample["status"] = "recorded"
    stored_sample["recorded_feedback_count"] = len(rows)
    return {"schema_version": 1, "sample_id": sample_id, "recorded_count": len(rows), "feedback": rows}


def record_ai_feedback_file(
    *,
    file_payload: Any,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    verdicts = file_payload.get("verdicts") if isinstance(file_payload, dict) else file_payload
    if not isinstance(verdicts, list):
        raise GovernanceError("AI verdict file must be an array or an object with verdicts array")
    rows = []
    for verdict in verdicts:
        if not isinstance(verdict, dict):
            raise GovernanceError("AI verdict entries must be JSON objects")
        rows.append(
            record_operator_feedback(
                tool_id=str(verdict.get("tool_id") or ""),
                run_id=str(verdict.get("run_id") or ""),
                finding_id=str(verdict.get("finding_id") or ""),
                verdict=str(verdict.get("verdict") or ""),
                severity=str(verdict.get("severity") or "medium"),
                note=str(verdict.get("note") or verdict.get("rationale") or ""),
                affected_belief_ids=_optional_string_list(verdict.get("affected_belief_ids")),
                source_type="ai_judge",
                judge_id=str(verdict.get("judge_id") or ""),
                model=str(verdict.get("model") or ""),
                prompt_hash=str(verdict.get("prompt_hash") or ""),
                confidence=float(verdict.get("confidence", 0.0)),
                rationale=str(verdict.get("rationale") or ""),
                evidence_refs=_optional_string_list(verdict.get("evidence_refs")),
                judgment_group_id=str(verdict.get("judgment_group_id") or ""),
                finding_fingerprint=str(verdict.get("finding_fingerprint") or ""),
                base_dir=base_dir,
            ),
        )
    return {"schema_version": 1, "recorded_count": len(rows), "feedback": rows}


def _has_unverifiable_evidence(rows: list[dict[str, Any]], workspace_root: str | Path) -> bool:
    """Plan 024 §C — True if any judge in the group cites an evidence ref that
    positively does not resolve in the repo (``missing`` / ``invalid``). A ref
    that exists but is unverified at a pinned sha (``worktree_candidate``) is
    given the benefit of the doubt — this gate catches fabricated evidence, not
    sha-pinning uncertainty, so it cannot flood escalation on a clean repo."""
    from .evidence_trust import classify_evidence_ref
    for row in rows:
        for ref in _optional_string_list(row.get("evidence_refs")):
            grade = classify_evidence_ref(
                ref, workspace_root=workspace_root, context="consensus_evidence_gate"
            ).trust_grade
            if grade in ("missing", "invalid"):
                return True
    return False


def generate_ai_consensus(
    *,
    tool_id: str,
    cycle_id: str | None = None,
    min_confidence: float = CONSENSUS_MIN_CONFIDENCE,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    judge_weights: dict[str, float] | None = None,
    conformal_floor: float | None = None,
) -> dict[str, Any]:
    """Kalibre Zekâ Z2a/Z2c — both knobs default OFF, preserving the
    legacy gate bit for bit:

    * ``judge_weights`` (judge_id -> Beta-posterior precision mean, from
      ``calibrated_intelligence.judge_weights_from_calibration``): the
      unanimity requirement becomes a WEIGHTED vote — the winning verdict
      must carry a strict majority of total weight AND every dissenter's
      weight share stays under the margin; with two equal judges a single
      dissenter still escalates, exactly like unanimity, so behaviour only
      shifts when the fleet grows or posteriors genuinely separate.
    * ``conformal_floor`` (from ``conformal_threshold`` over past CORRECT
      consensus confidences): a passing consensus whose confidence falls
      below the floor abstains to a human (``conformal_abstain``) with the
      distribution-free guarantee that at most ~alpha of genuinely-correct
      consensuses are escalated.
    """
    if min_confidence < 0 or min_confidence > 1:
        raise GovernanceError("min_confidence must be between 0 and 1")
    ai_rows = [
        row
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if row.get("source_type") == "ai_judge" and (cycle_id is None or _feedback_cycle(row, base_dir) == cycle_id)
    ]
    # JJ-1 - the dedup key remembers HOW MANY judges VOTED on the settled row.
    # A group settled at 2 judges must be re-settleable once the anchor
    # arbiter answers, otherwise the 3rd judge's verdict is minted, paid for,
    # and then discarded by an idempotency guard - the anchor class would be
    # unreachable by construction. Attendance (not agreement) is the right
    # key: a third judge who DISAGREES leaves the agreement count at 2, and
    # keying on agreement would re-settle that group every cycle forever.
    # Re-running with no new judge still appends nothing, and the count is
    # bounded by the number of distinct judges.
    existing_consensus: dict[tuple[str, str, str], int] = {}
    for row in load_feedback(tool_id=tool_id, base_dir=base_dir):
        if row.get("source_type") != "ai_consensus":
            continue
        key = _judgment_key(row)
        existing_consensus[key] = max(
            existing_consensus.get(key, 0), consensus_judges_voted(row),
        )
    grouped: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = {}
    for row in ai_rows:
        run_id = str(row.get("run_id") or "")
        finding_id = str(row.get("finding_id") or "")
        group_id = str(row.get("judgment_group_id") or "")
        judge_id = str(row.get("judge_id") or "")
        if not run_id or not finding_id or not judge_id:
            continue
        grouped.setdefault((run_id, finding_id, group_id), {})[judge_id] = row

    consensus_rows = []
    uncertainties = []
    for key, by_judge in sorted(grouped.items()):
        rows = list(by_judge.values())
        run_id, finding_id, group_id = key
        if key in existing_consensus and existing_consensus[key] >= len(rows):
            continue
        if len(rows) < 2:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "single_judge"))
            continue
        verdicts = {str(row.get("verdict") or "") for row in rows}
        if judge_weights is None:
            if len(verdicts) != 1:
                uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "judge_disagreement"))
                continue
        else:
            # Z2a — weighted vote. Weight-by-verdict; unknown judges weigh
            # at the neutral prior mean so a new judge neither dominates
            # nor vanishes. Strict-majority + margin: the winner needs
            # > 0.5 + margin of total weight, which with two equal judges
            # degenerates to unanimity — the legacy guarantee survives.
            _prior_mean = 0.8
            _margin = 0.10
            by_verdict: dict[str, float] = {}
            for judge_id, row in by_judge.items():
                weight = float(judge_weights.get(judge_id, _prior_mean))
                by_verdict[str(row.get("verdict") or "")] = by_verdict.get(str(row.get("verdict") or ""), 0.0) + weight
            total_weight = sum(by_verdict.values()) or 1.0
            winner, winner_weight = max(by_verdict.items(), key=lambda kv: kv[1])
            if winner_weight / total_weight <= 0.5 + _margin:
                uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "judge_disagreement"))
                continue
            verdicts = {winner}
        # JJ-1 fix — from here the row speaks for the judges who AGREED with
        # the settled verdict. Everything the consensus row asserts about
        # itself (how many judges, at what confidence, on what evidence) is
        # scoped to them: a dissenter's confidence has no business raising
        # the mean of a verdict he refused, and his count has no business
        # buying the row its anchor grade.
        settled_verdict = next(iter(verdicts))
        agreeing = [
            row for row in rows
            if str(row.get("verdict") or "") == settled_verdict
        ]
        # Kalibre Zekâ Z2b — a judge whose bridge stored confidence=None used
        # to be coerced to 0.0, silently dragging the mean under the 0.80
        # gate: a unanimous, correct pair could escalate as "low_confidence"
        # because one row lacked a number. Absent confidence now stays out of
        # the mean; a group with NO numeric confidence at all escalates under
        # its own name instead of masquerading as low confidence.
        confidences = [
            float(row["confidence"]) for row in agreeing
            if isinstance(row.get("confidence"), (int, float))
        ]
        if not confidences:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "missing_confidence"))
            continue
        avg_confidence = sum(confidences) / len(confidences)
        if avg_confidence < min_confidence:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "low_confidence"))
            continue
        # Z2c — conformal abstention: below the calibrated floor, a
        # passing consensus still routes to a human. The floor is None on
        # a short window, so this gate never fires before evidence exists.
        if conformal_floor is not None and avg_confidence < conformal_floor:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "conformal_abstain"))
            continue
        # Plan 024 §C — evidence-gated arbiter. When a workspace is supplied, the
        # union of judge evidence is only published as consensus if it actually
        # resolves in the repo; a judge citing fabricated evidence escalates to a
        # human instead of being rubber-stamped. Opt-in: legacy callers without
        # workspace_root keep the pure mechanical gate.
        if workspace_root is not None and _has_unverifiable_evidence(rows, workspace_root):
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "evidence_not_repo_verified"))
            continue
        dissenting = len(rows) - len(agreeing)
        severity = _max_severity(str(row.get("severity") or "medium") for row in agreeing)
        note = f"AI consensus from {len(agreeing)} independent judges"
        if dissenting:
            note += (
                f" over {dissenting} dissenting (weighted majority; "
                f"settles precision only, never ground truth)"
            )
        consensus_rows.append(
            record_operator_feedback(
                tool_id=tool_id,
                run_id=run_id,
                finding_id=finding_id,
                verdict=settled_verdict,
                severity=severity,
                note=note,
                source_type="ai_consensus",
                judge_id="aria-consensus-arbiter",
                model="consensus",
                confidence=round(avg_confidence, 3),
                rationale="; ".join(str(row.get("rationale") or row.get("note") or "") for row in agreeing if row.get("rationale") or row.get("note"))[:2000],
                evidence_refs=sorted({ref for row in agreeing for ref in _optional_string_list(row.get("evidence_refs"))}),
                judgment_group_id=group_id,
                finding_fingerprint=next((str(row.get("finding_fingerprint")) for row in rows if row.get("finding_fingerprint")), ""),
                # JJ-1 - the anchor discriminator, read off the pair
                # (judge_count, judges_voted) by is_ground_truth_row. Equal
                # and >= ANCHOR_MIN_JUDGE_COUNT is what makes this row
                # ground-truth-bearing; anything less still settles the
                # finding for the adapter-precision lane and nothing else.
                judge_count=len(agreeing),
                judges_voted=len(rows),
                base_dir=base_dir,
            ),
        )
    if uncertainties:
        # D2 (Kapalı Döngü) — re-emission dedup. With the ledger-derived
        # pending set (cycle_id=None), a permanently stuck group
        # (single_judge, low_confidence, …) would re-enter this list EVERY
        # cycle and append an identical uncertainty forever — unbounded
        # ledger growth for zero information. The escalation_id is already
        # stable per distinct failure; skip the ones the ledger has seen.
        uncertainties_path = ensure_tools_dir(base_dir) / "feedback-consensus-uncertainties.jsonl"
        seen_escalations: set[str] = set()
        for logged in load_jsonl(uncertainties_path) if uncertainties_path.exists() else []:
            for item in logged.get("uncertainties") or []:
                escalation = item.get("escalation_id")
                if escalation:
                    seen_escalations.add(str(escalation))
        fresh_uncertainties = [
            item for item in uncertainties
            if str(item.get("escalation_id") or "") not in seen_escalations
        ]
        if fresh_uncertainties:
            append_jsonl(
                uncertainties_path,
                {
                    "schema_version": 1,
                    "recorded_at": utc_now(),
                    "tool_id": tool_id,
                    "cycle_id": cycle_id,
                    "uncertainties": fresh_uncertainties,
                },
            )
    return {
        "schema_version": 1,
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "consensus_count": len(consensus_rows),
        "uncertainty_count": len(uncertainties),
        "consensus": consensus_rows,
        "uncertainties": uncertainties,
    }


def generate_judgment_sample(
    *,
    tool_id: str,
    sample_size: int,
    strategy: str = "stratified_by_uncertainty",
    cycle_id: str | None = None,
    min_judged_samples: int = DEFAULT_MIN_JUDGED_SAMPLES,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if sample_size <= 0:
        raise GovernanceError("feedback judge sample_size must be positive")
    if strategy not in JUDGMENT_STRATEGIES:
        raise GovernanceError(f"unknown feedback judge strategy: {strategy}")
    if min_judged_samples <= 0:
        raise GovernanceError("feedback judge min_judged_samples must be positive")
    findings = _sampleable_raw_findings(tool_id=tool_id, cycle_id=cycle_id, base_dir=base_dir)
    selected = _select_findings(findings, sample_size=sample_size, strategy=strategy, base_dir=base_dir)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "sample_id": _sample_id(tool_id, cycle_id, selected),
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "strategy": strategy,
        "sample_size": sample_size,
        "min_judged_samples": min_judged_samples,
        "status": "pending" if selected else "empty",
        "sampled_count": len(selected),
        "items": selected,
        "instructions": {
            "verdicts": list(FEEDBACK_VERDICTS),
            "lane": "record one operator-feedback verdict per sampled finding_id, or submit the full sample through record-batch",
            "cli": "aria-kernel feedback record --tool-id ... --run-id ... --finding-id ... --verdict true_positive|false_positive",
            "batch_cli": f"aria-kernel feedback record-batch --sample-id {_sample_id(tool_id, cycle_id, selected)} --file verdicts.json",
        },
    }
    append_jsonl(judgment_samples_path(base_dir), row)
    return row


def list_judgment_samples(
    *,
    tool_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(judgment_samples_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def load_feedback(
    *,
    tool_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(feedback_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def _sampleable_raw_findings(
    *,
    tool_id: str,
    cycle_id: str | None,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    existing_feedback = {
        (str(row.get("run_id")), str(row.get("finding_id")))
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
    }
    confirmed_false_positive_fingerprints = _confirmed_false_positive_fingerprints(base_dir)
    # `_confirmed_false_positive_fingerprints` is a dict (fingerprint →
    # suppressing row); only its keys matter for the settled test.
    settled_fingerprints = set(confirmed_false_positive_fingerprints) | _promoted_fingerprints(base_dir)
    # D4 — a rule whose measured FP rate earned quarantine stops consuming
    # judge capacity entirely; its repair work item already exists
    # (rule_health.commit_rule_defect_findings). Function-level import
    # breaks the module cycle (rule_health reads this module's ledgers).
    from .rule_health import quarantined_rules

    quarantined = quarantined_rules(base_dir)
    candidates = []
    for row in load_jsonl(raw_findings_path(base_dir)):
        if row.get("tool_id") != tool_id:
            continue
        if row.get("status") == "invalid_evidence":
            continue
        if cycle_id is not None and row.get("cycle_id") != cycle_id:
            continue
        finding = row.get("finding") if isinstance(row.get("finding"), dict) else {}
        if not finding and row.get("artifact_ref"):
            finding = resolve_finding_from_artifact(row, base_dir=base_dir) or {}
        finding_id = str(row.get("finding_id") or finding.get("id") or "")
        run_id = str(row.get("run_id") or "")
        if not finding_id or not run_id or (run_id, finding_id) in existing_feedback:
            continue
        fingerprint = str(row.get("finding_fingerprint") or finding_fingerprint(tool_id, finding))
        if fingerprint in settled_fingerprints:
            continue
        if (tool_id, str(finding.get("rule") or "").strip()) in quarantined:
            continue
        candidates.append(_sample_item_from_finding(tool_id, run_id, row.get("cycle_id"), finding_id, finding, fingerprint))
    if candidates:
        return _cap_candidates_by_rule(candidates, limit=50)
    for run in read_runs_rows(ensure_tools_dir(base_dir) / "runs.jsonl", base_dir=ensure_tools_dir(base_dir)):
        if run.get("tool_id") != tool_id or run.get("status") != "ok":
            continue
        if cycle_id is not None and run.get("cycle_id") != cycle_id:
            continue
        for finding in run.get("runner", {}).get("raw_findings_sample", []):
            if not isinstance(finding, dict):
                continue
            finding_id = str(finding.get("id") or "")
            run_id = str(run.get("run_id"))
            if not finding_id or (run_id, finding_id) in existing_feedback:
                continue
            fingerprint = finding_fingerprint(tool_id, finding)
            if fingerprint in settled_fingerprints:
                continue
            if (tool_id, str(finding.get("rule") or "").strip()) in quarantined:
                continue
            candidates.append(_sample_item_from_finding(tool_id, run_id, run.get("cycle_id"), finding_id, finding, fingerprint))
    return _cap_candidates_by_rule(candidates, limit=50)


def _cap_candidates_by_rule(candidates: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    capped: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=_stable_sort_key):
        rule = str(candidate.get("rule") or "unknown")
        if counts.get(rule, 0) >= limit:
            continue
        counts[rule] = counts.get(rule, 0) + 1
        capped.append(candidate)
    return capped


def _sample_item_from_finding(
    tool_id: str,
    run_id: str,
    cycle_id: Any,
    finding_id: str,
    finding: dict[str, Any],
    fingerprint: str,
) -> dict[str, Any]:
    return {
        "tool_id": tool_id,
        "run_id": run_id,
        "cycle_id": cycle_id,
        "finding_id": finding_id,
        "rule": str(finding.get("rule") or "unknown"),
        "severity": str(finding.get("severity") or "medium"),
        "path": str(finding.get("path") or ""),
        "message": str(finding.get("message") or ""),
        "evidence": finding.get("evidence", []) if isinstance(finding.get("evidence"), list) else [],
        "finding_fingerprint": fingerprint,
    }


def finding_fingerprint(tool_id: str, finding: dict[str, Any]) -> str:
    evidence_hash = evidence_hash_for_finding(finding)
    normalized = {
        "tool_id": tool_id,
        "rule": str(finding.get("rule") or "unknown").strip().lower(),
        "path": str(finding.get("path") or _first_evidence_path(finding)).replace("\\", "/"),
        "evidence_hash": evidence_hash,
        "message": _normalize_message(str(finding.get("message") or "")),
    }
    digest = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"finding:{digest}"


def evidence_hash_for_finding(finding: dict[str, Any]) -> str:
    evidence = finding.get("evidence", [])
    stable = evidence if isinstance(evidence, list) else []
    return "sha256:" + hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _select_findings(
    findings: list[dict[str, Any]],
    *,
    sample_size: int,
    strategy: str,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    if strategy == "random":
        return sorted(findings, key=lambda item: _stable_sort_key(item))[:sample_size]
    if strategy == "stratified_by_uncertainty":
        return _select_by_uncertainty(findings, sample_size=sample_size, base_dir=base_dir)
    by_rule: dict[str, list[dict[str, Any]]] = {}
    for finding in sorted(findings, key=lambda item: _stable_sort_key(item)):
        by_rule.setdefault(str(finding.get("rule") or "unknown"), []).append(finding)
    selected: list[dict[str, Any]] = []
    while len(selected) < sample_size and any(by_rule.values()):
        for rule in sorted(by_rule):
            bucket = by_rule[rule]
            if bucket:
                selected.append(bucket.pop(0))
                if len(selected) >= sample_size:
                    break
    return selected


def _select_by_uncertainty(
    findings: list[dict[str, Any]],
    *,
    sample_size: int,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    belief_scores = _belief_uncertainty_scores(base_dir)
    if not belief_scores:
        return _select_findings(findings, sample_size=sample_size, strategy="stratified_by_rule", base_dir=base_dir)
    ranked = []
    for finding in findings:
        score, belief_ids = _finding_uncertainty(finding, belief_scores)
        enriched = dict(finding)
        enriched["uncertainty_score"] = score
        enriched["uncertain_belief_ids"] = belief_ids
        ranked.append(enriched)
    return sorted(ranked, key=lambda item: (-float(item.get("uncertainty_score") or 0.0), _stable_sort_key(item)))[:sample_size]


def _belief_uncertainty_scores(base_dir: str | Path | None) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in load_jsonl(ensure_tools_dir(base_dir) / "memory" / "beliefs.jsonl"):
        belief_id = str(row.get("belief_id") or "")
        if belief_id:
            latest[belief_id] = row
    scores = []
    for belief_id, belief in latest.items():
        refs = _optional_string_list(belief.get("evidence_refs")) or _optional_string_list(belief.get("evidence"))
        if not refs:
            continue
        confidence = belief.get("confidence", 1.0)
        try:
            confidence_float = float(confidence)
        except (TypeError, ValueError):
            confidence_float = 1.0
        status = str(belief.get("status") or "supported")
        status_boost = {
            "contradicted": 0.35,
            "needs_revalidation": 0.25,
            "stale": 0.3,
            "withdrawn": 0.0,
            "supported": 0.0,
        }.get(status, 0.1)
        uncertainty = max(0.0, min(1.0, 1.0 - confidence_float + status_boost))
        if uncertainty <= 0:
            continue
        scores.append(
            {
                "belief_id": belief_id,
                "uncertainty": uncertainty,
                "evidence_refs": [ref.replace("\\", "/") for ref in refs],
            },
        )
    return sorted(scores, key=lambda item: (-float(item["uncertainty"]), str(item["belief_id"])))


def _finding_uncertainty(finding: dict[str, Any], belief_scores: list[dict[str, Any]]) -> tuple[float, list[str]]:
    paths = _finding_paths(finding)
    matched = []
    confidence = finding.get("confidence", 1.0)
    try:
        score = max(0.0, min(1.0, 1.0 - float(confidence)))
    except (TypeError, ValueError):
        score = 0.0
    severity_boost = {"critical": 0.2, "high": 0.12, "medium": 0.05, "low": 0.0}.get(str(finding.get("severity") or "").lower(), 0.0)
    score = min(1.0, score + severity_boost)
    for belief in belief_scores:
        refs = _optional_string_list(belief.get("evidence_refs"))
        if any(_path_matches_ref(path, ref) for path in paths for ref in refs):
            matched.append(str(belief.get("belief_id")))
            score = max(score, float(belief.get("uncertainty") or 0.0))
    return score, sorted(set(matched))


def _finding_paths(finding: dict[str, Any]) -> list[str]:
    paths = []
    path = finding.get("path")
    if isinstance(path, str) and path:
        paths.append(path)
    evidence = finding.get("evidence")
    if isinstance(evidence, list):
        paths.extend(str(item.get("path")) for item in evidence if isinstance(item, dict) and isinstance(item.get("path"), str))
    return sorted(set(path.replace("\\", "/") for path in paths if path))


def _path_matches_ref(path: str, ref: str) -> bool:
    normalized = ref.replace("\\", "/")
    return path == normalized or fnmatch.fnmatch(path, normalized) or path.startswith(normalized.rstrip("*"))


def _stable_sort_key(item: dict[str, Any]) -> str:
    return hashlib.sha256(
        f"{item.get('run_id')}:{item.get('finding_id')}:{item.get('rule')}".encode("utf-8"),
    ).hexdigest()


def _sample_id(tool_id: str, cycle_id: str | None, items: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256(
        json.dumps(
            {"tool_id": tool_id, "cycle_id": cycle_id, "items": [(i.get("run_id"), i.get("finding_id")) for i in items]},
            sort_keys=True,
        ).encode("utf-8"),
    ).hexdigest()[:12]
    return f"judge-{digest}"


def _sample_by_id(sample_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(judgment_samples_path(base_dir))):
        if row.get("sample_id") == sample_id:
            return row
    return None


def _batch_key(item: dict[str, Any]) -> tuple[str, str]:
    return (str(item.get("run_id") or ""), str(item.get("finding_id") or ""))


def _batch_verdict_key(verdict: dict[str, Any]) -> tuple[str, str]:
    run_id = str(verdict.get("run_id") or "")
    finding_id = str(verdict.get("finding_id") or "")
    return (run_id, finding_id)


def _resolve_batch_verdict_key(verdict: dict[str, Any], by_finding_id: dict[str, list[dict[str, Any]]]) -> tuple[str, str]:
    key = _batch_verdict_key(verdict)
    if key[0] or not key[1]:
        return key
    matches = by_finding_id.get(key[1], [])
    if len(matches) != 1:
        raise GovernanceError(f"batch verdict finding_id is ambiguous without run_id: {key[1]}")
    return _batch_key(matches[0])


def _evidence_refs_from_item(item: dict[str, Any]) -> list[str]:
    refs = []
    if isinstance(item.get("path"), str) and item["path"]:
        refs.append(item["path"])
    evidence = item.get("evidence")
    if isinstance(evidence, list):
        refs.extend(str(entry.get("path")) for entry in evidence if isinstance(entry, dict) and isinstance(entry.get("path"), str))
    return sorted(set(refs))


def _valid_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def _optional_string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if _valid_string_list(value) else []


def _confirmed_false_positive_fingerprints(base_dir: str | Path | None) -> dict[str, dict[str, Any]]:
    """Plan 023 v3 §F-1 — suppression eligibility filter.

    Pre-Plan-023 this read filtered ONLY on `verdict == "false_positive"`,
    accepting any row regardless of source_type. A single raw `ai_judge`
    verdict could suppress identical findings forever — no human review,
    no consensus, no audit trail. The pre-existing `compute_ai_consensus_
    for_tool` aggregator (lines 300-356) already produces ai_consensus
    rows from ≥2 raw ai_judge verdicts with verdict agreement +
    avg_confidence threshold, but the suppression filter never required
    them.

    Plan 023 v3 §F-1 fix: only `human` and `ai_consensus` source_types
    are eligible for suppression. Raw `ai_judge` rows alone never
    suppress directly — they flow through compute_ai_consensus_for_tool
    first; if they coalesce into an `ai_consensus` row, the suppression
    takes effect via that synthesized row.

    JJ-1 (ORPHAN-HIGH-731) NARROWS THAT AGAIN. Plan 023 stopped ONE judge
    from suppressing forever; it still let TWO do it, and suppression is the
    most irreversible thing a verdict can cause — the finding class stops
    being produced, so no later evidence can contradict it. Eligibility is
    now `is_ground_truth_row`: an operator verdict, or an ANCHOR consensus
    that a third judge was minted to attack and failed to overturn.
    """
    confirmed: dict[str, dict[str, Any]] = {}
    for row in load_feedback(base_dir=base_dir):
        if row.get("verdict") != "false_positive":
            continue
        # JJ-1 — ground-truth filter (one predicate, five readers). Raw
        # ai_judge rows and 2-judge consensus rows both stop here.
        if not is_ground_truth_row(row):
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if fingerprint:
            confirmed[fingerprint] = {
                "source_type": row.get("source_type") or "human",
                "judge_count": consensus_judge_count(row),
                "judges_voted": consensus_judges_voted(row),
                "run_id": row.get("run_id"),
                "finding_id": row.get("finding_id"),
                "recorded_at": row.get("recorded_at"),
            }
    return confirmed


def _first_evidence_path(finding: dict[str, Any]) -> str:
    evidence = finding.get("evidence")
    if isinstance(evidence, list):
        for item in evidence:
            if isinstance(item, dict) and isinstance(item.get("path"), str):
                return item["path"]
    return ""


def _normalize_message(message: str) -> str:
    return " ".join(message.lower().split())


def _max_severity(values: Any) -> str:
    order = {severity: index for index, severity in enumerate(FEEDBACK_SEVERITIES)}
    return max((value for value in values if value in order), key=lambda item: order[item], default="medium")


def _feedback_cycle(row: dict[str, Any], base_dir: str | Path | None) -> str | None:
    run_id = str(row.get("run_id") or "")
    for run in read_runs_rows(ensure_tools_dir(base_dir) / "runs.jsonl", base_dir=ensure_tools_dir(base_dir)):
        if run.get("run_id") == run_id:
            return str(run.get("cycle_id") or "")
    return None


def record_consensus_uncertainty(
    *,
    tool_id: str,
    run_id: str,
    finding_id: str,
    group_id: str,
    reason: str,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """ORPHAN-CRITICAL-735 — the ONE public producer of a consensus
    uncertainty, shared by the deterministic engine's caller and the
    agent-arbiter bridge.

    The live arbiter did its job correctly ("the two judges disagree —
    uncertainty, reason judge_disagreement", exactly as its contract and
    the engine it mirrors specify) and the Y5 bridge contract burned the
    claim as `judge_verdict.verdict:invalid:None` — the fourth instance
    of the kernel minting an outcome its own law refuses. The fix is one
    producer: the same row shape, the same ledger, the same idempotent
    escalation_id, so `sweep_consensus_uncertainties_for_human_required`
    drains BOTH lanes into one operator-triage record.
    """
    if reason not in CONSENSUS_UNCERTAINTY_REASONS:
        raise GovernanceError(
            f"unregistered_consensus_uncertainty_reason: {reason!r} — the "
            "vocabulary is CONSENSUS_UNCERTAINTY_REASONS (closed)"
        )
    row = _consensus_uncertainty(tool_id, run_id, finding_id, group_id, reason)
    uncertainties_path = (
        ensure_tools_dir(base_dir) / "feedback-consensus-uncertainties.jsonl"
    )
    seen: set[str] = set()
    for logged in load_jsonl(uncertainties_path) if uncertainties_path.exists() else []:
        for item in logged.get("uncertainties") or []:
            if item.get("escalation_id"):
                seen.add(str(item["escalation_id"]))
    if str(row.get("escalation_id")) not in seen:
        append_jsonl(
            uncertainties_path,
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "tool_id": tool_id,
                "cycle_id": cycle_id,
                "uncertainties": [row],
            },
        )
    return row


def _consensus_uncertainty(
    tool_id: str,
    run_id: str,
    finding_id: str,
    group_id: str,
    reason: str,
) -> dict[str, Any]:
    # Plan 023 §B — stable escalation_id so the human-escalation consumer
    # (human_required.sweep_consensus_uncertainties_for_human_required) can
    # record one idempotent HUMAN_REQUIRED entry per distinct consensus
    # failure, instead of this row landing in a file nothing ever reads.
    digest = hashlib.sha256(
        "|".join((tool_id, run_id, finding_id, group_id, reason)).encode("utf-8")
    ).hexdigest()[:16]
    return {
        "tool_id": tool_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "judgment_group_id": group_id,
        "reason": reason,
        "status": "uncertainty",
        "escalation_id": f"consensus-{digest}",
    }


# ORPHAN-668 — filename→declared-surface routing for every ledger this
# store (and its callers: proactive_priority, judge_calibration) writes.
# Raw-findings established the pattern; the verdict/calibration ledgers
# joined the state manifest so their rows survive the nightly publish,
# and a declared surface REFUSES the legacy chained append — routing here
# keeps every callsite on the single store-level write primitive. The
# seeding corpus files (operator-feedback-seeding/*/raw-findings.jsonl)
# do NOT flow through this store — calibration_bootstrap declares its own
# surface — so the "raw-findings.jsonl" name below can stay unambiguous.
_DECLARED_SURFACE_BY_FILENAME: dict[str, str] = {
    "raw-findings.jsonl": "raw_findings",
    "operator-feedback.jsonl": "operator_feedback",
    "judgment-samples.jsonl": "judgment_samples",
    "feedback-consensus-uncertainties.jsonl": "feedback_consensus_uncertainties",
    "priorities.jsonl": "proactive_priorities",
    "judge-calibration.jsonl": "calibration_judge",
    # ORPHAN-670 — the tool-finding and promotion ledgers joined the
    # declared roster (they died at job teardown before).
    "findings.jsonl": "findings",
    "promotions.jsonl": "promotions",
}


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    surface = _DECLARED_SURFACE_BY_FILENAME.get(path.name)
    if surface is not None:
        append_declared_jsonl(path, payload, expected_surface=surface)
        return
    append_chained_jsonl(path, payload)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    # ORPHAN-670 — a declared surface refuses the legacy chained rewrite
    # just like the legacy append; route through the same filename map so
    # the status-update path (finding open→resolved) keeps one primitive.
    surface = _DECLARED_SURFACE_BY_FILENAME.get(path.name)
    if surface is not None:
        from .ledger import rewrite_declared_jsonl

        rewrite_declared_jsonl(path, rows, expected_surface=surface)
        return
    rewrite_chained_jsonl(path, rows)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return load_chained_jsonl(path)
