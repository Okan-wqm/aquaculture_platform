from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


APPROVED_CLAUDE_AUTH = frozenset({"managed_claude_code_cli", "claude_code_managed"})


def record_runner_attestation(
    attestation: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_runner_attestation",
        **dict(attestation),
    }
    row.setdefault("row_id", f"runner:{row.get('pr_number')}:{row.get('head_sha')}:{row.get('runner_id')}")
    _validate_attestation(row)
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "runner-attestations.jsonl",
        row,
        expected_surface="enterprise_runner_attestations",
    )


def verify_runner_attestation(
    *,
    pr_number: int,
    head_sha: str,
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "runner-attestations.jsonl",
        expected_surface="enterprise_runner_attestations",
    )
    match = next(
        (
            row for row in reversed(rows)
            if row.get("pr_number") == pr_number
            and row.get("head_sha") == head_sha
            and row.get("readiness_claim_id") == readiness_claim_id
        ),
        None,
    )
    if match is None:
        raise GovernanceError("runner_attestation_required_for_merge")
    _validate_attestation(match)
    return {
        "valid": True,
        "runner_id": match.get("runner_id"),
        "ledger_hash": match.get("ledger_hash"),
    }


def probe_runner_attestation(
    *,
    pr_number: int,
    head_sha: str,
    readiness_claim_id: str,
    repo: str,
    target_ref: str,
    head_ref: str,
    runner_group: str,
    ephemeral_runner: bool,
    approved_runner_group: bool,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """PROBE the runner and record the attestation row the merge gate demands.

    `verify_runner_attestation` has been MANDATORY at merge since the
    enterprise gate landed, and nothing anywhere produced a row — the gate
    could only ever raise `runner_attestation_required_for_merge` (Plan
    "ARIA Sinir Sistemi" FAZ 5a). This is the producer, and it is probed,
    not self-asserted: the environment facts are measured on the host that
    calls it, the same way the capability-probe workflow measures them —
      * `sandbox_available` — `implementation_safety.sandbox_backend()`,
        the accessor the runtime itself uses to permit a write-capable spawn;
      * `api_key_auth` — presence of `ANTHROPIC_API_KEY` in the environment;
      * `claude_auth` — `CLAUDE_CODE_OAUTH_TOKEN` present → managed CLI auth,
        else recorded as `"absent"` (which `_validate_attestation` rejects —
        an unauthenticated host must not attest, and lying about it here
        would defeat the gate's purpose).
    Identity facts a process cannot measure about itself (`runner_group`,
    `ephemeral_runner`, `approved_runner_group`) come from the workflow's
    registration knowledge and are labeled as such in `probe`.

    Idempotent per (pr_number, head_sha, readiness_claim_id): re-probing an
    already-attested triple returns the existing row unchanged, so lanes can
    call it unconditionally at start.
    """
    root = ensure_tools_dir(base_dir)
    path = root / "enterprise" / "runner-attestations.jsonl"
    if path.exists():
        rows = load_declared_jsonl(
            path, expected_surface="enterprise_runner_attestations"
        )
        existing = next(
            (
                row for row in reversed(rows)
                if row.get("pr_number") == pr_number
                and row.get("head_sha") == head_sha
                and row.get("readiness_claim_id") == readiness_claim_id
            ),
            None,
        )
        if existing is not None:
            return existing

    try:
        from .implementation_safety import sandbox_backend

        backend = sandbox_backend()
    except ImportError:
        backend = None
    api_key_present = bool(os.environ.get("ANTHROPIC_API_KEY"))
    managed_auth_present = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))

    return record_runner_attestation(
        {
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
            "runner_id": os.environ.get("RUNNER_NAME") or "unknown-runner",
            "runner_group": runner_group,
            "ephemeral_runner": bool(ephemeral_runner),
            "approved_runner_group": bool(approved_runner_group),
            "sandbox_available": backend is not None,
            "api_key_auth": api_key_present,
            "claude_auth": (
                "managed_claude_code_cli" if managed_auth_present else "absent"
            ),
            "attestation_method": "probed",
            "probe": {
                "sandbox_backend": backend,
                "api_key_env_present": api_key_present,
                "managed_auth_env_present": managed_auth_present,
                "config_asserted_fields": [
                    "runner_group", "ephemeral_runner", "approved_runner_group",
                ],
            },
        },
        base_dir=root,
    )


def probe_runner_attestations_for_claims(
    *,
    base_dir: str | Path | None = None,
    repo: str,
    target_ref: str,
) -> dict[str, Any]:
    """Mint a probed attestation for every recorded readiness claim.

    The lane-start entry point: readiness claims carry the
    (pr_number, head_sha, readiness_claim_id) triple the merge gate keys on,
    so each open claim gets an attestation from the host that will run the
    merge. A claim whose probe fails validation (no sandbox, missing managed
    auth, API key present) is reported in `refused` — recording an invalid
    attestation is forbidden by `_validate_attestation`, and that refusal is
    the contract working, not an error to swallow.
    """
    root = ensure_tools_dir(base_dir)
    claims_path = root / "enterprise" / "readiness-claims.jsonl"
    if not claims_path.exists():
        return {"attested": [], "refused": [], "claims_seen": 0}
    claims = load_declared_jsonl(
        claims_path, expected_surface="enterprise_readiness_claims"
    )
    attested: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for claim in claims:
        pr_number = claim.get("pr_number")
        head_sha = str(claim.get("head_sha") or "")
        claim_id = str(claim.get("readiness_claim_id") or "")
        if not isinstance(pr_number, int) or not head_sha or not claim_id:
            continue
        try:
            row = probe_runner_attestation(
                pr_number=pr_number,
                head_sha=head_sha,
                readiness_claim_id=claim_id,
                repo=repo,
                target_ref=target_ref,
                head_ref=str(claim.get("head_ref") or "unknown"),
                runner_group=os.environ.get("ARIA_RUNNER_GROUP") or "self-hosted",
                ephemeral_runner=_env_flag("ARIA_RUNNER_EPHEMERAL"),
                approved_runner_group=_env_flag("ARIA_RUNNER_GROUP_APPROVED"),
                base_dir=root,
            )
            attested.append({
                "readiness_claim_id": claim_id,
                "pr_number": pr_number,
                "row_id": row.get("row_id"),
            })
        except GovernanceError as exc:
            refused.append({
                "readiness_claim_id": claim_id,
                "pr_number": pr_number,
                "reason": str(exc),
            })
    return {
        "attested": attested,
        "refused": refused,
        "claims_seen": len(claims),
    }


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {"1", "true", "yes"}


def _validate_attestation(row: dict[str, Any]) -> None:
    required = ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id", "runner_id", "runner_group", "claude_auth")
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError("runner_attestation_missing_fields:" + ",".join(missing))
    if row.get("ephemeral_runner") is not True:
        raise GovernanceError("runner_attestation_ephemeral_runner_required")
    if row.get("approved_runner_group") is not True:
        raise GovernanceError("runner_attestation_approved_group_required")
    if row.get("sandbox_available") is not True:
        raise GovernanceError("runner_attestation_sandbox_required")
    if row.get("api_key_auth") is not False:
        raise GovernanceError("runner_attestation_api_key_auth_forbidden")
    if row.get("claude_auth") not in APPROVED_CLAUDE_AUTH:
        raise GovernanceError("runner_attestation_claude_managed_auth_required")


__all__ = [
    "APPROVED_CLAUDE_AUTH",
    "probe_runner_attestation",
    "probe_runner_attestations_for_claims",
    "record_runner_attestation",
    "verify_runner_attestation",
]
