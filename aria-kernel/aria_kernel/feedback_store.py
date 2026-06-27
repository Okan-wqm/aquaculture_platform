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
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
FEEDBACK_SOURCE_TYPES = ("human", "ai_judge", "ai_consensus")
JUDGMENT_STRATEGIES = ("stratified_by_uncertainty", "stratified_by_rule", "random")
DEFAULT_MIN_JUDGED_SAMPLES = 10
CONSENSUS_MIN_CONFIDENCE = 0.80


def findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "findings.jsonl"


def feedback_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def judgment_samples_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "judgment-samples.jsonl"


def raw_findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "raw-findings.jsonl"


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
                "finding": finding,
            },
        )


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
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(findings_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    if status is not None:
        rows = [row for row in rows if row.get("status") == status]
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
) -> dict[str, Any]:
    if min_confidence < 0 or min_confidence > 1:
        raise GovernanceError("min_confidence must be between 0 and 1")
    ai_rows = [
        row
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if row.get("source_type") == "ai_judge" and (cycle_id is None or _feedback_cycle(row, base_dir) == cycle_id)
    ]
    existing_consensus = {
        (str(row.get("run_id")), str(row.get("finding_id")), str(row.get("judgment_group_id") or ""))
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if row.get("source_type") == "ai_consensus"
    }
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
        if key in existing_consensus:
            continue
        if len(rows) < 2:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "single_judge"))
            continue
        verdicts = {str(row.get("verdict") or "") for row in rows}
        avg_confidence = sum(float(row.get("confidence") or 0.0) for row in rows) / len(rows)
        if len(verdicts) != 1:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "judge_disagreement"))
            continue
        if avg_confidence < min_confidence:
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "low_confidence"))
            continue
        # Plan 024 §C — evidence-gated arbiter. When a workspace is supplied, the
        # union of judge evidence is only published as consensus if it actually
        # resolves in the repo; a judge citing fabricated evidence escalates to a
        # human instead of being rubber-stamped. Opt-in: legacy callers without
        # workspace_root keep the pure mechanical gate.
        if workspace_root is not None and _has_unverifiable_evidence(rows, workspace_root):
            uncertainties.append(_consensus_uncertainty(tool_id, run_id, finding_id, group_id, "evidence_not_repo_verified"))
            continue
        verdict = verdicts.pop()
        severity = _max_severity(str(row.get("severity") or "medium") for row in rows)
        consensus_rows.append(
            record_operator_feedback(
                tool_id=tool_id,
                run_id=run_id,
                finding_id=finding_id,
                verdict=verdict,
                severity=severity,
                note=f"AI consensus from {len(rows)} independent judges",
                source_type="ai_consensus",
                judge_id="aria-consensus-arbiter",
                model="consensus",
                confidence=round(avg_confidence, 3),
                rationale="; ".join(str(row.get("rationale") or row.get("note") or "") for row in rows if row.get("rationale") or row.get("note"))[:2000],
                evidence_refs=sorted({ref for row in rows for ref in _optional_string_list(row.get("evidence_refs"))}),
                judgment_group_id=group_id,
                finding_fingerprint=next((str(row.get("finding_fingerprint")) for row in rows if row.get("finding_fingerprint")), ""),
                base_dir=base_dir,
            ),
        )
    if uncertainties:
        append_jsonl(
            ensure_tools_dir(base_dir) / "feedback-consensus-uncertainties.jsonl",
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "tool_id": tool_id,
                "cycle_id": cycle_id,
                "uncertainties": uncertainties,
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
        if fingerprint in confirmed_false_positive_fingerprints:
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
            if fingerprint in confirmed_false_positive_fingerprints:
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
    """
    confirmed: dict[str, dict[str, Any]] = {}
    for row in load_feedback(base_dir=base_dir):
        if row.get("verdict") != "false_positive":
            continue
        # Plan 023 v3 §F-1 — source_type filter. raw ai_judge rows are
        # NOT suppression-eligible; they must pass through the
        # consensus aggregator first.
        source_type = row.get("source_type", "human")
        if source_type not in ("human", "ai_consensus"):
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if fingerprint:
            confirmed[fingerprint] = {
                "source_type": source_type,
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


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    if path.name == "raw-findings.jsonl":
        append_declared_jsonl(path, payload, expected_surface="raw_findings")
        return
    append_chained_jsonl(path, payload)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    rewrite_chained_jsonl(path, rows)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return load_chained_jsonl(path)
