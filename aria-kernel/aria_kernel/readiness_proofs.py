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

from .enterprise_readiness import (
    REQUIRED_MERGE_STATUS_CHECKS,
    record_branch_protection_proof,
    record_workflow_run_proof,
)
from .ledger import append_declared_jsonl, load_declared_jsonl
from .ledger_refs import ledger_ref_for_row
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

# Single spelling of the source/target surfaces so the producer and its
# tests cannot drift from the state_manifest declaration (İ1).
CI_WORKFLOW_RUNS_SURFACE = "ci_workflow_runs"
CI_WORKFLOW_RUNS_LEDGER_PATH = "ci/workflow-runs.jsonl"
CI_WORKFLOW_RUN_ROW_TYPE = "ci_workflow_run"
WORKFLOW_RUN_PROOFS_SURFACE = "enterprise_workflow_run_proofs"
WORKFLOW_RUN_PROOFS_LEDGER_PATH = "enterprise/workflow-run-proofs.jsonl"

SKIP_REASON_LEGACY_ROW = "legacy_row_missing_row_identity"
SKIP_REASON_ALREADY_PROVEN = "already_proven"

# F5-b (ORPHAN-694) — branch-protection snapshot + proof surfaces.
BP_SNAPSHOTS_SURFACE = "enterprise_branch_protection_snapshots"
BP_SNAPSHOTS_LEDGER_PATH = "enterprise/branch-protection-snapshots.jsonl"
BP_SNAPSHOT_ROW_TYPE = "branch_protection_snapshot"
BRANCH_PROTECTION_PROOF_SCHEMA = "aria/branch-protection-proof/v3"


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


# --------------------------------------------------------------------------
# F5-b (ORPHAN-694) — branch-protection proof producer.
#
# WHY: `record_branch_protection_proof` (the family the claim verifier
# demands) had zero production callers, and there was no ledger row a
# proof's ``source_ledger_ref`` could even point at — the GitHub probe
# existed (preflight) but its evidence evaporated with the process. The
# producer records the RAW gh-api snapshot as a ledger row, then mints a
# proof whose every field is MEASURED from that snapshot. An honest
# producer records what IS configured; the claim gate is where policy
# (exact required checks, no bypass actors) gets enforced — a repo with
# weak protection yields a proof that says so, and the claim fails loudly.
# --------------------------------------------------------------------------


def _canonical_sha256(payload: dict[str, Any]) -> str:
    import hashlib
    import json

    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def record_branch_protection_snapshot(
    payload: dict[str, Any],
    *,
    repo: str,
    branch: str,
    probe_ok: bool,
    probe_reasons: tuple[str, ...] | list[str],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Persist the raw protection payload as the proof's resolvable source."""
    if not isinstance(payload, dict) or not payload:
        raise GovernanceError("branch_protection_snapshot_payload_required")
    root = ensure_tools_dir(base_dir)
    payload_hash = _canonical_sha256(payload)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"bp-snapshot:{repo}:{branch}:{payload_hash[:12]}",
        "row_type": BP_SNAPSHOT_ROW_TYPE,
        "repo": repo,
        "branch": branch,
        "payload_hash": payload_hash,
        "payload": payload,
        "probe_ok": bool(probe_ok),
        "probe_reasons": list(probe_reasons),
    }
    return append_declared_jsonl(
        root / BP_SNAPSHOTS_LEDGER_PATH, row,
        expected_surface=BP_SNAPSHOTS_SURFACE,
    )


def _measured_protection_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Every proof field derives from the snapshot — nothing is asserted."""
    def enabled(*path: str) -> bool:
        cursor: Any = payload
        for key in path:
            if not isinstance(cursor, dict):
                return False
            cursor = cursor.get(key)
        if isinstance(cursor, dict):
            return cursor.get("enabled") is True
        return cursor is True

    checks_block = payload.get("required_status_checks")
    contexts = (
        [str(c) for c in checks_block.get("contexts", [])]
        if isinstance(checks_block, dict)
        else []
    )
    return {
        "required_checks": contexts,
        "exact_required_checks": contexts,
        "signed_commits_required": enabled("required_signatures"),
        "reviews_required": isinstance(payload.get("required_pull_request_reviews"), dict),
        "conversation_resolution_required": enabled("required_conversation_resolution"),
        "force_push_disabled": not enabled("allow_force_pushes"),
        "delete_branch_disabled": not enabled("allow_deletions"),
    }


def produce_branch_protection_proof(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    readiness_claim_id: str | None = None,
    base_dir: str | Path | None = None,
    probe: Any = None,
    rules_probe: Any = None,
) -> dict[str, Any]:
    """Probe → snapshot row → measured proof row.

    ``probe`` defaults to ``preflight.probe_branch_protection`` (the ONE
    probe, İ1); ``rules_probe`` supplies ``(ruleset_ids, bypass_actors)``
    for the branch and defaults to the gh-api rules probe below. Both are
    injectable so tests exercise the producer without network.

    Fails closed: no payload → no snapshot → no proof. A probe that
    reaches GitHub but finds weak protection still produces — the proof
    records the weakness and the claim gate rejects it loudly, which is
    the honest split between measurement and policy.
    """
    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    if probe is None:
        from .preflight import probe_branch_protection as probe
    if rules_probe is None:
        rules_probe = _probe_branch_rules

    ok, reasons, payload = probe(branch=target_ref, repo=repo)
    if payload is None:
        raise GovernanceError(
            f"branch_protection_probe_no_payload: {';'.join(reasons) or 'unknown'}"
        )
    root = ensure_tools_dir(base_dir)
    snapshot = record_branch_protection_snapshot(
        payload, repo=repo, branch=target_ref,
        probe_ok=ok, probe_reasons=reasons, base_dir=root,
    )
    source_ledger_ref = ledger_ref_for_row(
        surface=BP_SNAPSHOTS_SURFACE,
        ledger_path=BP_SNAPSHOTS_LEDGER_PATH,
        row_id=str(snapshot["row_id"]),
        row_type=str(snapshot["row_type"]),
        row=snapshot,
    )
    ruleset_ids, bypass_actors = rules_probe(repo=repo, branch=target_ref)
    measured = _measured_protection_fields(payload)
    proof: dict[str, Any] = {
        "$schema": BRANCH_PROTECTION_PROOF_SCHEMA,
        "repo": repo,
        "pr_number": pr_number,
        "target_ref": target_ref,
        "head_ref": head_ref,
        "head_sha": head_sha,
        # valid is the probe verdict over REQUIRED_BRANCH_PROTECTION_FIELDS
        # AND the exact-checks comparison the claim gate will re-run —
        # recorded here so a red proof names itself before any claim reads it.
        "valid": bool(
            ok
            and sorted(measured["required_checks"]) == sorted(REQUIRED_MERGE_STATUS_CHECKS)
        ),
        "snapshot_hash": snapshot["payload_hash"],
        "ruleset_ids": list(ruleset_ids),
        "bypass_actors": list(bypass_actors),
        "probe_reasons": list(reasons),
        "source_ledger_ref": source_ledger_ref,
        **measured,
    }
    if readiness_claim_id is not None:
        proof["readiness_claim_id"] = readiness_claim_id
    recorded = record_branch_protection_proof(proof, base_dir=root)
    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "snapshot": snapshot,
        "proof": recorded,
        "valid": recorded.get("valid"),
        "probe_reasons": list(reasons),
    }


def _probe_branch_rules(*, repo: str, branch: str, gh_cli: str = "gh") -> tuple[list[int], list[dict[str, Any]]]:
    """gh-api rules probe: (active ruleset ids, aggregated bypass actors).

    Read-only, best-effort on the ID list (an empty result is recorded as
    empty and the claim gate decides), but a FAILURE to reach the API is
    an exception — silence must never read as "no bypass actors".
    """
    import json
    import subprocess

    proc = subprocess.run(
        [gh_cli, "api", f"repos/{repo}/rules/branches/{branch}"],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise GovernanceError(
            f"branch_rules_probe_failed: {proc.stderr.strip().splitlines()[0][:200] if proc.stderr else '<empty>'}"
        )
    rules = json.loads(proc.stdout)
    ruleset_ids = sorted({int(rule["ruleset_id"]) for rule in rules if isinstance(rule, dict) and "ruleset_id" in rule})
    bypass_actors: list[dict[str, Any]] = []
    for ruleset_id in ruleset_ids:
        detail_proc = subprocess.run(
            [gh_cli, "api", f"repos/{repo}/rulesets/{ruleset_id}"],
            capture_output=True, text=True, timeout=30,
        )
        if detail_proc.returncode != 0:
            raise GovernanceError(f"ruleset_detail_probe_failed:{ruleset_id}")
        detail = json.loads(detail_proc.stdout)
        for actor in detail.get("bypass_actors") or []:
            bypass_actors.append(actor)
    return ruleset_ids, bypass_actors
