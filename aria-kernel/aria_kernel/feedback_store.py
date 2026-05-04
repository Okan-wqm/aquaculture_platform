from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

from .ledger import append_jsonl as append_chained_jsonl
from .ledger import load_jsonl as load_chained_jsonl
from .ledger import rewrite_jsonl as rewrite_chained_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FEEDBACK_VERDICTS = ("true_positive", "false_positive")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
FEEDBACK_SOURCE_TYPES = ("human", "ai_judge", "ai_consensus")
JUDGMENT_STRATEGIES = ("stratified_by_rule", "random")
DEFAULT_MIN_JUDGED_SAMPLES = 10
CONSENSUS_MIN_CONFIDENCE = 0.80


def findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "findings.jsonl"


def feedback_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def judgment_samples_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "judgment-samples.jsonl"


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


def generate_ai_consensus(
    *,
    tool_id: str,
    cycle_id: str | None = None,
    min_confidence: float = CONSENSUS_MIN_CONFIDENCE,
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
    strategy: str = "stratified_by_rule",
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
    selected = _select_findings(findings, sample_size=sample_size, strategy=strategy)
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
            "lane": "record one operator-feedback verdict per sampled finding_id",
            "cli": "aria-kernel feedback record --tool-id ... --run-id ... --finding-id ... --verdict true_positive|false_positive",
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
    for run in load_jsonl(ensure_tools_dir(base_dir) / "runs.jsonl"):
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
            candidates.append(
                {
                    "tool_id": tool_id,
                    "run_id": run_id,
                    "cycle_id": run.get("cycle_id"),
                    "finding_id": finding_id,
                    "rule": str(finding.get("rule") or "unknown"),
                    "severity": str(finding.get("severity") or "medium"),
                    "path": str(finding.get("path") or ""),
                    "message": str(finding.get("message") or ""),
                    "evidence": finding.get("evidence", []) if isinstance(finding.get("evidence"), list) else [],
                    "finding_fingerprint": fingerprint,
                },
            )
    return candidates


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


def _select_findings(findings: list[dict[str, Any]], *, sample_size: int, strategy: str) -> list[dict[str, Any]]:
    if strategy == "random":
        return sorted(findings, key=lambda item: _stable_sort_key(item))[:sample_size]
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


def _valid_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def _optional_string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if _valid_string_list(value) else []


def _confirmed_false_positive_fingerprints(base_dir: str | Path | None) -> dict[str, dict[str, Any]]:
    confirmed: dict[str, dict[str, Any]] = {}
    for row in load_feedback(base_dir=base_dir):
        if row.get("verdict") != "false_positive":
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if fingerprint:
            confirmed[fingerprint] = {
                "source_type": row.get("source_type", "human"),
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
    for run in load_jsonl(ensure_tools_dir(base_dir) / "runs.jsonl"):
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
    return {
        "tool_id": tool_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "judgment_group_id": group_id,
        "reason": reason,
        "status": "uncertainty",
    }


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    append_chained_jsonl(path, payload)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    rewrite_chained_jsonl(path, rows)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return load_chained_jsonl(path)
