"""The one complete open-issue read (ARIA-LOW-554, ARIA-MEDIUM-582).

Two owners asked one question — every open issue carrying all of a label
set — and kept two answers: the issue writer's lookup paged the REST list
to the end (ARIA-LOW-554), while the merge lane's adapter read the 50
newest through ``gh issue list --limit 50`` and reported the window
readable. The freeze gates filter that window by title, so a self-merge
freeze notice or a watchdog incident older than the 50 newest labelled
issues was an absent freeze, and the merge proceeded (ARIA-MEDIUM-582).

One function is now the owner of the read, and both call it with their
own ``gh`` callable. It is a leaf module on purpose: ``github_adapters``
already imports ``auto_merge``'s adapter, so a reader module-level there
could not be imported by ``auto_merge`` without a cycle, and the reader
belongs to neither adapter.

The read is the REST issue list, every page of it (``--paginate
--slurp``: one JSON array of the page arrays), never a capped
newest-first window and never the search index (ARIA-HIGH-415: the index
lags a just-created issue). The REST list carries pull requests too,
marked ``pull_request``; they are not issues here, as they were not in
``gh issue list``. ``gh api`` takes no ``--repo``: the repository is in
the endpoint, or the ``{owner}/{repo}`` placeholder, which ``gh``
resolves from the working directory exactly as ``gh issue list`` did
without one.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlencode

__all__ = ["open_issues_endpoint", "read_open_issues"]

#: Runs ``gh`` with ``argv`` and answers ``(ok, output)`` — a refusal or a
#: transport failure is a failed read with its detail, never an exception,
#: because the freeze gates report an unreadable listing rather than raise
#: through the merge decision. Both adapters' own plumbing has this shape.
GhRead = Callable[[list[str]], "tuple[bool, str]"]


def open_issues_endpoint(*, repo: str | None, labels: Sequence[str]) -> str:
    """The REST issue-list endpoint for the whole open set of ``labels``.

    Single owner of the query shape (the adapter consults the gh api
    allowlist with exactly this string before it runs the read).
    """
    query = urlencode({"state": "open", "labels": ",".join(labels), "per_page": 100}, safe=",")
    return f"repos/{repo or '{owner}/{repo}'}/issues?{query}"


def read_open_issues(
    gh_read: GhRead, *, repo: str | None, labels: Sequence[str],
) -> tuple[bool, list[dict[str, Any]], str]:
    """Every open issue carrying all ``labels``, as ``{number, title, url}``.

    ``(False, [], reason)`` when the listing refused
    (``issue_list_failed:<detail>``) or its answer is not the paged-array
    shape (``issue_list_unparseable``): an unreadable freeze is not an
    absent freeze, so a caller that cannot read says so instead of
    reading a partial set as "no freeze".
    """
    ok, out = gh_read(["api", "--paginate", "--slurp", open_issues_endpoint(repo=repo, labels=labels)])
    if not ok:
        return False, [], f"issue_list_failed:{out}"
    try:
        pages = json.loads(out)
    except ValueError:
        return False, [], "issue_list_unparseable"
    if not isinstance(pages, list) or not all(isinstance(page, list) for page in pages):
        return False, [], "issue_list_unparseable"
    return True, [
        {"number": row.get("number"), "title": row.get("title"), "url": row.get("html_url")}
        for page in pages
        for row in page
        if isinstance(row, dict) and "pull_request" not in row
    ], ""
