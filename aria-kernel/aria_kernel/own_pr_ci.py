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
