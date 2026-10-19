"""ARIA-HIGH-222 — the claim lane's backstop: the heads no claim run claimed.

WHY this module exists
----------------------
``aria-readiness-claim`` runs once per completed, green ``pull_request`` run
of ``aria-merge-authority`` and assembles that head's readiness claim under
the aria/state writer lease. It waits 300 s for the lease, then yields green
and claims nothing. The executor holds the lease for up to 650 minutes and
the cycle for up to 440, and the executor opens ARIA's own pull requests in
the middle of its drain, so their completions land while the lease is held.
Nothing produced those claims again: the merge lane only consumes claims,
and a dispatch of the claim lane is refused (it has no completed run to
bind). A yield was terminal for the head, and the head never merged.

WHAT it does
------------
:func:`sweep_claimless_heads` names the heads a claim run should have
claimed and did not: an open pull request whose live head no recorded claim
names (``readiness_proofs.recorded_claim_heads``, the reader the merge lane
uses for its candidates), with a completed, successful ``pull_request`` run
of ``aria-merge-authority`` for exactly that head whose proof artifact is
still published (the claim fetches and hashes it). The claim lane's hourly
schedule claims the target it returns through the same steps a
``workflow_run`` uses, bound to the swept run id, so
``readiness_claim_current_run_unproven`` still refuses a run the ci ledger
has not proven.

One target per run, rotated by the hour across the claimable heads: a head
whose claim keeps failing (a DLP finding, a refused proof) cannot hold the
backstop on itself, and every claimable head is tried within as many hours
as there are claimable heads. A listing GitHub refuses is a named failure
(``actions_listing_failed``), never an empty sweep.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from . import actions_artifacts
from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .readiness_proofs import recorded_claim_heads
from .tool_registry import GovernanceError
from .workflow_contract_registry import WORKFLOW_CONTRACTS

# The lane whose completed run a claim is bound to; its contract names the
# workflow file (the runs listing is scoped to it) and the proof artifact's
# retention (runs older than that have no artifact left to claim with).
MERGE_AUTHORITY_WORKFLOW_ID = "aria-merge-authority"

UNCLAIMABLE_RUN_ABSENT = "merge_authority_run_absent"
UNCLAIMABLE_PROOF_UNAVAILABLE = "merge_authority_proof_artifact_unavailable"

# Each claimable head costs one artifacts read; a run probes at most this
# many before it stops (the rotation reaches the rest on later runs).
MAX_PROOF_PROBES_PER_SWEEP = 10


def merge_authority_proof_artifact_name(run_id: int | str, run_attempt: int | str) -> str:
    """The proof artifact aria-merge-authority uploads for one run attempt
    (``aria-merge-authority-proof-${run_id}-${run_attempt}``), the one the
    claim lane fetches and hashes."""
    return f"aria-merge-authority-proof-{run_id}-{run_attempt}"


def sweep_claimless_heads(
    *,
    adapter: Any,
    base_dir: str | Path | None,
    limit: int = 1,
    gh_cli: str = "gh",
) -> dict[str, Any]:
    """The open heads a claim run never claimed, and up to ``limit`` to claim now.

    ``adapter`` lists the open pull requests' live heads
    (``list_open_pull_request_heads``) and names the repository
    (``owner`` / ``repo``), as ``auto_merge.GhCliGitHubAdapter`` does.
    """
    if limit < 1:
        raise GovernanceError(f"readiness_claim_sweep_limit_must_be_positive:{limit}")
    moment = _utc_now()
    repo = f"{adapter.owner}/{adapter.repo}"
    open_heads = adapter.list_open_pull_request_heads()
    claimed = recorded_claim_heads(base_dir)
    claimless = sorted(
        (number, head_sha) for number, head_sha in open_heads.items()
        if (number, head_sha) not in claimed
    )
    report: dict[str, Any] = {
        "schema_version": 1,
        "swept_at": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "open_heads": len(open_heads),
        "claimless": [{"pr_number": number, "head_sha": head} for number, head in claimless],
        "targets": [],
        "unclaimable": [],
        "awaiting_rotation": [],
    }
    if not claimless:
        return report

    runs = _green_runs_by_head(repo=repo, moment=moment, gh_cli=gh_cli)
    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for number, head_sha in claimless:
        run = runs.get(head_sha)
        if run is None:
            report["unclaimable"].append(
                {"pr_number": number, "head_sha": head_sha, "reason": UNCLAIMABLE_RUN_ABSENT},
            )
            continue
        candidates.append((number, head_sha, run))
    if not candidates:
        return report

    start = int(moment.timestamp() // 3600) % len(candidates)
    probes = 0
    for number, head_sha, run in candidates[start:] + candidates[:start]:
        entry = {
            "pr_number": number, "head_sha": head_sha,
            "workflow_run_id": str(run["id"]), "run_attempt": int(run["run_attempt"]),
        }
        if len(report["targets"]) >= limit or probes >= MAX_PROOF_PROBES_PER_SWEEP:
            report["awaiting_rotation"].append(entry)
            continue
        probes += 1
        if not _proof_published(repo=repo, run=run, gh_cli=gh_cli):
            report["unclaimable"].append({**entry, "reason": UNCLAIMABLE_PROOF_UNAVAILABLE})
            continue
        report["targets"].append(entry)
    return report


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _green_runs_by_head(*, repo: str, moment: datetime, gh_cli: str) -> dict[str, dict[str, Any]]:
    """The newest completed, successful ``pull_request`` run of
    aria-merge-authority per head sha, inside the proof's retention."""
    contract = WORKFLOW_CONTRACTS[MERGE_AUTHORITY_WORKFLOW_ID]
    (job,) = contract.job_contracts
    since = (moment - timedelta(days=job.retention_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = urlencode({
        "event": "pull_request", "status": "success", "created": f">={since}", "per_page": 100,
    })
    workflow_file = Path(contract.workflow_file).name
    rows = actions_artifacts.list_actions_pages(
        path=f"repos/{repo}/actions/workflows/{workflow_file}/runs?{query}",
        key="workflow_runs",
        gh_cli=gh_cli,
    )
    newest: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not _is_green_pull_request_run(row):
            continue
        current = newest.get(row["head_sha"])
        if current is None or (row["id"], row["run_attempt"]) > (current["id"], current["run_attempt"]):
            newest[row["head_sha"]] = row
    return newest


def _is_green_pull_request_run(row: dict[str, Any]) -> bool:
    """The listing's own filters are not trusted: every field a claim binds
    to is checked on the row GitHub returned."""
    return (
        row.get("name") == MERGE_AUTHORITY_WORKFLOW_ID
        and row.get("event") == "pull_request"
        and row.get("status") == "completed"
        and row.get("conclusion") == "success"
        and isinstance(row.get("id"), int) and not isinstance(row.get("id"), bool)
        and isinstance(row.get("run_attempt"), int) and row["run_attempt"] >= 1
        and is_object_id(row.get("head_sha"), formats=ANY_OBJECT_FORMAT)
    )


def _proof_published(*, repo: str, run: dict[str, Any], gh_cli: str) -> bool:
    expected = merge_authority_proof_artifact_name(run["id"], run["run_attempt"])
    artifacts = actions_artifacts.list_actions_pages(
        path=f"repos/{repo}/actions/runs/{run['id']}/artifacts?per_page=100",
        key="artifacts",
        gh_cli=gh_cli,
    )
    return any(item.get("name") == expected and item.get("expired") is False for item in artifacts)


__all__ = [
    "MAX_PROOF_PROBES_PER_SWEEP",
    "MERGE_AUTHORITY_WORKFLOW_ID",
    "UNCLAIMABLE_PROOF_UNAVAILABLE",
    "UNCLAIMABLE_RUN_ABSENT",
    "merge_authority_proof_artifact_name",
    "sweep_claimless_heads",
]
