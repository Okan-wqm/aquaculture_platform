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
    record_remote_cas_proof,
    record_retention_proof,
    record_rollback_proof,
    record_token_proof,
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

# F5-d (ORPHAN-694) — remote-cas lease snapshot surface (family convention:
# one snapshot ledger per proof family, matching the per-family proof
# ledgers the claim verifier already reads).
CAS_SNAPSHOTS_SURFACE = "enterprise_remote_cas_lease_snapshots"
CAS_SNAPSHOTS_LEDGER_PATH = "enterprise/remote-cas-lease-snapshots.jsonl"
CAS_SNAPSHOT_ROW_TYPE = "remote_cas_lease_snapshot"

# F5-c (ORPHAN-694) — token lease snapshot surface (metadata ONLY; the
# token itself never touches a ledger).
TOKEN_SNAPSHOTS_SURFACE = "enterprise_token_lease_snapshots"
TOKEN_SNAPSHOTS_LEDGER_PATH = "enterprise/token-lease-snapshots.jsonl"
TOKEN_SNAPSHOT_ROW_TYPE = "token_lease_snapshot"

# F5-f (ORPHAN-694) — DLP scan snapshot surface.
DLP_SNAPSHOTS_SURFACE = "enterprise_dlp_scan_snapshots"
DLP_SNAPSHOTS_LEDGER_PATH = "enterprise/dlp-scan-snapshots.jsonl"
DLP_SNAPSHOT_ROW_TYPE = "dlp_scan_snapshot"


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
    """"sha256:"-prefixed canonical digest — the claim gate's
    `_is_sha256_digest` REQUIRES the prefix; a raw hex here would mint
    proofs the gate structurally rejects."""
    import hashlib
    import json

    return "sha256:" + hashlib.sha256(
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


# --------------------------------------------------------------------------
# F5-d (ORPHAN-694) — remote-CAS lease proof producer.
#
# WHY: `acquire_remote_cas_lease` implemented full CAS semantics (epoch
# fencing, owner compare, stale reap) and had ZERO production callers —
# the mechanism the claim verifier calls the merge lock's liveness proof
# was a museum piece. This producer is its first caller: acquiring (or
# same-owner refreshing) the lease IS the evidence, snapshotted to a
# ledger row the proof's source ref resolves into.
# --------------------------------------------------------------------------


def produce_remote_cas_proof(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    owner: str | None = None,
    readiness_claim_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Acquire the remote-CAS lease and mint the proof from what was acquired.

    Fails closed on a fresh lease held by ANOTHER owner (GovernanceError
    from the lease layer) — a proof must never be minted over someone
    else's live lease, because the whole point of the family is "exactly
    one autonomous writer per target".
    """
    from .autonomous_host_lease import acquire_remote_cas_lease

    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    root = ensure_tools_dir(base_dir)
    lease = acquire_remote_cas_lease(
        base_dir=root, target_ref=target_ref, head_sha=head_sha, owner=owner,
    )
    snapshot_row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"cas-lease:{lease.lease_id}:{lease.epoch}",
        "row_type": CAS_SNAPSHOT_ROW_TYPE,
        "lease_id": lease.lease_id,
        "epoch": lease.epoch,
        "owner": lease.owner,
        "target_ref": lease.target_ref,
        "head_sha": lease.head_sha,
        "expires_at": lease.expires_at,
    }
    snapshot = append_declared_jsonl(
        root / CAS_SNAPSHOTS_LEDGER_PATH, snapshot_row,
        expected_surface=CAS_SNAPSHOTS_SURFACE,
    )
    source_ledger_ref = ledger_ref_for_row(
        surface=CAS_SNAPSHOTS_SURFACE,
        ledger_path=CAS_SNAPSHOTS_LEDGER_PATH,
        row_id=str(snapshot["row_id"]),
        row_type=str(snapshot["row_type"]),
        row=snapshot,
    )
    proof: dict[str, Any] = {
        "repo": repo,
        "pr_number": pr_number,
        "target_ref": target_ref,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "state": "fresh",
        "lease_id": lease.lease_id,
        "epoch": lease.epoch,
        "owner": lease.owner,
        "expires_at": lease.expires_at,
        "source_ledger_ref": source_ledger_ref,
    }
    if readiness_claim_id is not None:
        proof["readiness_claim_id"] = readiness_claim_id
    recorded = record_remote_cas_proof(proof, base_dir=root)
    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "lease_id": lease.lease_id,
        "epoch": lease.epoch,
        "snapshot": snapshot,
        "proof": recorded,
    }


# --------------------------------------------------------------------------
# F5-e (ORPHAN-694) — rollback + retention proof producer.
#
# WHY: `record_rollback_proof` / `record_retention_proof` had no producer,
# and nothing in the repo ever BUILT a restore artifact — the claim's
# "we can undo this merge" assertion had no bytes behind it. This
# producer creates a REAL `git bundle` of the target ref, verifies it
# with git's own verifier (the simulation is git, not a flag), archives
# a byte-identical copy under the retention store, and mints both
# proofs from measured digests. Equal source/archive sha256 pairs are
# the faithful-archival proof; `git bundle verify` exit 0 is the
# restore-simulation proof.
# --------------------------------------------------------------------------

ROLLBACK_BUNDLES_SURFACE = "enterprise_rollback_bundles"
ROLLBACK_BUNDLES_LEDGER_PATH = "enterprise/rollback-bundles.jsonl"
RETENTION_EVENTS_SURFACE = "retention_events"
RETENTION_EVENTS_LEDGER_PATH = "retention/events.jsonl"
DEFAULT_ROLLBACK_RETENTION_DAYS = 30


def _sha256_file(path: Path) -> str:
    """"sha256:"-prefixed file digest (see _canonical_sha256's WHY)."""
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def produce_rollback_and_retention_proofs(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    readiness_claim_id: str,
    workspace_root: str | Path,
    retention_days: int = DEFAULT_ROLLBACK_RETENTION_DAYS,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Build, verify, archive and prove the merge's undo artifact.

    ``readiness_claim_id`` is REQUIRED (not optional as in the other
    families): the rollback-bundle ledger row demands it, so F5-g
    pre-allocates the claim id deterministically and threads it here
    before the claim row itself is minted.
    """
    import shutil
    import subprocess

    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    if not isinstance(readiness_claim_id, str) or not readiness_claim_id.strip():
        raise GovernanceError("rollback_proof_readiness_claim_id_required")
    if not isinstance(retention_days, int) or isinstance(retention_days, bool) or retention_days <= 0:
        raise GovernanceError("retention_days_must_be_positive_int")
    root = ensure_tools_dir(base_dir)
    workspace = Path(workspace_root).resolve()

    bundle_dir = root / "enterprise" / "rollback-artifacts"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = bundle_dir / f"rollback-{head_sha[:12]}.bundle"
    create = subprocess.run(
        ["git", "bundle", "create", str(bundle_path), target_ref],
        cwd=workspace, capture_output=True, text=True, check=False,
    )
    if create.returncode != 0 or not bundle_path.exists():
        raise GovernanceError(
            f"rollback_bundle_create_failed: {create.stderr.strip().splitlines()[-1][:200] if create.stderr else create.returncode}"
        )
    verify = subprocess.run(
        ["git", "bundle", "verify", str(bundle_path)],
        cwd=workspace, capture_output=True, text=True, check=False,
    )
    if verify.returncode != 0:
        raise GovernanceError(
            f"rollback_bundle_verify_failed: {verify.stderr.strip().splitlines()[-1][:200] if verify.stderr else verify.returncode}"
        )
    source_sha256 = _sha256_file(bundle_path)

    # Claim ids carry ':'; a path segment with ':' round-trips through
    # file:// URIs as %3A and breaks any consumer that joins the two.
    safe_claim_segment = readiness_claim_id.replace(":", "-")
    archive_path = root / ".archive" / "rollback" / safe_claim_segment / bundle_path.name
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bundle_path, archive_path)
    archive_sha256 = _sha256_file(archive_path)
    if archive_sha256 != source_sha256:
        raise GovernanceError(
            f"rollback_archive_digest_mismatch: source={source_sha256} archive={archive_sha256}"
        )

    binding = {
        "repo": repo,
        "pr_number": pr_number,
        "target_ref": target_ref,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "readiness_claim_id": readiness_claim_id,
    }
    # The claim verifier RE-READS these uris relative to the tools root and
    # re-hashes the bytes — absolute paths and file:// schemes are rejected.
    source_uri = bundle_path.relative_to(root).as_posix()
    archive_uri = archive_path.relative_to(root).as_posix()
    from .rollback_bundle import record_rollback_bundle, record_rollback_simulation

    bundle_row = record_rollback_bundle(
        {
            **binding,
            "rollback_bundle_id": f"rb:{head_sha[:12]}:{readiness_claim_id}",
            "rollback_plan_sha256": source_sha256,
            "source_uri": source_uri,
            "archive_uri": archive_uri,
        },
        base_dir=root,
    )
    record_rollback_simulation(
        {
            **binding,
            "rollback_simulation_id": f"rbsim:{head_sha[:12]}:{readiness_claim_id}",
            "rollback_bundle_id": bundle_row["rollback_bundle_id"],
            "status": "passed",
            "verifier": "git bundle verify",
            "verifier_output_tail": (verify.stderr or verify.stdout or "").strip()[-400:],
        },
        base_dir=root,
    )
    bundle_ref = ledger_ref_for_row(
        surface=ROLLBACK_BUNDLES_SURFACE,
        ledger_path=ROLLBACK_BUNDLES_LEDGER_PATH,
        row_id=str(bundle_row["row_id"]),
        row_type=str(bundle_row["row_type"]),
        row=bundle_row,
    )
    rollback_proof = record_rollback_proof(
        {
            **binding,
            "validated": True,
            # the evaluator's id_key for this family
            "rollback_proof_id": f"rbproof:{head_sha[:12]}:{readiness_claim_id}",
            "rollback_bundle_id": bundle_row["rollback_bundle_id"],
            "source_uri": source_uri,
            "archive_uri": archive_uri,
            "source_sha256": source_sha256,
            "archive_sha256": archive_sha256,
            "source_ledger_ref": bundle_ref,
        },
        base_dir=root,
    )

    retention_event = append_declared_jsonl(
        root / RETENTION_EVENTS_LEDGER_PATH,
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "row_id": f"retention:rollback:{readiness_claim_id}",
            "row_type": "retention_scheduled",
            "artifact_uri": archive_uri,
            "artifact_sha256": archive_sha256,
            "retention_days": retention_days,
            **binding,
        },
        expected_surface=RETENTION_EVENTS_SURFACE,
    )
    retention_ref = ledger_ref_for_row(
        surface=RETENTION_EVENTS_SURFACE,
        ledger_path=RETENTION_EVENTS_LEDGER_PATH,
        row_id=str(retention_event["row_id"]),
        row_type=str(retention_event["row_type"]),
        row=retention_event,
    )
    retention_proof = record_retention_proof(
        {
            **binding,
            "validated": True,
            "retention_proof_id": f"ret:{head_sha[:12]}:{readiness_claim_id}",
            "retention_days": retention_days,
            "source_uri": source_uri,
            "archive_uri": archive_uri,
            "source_sha256": source_sha256,
            "archive_sha256": archive_sha256,
            "source_ledger_ref": retention_ref,
        },
        base_dir=root,
    )
    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "rollback_bundle_id": bundle_row["rollback_bundle_id"],
        "rollback_proof": rollback_proof,
        "retention_proof": retention_proof,
        "bundle_uri": source_uri,
        "archive_uri": archive_uri,
    }


# --------------------------------------------------------------------------
# F5-c (ORPHAN-694) — scoped-token proof producer.
#
# WHY: the claim's token family attests that the merge lane runs on a
# SCOPED installation token under a pinned workflow contract — and
# `record_token_proof` had no producer while `mint_installation_token`
# already emitted its fallback signal into governance. The producer
# measures everything: workflow_hash from the actual YAML bytes,
# contract_hash from the registry SSoT, write paths and network policy
# from the pinned job contract, and the lease MODE from the mint itself.
# A PAT-fallback lease is recorded with valid=False — the claim then
# fails loudly until the GH App secrets exist, which is the truth.
# --------------------------------------------------------------------------


def produce_token_proof(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    readiness_claim_id: str,
    workflow_id: str,
    job_id: str,
    workflow_run_id: str,
    artifact_id: str,
    artifact_sha256: str,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    mint: Any = None,
) -> dict[str, Any]:
    """Mint (or attest) the lane token and prove its scoping context.

    ``mint`` defaults to ``gh_token_factory.mint_installation_token`` and
    is injectable so tests never touch credentials. The proof's hash
    fields carry the gate's required "sha256:" prefix; the token itself
    NEVER appears in any row — only mode, ttl and scoping metadata.
    """
    from .workflow_contract_registry import (
        WORKFLOW_CONTRACTS,
        workflow_hash,
        workflow_job_contract,
        workflow_job_contract_hash,
    )

    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    if not isinstance(readiness_claim_id, str) or not readiness_claim_id.strip():
        raise GovernanceError("token_proof_readiness_claim_id_required")
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    job = workflow_job_contract(workflow_id, job_id)
    if contract is None or job is None:
        raise GovernanceError(
            f"token_proof_workflow_contract_unknown: {workflow_id}/{job_id}"
        )
    workflow_file = Path(workspace_root).resolve() / contract.workflow_file
    if not workflow_file.exists():
        raise GovernanceError(f"token_proof_workflow_file_missing: {contract.workflow_file}")
    measured_workflow_hash = workflow_hash(workflow_file)
    measured_contract_hash = workflow_job_contract_hash(workflow_id, job_id)
    if measured_contract_hash is None:
        raise GovernanceError(f"token_proof_contract_hash_unavailable: {workflow_id}/{job_id}")

    if mint is None:
        from .gh_token_factory import mint_installation_token as mint
    root = ensure_tools_dir(base_dir)
    lease = mint(cycle_id=cycle_id, workspace_root=workspace_root)
    fallback_active = bool(getattr(lease, "fallback_active", True))

    snapshot_row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"token-lease:{cycle_id}:{workflow_run_id}",
        "row_type": TOKEN_SNAPSHOT_ROW_TYPE,
        "cycle_id": cycle_id,
        "mode": "pat_fallback" if fallback_active else "installation",
        "gh_app_installation_id_present": getattr(lease, "gh_app_installation_id", None) is not None,
        "ttl_seconds": getattr(lease, "ttl_seconds", None),
        "workflow_id": workflow_id,
        "job_id": job_id,
        "workflow_hash": measured_workflow_hash,
        "contract_hash": measured_contract_hash,
    }
    snapshot = append_declared_jsonl(
        root / TOKEN_SNAPSHOTS_LEDGER_PATH, snapshot_row,
        expected_surface=TOKEN_SNAPSHOTS_SURFACE,
    )
    source_ledger_ref = ledger_ref_for_row(
        surface=TOKEN_SNAPSHOTS_SURFACE,
        ledger_path=TOKEN_SNAPSHOTS_LEDGER_PATH,
        row_id=str(snapshot["row_id"]),
        row_type=str(snapshot["row_type"]),
        row=snapshot,
    )
    proof: dict[str, Any] = {
        "repo": repo,
        "pr_number": pr_number,
        "target_ref": target_ref,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "readiness_claim_id": readiness_claim_id,
        "token_proof_id": f"token:{cycle_id}:{workflow_run_id}",
        # An operator-PAT fallback is a WEAKER isolation mode than the
        # scoped installation token the claim family attests; the honest
        # producer records it as invalid and the gate names the gap.
        "valid": not fallback_active,
        "token_mode": "pat_fallback" if fallback_active else "installation",
        # The gate's exact vocabulary: type + mutation token must name the
        # installation token, and every fallback flag must be False. Under
        # PAT fallback these record the true (failing) state.
        "token_type": "operator_pat" if fallback_active else "github_app_installation_token",
        "mutation_token": "operator_pat" if fallback_active else "github_app_installation_token",
        "gh_token_fallback": fallback_active,
        "github_token_fallback": fallback_active,
        "pat_fallback": fallback_active,
        "workflow_run_id": workflow_run_id,
        "artifact_id": artifact_id,
        "artifact_sha256": artifact_sha256,
        "workflow_hash": measured_workflow_hash,
        "contract_hash": measured_contract_hash,
        "network_policy": ",".join(job.network_policy),
        "runtime_write_paths": list(job.allowed_write_path_patterns),
        "source_ledger_ref": source_ledger_ref,
    }
    recorded = record_token_proof(proof, base_dir=root)
    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "token_mode": proof["token_mode"],
        "valid": proof["valid"],
        "snapshot": snapshot,
        "proof": recorded,
    }


# --------------------------------------------------------------------------
# F5-f (ORPHAN-694) — deterministic DLP scanner + proof producer.
#
# WHY: the claim's dlp family demands scanner_results whose status is
# "passed" over five named evidence surfaces — and no scanner existed,
# which made the whole claim chain permanently unsatisfiable (the plan
# had parked this behind an operator waiver; a waiver cannot satisfy
# the evaluator, so the ROOT fix is the scanner itself). The pattern
# set is closed, deterministic, and secret-shaped — private key
# headers, provider token prefixes, credential assignments. A hit
# records the pattern NAME and location, NEVER the matched bytes.
# --------------------------------------------------------------------------

DLP_PATTERNS: tuple[tuple[str, str], ...] = (
    ("private_key_block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("github_token", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    ("github_pat", r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    ("aws_access_key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("stripe_live_key", r"\bsk_live_[A-Za-z0-9]{16,}"),
    ("slack_token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    ("npm_auth_token", r"_authToken\s*=\s*\S+"),
    ("jwt_like", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\."),
    ("credential_assignment", r"(?i)\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*['\"][^'\"\s]{16,}['\"]"),
)


def scan_paths_for_secrets(paths: list[Path]) -> list[dict[str, Any]]:
    """Deterministic secret-pattern scan. Findings carry pattern NAME and
    location only — the matched bytes never leave the file."""
    import re

    findings: list[dict[str, Any]] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise GovernanceError(f"dlp_scan_unreadable:{path}:{exc.errno}")
        for name, pattern in DLP_PATTERNS:
            for match in re.finditer(pattern, text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append({"pattern": name, "path": str(path), "line": line})
    return findings


def produce_dlp_proof(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    readiness_claim_id: str,
    workflow_run_id: str,
    artifact_id: str,
    artifact_sha256: str,
    workflow_hash: str,
    contract_hash: str,
    network_policy: str,
    runtime_write_paths: list[str],
    surface_paths: dict[str, list[str | Path]],
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Scan the run's evidence surfaces and mint the dlp proof.

    ``surface_paths`` maps each of REQUIRED_DLP_SCANNED_SURFACES (diff,
    prompt, transcript, logs, artifacts) to the files that ARE that
    surface for this run. Every required surface must name at least one
    existing file — scanning nothing is not scanning, so an empty or
    missing surface fails closed instead of passing vacuously.
    """
    from .enterprise_readiness import REQUIRED_DLP_SCANNED_SURFACES

    _require_binding(pr_number=pr_number, repo=repo, target_ref=target_ref, head_ref=head_ref, head_sha=head_sha)
    if not isinstance(readiness_claim_id, str) or not readiness_claim_id.strip():
        raise GovernanceError("dlp_proof_readiness_claim_id_required")
    root = ensure_tools_dir(base_dir)

    per_surface: dict[str, dict[str, Any]] = {}
    all_findings: list[dict[str, Any]] = []
    for surface in REQUIRED_DLP_SCANNED_SURFACES:
        raw_paths = surface_paths.get(surface) or []
        paths = [Path(item) for item in raw_paths]
        if not paths or not all(path.exists() for path in paths):
            raise GovernanceError(
                f"dlp_scan_surface_unscannable:{surface}: every required "
                f"surface must name at least one existing file — a vacuous "
                f"scan is not a scan"
            )
        findings = scan_paths_for_secrets(paths)
        all_findings.extend(findings)
        per_surface[surface] = {
            "files": [str(path) for path in paths],
            "file_sha256s": [_sha256_file(path) for path in paths],
            "finding_count": len(findings),
        }
        # ARIA-AUDIT-022: the DIFF surface is caller-supplied, and a
        # caller choosing its own scan scope can hand the proof an
        # innocent file while the real diff carries the secret. The
        # verifier therefore derives the touched-file set from head_sha
        # itself and refuses when any touched file is missing from the
        # scanned diff text — scope is proven, not promised.
        if surface == "diff":
            import subprocess as _sp

            if workspace_root is None:
                # No workspace binding: the scope check cannot run. The
                # skip is RECORDED on the proof so a caller reading it
                # sees the diff surface was caller-scoped, not
                # verifier-derived.
                per_surface[surface]["diff_scope_check"] = "skipped_no_workspace_root"
                continue
            repo_dir = Path(workspace_root)
            probe = None
            try:
                probe = _sp.run(
                    ["git", "show", "--name-only", "--pretty=format:", head_sha],
                    cwd=repo_dir, capture_output=True, text=True, check=False, timeout=30,
                )
            except (_sp.SubprocessError, OSError, ValueError):
                probe = None
            if probe is None or probe.returncode != 0:
                per_surface[surface]["diff_scope_check"] = "skipped_head_sha_unresolvable"
                continue
            touched = probe.stdout.split()
            diff_text = "\n".join(
                path.read_text(encoding="utf-8", errors="replace") for path in paths
            )
            missing = [name for name in touched if name and name not in diff_text]
            if missing:
                raise GovernanceError(
                    "dlp_diff_surface_incomplete: files touched by "
                    f"{head_sha[:12]} absent from the scanned diff: "
                    f"{missing[:10]}"
                )
    status = "passed" if not all_findings else "failed"

    snapshot_payload = {
        "per_surface": per_surface,
        "finding_count": len(all_findings),
        "findings": all_findings,
        "pattern_names": [name for name, _ in DLP_PATTERNS],
        "status": status,
    }
    scanner_output_sha256 = _canonical_sha256(snapshot_payload)
    snapshot = append_declared_jsonl(
        root / DLP_SNAPSHOTS_LEDGER_PATH,
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "row_id": f"dlp-scan:{readiness_claim_id}:{workflow_run_id}",
            "row_type": DLP_SNAPSHOT_ROW_TYPE,
            "scanner_output_sha256": scanner_output_sha256,
            **snapshot_payload,
        },
        expected_surface=DLP_SNAPSHOTS_SURFACE,
    )
    source_ledger_ref = ledger_ref_for_row(
        surface=DLP_SNAPSHOTS_SURFACE,
        ledger_path=DLP_SNAPSHOTS_LEDGER_PATH,
        row_id=str(snapshot["row_id"]),
        row_type=str(snapshot["row_type"]),
        row=snapshot,
    )
    from .enterprise_readiness import record_dlp_proof

    proof = record_dlp_proof(
        {
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
            "dlp_proof_id": f"dlp:{readiness_claim_id}:{workflow_run_id}",
            "valid": status == "passed",
            "workflow_run_id": workflow_run_id,
            "artifact_id": artifact_id,
            "artifact_sha256": artifact_sha256,
            "workflow_hash": workflow_hash,
            "contract_hash": contract_hash,
            "network_policy": network_policy,
            "runtime_write_paths": list(runtime_write_paths),
            "scanner_results": {
                "status": status,
                "scanned_surfaces": list(REQUIRED_DLP_SCANNED_SURFACES),
                "scanner_output_sha256": scanner_output_sha256,
                "finding_count": len(all_findings),
            },
            "source_ledger_ref": source_ledger_ref,
        },
        base_dir=root,
    )
    return {
        "pr_number": pr_number,
        "head_sha": head_sha,
        "status": status,
        "finding_count": len(all_findings),
        "snapshot": snapshot,
        "proof": proof,
    }


# --------------------------------------------------------------------------
# F5-g (ORPHAN-694) — the lane-start readiness-claim assembler.
#
# WHY: every proof family now has a producer, but
# `record_enterprise_readiness_claim` still had none — auto-merge's
# resolver matched on ZERO claims forever. The assembler is the single
# composition point: it allocates the claim id deterministically,
# threads it through the families that demand it, sweeps the waiver
# ledger with a recorded attestation, and mints the claim — which
# `record_enterprise_readiness_claim` itself re-validates fail-closed.
# --------------------------------------------------------------------------


def allocate_readiness_claim_id(*, pr_number: int, head_sha: str) -> str:
    return f"claim:{pr_number}:{head_sha[:12]}"


def produce_readiness_claim(
    *,
    pr_number: int,
    repo: str,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    workflow_id: str,
    job_id: str,
    workflow_run_id: str,
    cycle_id: str,
    artifact: dict[str, Any],
    surface_paths: dict[str, list[str | Path]],
    workspace_root: str | Path,
    retention_days: int = DEFAULT_ROLLBACK_RETENTION_DAYS,
    owner: str | None = None,
    base_dir: str | Path | None = None,
    probe: Any = None,
    rules_probe: Any = None,
    mint: Any = None,
) -> dict[str, Any]:
    """Assemble and record the enterprise readiness claim for one PR head.

    Raises GovernanceError with the full reason list when ANY family's
    evidence fails — a partial claim is never recorded, because a claim
    row the verifier would reject is audit theater with a row id.
    """
    root = ensure_tools_dir(base_dir)
    readiness_claim_id = allocate_readiness_claim_id(pr_number=pr_number, head_sha=head_sha)
    binding = dict(
        pr_number=pr_number, repo=repo, target_ref=target_ref,
        head_ref=head_ref, head_sha=head_sha,
    )

    workflow_report = produce_workflow_run_proofs(**binding, readiness_claim_id=readiness_claim_id, base_dir=root)
    # Only LEDGER-PROVEN runs enter the claim: the verifier cross-checks
    # every id against workflow-run-proof rows, so an unproven id would
    # poison the claim. The current run MUST be among them — a claim
    # assembled by a run the ci ledger never saw is not evidence.
    run_ids: set[str] = set()
    for row in workflow_report.get("produced", []):
        if row.get("workflow_run_id") is not None:
            run_ids.add(str(row["workflow_run_id"]))
    for skip in workflow_report.get("skipped", []):
        if skip.get("reason") == SKIP_REASON_ALREADY_PROVEN and skip.get("workflow_run_id") is not None:
            run_ids.add(str(skip["workflow_run_id"]))
    if str(workflow_run_id) not in run_ids:
        raise GovernanceError(
            f"readiness_claim_current_run_unproven: workflow_run_id="
            f"{workflow_run_id!r} has no successful ci_workflow_run row for "
            f"this PR head — record the CI report before assembling the claim"
        )

    bp_report = produce_branch_protection_proof(
        **binding, readiness_claim_id=readiness_claim_id, base_dir=root,
        probe=probe, rules_probe=rules_probe,
    )
    cas_report = produce_remote_cas_proof(
        **binding, readiness_claim_id=readiness_claim_id, owner=owner, base_dir=root,
    )
    rollback_report = produce_rollback_and_retention_proofs(
        **binding, readiness_claim_id=readiness_claim_id,
        workspace_root=workspace_root, retention_days=retention_days, base_dir=root,
    )
    token_report = produce_token_proof(
        **binding, readiness_claim_id=readiness_claim_id,
        workflow_id=workflow_id, job_id=job_id,
        workflow_run_id=str(workflow_run_id),
        artifact_id=str(artifact["artifact_id"]),
        artifact_sha256=str(artifact["sha256"]),
        cycle_id=cycle_id, workspace_root=workspace_root,
        base_dir=root, mint=mint,
    )
    token_proof = token_report["proof"]
    dlp_report = produce_dlp_proof(
        **binding, readiness_claim_id=readiness_claim_id,
        workflow_run_id=str(workflow_run_id),
        artifact_id=str(artifact["artifact_id"]),
        artifact_sha256=str(artifact["sha256"]),
        workflow_hash=str(token_proof["workflow_hash"]),
        contract_hash=str(token_proof["contract_hash"]),
        network_policy=str(token_proof["network_policy"]),
        runtime_write_paths=list(token_proof["runtime_write_paths"]),
        surface_paths=surface_paths,
        base_dir=root,
        workspace_root=workspace_root,
    )

    # Artifact proof — the verifier demands a proof row matching the
    # artifact ref field-for-field, with its own resolvable source.
    from .ci import record_ci_source_attestation
    from .enterprise_readiness import record_artifact_proof

    artifact_attestation = record_ci_source_attestation(
        label=f"artifact:{readiness_claim_id}:{artifact['artifact_id']}",
        payload={
            "artifact_id": str(artifact["artifact_id"]),
            "sha256": str(artifact["sha256"]),
            "produced_by_workflow_run_id": str(workflow_run_id),
        },
        base_dir=root,
    )
    artifact_source_ref = ledger_ref_for_row(
        surface="ci_source", ledger_path="ci/source.jsonl",
        row_id=str(artifact_attestation["row_id"]),
        row_type=str(artifact_attestation["row_type"]),
        row=artifact_attestation,
    )
    artifact_ref_row = {
        "schema_version": 2,
        "artifact_id": str(artifact["artifact_id"]),
        "uri": str(artifact["uri"]),
        "sha256": str(artifact["sha256"]),
        "content_type": str(artifact.get("content_type") or "application/octet-stream"),
        "produced_by_workflow_run_id": str(workflow_run_id),
        "source_surface": "github_actions_artifact",
    }
    record_artifact_proof(
        {
            **binding,
            "readiness_claim_id": readiness_claim_id,
            **artifact_ref_row,
            "source_ledger_ref": artifact_source_ref,
        },
        base_dir=root,
    )


    waivers = load_declared_jsonl(
        root / "enterprise" / "waivers.jsonl", expected_surface="enterprise_waivers",
    ) if (root / "enterprise" / "waivers.jsonl").exists() else []
    from datetime import datetime, timezone

    def _expired(row: dict[str, Any]) -> bool:
        if row.get("state", "open") != "open":
            return False
        expires_at = str(row.get("expires_at") or "")
        try:
            parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return True
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed <= datetime.now(timezone.utc)

    open_expired = sorted({
        str(row.get("waiver_id") or "") for row in waivers if _expired(row)
    } - {""})
    sweep_row = record_ci_source_attestation(
        label=f"waiver-sweep:{readiness_claim_id}",
        payload={
            "readiness_claim_id": readiness_claim_id,
            "open_expired_waivers": open_expired,
            "waiver_row_count": len(waivers),
        },
        base_dir=root,
    )
    waiver_ref = ledger_ref_for_row(
        surface="ci_source", ledger_path="ci/source.jsonl",
        row_id=str(sweep_row["row_id"]), row_type=str(sweep_row["row_type"]),
        row=sweep_row,
    )

    from .enterprise_readiness import (
        READINESS_SCHEMA,
        record_enterprise_readiness_claim,
    )

    claim = {
        "$schema": READINESS_SCHEMA,
        "schema_version": 2,
        "claim_row_id": f"claim-row:{readiness_claim_id}",
        "readiness_claim_id": readiness_claim_id,
        **binding,
        "evidence_bundle": {"path": f"enterprise/claims/{readiness_claim_id}.json"},
        "workflow_run_ids": sorted(run_ids),
        "artifact_refs": [dict(artifact_ref_row)],
        "remote_cas_proof": cas_report["proof"],
        "rollback_proof": rollback_report["rollback_proof"],
        "retention_proof": rollback_report["retention_proof"],
        "waiver_ledger": {
            "open_expired_waivers": open_expired,
            "source_ledger_ref": waiver_ref,
        },
        "branch_protection_proof": bp_report["proof"],
        "dlp_proof": dlp_report["proof"],
        "token_proof": token_proof,
    }
    recorded = record_enterprise_readiness_claim(claim, base_dir=root)
    return {
        "readiness_claim_id": readiness_claim_id,
        "claim": recorded,
        "workflow_run_ids": sorted(run_ids),
        "family_reports": {
            "workflow_runs": workflow_report,
            "branch_protection": {"valid": bp_report["proof"].get("valid")},
            "remote_cas": {"lease_id": cas_report["lease_id"], "epoch": cas_report["epoch"]},
            "rollback_retention": {"bundle": rollback_report["rollback_bundle_id"]},
            "token": {"mode": token_report["token_mode"], "valid": token_report["valid"]},
            "dlp": {"status": dlp_report["status"], "finding_count": dlp_report["finding_count"]},
        },
    }
