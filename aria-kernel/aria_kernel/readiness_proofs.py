"""F5-a — production producer for enterprise workflow-run proofs.

WHY this module exists: the enterprise readiness-claim chain (auto-merge's
lock) demands proof rows whose ``source_ledger_ref`` RESOLVES via
``ledger_refs.find_row_by_source_ledger_ref``. Until F5-a,
``enterprise_readiness.record_workflow_run_proof`` had zero production
callers and the live CI evidence rows in ``ci/workflow-runs.jsonl`` carried
no row identity, so no real workflow run could ever be ledger-bound into a
readiness claim. This module is the first production bridge: it turns the
PR's successful CI workflow-run rows into workflow-run proof rows whose
refs provably resolve back to the source ledger.

WHAT it does: select the PR's successful ``ci_workflow_run`` rows (matched
on pr_number + head_sha, conclusion == "success"), build a
``source_ledger_ref`` for each via ``ledger_refs.ledger_ref_for_row``, and
record one proof per workflow run through
``enterprise_readiness.record_workflow_run_proof`` — which itself refuses
any ref that does not resolve. Idempotent: runs already proven for the same
head_sha are skipped; legacy rows without row identity are skipped with a
structural reason instead of crashing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .enterprise_readiness import record_workflow_run_proof
from .ledger import load_declared_jsonl
from .ledger_refs import ledger_ref_for_row
from .tool_registry import GovernanceError, ensure_tools_dir

# Single spelling of the source/target surfaces so the producer and its
# tests cannot drift from the state_manifest declaration (İ1).
CI_WORKFLOW_RUNS_SURFACE = "ci_workflow_runs"
CI_WORKFLOW_RUNS_LEDGER_PATH = "ci/workflow-runs.jsonl"
CI_WORKFLOW_RUN_ROW_TYPE = "ci_workflow_run"
WORKFLOW_RUN_PROOFS_SURFACE = "enterprise_workflow_run_proofs"
WORKFLOW_RUN_PROOFS_LEDGER_PATH = "enterprise/workflow-run-proofs.jsonl"

SKIP_REASON_LEGACY_ROW = "legacy_row_missing_row_identity"
SKIP_REASON_ALREADY_PROVEN = "already_proven"


def produce_workflow_run_proofs(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    readiness_claim_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record enterprise workflow-run proofs for a PR head's successful runs.

    Returns a report: ``produced`` (proof rows written this call) and
    ``skipped`` (per-run structural reasons). Raises GovernanceError on
    invalid binding inputs — a proof bound to an empty repo/sha would be
    audit theater, so the producer fails closed instead of recording it.
    """
    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    root = ensure_tools_dir(base_dir)
    runs = load_declared_jsonl(
        root / CI_WORKFLOW_RUNS_LEDGER_PATH,
        expected_surface=CI_WORKFLOW_RUNS_SURFACE,
    )
    candidates = [
        row for row in runs
        if str(row.get("pr_number")) == str(pr_number)
        and str(row.get("head_sha") or "") == head_sha
        and row.get("conclusion") == "success"
    ]
    proven = _proven_run_ids(root, head_sha=head_sha)

    produced: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    # Latest row wins per workflow_run_id: re-recorded runs (multiple
    # record_ci_report calls) each produce a distinct ledger row; proving
    # every duplicate would mint redundant proofs for one real run.
    for run_id, row in _latest_by_run_id(candidates, skipped).items():
        if run_id in proven:
            skipped.append(_skip(row, SKIP_REASON_ALREADY_PROVEN))
            continue
        source_ledger_ref = ledger_ref_for_row(
            surface=CI_WORKFLOW_RUNS_SURFACE,
            ledger_path=CI_WORKFLOW_RUNS_LEDGER_PATH,
            row_id=str(row["row_id"]),
            row_type=str(row["row_type"]),
            row=row,
        )
        proof: dict[str, Any] = {
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "workflow_run_id": row.get("workflow_run_id"),
            "conclusion": row.get("conclusion"),
            "source_ledger_ref": source_ledger_ref,
        }
        # readiness_claim_id binds the proof to one claim row; it is
        # optional because proofs can be produced before the claim is
        # minted (the claim verifier matches on the binding fields).
        if readiness_claim_id is not None:
            proof["readiness_claim_id"] = readiness_claim_id
        produced.append(record_workflow_run_proof(proof, base_dir=root))

    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "produced": produced,
        "skipped": skipped,
        "produced_count": len(produced),
        "skipped_count": len(skipped),
    }


def _require_binding(*, pr_number: int, repo: str, target_ref: str, head_ref: str, head_sha: str) -> None:
    if not isinstance(pr_number, int) or isinstance(pr_number, bool) or pr_number <= 0:
        raise GovernanceError("workflow_run_proof_pr_number_must_be_positive_int")
    for name, value in (("repo", repo), ("target_ref", target_ref), ("head_ref", head_ref), ("head_sha", head_sha)):
        if not isinstance(value, str) or not value.strip():
            raise GovernanceError(f"workflow_run_proof_binding_required:{name}")


def _latest_by_run_id(
    candidates: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Partition candidate rows: provable (keyed by run id) vs skipped.

    A row missing row_id/row_type predates F5-a row identity — it CANNOT
    be targeted by find_row_by_source_ledger_ref, so it is reported as a
    structural skip rather than crashing mid-produce (the operator's
    remedy is to re-record the CI report, which stamps identity).
    """
    latest: dict[str, dict[str, Any]] = {}
    for row in candidates:
        row_id = row.get("row_id")
        row_type = row.get("row_type")
        if not isinstance(row_id, str) or not row_id or row_type != CI_WORKFLOW_RUN_ROW_TYPE:
            skipped.append(_skip(row, SKIP_REASON_LEGACY_ROW))
            continue
        latest[str(row.get("workflow_run_id"))] = row
    return latest


def _proven_run_ids(root: Path, *, head_sha: str) -> set[str]:
    proofs = load_declared_jsonl(
        root / WORKFLOW_RUN_PROOFS_LEDGER_PATH,
        expected_surface=WORKFLOW_RUN_PROOFS_SURFACE,
    )
    return {
        str(row.get("workflow_run_id"))
        for row in proofs
        if str(row.get("head_sha") or "") == head_sha
        and row.get("workflow_run_id") is not None
    }


def _skip(row: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "reason": reason,
        "workflow_run_id": row.get("workflow_run_id"),
        "name": row.get("name"),
        "ledger_hash": row.get("ledger_hash"),
    }


__all__ = [
    "CI_WORKFLOW_RUNS_LEDGER_PATH",
    "CI_WORKFLOW_RUNS_SURFACE",
    "CI_WORKFLOW_RUN_ROW_TYPE",
    "SKIP_REASON_ALREADY_PROVEN",
    "SKIP_REASON_LEGACY_ROW",
    "WORKFLOW_RUN_PROOFS_LEDGER_PATH",
    "WORKFLOW_RUN_PROOFS_SURFACE",
    "produce_workflow_run_proofs",
]
