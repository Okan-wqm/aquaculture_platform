"""A lane that cannot get its runner fails by name instead of vanishing.

WHY: the ARIA self-hosted lanes (`aria-auto-cycle`, `aria-agent-executor`)
share one concurrency group with `cancel-in-progress: false`. When the only
runner carrying their labels went offline (2026-09-08 09:48Z), every
scheduled run queued with zero jobs and was CANCELLED ~12 hours later by the
next schedule taking the group's single pending slot. No red run, no error
line, no notification: a lane that had stopped working read as a lane with
nothing to do — green by absence.

WHAT: a hosted preflight job asks GitHub which runners the repository has
(`GET /repos/{owner}/{repo}/actions/runners`) and fails the run, with a named
reason, unless an ONLINE runner carries every label the self-hosted job
requires. The self-hosted job `needs` it, so the run either has a runner or
is red within a minute. The decision is a pure function over the API
payload so the reasons are pinned by tests without a network.

The endpoint needs `administration:read`, which the Actions `GITHUB_TOKEN`
cannot carry. With `--app-token` this module mints the ARIA GitHub App
installation token itself (`gh_token_factory.mint_installation_token` with
`RUNNER_STATUS_PERMISSIONS` — administration:read and nothing else, because
the preflight runs on a GitHub-hosted runner that must never hold a write
scope on the repository), reads the roster, and revokes the lease before
returning: the token never enters the job environment. `--token-env` is the
operator's local path (a PAT in `GH_TOKEN`). A status that cannot be read is
itself a named failure: guessing "available" would recreate the silence this
exists to end.

Every self-hosted lane needs this preflight, and the wiring is one composite
action (`.github/actions/require-self-hosted-runner`) so five workflows
carry one definition; `tests/test_runner_availability.py` discovers every
self-hosted job across `.github/workflows/` and fails any lane that runs
without it — except the reasoned allowlist there (manual-only diagnostics a
human dispatches and watches).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from typing import Any

# The closed reason vocabulary the preflight step prints as `::error::`.
NO_RUNNER_REGISTERED = "no_runner_registered"
REQUIRED_RUNNER_OFFLINE = "required_runner_offline"
REQUIRED_LABELS_UNMATCHED = "required_labels_unmatched"
RUNNER_STATUS_UNREADABLE = "runner_status_unreadable"
RUNNER_ONLINE = "runner_online"

GITHUB_API_BASE_URL = "https://api.github.com"
_PAGE_SIZE = 100


class RunnerStatusUnreadable(Exception):
    """GitHub did not answer the runner listing; the detail names why."""


@dataclass(frozen=True)
class RunnerAvailability:
    available: bool
    reason: str
    required_labels: tuple[str, ...]
    online: tuple[str, ...]
    offline: tuple[str, ...]
    unlabelled: tuple[str, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


def _normalized_labels(labels: Iterable[str]) -> frozenset[str]:
    # GitHub matches runner labels case-insensitively (`Linux` on the runner
    # satisfies `linux` in `runs-on`); the decision follows the platform.
    return frozenset(str(label).strip().lower() for label in labels if str(label).strip())


def _runner_labels(runner: Mapping[str, Any]) -> frozenset[str]:
    raw = runner.get("labels")
    if not isinstance(raw, list):
        return frozenset()
    return _normalized_labels(
        entry.get("name", "") if isinstance(entry, Mapping) else entry for entry in raw
    )


def evaluate_runner_availability(
    runners: Iterable[Mapping[str, Any]], required_labels: Iterable[str],
) -> RunnerAvailability:
    """Can a job with ``required_labels`` in ``runs-on`` get a runner now?

    A `busy` online runner counts as available: the job queues behind its
    current work, which is the normal state of a shared lane. Only status
    decides; a runner GitHub reports offline cannot pick anything up.
    """
    required = _normalized_labels(required_labels)
    if not required:
        raise ValueError("required_labels must name at least one label")
    online: list[str] = []
    offline: list[str] = []
    unlabelled: list[str] = []
    seen_any = False
    for runner in runners:
        seen_any = True
        name = str(runner.get("name") or runner.get("id") or "?")
        if not required <= _runner_labels(runner):
            unlabelled.append(name)
        elif str(runner.get("status") or "").lower() == "online":
            online.append(name)
        else:
            offline.append(name)
    if online:
        reason = RUNNER_ONLINE
    elif not seen_any:
        reason = NO_RUNNER_REGISTERED
    elif offline:
        reason = REQUIRED_RUNNER_OFFLINE
    else:
        reason = REQUIRED_LABELS_UNMATCHED
    return RunnerAvailability(
        available=bool(online), reason=reason, required_labels=tuple(sorted(required)),
        online=tuple(online), offline=tuple(offline), unlabelled=tuple(unlabelled),
    )


def fetch_repository_runners(
    repository: str, token: str, *, timeout_seconds: float = 20.0,
    base_url: str = GITHUB_API_BASE_URL,
) -> list[dict[str, Any]]:
    """Every runner registered on ``owner/repo``, across pages."""
    if "/" not in repository:
        raise RunnerStatusUnreadable(f"repository_not_owner_slash_name:{repository!r}")
    if not token.strip():
        raise RunnerStatusUnreadable("token_absent")
    runners: list[dict[str, Any]] = []
    page = 1
    while True:
        request = urllib.request.Request(
            f"{base_url}/repos/{repository}/actions/runners?per_page={_PAGE_SIZE}&page={page}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RunnerStatusUnreadable(f"http_{exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise RunnerStatusUnreadable(f"transport:{type(exc).__name__}") from exc
        batch = payload.get("runners") if isinstance(payload, Mapping) else None
        if not isinstance(batch, list):
            raise RunnerStatusUnreadable("payload_without_runners_list")
        runners.extend(row for row in batch if isinstance(row, Mapping))
        total = int(payload.get("total_count") or 0)
        if len(batch) < _PAGE_SIZE or len(runners) >= total:
            return runners
        page += 1


def _read_roster_with_app_token(
    repository: str, *, workspace_root: str, cycle_id: str, timeout_seconds: float,
) -> list[dict[str, Any]]:
    """Mint the read-only App token, read the roster, revoke the lease.

    The lease lives exactly as long as the read: the token is never exported,
    never written anywhere but the 0600 lease file the factory owns, and that
    file is removed on every exit of this function. A mint the factory
    refuses (no App configured under ARIA_REQUIRE_MODE_A, an unreadable PEM,
    a permission the App was not granted) is a named unreadable status.
    """
    from .gh_token_factory import RUNNER_STATUS_PERMISSIONS, mint_installation_token, revoke_installation_token

    try:
        lease = mint_installation_token(
            cycle_id=cycle_id, workspace_root=workspace_root, permissions=RUNNER_STATUS_PERMISSIONS,
        )
    except (RuntimeError, ValueError) as exc:
        raise RunnerStatusUnreadable(f"app_token_mint_refused:{exc}") from exc
    try:
        token = lease.token_file.read_text(encoding="utf-8").strip()
        return fetch_repository_runners(repository, token, timeout_seconds=timeout_seconds)
    finally:
        revoke_installation_token(lease=lease)


def main(argv: list[str] | None = None) -> int:
    """Exit 0 with the decision on stdout when a runner is online; otherwise
    exit 1 after an ``::error::`` line naming the reason."""
    parser = argparse.ArgumentParser(prog="aria_kernel.runner_availability")
    parser.add_argument("--repository", required=True, help="owner/name")
    parser.add_argument("--required-labels", required=True,
                        help="comma-separated labels the self-hosted job's runs-on requires")
    parser.add_argument("--token-env", default="GH_TOKEN",
                        help="environment variable holding a token that can list runners (operator path)")
    parser.add_argument("--app-token", action="store_true",
                        help="mint the ARIA GitHub App token in-process with administration:read only "
                             "(the CI path; ARIA_GH_APP_* / ARIA_REQUIRE_MODE_A as for every App mint)")
    parser.add_argument("--workspace-root", default=".",
                        help="where the App lease file lives for the duration of the read (--app-token)")
    parser.add_argument("--cycle-id", default="runner-preflight",
                        help="lease id for the App mint (--app-token); the workflow passes its run id")
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    args = parser.parse_args(argv)
    labels = [label for label in args.required_labels.split(",") if label.strip()]
    try:
        if args.app_token:
            runners = _read_roster_with_app_token(
                args.repository, workspace_root=args.workspace_root, cycle_id=args.cycle_id,
                timeout_seconds=args.timeout_seconds,
            )
        else:
            runners = fetch_repository_runners(
                args.repository, os.environ.get(args.token_env, ""), timeout_seconds=args.timeout_seconds,
            )
    except RunnerStatusUnreadable as exc:
        sys.stderr.write(
            f"::error::{RUNNER_STATUS_UNREADABLE}: {exc} — the self-hosted runner status for "
            f"{args.repository} could not be read, so the lane cannot prove it has a runner\n"
        )
        return 1
    decision = evaluate_runner_availability(runners, labels)
    sys.stdout.write(decision.to_json() + "\n")
    if decision.available:
        return 0
    sys.stderr.write(
        f"::error::{decision.reason}: no ONLINE runner carries {list(decision.required_labels)} "
        f"(online={list(decision.online)} offline={list(decision.offline)} "
        f"unlabelled={list(decision.unlabelled)}); bring the runner back before this lane can run\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
