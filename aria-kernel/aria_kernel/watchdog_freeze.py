"""ARIA must not merge while the external watchdog says its memory is stalled.

PLAN Wave 2 specifies ``MERGE_FROZEN`` on a watchdog anomaly. The watchdog
shipped with the notification half only: it files an incident issue and fails
its own run, and its own body says so — *"It reports; it does not repair."*
So a stalled ARIA memory was visible and not enforcing (``ORPHAN-MEDIUM-562``).

WHY THE WATCHDOG DOES NOT FREEZE, and must not. Freezing writes the breaker
ledger, which requires importing the kernel — and every failure the watchdog
exists to catch is a failure of that kernel. A watchman that dies of the illness
it watches for is not a watchman. So the alarm is something the MERGE side
READS, never something the watchdog writes, which keeps the dependency pointing
the safe way.

TWO DEADLOCKS THIS DESIGN AVOIDS, both found by working the consequences through
rather than by review:

1. **Not the required check.** ``ORPHAN-MEDIUM-562`` itself proposed refusing in
   the ``aria-merge-authority`` workflow. That workflow is a REQUIRED status
   check running on every ``pull_request``, so refusing there would block every
   human pull request in the repository — including the one repairing the stall.
   The finding's recorded shape is corrected rather than followed.

2. **Not the cycle preflight.** The obvious reuse is the circuit breaker, whose
   ``state_integrity_gap`` comment argues — correctly — that one stop mechanism
   beats two. But the watchdog fires when the ``aria/state`` branch tip stops
   advancing, and the CYCLE is what advances it. Freezing the cycle would mean
   the branch never moves, the incident never closes, and the freeze never
   lifts. The breaker is the right mechanism for failures the cycle can recover
   from by not acting; this is a failure the cycle recovers from by *acting*.

What is frozen is therefore exactly ARIA's autonomous merge, at
``merge_authority.merge_pr_if_ready`` — the single real-merge authority. The
cycle keeps running and can publish the state that closes the incident; humans
keep merging; ARIA stops merging on memory it cannot vouch for.

FAIL-CLOSED. An unreadable issue list is treated as frozen. The alternative is
that a transient GitHub error reads as "no incident", which is the one wrong
answer this control exists to prevent — and ARIA's merges are rare enough that
refusing one costs a cycle, while merging on stale memory costs the invariant.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

# The watchdog's own manifest is the single source for what an incident looks
# like. Duplicating the labels here would be two copies of one truth, and the
# copy that drifts is always the one nobody is reading.
WATCHDOG_MANIFEST_RELPATH = ".github/manifests/aria-state-watchdog.json"

# Same resolution the other repo-relative policy readers use
# (`risk_policy`, `autonomy_unlock`, `policy_approval`): the kernel lives at
# <repo>/aria-kernel/aria_kernel, so the repository is two levels up.
DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[2]


def load_incident_signature(repo_root: str | Path | None = None) -> dict[str, Any]:
    """The title prefix and labels that mark a watchdog incident issue."""
    path = Path(repo_root or DEFAULT_REPO_ROOT) / WATCHDOG_MANIFEST_RELPATH
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GovernanceError(f"watchdog_manifest_unreadable: {path.as_posix()}: {exc}") from exc
    incident = manifest.get("incidentIssue")
    if not isinstance(incident, dict):
        raise GovernanceError("watchdog_manifest_missing_incident_issue")
    title_prefix = incident.get("titlePrefix")
    labels = incident.get("labels")
    if not isinstance(title_prefix, str) or not title_prefix.strip():
        raise GovernanceError("watchdog_manifest_missing_title_prefix")
    if not isinstance(labels, list) or not labels or not all(isinstance(x, str) and x for x in labels):
        raise GovernanceError("watchdog_manifest_missing_labels")
    return {"title_prefix": title_prefix, "labels": list(labels)}


def open_watchdog_incidents(
    *,
    adapter: Any,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    """Open incident issues the watchdog raised, and whether the read succeeded.

    The label filter is what the API can do; the title prefix is checked here so
    an unrelated issue that happens to carry the `aria` and `watchdog` labels
    cannot freeze ARIA's merges. A freeze that fires on the wrong issue is a
    freeze someone turns off.
    """
    signature = load_incident_signature(repo_root)
    try:
        payload = adapter.get_open_issues(labels=list(signature["labels"]))
    except Exception as exc:
        return {"readable": False, "reason": f"{exc.__class__.__name__}: {exc}", "incidents": []}
    if not isinstance(payload, dict) or payload.get("readable") is not True:
        return {"readable": False, "reason": "adapter_reported_unreadable", "incidents": []}
    issues = payload.get("issues")
    if not isinstance(issues, list):
        return {"readable": False, "reason": "adapter_returned_no_issue_list", "incidents": []}
    prefix = str(signature["title_prefix"])
    incidents = [
        {"number": issue.get("number"), "title": issue.get("title")}
        for issue in issues
        if isinstance(issue, dict) and str(issue.get("title") or "").startswith(prefix)
    ]
    return {"readable": True, "reason": None, "incidents": incidents}


def assert_merge_not_watchdog_frozen(
    *,
    adapter: Any,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    """Refuse an ARIA merge while a watchdog incident is open, or unreadable."""
    verdict = open_watchdog_incidents(adapter=adapter, repo_root=repo_root)
    if verdict["readable"] is not True:
        raise GovernanceError(
            "merge_frozen_watchdog_unreadable: cannot confirm ARIA's memory is "
            f"advancing ({verdict['reason']}); refusing to merge rather than "
            "reading an unreadable alarm as silence",
        )
    if verdict["incidents"]:
        listed = ", ".join(f"#{item['number']}" for item in verdict["incidents"])
        raise GovernanceError(
            f"merge_frozen_watchdog_incident_open: {listed}. The external watchdog "
            "reports ARIA's memory is not advancing; merging would act on state "
            "nobody can attest to. The cycle is deliberately NOT frozen, so the "
            "lanes can publish the state that closes the incident.",
        )
    return verdict


__all__ = [
    "DEFAULT_REPO_ROOT",
    "WATCHDOG_MANIFEST_RELPATH",
    "assert_merge_not_watchdog_frozen",
    "load_incident_signature",
    "open_watchdog_incidents",
]
