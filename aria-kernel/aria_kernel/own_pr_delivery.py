"""The facts ARIA reads about its own open PRs: which PRs ARIA opened, and their CI.

WHY (ARIA-HIGH-372, ARIA-HIGH-373). The delivery opened a PR and nothing
looked at it again except to read red checks (``own_pr_ci``). Two steps after the open
need the same two facts, so they are read here once, in one spelling:

* :func:`aria_opened_prs` — ARIA's OWN record of the PRs it opened (the
  ``opened`` rows of ``pr-lifecycle.jsonl``, carrying the merge route the
  opener classified). A head-branch prefix is not that record: a person can
  push an ``aria-impl-*`` branch, and the record is readable without GitHub.
* :func:`ci_summary` — the check rollup of ``gh pr view --json
  statusCheckRollup`` reduced to green / red / pending / none, with the
  names that decided it. The rollup carries both check runs (``status`` +
  ``conclusion``) and commit statuses (``state``); both are read.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .ledger import load_declared_jsonl
from .tool_registry import ensure_tools_dir

CI_GREEN = "green"
CI_RED = "red"
CI_PENDING = "pending"
CI_NONE = "none"

_RED_CONCLUSIONS = frozenset({"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"})
_RED_STATES = frozenset({"FAILURE", "ERROR"})
_PENDING_STATES = frozenset({"PENDING", "EXPECTED"})


def aria_opened_prs(*, base_dir: str | Path | None) -> dict[int, dict[str, Any]]:
    """The latest ``opened`` lifecycle row per PR number ARIA opened."""
    path = ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl"
    if not path.exists():
        return {}
    opened: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface="pr_lifecycle"):
        number = row.get("pr_number")
        if row.get("event") == "opened" and type(number) is int and number > 0:
            opened[number] = row
    return opened


def ci_summary(rollup: Any) -> dict[str, Any]:
    """Reduce a ``statusCheckRollup`` to one verdict and the names behind it.

    ``red`` wins over ``pending`` (a failed required check will not turn
    green by waiting), ``pending`` over ``green``; an empty or unreadable
    rollup is ``none`` — never green.
    """
    red: list[str] = []
    pending: list[str] = []
    seen = 0
    for item in rollup if isinstance(rollup, list) else []:
        if not isinstance(item, Mapping):
            continue
        seen += 1
        name = str(item.get("name") or item.get("context") or "?")
        status = str(item.get("status") or "").upper()
        conclusion = str(item.get("conclusion") or "").upper()
        state = str(item.get("state") or "").upper()
        if conclusion in _RED_CONCLUSIONS or state in _RED_STATES:
            red.append(name)
        elif (status and status != "COMPLETED") or state in _PENDING_STATES:
            pending.append(name)
    verdict = CI_RED if red else CI_PENDING if pending else CI_GREEN if seen else CI_NONE
    return {"state": verdict, "red": sorted(set(red)), "pending": sorted(set(pending)), "checks": seen}


__all__ = ["CI_GREEN", "CI_NONE", "CI_PENDING", "CI_RED", "aria_opened_prs", "ci_summary"]
