"""ARIA-HIGH-350 — is the GitHub run that holds the writer lease still alive?

A cancelled job does not run its `if: always()` steps when GitHub tears the
runner down (executor run 37231079995, cancelled 22:18Z on 2026-10-04: no
publish, no release), so a `gha:` holder can leave the lease held for its
whole TTL — 650 minutes for the executor. The run's own state is the
authority on whether its holder can still publish: an acquirer asks the
Actions API about the EXACT run attempt the lease names and reaps the lease
only when GitHub says that attempt has concluded.

Fail closed, by name: no token, no repository, a network error, a non-200,
an unparseable body — every one of them is "not reaped" with the reason, and
the acquirer keeps waiting or yields exactly as before. A local or operator
owner is never asked about: its liveness is not GitHub's to report.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

GITHUB_API = "https://api.github.com"
_OWNER_RUN = re.compile(r"^gha:.*:run=(?P<run>\d+):attempt=(?P<attempt>\d+)$")
_TIMEOUT_SECONDS = 15
RunStatus = tuple[str, "str | None"]
RunStatusReader = Callable[[str, str], RunStatus]


class RunStatusUnavailable(RuntimeError):
    """The Actions API gave no usable answer about a run attempt."""


def github_run_attempt_status(
    run_id: str,
    attempt: str,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> RunStatus:
    """``(status, conclusion)`` of one run attempt, from the Actions API.

    The token is the one the lane already holds (`GH_TOKEN`, else
    `GITHUB_TOKEN`; a job needs `actions: read`), the repository is the
    job's own `GITHUB_REPOSITORY`. Raises ``RunStatusUnavailable`` rather
    than guess.
    """
    token = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token or not repository:
        raise RunStatusUnavailable("no GitHub token or repository in the environment")
    url = f"{GITHUB_API}/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}"
    request = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with opener(request, timeout=_TIMEOUT_SECONDS) as response:
            if getattr(response, "status", 200) != 200:
                raise RunStatusUnavailable(f"HTTP {response.status} from the Actions API")
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RunStatusUnavailable(f"HTTP {exc.code} from the Actions API") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise RunStatusUnavailable(f"Actions API unreachable or unreadable: {exc}") from exc
    status = payload.get("status") if isinstance(payload, dict) else None
    if not isinstance(status, str) or not status:
        raise RunStatusUnavailable("Actions API answer carries no run status")
    conclusion = payload.get("conclusion")
    return status, conclusion if isinstance(conclusion, str) else None


@dataclass(frozen=True)
class ReapDecision:
    """Whether a held lease's run has concluded, and in whose words."""

    concluded: bool
    reason: str
    record: dict[str, Any] | None = None


def reap_decision(
    *,
    owner: str,
    run_id: str | None,
    lease_id: str,
    run_status: RunStatusReader,
) -> ReapDecision:
    match = _OWNER_RUN.match(owner)
    if match is None:
        return ReapDecision(False, f"owner {owner} is not a GitHub run")
    if not run_id or run_id != match.group("run"):
        return ReapDecision(False, f"lease records run id {run_id or '-'} and its owner run {match.group('run')}")
    attempt = match.group("attempt")
    try:
        status, conclusion = run_status(run_id, attempt)
    except RunStatusUnavailable as exc:
        return ReapDecision(False, f"run status unavailable: {exc}")
    if status != "completed":
        return ReapDecision(False, f"run {run_id} attempt {attempt} is {status}")
    return ReapDecision(
        True,
        f"run {run_id} attempt {attempt} concluded: {conclusion or 'unknown'}",
        record={
            "lease_id": lease_id,
            "owner": owner,
            "run_id": run_id,
            "run_attempt": attempt,
            "status": status,
            "conclusion": conclusion,
        },
    )


__all__ = [
    "ReapDecision",
    "RunStatusReader",
    "RunStatusUnavailable",
    "github_run_attempt_status",
    "reap_decision",
]
