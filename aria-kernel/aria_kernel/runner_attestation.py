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


# ARIA-HIGH-220 — the platform proof of a runner's identity is the Actions
# OIDC token itself, verified: GitHub signs it (JWKS below), it names the
# run, the attempt, the repository, the runner environment and the workflow
# file and ref the job runs. The two environment variables that deliver it
# (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN) used to BE the proof — any process
# that could set two variables could claim to be an Actions runner.
GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
GITHUB_ACTIONS_OIDC_JWKS_URL = f"{GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks"
ACTIONS_OIDC_REQUEST_TIMEOUT_SECONDS = 30
# The merge lane is exactly this job: the merge-runner workflow, as it is on
# main, on a GitHub-hosted runner.
MERGE_LANE_WORKFLOW_PATH = ".github/workflows/aria-merge-runner.yml"
MERGE_LANE_WORKFLOW_REF = "refs/heads/main"
MERGE_LANE_OIDC_AUDIENCE = "aria-merge-lane"
RUNNER_ATTESTATION_OIDC_AUDIENCE = "aria-runner-attestation"


def measured_runner_identity() -> dict[str, Any]:
    """The runner and the run, from the platform's own report.

    ``runner_group``/``ephemeral_runner``/``approved_runner_group`` derive
    from ``RUNNER_ENVIRONMENT`` (ARIA-HIGH-198); ``run_id``/``run_attempt``/
    ``runner_name``/``repository`` are what GitHub sets for the job
    (ARIA-HIGH-220), the binding an attestation row carries.
    """
    environment = (os.environ.get(RUNNER_ENVIRONMENT_ENV) or "").strip() or "unknown"
    return {
        "runner_group": environment,
        "ephemeral_runner": environment == GITHUB_HOSTED,
        "approved_runner_group": environment in APPROVED_RUNNER_GROUPS,
        "run_id": (os.environ.get("GITHUB_RUN_ID") or "").strip(),
        "run_attempt": (os.environ.get("GITHUB_RUN_ATTEMPT") or "").strip(),
        "runner_name": (os.environ.get("RUNNER_NAME") or "").strip(),
        "repository": (os.environ.get("GITHUB_REPOSITORY") or "").strip(),
    }


def fetch_actions_oidc_token(*, audience: str) -> str:
    """Request this job's OIDC token (needs ``permissions: id-token: write``)."""
    import json
    import urllib.error
    import urllib.parse
    import urllib.request

    url = (os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL") or "").strip()
    bearer = (os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN") or "").strip()
    if not url or not bearer:
        raise GovernanceError("actions_oidc_channel_absent")
    separator = "&" if "?" in url else "?"
    request = urllib.request.Request(
        f"{url}{separator}audience={urllib.parse.quote(audience, safe='')}",
        headers={"Authorization": f"bearer {bearer}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=ACTIONS_OIDC_REQUEST_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise GovernanceError(f"actions_oidc_token_request_failed:{exc.__class__.__name__}") from exc
    token = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise GovernanceError("actions_oidc_token_request_failed:no_value")
    return token


def _github_jwks_client() -> Any:
    """GitHub's published signing keys for Actions OIDC tokens (PyJWT)."""
    import jwt

    return jwt.PyJWKClient(GITHUB_ACTIONS_OIDC_JWKS_URL, cache_keys=True)


def verify_actions_oidc_token(token: str, *, audience: str) -> dict[str, Any]:
    """The token's claims, once its signature, issuer, audience and expiry hold."""
    import jwt

    try:
        signing_key = _github_jwks_client().get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=audience,
            issuer=GITHUB_ACTIONS_OIDC_ISSUER,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise GovernanceError(f"actions_oidc_token_invalid:{exc.__class__.__name__}:{exc}") from exc


def measure_actions_identity(*, audience: str, workflow_path: str | None = None) -> dict[str, Any]:
    """This process's run, measured and proven by the job's OIDC token.

    ``platform_verified``: the token verifies and its claims name THIS run —
    run id, attempt, repository and runner environment equal what the
    platform set for the process. ``workflow_verified`` (when
    ``workflow_path`` is given): the job runs that workflow file as it is on
    ``MERGE_LANE_WORKFLOW_REF``.
    """
    identity = measured_runner_identity()
    reasons: list[str] = []
    claims: dict[str, Any] = {}
    try:
        claims = verify_actions_oidc_token(fetch_actions_oidc_token(audience=audience), audience=audience)
    except GovernanceError as exc:
        reasons.append(str(exc))
    else:
        for claim, measured in (
            ("run_id", identity["run_id"]),
            ("run_attempt", identity["run_attempt"]),
            ("repository", identity["repository"]),
            ("runner_environment", identity["runner_group"]),
        ):
            if not measured or str(claims.get(claim) or "") != measured:
                reasons.append(f"oidc_{claim}_mismatch:{claims.get(claim)!r}!={measured!r}")
    platform_verified = not reasons
    workflow_verified = False
    if workflow_path is not None and platform_verified:
        expected = f"{identity['repository']}/{workflow_path}@{MERGE_LANE_WORKFLOW_REF}"
        workflow_verified = claims.get("job_workflow_ref") == expected
        if not workflow_verified:
            reasons.append(f"oidc_job_workflow_ref_mismatch:{claims.get('job_workflow_ref')!r}!={expected!r}")
    return {
        **identity,
        "platform_verified": platform_verified,
        "workflow_verified": workflow_verified,
        "oidc": {
            key: claims.get(key)
            for key in ("job_workflow_ref", "runner_environment", "run_id", "run_attempt", "repository", "sub")
            if key in claims
        },
        "reasons": reasons,
    }


def measure_merge_lane_identity() -> dict[str, Any]:
    """Is THIS process the merge lane? Measured in-process, never asserted."""
    identity = measure_actions_identity(
        audience=MERGE_LANE_OIDC_AUDIENCE, workflow_path=MERGE_LANE_WORKFLOW_PATH,
    )
    identity["merge_lane"] = bool(
        identity["platform_verified"]
        and identity["workflow_verified"]
        and identity["runner_group"] == GITHUB_HOSTED
    )
    if identity["platform_verified"] and identity["runner_group"] != GITHUB_HOSTED:
        identity["reasons"].append(f"runner_not_github_hosted:{identity['runner_group']}")
    return identity


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
    row.setdefault(
        "row_id",
        f"runner:{row.get('pr_number')}:{row.get('head_sha')}:{row.get('runner_id')}"
        f":{row.get('run_id')}:{row.get('run_attempt')}",
    )
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
    """The attestation of THE RUN THAT IS MERGING, re-measured at the merge.

    ARIA-HIGH-220 — rows used to be matched on (PR, head, claim) alone, so
    a row any host recorded satisfied any other host's merge. The identity
    is measured here, in the process about to merge
    (:func:`measure_merge_lane_identity`: the OIDC token verified against
    GitHub's keys, naming this run and the merge-runner workflow on main),
    and only a row recorded by this run — same run id, attempt and runner —
    is accepted.
    """
    current = measure_merge_lane_identity()
    if current["merge_lane"] is not True:
        raise GovernanceError(
            "runner_attestation_host_not_merge_lane: " + "; ".join(current["reasons"] or ["unverified"])
        )
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
            and row.get("attestation_lane") == MERGE_LANE
            and row.get("run_id") == current["run_id"]
            and row.get("run_attempt") == current["run_attempt"]
            and row.get("runner_id") == current["runner_name"]
        ),
        None,
    )
    if match is None:
        raise GovernanceError(
            "runner_attestation_required_for_merge: no attestation recorded by this run "
            f"(run {current['run_id']} attempt {current['run_attempt']} on {current['runner_name']!r})"
        )
    _validate_attestation(match)
    return {
        "valid": True,
        "runner_id": match.get("runner_id"),
        "run_id": match.get("run_id"),
        "run_attempt": match.get("run_attempt"),
        "job_workflow_ref": (match.get("oidc") or {}).get("job_workflow_ref"),
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
    identity: dict[str, Any] | None = None,
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

    ARIA-HIGH-220 — the row is bound to the run that recorded it (run id,
    attempt, runner name) and carries the verified OIDC identity:
    ``platform_verified`` is the token verifying and naming this run, and a
    merge-lane row also records that the job is the merge-runner workflow on
    main (``merge_lane_identity``). ``identity`` is the caller's in-process
    measurement (the merge lane measures once per run); omitted, it is
    measured here.

    Idempotent per (pr_number, head_sha, readiness_claim_id, run): re-probing
    in the same run returns the existing row unchanged.
    """
    if lane not in ATTESTATION_LANES:
        raise GovernanceError(f"runner_attestation_lane_unknown:{lane}")
    if identity is None:
        identity = (
            measure_merge_lane_identity() if lane == MERGE_LANE
            else measure_actions_identity(audience=RUNNER_ATTESTATION_OIDC_AUDIENCE)
        )
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
                and row.get("run_id") == identity["run_id"]
                and row.get("run_attempt") == identity["run_attempt"]
                and row.get("runner_id") == identity["runner_name"]
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
            "runner_id": identity["runner_name"],
            "run_id": identity["run_id"],
            "run_attempt": identity["run_attempt"],
            "runner_group": identity["runner_group"],
            "ephemeral_runner": identity["ephemeral_runner"],
            "approved_runner_group": identity["approved_runner_group"],
            "attestation_lane": lane,
            "sandbox_available": backend is not None,
            "api_key_auth": api_key_present,
            "claude_auth": (
                CLAUDE_AUTH_NOT_REQUIRED if lane == MERGE_LANE
                else "managed_claude_code_cli" if managed_auth_present
                else "absent"
            ),
            "attestation_method": "probed",
            # ARIA-AUDIT-016 / ARIA-HIGH-220: identity claims need PLATFORM
            # evidence. The evidence is the Actions OIDC token, verified
            # against GitHub's signing keys and naming this run — not the
            # presence of the variables that deliver it.
            "platform_verified": identity["platform_verified"] is True,
            "oidc": dict(identity.get("oidc") or {}),
            "identity_reasons": list(identity.get("reasons") or []),
            **({"merge_lane_identity": identity.get("merge_lane") is True} if lane == MERGE_LANE else {}),
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

    The lane-start entry point of the agent lanes: each claim gets one
    attestation from that lane's host, bound to the run that recorded it. A
    claim this lane already attested is not re-attested by every later run
    (the ledger would grow by every claim ever made, each run). The merge
    gate does not read these rows: since ARIA-HIGH-220 it accepts only the
    row the merging run records for the claim it merges
    (``auto_merge_runners.RealAutoMergeRunner._merge_candidate``).

    A claim whose probe fails validation (no sandbox, missing managed auth,
    API key present, identity unverified) is reported in `refused` —
    recording an invalid attestation is forbidden by
    `_validate_attestation`, and that refusal is the contract working, not
    an error to swallow.
    """
    if lane not in ATTESTATION_LANES:
        raise GovernanceError(f"runner_attestation_lane_unknown:{lane}")
    root = ensure_tools_dir(base_dir)
    claims_path = root / "enterprise" / "readiness-claims.jsonl"
    if not claims_path.exists():
        return {"attested": [], "refused": [], "claims_seen": 0}
    claims = load_declared_jsonl(
        claims_path, expected_surface="enterprise_readiness_claims"
    )
    attestations_path = root / "enterprise" / "runner-attestations.jsonl"
    already = {
        (row.get("pr_number"), row.get("head_sha"), row.get("readiness_claim_id")): row
        for row in (
            load_declared_jsonl(attestations_path, expected_surface="enterprise_runner_attestations")
            if attestations_path.exists() else []
        )
        if row.get("attestation_lane") == lane
    }
    attested: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    pending: list[tuple[int, str, str, dict[str, Any]]] = []
    for claim in claims:
        pr_number = claim.get("pr_number")
        head_sha = str(claim.get("head_sha") or "")
        claim_id = str(claim.get("readiness_claim_id") or "")
        if not isinstance(pr_number, int) or not head_sha or not claim_id:
            continue
        existing = already.get((pr_number, head_sha, claim_id))
        if existing is not None:
            attested.append({
                "readiness_claim_id": claim_id,
                "pr_number": pr_number,
                "row_id": existing.get("row_id"),
                "already_attested": True,
            })
            continue
        pending.append((pr_number, head_sha, claim_id, claim))
    if not pending:
        return {"attested": attested, "refused": refused, "claims_seen": len(claims)}
    # One in-process measurement for the whole probe: every row it records
    # names the same run.
    identity = (
        measure_merge_lane_identity() if lane == MERGE_LANE
        else measure_actions_identity(audience=RUNNER_ATTESTATION_OIDC_AUDIENCE)
    )
    for pr_number, head_sha, claim_id, claim in pending:
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
                identity=identity,
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
    required = (
        "repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id",
        "runner_id", "runner_group", "claude_auth", "run_id", "run_attempt",
    )
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError("runner_attestation_missing_fields:" + ",".join(missing))
    if not str(row.get("run_id")).isdigit() or not str(row.get("run_attempt")).isdigit():
        raise GovernanceError("runner_attestation_run_binding_invalid")
    if row.get("platform_verified") is not True:
        raise GovernanceError(
            "runner_attestation_platform_unverified: identity claims require "
            "the Actions OIDC token, verified against GitHub's signing keys "
            "and naming this run; "
            + "; ".join(str(reason) for reason in row.get("identity_reasons") or [])
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
        # ARIA-HIGH-220 — and the merge lane is the merge-runner workflow on
        # main, as the verified token says; no other job attests as it.
        if row.get("merge_lane_identity") is not True:
            raise GovernanceError(
                "runner_attestation_not_the_merge_lane: "
                + "; ".join(str(reason) for reason in row.get("identity_reasons") or [])
            )
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
    "GITHUB_ACTIONS_OIDC_ISSUER",
    "MERGE_LANE",
    "MERGE_LANE_OIDC_AUDIENCE",
    "MERGE_LANE_WORKFLOW_PATH",
    "MERGE_LANE_WORKFLOW_REF",
    "fetch_actions_oidc_token",
    "measure_actions_identity",
    "measure_merge_lane_identity",
    "measured_runner_identity",
    "verify_actions_oidc_token",
    "probe_runner_attestation",
    "probe_runner_attestations_for_claims",
    "record_runner_attestation",
    "verify_runner_attestation",
]
