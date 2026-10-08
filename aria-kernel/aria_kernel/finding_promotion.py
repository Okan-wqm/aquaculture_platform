"""Kapalı Döngü D3 — accepted consensus becomes a durable finding.

WHY: until this module existed, NOTHING converted an `ai_consensus`
true_positive into a committed finding — the loop was "find → judge →
forget" by construction, while confirmed false positives were remembered
forever (fingerprint suppression). This is the missing symmetric half:
a confirmed TRUE positive is promoted exactly once per fingerprint into
the operator-facing `aria-findings/` record (owner-visible, report-rendered,
plan-candidate via scan_f_findings) and never re-judged again.

Contract discipline (verified against finding.emit_finding):
* claim text is CONSTRUCTED from structured fields only — judge free text
  never reaches the banned-phrase gate;
* evidence refs are repo-file paths only, pre-checked for existence so a
  ledger/self-output ref can never poison the emission;
* claim type and severity come from the rule's manifest contract
  (ARIA-MEDIUM-326): the contract's claim_type, and the consensus severity
  bounded by the contract's severity_cap and the claim type's floor;
* the promotion ledger (`promotions.jsonl`, hash-chain-free append like the
  sibling feedback ledgers) is the once-only memory — read by the sampler
  to stop re-judging what is already committed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .adapter_findings import adapter_findings_by_fingerprint
from .evidence_trust import tool_evidence_refusal
from .feedback_store import (
    append_jsonl,
    load_feedback,
    load_jsonl,
    promotions_path,
)
from .rule_contract import resolve_rule_contract
from .tool_registry import ensure_tools_dir, utc_now

def promoted_fingerprints(base_dir: str | Path | None = None) -> set[str]:
    """Fingerprints that already have a committed finding."""
    path = promotions_path(base_dir)
    return {
        str(row.get("finding_fingerprint"))
        for row in (load_jsonl(path) if path.exists() else [])
        if row.get("finding_fingerprint")
    }


def promotion_row(
    *,
    finding_fingerprint: str,
    finding_id: Any,
    tool_id: Any,
    judgment_group_id: Any,
) -> dict[str, Any]:
    """The one constructor of a promotions row: the finding_funnel proof row,
    whose meaning its schema_version declares (pinned by producer fixture in
    test_capability_semantic_equivalence)."""
    return {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "finding_fingerprint": finding_fingerprint,
        "finding_id": finding_id,
        "tool_id": tool_id,
        "judgment_group_id": judgment_group_id,
    }


def _repo_file_refs(row: dict[str, Any], repo_root: Path) -> list[str]:
    """Evidence refs that resolve to real repo files (path[:line])."""
    refs: list[str] = []
    for ref in row.get("evidence_refs") or []:
        if not isinstance(ref, str) or not ref.strip():
            continue
        path_part = ref.split(":", 1)[0]
        candidate = (repo_root / path_part)
        try:
            resolved = candidate.resolve()
            resolved.relative_to(repo_root.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            refs.append(ref)
    return refs


def _subject_ref(finding: dict[str, Any]) -> str:
    """The adapter finding's own location as an evidence ref (path[:line])."""
    path, _, suffix = str(finding.get("path") or "").partition(":")
    line = finding.get("line")
    if not isinstance(line, int) or isinstance(line, bool):
        line = int(suffix) if suffix.isdigit() else None
    return f"{path}:{line}" if line else path


def _subject_facts(adapter_finding: dict[str, Any]) -> list[str]:
    from .finding_subject import ADAPTER_SUBJECT_FACT_PREFIX

    subject = adapter_finding.get("subject")
    if isinstance(subject, str) and subject.strip():
        return [f"{ADAPTER_SUBJECT_FACT_PREFIX}{subject.strip()}"]
    return []


def promote_consensus_findings(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    """Promote every unpromoted ai_consensus true_positive; idempotent.

    ARIA-AUDIT-015: promoting AI-consensus rows into operator-facing
    findings used to carry no operator gate at all — weaker than a string
    check. The batch now requires an operator approval reference that
    RESOLVES (gov:<event>, review:<path>#<id>, ack-env:<VAR>); without
    one the promotion refuses, which the cycle records as a blocked step
    rather than a silent empty promotion.

    ARIA-CRITICAL-216 classifies this as a RECORD surface: admitting a
    consensus finding widens what the operator sees, not what ARIA may do
    (acting on a finding still needs the profile and grant authority), so
    the recorded-reference grammar is the right proof here and only here.
    """
    import os

    from .finding import CLAIM_TYPES, emit_finding
    from .operator_approval import OperatorApprovalUnrecorded, verify_recorded_reference

    repo_path = Path(repo_root).resolve()
    root = ensure_tools_dir(base_dir)
    if operator_approval_ref is None:
        ack = os.environ.get("ARIA_CONSENSUS_PROMOTION_ACK", "").strip()
        operator_approval_ref = f"ack-env:ARIA_CONSENSUS_PROMOTION_ACK" if ack else None
    try:
        verify_recorded_reference(
            operator_approval_ref, base_dir=root, surface="consensus_finding_promotion",
        )
    except OperatorApprovalUnrecorded as exc:
        from .tool_registry import GovernanceError

        raise GovernanceError(f"consensus_promotion_operator_approval: {exc}") from exc
    already = promoted_fingerprints(root)
    promoted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    pending = [
        row for row in load_feedback(base_dir=root)
        if row.get("source_type") == "ai_consensus" and row.get("verdict") == "true_positive"
    ]
    wanted = {str(row.get("finding_fingerprint") or "") for row in pending} - already - {""}
    # ARIA-HIGH-325 — the subject is the finding the judges were asked
    # about, not whichever cited file sorts first: F-011 read "at
    # tools/aria-adapters/bundle-budget-adapter.ts", F-009 named a
    # platform-admin spec while its subject was hr-service's gql-auth.guard.ts.
    subjects = adapter_findings_by_fingerprint(wanted, base_dir=root) if wanted else {}
    for row in pending:
        fingerprint = str(row.get("finding_fingerprint") or "")
        if not fingerprint:
            # ORPHAN-HIGH-765 — visible, not silent. A consensus row whose
            # judges minted before fingerprint threading can never promote,
            # and an invisible skip is indistinguishable from "nothing to
            # promote" — the exact silence that hid 24,788 raw findings
            # promoting to zero for months while the circuit looked wired.
            skipped.append({
                "finding_fingerprint": "",
                "reason": "missing_finding_fingerprint",
                "finding_id": row.get("finding_id"),
                "run_id": row.get("run_id"),
                "judgment_group_id": row.get("judgment_group_id"),
            })
            continue
        if fingerprint in already:
            continue
        subject = subjects.get(fingerprint)
        if subject is None:
            skipped.append({"finding_fingerprint": fingerprint, "reason": "adapter_finding_unresolved"})
            continue
        tool_id = str(row.get("tool_id") or "")
        rule = str(subject.get("rule") or "")
        contract = resolve_rule_contract(tool_id=tool_id, rule=rule, base_dir=root)
        if contract is None:
            skipped.append({
                "finding_fingerprint": fingerprint, "reason": "rule_contract_undeclared",
                "tool_id": tool_id, "rule": rule,
            })
            continue
        subject_ref = _subject_ref(subject)
        cited = [ref for ref in row.get("evidence_refs") or [] if isinstance(ref, str) and ref.strip()]
        # ARIA-HIGH-325 — evidence for a promotion lies in the producing
        # tool's declared scope; one inadmissible ref means the consensus
        # argued the rule, so the whole row is refused, visibly.
        refused = {
            ref: refusal for ref in [subject_ref, *cited]
            if (refusal := tool_evidence_refusal(ref, declared_scope=contract.declared_scope)) is not None
        }
        if refused:
            skipped.append({"finding_fingerprint": fingerprint, "reason": "inadmissible_evidence", "refused": refused})
            continue
        refs = _repo_file_refs({"evidence_refs": list(dict.fromkeys([subject_ref, *cited]))}, repo_path)
        if not refs or refs[0] != subject_ref:
            skipped.append({
                "finding_fingerprint": fingerprint,
                "reason": "no_repo_verified_evidence",
            })
            continue
        min_evidence = int(CLAIM_TYPES[contract.claim_type]["min_evidence"])
        if len(refs) < min_evidence:
            # emit_finding would refuse it and abort every later promotion.
            skipped.append({
                "finding_fingerprint": fingerprint, "reason": "insufficient_admissible_evidence",
                "claim_type": contract.claim_type, "min_evidence": min_evidence,
            })
            continue
        scope_files = sorted({ref.split(":", 1)[0] for ref in refs})
        confidence = row.get("confidence")
        summary = (
            f"{rule} at {subject_ref} "
            f"(tool {tool_id}, finding {row.get('finding_id')}, AI consensus"
            + (f" confidence {confidence}" if confidence is not None else "")
            + f"): {contract.defect_claim}"
        )
        finding = emit_finding(
            repo_root=repo_path,
            base_dir=root,
            claim_type=contract.claim_type,
            claim_summary=summary,
            severity=contract.promotion_severity(str(row.get("severity") or "medium")),
            evidences=[{"ref": ref} for ref in refs],
            facts=[
                f"finding_fingerprint={fingerprint}",
                f"rule={rule}",
                f"judgment_group_id={row.get('judgment_group_id')}",
                f"consensus_run_id={row.get('run_id')}",
                # ARIA-MEDIUM-378 — the adapter's declared subject, so findings
                # of two rules about one defect share a subject key
                # (finding_subject.finding_subject_key).
                *_subject_facts(subject),
            ],
            scope_files=scope_files,
            originating_skill="ai_consensus:judgment_pipeline",
            originating_run_id=str(row.get("run_id") or "") or None,
        )
        already.add(fingerprint)
        append_jsonl(
            promotions_path(root),
            promotion_row(
                finding_fingerprint=fingerprint,
                finding_id=finding.get("finding_id"),
                tool_id=row.get("tool_id"),
                judgment_group_id=row.get("judgment_group_id"),
            ),
        )
        promoted.append({
            "finding_fingerprint": fingerprint,
            "finding_id": finding.get("finding_id"),
        })

    return {
        "schema_version": 1,
        "promoted": promoted,
        "skipped": skipped,
        "promoted_count": len(promoted),
        "skipped_count": len(skipped),
    }
