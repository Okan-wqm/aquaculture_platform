"""Own-PR CI feedback — ARIA reads the checks of the PRs it pushed.

Plan "Own-PR CI Feedback" (ORPHAN-HIGH-626). Until this module, nothing
anywhere enumerated ARIA-authored open PRs, read their GitHub check
conclusions, and turned a RED into next-cycle work: `poll_pr_checks` was
dead, the whole of `ci.py` (record_ci_report → ci/failures.jsonl →
remediation) had zero producers while `executor.py` READ its ledger for
flaky fingerprints, and the nightly's `standard` profile received a
Recording adapter whose `get_checks` returns empty. ARIA could write wrong
code, watch nothing, and learn nothing — the merge gate would block the
red PR, forever, silently.

Three parts, matching the runtime_signal bridge pattern:
  * `scan_own_prs` — cycle-phase body: enumerate own PRs (head branch
    `aria/*` or `automation/*`, `aria/state` excluded), snapshot checks via
    the REVIVED `ci._gh_pr_snapshot` + `ci.record_ci_report` (the dead
    ledger's first producer), and append open/cleared rows to the bridge
    ledger `ci/own-pr-checks.jsonl`.
  * `load_open_own_pr_reds` — the pressure producer's read: latest row per
    PR, only `status == "open"` survives.
  * Profile respect lives in `github_adapters.select_checks_reader`: the
    Recording split exists for WRITE safety; a read-only check scan is
    exactly what the standard nightly should observe. No token / no gh →
    `readable: False` with a NAMED reason — never a silent empty list
    (the failing_ci scanner's mistake, not repeated).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now

OWN_PR_HEAD_PREFIXES = ("aria/", "automation/")
OWN_PR_EXCLUDED_HEADS = ("aria/state",)

_BRIDGE_RELPATH = ("ci", "own-pr-checks.jsonl")
_MERGE_OUTCOME_RELPATH = ("ci", "merge-outcomes.jsonl")
_REPO_PR_HEALTH_RELPATH = ("ci", "repo-pr-health.jsonl")
_RED_CONCLUSIONS = {"failure", "cancelled", "timed_out"}


def bridge_path(base_dir: str | Path | None = None) -> Path:
    root = ensure_tools_dir(base_dir)
    return root.joinpath(*_BRIDGE_RELPATH)


def is_own_pr_head(head_ref: str) -> bool:
    head = str(head_ref or "")
    if head in OWN_PR_EXCLUDED_HEADS:
        return False
    return head.startswith(OWN_PR_HEAD_PREFIXES)


def red_jobs_of(github: dict[str, Any]) -> list[str]:
    """The failed run names out of a `ci._gh_pr_snapshot` github payload."""
    runs = github.get("workflow_runs") or []
    return sorted(
        str(run.get("name"))
        for run in runs
        if isinstance(run, dict) and run.get("conclusion") in _RED_CONCLUSIONS
    )


def scan_own_prs(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    reader: Any,
) -> dict[str, Any]:
    """Scan ARIA's own open PRs and record their check verdicts.

    `reader` comes from `github_adapters.select_checks_reader`. A reader
    that cannot read (no gh, no token, observing profile) reports itself in
    the result — the phase result carries WHY nothing was scanned, so a
    tokenless night is a visible cause, not a quiet zero.
    """
    root = ensure_tools_dir(base_dir)
    readable, reason = reader.readable()
    if not readable:
        return {
            "status": "unreadable",
            "readable": False,
            "reason": reason,
            "scanned": [],
            "red": [],
            "cleared": [],
        }
    prs = reader.list_own_prs()
    scanned: list[dict[str, Any]] = []
    red: list[int] = []
    cleared: list[int] = []
    for pr in prs:
        number = pr.get("number")
        head_ref = str(pr.get("headRefName") or "")
        if not isinstance(number, int) or not is_own_pr_head(head_ref):
            continue
        snapshot = reader.pr_snapshot(number)
        if snapshot is None:
            continue
        # The dead pipeline's first producer: workflow-runs + failures +
        # gate rows land in ci/*.jsonl, feeding the flaky-fingerprint
        # reader that has waited in executor.py since the pipeline shipped.
        from .ci import record_ci_report

        record_ci_report(
            pr=snapshot["pr"],
            github=snapshot["github"],
            base_dir=root,
            cycle_id=cycle_id,
        )
        jobs = red_jobs_of(snapshot["github"])
        status = "open" if jobs else "cleared"
        append_declared_jsonl(
            bridge_path(root),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "pr_number": number,
                "head_ref": head_ref,
                "head_sha": str(snapshot["pr"].get("headRefOid") or ""),
                "red_jobs": jobs,
                "status": status,
            },
            expected_surface="own_pr_checks",
        )
        scanned.append({"pr_number": number, "head_ref": head_ref, "status": status})
        (red if jobs else cleared).append(number)
    return {
        "status": "scanned",
        "readable": True,
        "scanned": scanned,
        "red": red,
        "cleared": cleared,
    }


def merge_outcomes_path(base_dir: str | Path | None = None) -> Path:
    root = ensure_tools_dir(base_dir)
    return root.joinpath(*_MERGE_OUTCOME_RELPATH)


def scan_merged_own_prs(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    reader: Any,
    limit: int = 20,
) -> dict[str, Any]:
    """ORPHAN-718 — track whether main stayed green after ARIA's merges.

    2026-08-18 operator directive: ARIA must watch BOTH its PR's first
    Actions verdict (scan_own_prs above) and the post-merge Actions runs
    on main, record them, and learn from the reds. PR-green and
    main-green diverged for months on this repository — the deploy lane
    was red on main while every PR stayed green — and nothing ARIA-side
    could see it.

    Appends one row per merged own-PR whose outcome CHANGED since the
    last recorded row (idempotent across cycles); a NEW red also lands a
    governance event so the ledger carries the moment of discovery, and
    ``load_post_merge_reds`` below feeds the pressure producer — the red
    becomes next-cycle work, which is the learning loop.
    """
    root = ensure_tools_dir(base_dir)
    readable, reason = reader.readable()
    if not readable:
        return {"status": "unreadable", "readable": False, "reason": reason,
                "scanned": [], "red": [], "green": []}
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(
        merge_outcomes_path(root), expected_surface="merge_outcomes",
    ):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest[number] = row
    scanned: list[dict[str, Any]] = []
    red: list[int] = []
    green: list[int] = []
    for pr in reader.list_merged_own_prs(limit=limit):
        number = pr.get("number")
        head_ref = str(pr.get("headRefName") or "")
        if not isinstance(number, int) or not is_own_pr_head(head_ref):
            continue
        merge_sha = str((pr.get("mergeCommit") or {}).get("oid") or "")
        if not merge_sha:
            continue
        runs = [
            run for run in reader.runs_for_commit(merge_sha)
            if str(run.get("headBranch") or "") == "main"
        ]
        red_jobs = sorted(
            str(run.get("name"))
            for run in runs
            if run.get("conclusion") in _RED_CONCLUSIONS
        )
        pending_jobs = sorted(
            str(run.get("name"))
            for run in runs
            if str(run.get("status") or "") != "completed"
        )
        if not runs:
            status = "no_runs_observed"
        elif red_jobs:
            status = "red"
        elif pending_jobs:
            status = "pending"
        else:
            status = "green"
        previous = latest.get(number)
        if previous and previous.get("status") == status and previous.get("red_jobs") == red_jobs:
            continue
        append_declared_jsonl(
            merge_outcomes_path(root),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "pr_number": number,
                "head_ref": head_ref,
                "merge_sha": merge_sha,
                "red_jobs": red_jobs,
                "pending_jobs": pending_jobs,
                "status": status,
            },
            expected_surface="merge_outcomes",
        )
        if status == "red" and (previous is None or previous.get("status") != "red"):
            from .tool_registry import append_tools_governance

            append_tools_governance(
                root,
                "post_merge_ci_red",
                {
                    "pr_number": number,
                    "merge_sha": merge_sha,
                    "red_jobs": red_jobs,
                    "cycle_id": cycle_id,
                },
            )
        scanned.append({"pr_number": number, "status": status})
        (red if status == "red" else green).append(number)
    return {"status": "scanned", "readable": True, "scanned": scanned,
            "red": red, "green": green}


def repo_pr_health_path(base_dir: str | Path | None = None) -> Path:
    root = ensure_tools_dir(base_dir)
    return root.joinpath(*_REPO_PR_HEALTH_RELPATH)


def scan_repo_pr_health(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    reader: Any,
    limit: int = 30,
) -> dict[str, Any]:
    """ORPHAN-723 — see the whole repo's PR weather, own or not.

    2026-08-18 operator ask: "does ARIA also see Dependabot's branches
    failing Actions?" It did not — the own-PR scan is branch-prefix
    scoped by design. This observer records EVERY open PR's check
    verdict (outcome changes only, mirror of the merge-outcome dedupe)
    so third-party reds are at least VISIBLE in ARIA's ledgers and
    reports. Strictly read-only: no comments, no reviews, no dispatch —
    acting on third-party PRs is E23's operator-gated authority, and
    this observer deliberately stops at observation.
    """
    root = ensure_tools_dir(base_dir)
    readable, reason = reader.readable()
    if not readable:
        return {"status": "unreadable", "readable": False, "reason": reason,
                "scanned": [], "red": []}
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(
        repo_pr_health_path(root), expected_surface="repo_pr_health",
    ):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest[number] = row
    scanned: list[dict[str, Any]] = []
    red: list[int] = []
    for pr in reader.list_open_prs(limit=limit):
        number = pr.get("number")
        head_ref = str(pr.get("headRefName") or "")
        if not isinstance(number, int):
            continue
        snapshot = reader.pr_snapshot(number)
        if snapshot is None:
            continue
        jobs = red_jobs_of(snapshot["github"])
        status = "red" if jobs else "green"
        previous = latest.get(number)
        if previous and previous.get("status") == status and previous.get("red_jobs") == jobs:
            continue
        append_declared_jsonl(
            repo_pr_health_path(root),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "pr_number": number,
                "head_ref": head_ref,
                "own_pr": is_own_pr_head(head_ref),
                "author": str((pr.get("author") or {}).get("login") or ""),
                "red_jobs": jobs,
                "status": status,
            },
            expected_surface="repo_pr_health",
        )
        scanned.append({"pr_number": number, "status": status})
        if jobs:
            red.append(number)
    return {"status": "scanned", "readable": True, "scanned": scanned, "red": red}


def load_third_party_pr_reds(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Latest health row per non-own PR; only still-red rows survive."""
    root = ensure_tools_dir(base_dir)
    path = repo_pr_health_path(root)
    if not path.exists():
        return []
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface="repo_pr_health"):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest[number] = row
    return [
        row for row in latest.values()
        if row.get("status") == "red" and not row.get("own_pr")
    ]


def load_post_merge_reds(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Latest merge-outcome row per PR; only still-red rows survive.

    Mirror of ``load_open_own_pr_reds`` — a later green row retires the
    pressure the red minted, the same way open-PR reds clear.
    """
    root = ensure_tools_dir(base_dir)
    path = merge_outcomes_path(root)
    if not path.exists():
        return []
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface="merge_outcomes"):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest[number] = row
    return [row for row in latest.values() if row.get("status") == "red"]


def load_open_own_pr_reds(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Latest bridge row per PR; only still-open reds survive.

    The pressure producer's read: a PR that went green writes a `cleared`
    row, which retires its pressure the same way the red minted it —
    append-only ledger, latest-row-wins state.
    """
    path = bridge_path(base_dir)
    if not path.exists():
        return []
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface="own_pr_checks"):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest[number] = row
    return [row for row in latest.values() if row.get("status") == "open"]


__all__ = [
    "OWN_PR_EXCLUDED_HEADS",
    "OWN_PR_HEAD_PREFIXES",
    "bridge_path",
    "is_own_pr_head",
    "load_open_own_pr_reds",
    "red_jobs_of",
    "scan_own_prs",
]
