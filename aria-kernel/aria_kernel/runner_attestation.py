from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


APPROVED_CLAUDE_AUTH = frozenset({"managed_claude_code_cli", "claude_code_managed"})

# ARIA-HIGH-198 — runner identity is MEASURED. GitHub sets RUNNER_ENVIRONMENT
# to `github-hosted` or `self-hosted` on every Actions runner. A GitHub-hosted
# runner is a fresh VM per job (ephemeral by construction); ARIA cannot
# measure a self-hosted registration's ephemerality, so a self-hosted runner
# is never attested ephemeral. The workflow inputs that used to assert the
# three identity facts are gone: an assertion is not a measurement, and the
# persistent self-hosted host could only ever attest honestly as refused.
RUNNER_ENVIRONMENT_ENV = "RUNNER_ENVIRONMENT"
GITHUB_HOSTED = "github-hosted"
APPROVED_RUNNER_GROUPS = frozenset({GITHUB_HOSTED})
# The merge lane runs no model and no agent-written code: it evaluates gates
# and calls the merge API. Its attestation says so rather than borrowing an
# agent host's auth and sandbox requirements.
MERGE_LANE = "merge"
AGENT_LANE = "agent"
ATTESTATION_LANES = frozenset({MERGE_LANE, AGENT_LANE})
CLAUDE_AUTH_NOT_REQUIRED = "not_required"


def measured_runner_identity() -> dict[str, Any]:
    """(group, ephemeral, approved) from the platform's own report."""
    environment = (os.environ.get(RUNNER_ENVIRONMENT_ENV) or "").strip() or "unknown"
    return {
        "runner_group": environment,
        "ephemeral_runner": environment == GITHUB_HOSTED,
        "approved_runner_group": environment in APPROVED_RUNNER_GROUPS,
    }


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
    lane: str = AGENT_LANE,
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
    Identity (`runner_group`, `ephemeral_runner`, `approved_runner_group`)
    is measured from the platform's `RUNNER_ENVIRONMENT` (ARIA-HIGH-198),
    never taken from workflow inputs. ``lane`` names what the host will do:
    ``merge`` runs no model, so its `claude_auth` is `not_required`.

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

    if lane not in ATTESTATION_LANES:
        raise GovernanceError(f"runner_attestation_lane_unknown:{lane}")
    identity = measured_runner_identity()
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
            **identity,
            "attestation_lane": lane,
            "sandbox_available": backend is not None,
            "api_key_auth": api_key_present,
            "claude_auth": (
                CLAUDE_AUTH_NOT_REQUIRED if lane == MERGE_LANE
                else "managed_claude_code_cli" if managed_auth_present
                else "absent"
            ),
            "attestation_method": "probed",
            # ARIA-AUDIT-016: identity claims need PLATFORM evidence, not
            # workflow inputs. GitHub mints an OIDC token channel for every
            # Actions runner (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN); its
            # presence is the runner-side proof of "this executes on an
            # Actions runner". The config-asserted trio (group, ephemeral,
            # approved) may still ride along as claims — the validator
            # refuses them without this platform signal.
            "platform_verified": bool(
                os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
                and os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
            ),
            "probe": {
                "sandbox_backend": backend,
                "api_key_env_present": api_key_present,
                "managed_auth_env_present": managed_auth_present,
                "runner_environment": identity["runner_group"],
                "measured_fields": [
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
    lane: str = AGENT_LANE,
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
                lane=lane,
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


def _validate_attestation(row: dict[str, Any]) -> None:
    required = ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id", "runner_id", "runner_group", "claude_auth")
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError("runner_attestation_missing_fields:" + ",".join(missing))
    if row.get("platform_verified") is not True:
        raise GovernanceError(
            "runner_attestation_platform_unverified: identity claims require "
            "the Actions OIDC channel (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN); "
            "workflow-input defaults are assertions, not evidence"
        )
    if row.get("ephemeral_runner") is not True:
        raise GovernanceError("runner_attestation_ephemeral_runner_required")
    if row.get("approved_runner_group") is not True:
        raise GovernanceError("runner_attestation_approved_group_required")
    if row.get("api_key_auth") is not False:
        raise GovernanceError("runner_attestation_api_key_auth_forbidden")
    if row.get("claude_auth") == CLAUDE_AUTH_NOT_REQUIRED:
        # The merge lane runs no model and no agent-written code, so neither
        # managed auth nor a write sandbox is its requirement; anything else
        # that claims `not_required` is refused.
        if row.get("attestation_lane") != MERGE_LANE:
            raise GovernanceError("runner_attestation_not_required_auth_is_merge_lane_only")
        return
    if row.get("sandbox_available") is not True:
        raise GovernanceError("runner_attestation_sandbox_required")
    if row.get("claude_auth") not in APPROVED_CLAUDE_AUTH:
        raise GovernanceError("runner_attestation_claude_managed_auth_required")


__all__ = [
    "AGENT_LANE",
    "APPROVED_CLAUDE_AUTH",
    "APPROVED_RUNNER_GROUPS",
    "ATTESTATION_LANES",
    "CLAUDE_AUTH_NOT_REQUIRED",
    "GITHUB_HOSTED",
    "MERGE_LANE",
    "measured_runner_identity",
    "probe_runner_attestation",
    "probe_runner_attestations_for_claims",
    "record_runner_attestation",
    "verify_runner_attestation",
]
