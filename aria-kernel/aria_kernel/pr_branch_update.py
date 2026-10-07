"""ARIA-HIGH-372 — keep ARIA's own open PR branches mergeable under strict protection.

WHY. ``main`` requires an up-to-date branch (``required_status_checks.strict``
true, four required checks, no merge queue — read from the branch protection
on 2026-10-07). An ARIA implementation branch is cut from its anchor commit
and nothing ever updated it, so once ``main`` moved (hourly here) the PR was
``mergeStateStatus: BEHIND`` and unmergeable by anyone until a person updated
it by hand: the merge lane's ``gh pr merge --match-head-commit`` is refused
by GitHub, and a human-merge PR (F-015: ``web/**/src/**`` + ``apps/**/src/**``
are lane L2) waited behind an extra manual step nobody was told about.

WHAT. Once per cycle (``cycle._phase_pr_ci_scan``, the single writer of the
store while it holds the lease), for each PR ARIA's own ledger says it
opened (``own_pr_delivery.aria_opened_prs``) on an ``aria-impl-*`` branch:

* only when GitHub itself says ``BEHIND`` (never ``DIRTY``: a conflict is a
  person's — ``human_merge_surface`` names it) and the current head's checks
  have settled green (updating a pending head cancels its run; a red head is
  not mergeable after an update either);
* through GitHub's ``update-branch`` endpoint with ``expected_head_sha``:
  the server merges ``main`` into the branch only if the head is still the
  one judged here, so a racing push is refused rather than merged over. It
  is the same merge a person makes with ``git merge origin/main``. The
  repository's custom merge driver (``.gitattributes``:
  ``docs/reviews/_registry/findings.jsonl merge=findings-registry``) is not
  needed for these branches: that registry is in
  ``implementation_safety.READONLY_PATHS``, so no ARIA implementation diff
  carries it (the reconcile PR that makes other PRs ``DIRTY`` on GitHub
  cannot conflict with an ARIA branch), and a genuine code conflict is
  ``DIRTY``, which this step never touches;
* on the delivery's own credential path (``hold_delivery_credentials``,
  consumer ``pr_branch_update``, minted only when a PR qualifies, one hold
  for the batch) and through ``run_gh_write`` (installation token or no
  write); gated by the ``pr_open`` profile action — a profile that may not
  open a PR may not move one;
* idempotent and bounded: at most ``MAX_UPDATES_PER_CYCLE`` requests per
  cycle, and at most ONE request per ``(pr, head, base)`` triple — the
  intent's idempotency key on the external-effects ledger (``recovery``).
  Main moving gives a new base, hence at most one retry per main commit; an
  attempt whose receipt never came (timeout) is answered from the PR's head
  on the next pass and never re-sent for the same triple.

AFTER THE UPDATE (ARIA-HIGH-374). An update changes the PR head, and every
self-merge gate binds the evidence to the delivered commit. The gates accept
the updated head only through ``branch_update_lineage``: each update commit
must be one this ledger records (``request_branch_update``) and a pure merge
of main. Anything else on the branch keeps the PR a person's merge.
"""
from __future__ import annotations

import os
import re
import subprocess
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .own_pr_delivery import CI_GREEN, aria_opened_prs, ci_summary
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

# One `gh api PUT .../update-branch` (202 Accepted is immediate: the merge
# itself runs on GitHub's side), bounded like the self-revert PR lookup.
GH_UPDATE_BRANCH_TIMEOUT_SECONDS = 60
# A cycle requests at most this many updates: each one re-runs the four
# required checks on a shared runner pool, and the next cycle continues.
MAX_UPDATES_PER_CYCLE = 3
BEHIND = "BEHIND"
EFFECT_KIND = "gh_api_write"
UPDATE_REQUESTED_EVENT = "pr_branch_update_requested"


@dataclass(frozen=True)
class BranchUpdateGrant:
    """The external-write grant ``hold_delivery_credentials`` mints for: the
    cycle's update of ARIA's own PR branches, exactly one API call per PR."""

    profile_id: str = "kernel_pr_branch_update"
    external_writes: bool = True


_REQUEST_PREFIX = "pr-branch-update:"


def update_request_id(pr_number: int) -> str:
    return f"{_REQUEST_PREFIX}{pr_number}"


def _attempted(request_id: str, *, base_dir: str | Path | None) -> dict[str, dict[str, Any]]:
    """This PR's update intents by operation id, each with its receipt (or None)."""
    from .ledger import load_declared_jsonl
    from .recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return {}
    rows = [row for row in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE)
            if row.get("request_id") == request_id]
    # The operation id is the idempotency key of the (pr, head, base) triple,
    # so a retried triple appends a new intent under the same id: rows are
    # paired in ledger order, each receipt answering the latest intent.
    intents: dict[str, dict[str, Any]] = {}
    for row in rows:
        operation_id = str(row.get("operation_id"))
        if row.get("event") == "intent":
            intents[operation_id] = {"intent": row, "receipt": None}
        elif row.get("event") == "receipt" and operation_id in intents:
            intents[operation_id]["receipt"] = row
    return intents


def _answer_unreceipted(request_id: str, live: dict[str, Any], *, base_dir: str | Path | None) -> None:
    """An intent a killed or timed-out pass left without a receipt is answered
    ``absent``, with the head GitHub shows now — for a PR that has since
    closed too (review LOW), so no intent stays unanswered.

    GSEC-MEDIUM-002 — a head that MOVED is not proof the update landed: a
    stranger's push moves it as well. Only a result read back right after
    an accepted call (``request_branch_update``) confirms an update; this
    answer never does, so the lineage never accepts what it saw here.
    """
    from .recovery import record_receipt

    live_head = str(live.get("headRefOid") or "")
    for operation_id, entry in _attempted(request_id, base_dir=base_dir).items():
        if entry["receipt"] is not None:
            continue
        record_receipt(
            operation_id=operation_id, request_id=request_id,
            observed={"head_sha": live_head, "state": str(live.get("state") or ""), "answered_from": "pr_head"},
            status="absent", base_dir=base_dir,
        )


def _prs_with_unanswered_intents(*, base_dir: str | Path | None) -> set[int]:
    """PR numbers whose update intent has no receipt, read in one pass."""
    from .ledger import load_declared_jsonl
    from .recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return set()
    rows = [row for row in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE)
            if str(row.get("request_id") or "").startswith(_REQUEST_PREFIX)]
    answered = {str(row.get("operation_id")) for row in rows if row.get("event") == "receipt"}
    numbers: set[int] = set()
    for row in rows:
        number = (row.get("intended_postcondition") or {}).get("pr_number")
        if row.get("event") == "intent" and str(row.get("operation_id")) not in answered and type(number) is int:
            numbers.add(number)
    return numbers


def _is_behind(live: dict[str, Any]) -> bool:
    """GitHub's verdict that the head lacks base commits.

    ``mergeStateStatus`` is ONE value: a PR both behind and blocked by a
    branch-protection rule (a required review) reads ``BLOCKED`` (review
    LOW). The reader then adds ``behindBy`` from the compare API, so that
    case is still an update, while ``BLOCKED`` with nothing to merge in
    is not.
    """
    merge_state = str(live.get("mergeStateStatus") or "").upper()
    behind_by = live.get("behindBy")
    return merge_state == BEHIND or (
        merge_state == "BLOCKED" and type(behind_by) is int and behind_by > 0
    )


def _candidate(live: dict[str, Any] | None) -> tuple[str | None, str]:
    """(head to update, "") for a qualifying PR, else (None, why not)."""
    from .command_policy import ARIA_IMPL_BRANCH_FRAGMENT

    if live is None:
        return None, "unobserved"
    if str(live.get("state") or "").upper() != "OPEN":
        return None, f"not_open:{live.get('state')}"
    branch = str(live.get("headRefName") or "")
    if re.fullmatch(ARIA_IMPL_BRANCH_FRAGMENT, branch) is None:
        return None, "not_an_aria_implementation_branch"
    merge_state = str(live.get("mergeStateStatus") or "").upper()
    if not _is_behind(live):
        return None, f"merge_state:{merge_state or 'unknown'}"
    ci = ci_summary(live.get("statusCheckRollup"))
    if ci["state"] != CI_GREEN:
        return None, f"head_checks_not_green:{ci['state']}"
    head = str(live.get("headRefOid") or "")
    if re.fullmatch(r"[0-9a-f]{40}", head) is None:
        return None, "head_sha_unreadable"
    return head, ""


def already_requested(*, pr_number: int, head_sha: str, base_sha: str, base_dir: str | Path | None) -> bool:
    """Whether the triple's latest request is still unanswered or was accepted.

    Review M3 — any intent used to block its triple forever, so a crash
    before the call (answered ``absent``) or a ``failed`` receipt (a 5xx, a
    rate limit) left that PR behind until main moved. Only an accepted or
    still-unanswered request blocks a repeat; a failed or absent one is
    retried, inside the per-cycle cap.
    """
    from .recovery import idempotency_key

    intended = {"pr_number": pr_number, "expected_head_sha": head_sha, "base_sha": base_sha}
    key = idempotency_key(effect_kind=EFFECT_KIND, target=f"pr#{pr_number}", intended=intended)
    entry = _attempted(update_request_id(pr_number), base_dir=base_dir).get(f"{EFFECT_KIND}:{key}")
    if entry is None:
        return False
    receipt = entry["receipt"]
    return receipt is None or receipt.get("status") == "confirmed"


# GitHub merges asynchronously after the 202: poll the head this long.
RESULT_READ_BACK_ATTEMPTS = 6
RESULT_READ_BACK_INTERVAL_SECONDS = 5.0


def _read_back_head(
    *, pr_number: int, previous_head: str, environment: dict[str, str], workspace_root: str | Path,
    sleep: Callable[[float], None] | None = None,
) -> str | None:
    """The PR head once it moved off ``previous_head``, or None inside the bound."""
    import time

    pause = sleep or time.sleep
    for attempt in range(RESULT_READ_BACK_ATTEMPTS):
        try:
            read = subprocess.run(
                ["gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{int(pr_number)}", "--jq", ".head.sha"],
                cwd=workspace_root, env=environment, capture_output=True, text=True, check=False, timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        head = (read.stdout or "").strip()
        if read.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", head) and head != previous_head:
            return head
        if attempt + 1 < RESULT_READ_BACK_ATTEMPTS:
            pause(RESULT_READ_BACK_INTERVAL_SECONDS)
    return None


def request_branch_update(
    *,
    pr_number: int,
    head_sha: str,
    base_sha: str,
    environment: dict[str, str],
    workspace_root: str | Path,
    base_dir: str | Path | None,
    runner: Callable[..., "subprocess.CompletedProcess[str]"] | None = None,
    head_reader: Callable[..., str | None] | None = None,
) -> dict[str, Any]:
    """The ONE ``update-branch`` call ARIA makes, bracketed by intent and receipt.

    ARIA-HIGH-374 — the cycle's batch and the merge lane (for a ``BEHIND``
    PR it would otherwise try to merge) both call this, so every update ARIA
    asks for is on the external-effects ledger in one shape: the record
    ``branch_update_lineage.verify_branch_update_lineage`` accepts an updated
    head by. ``environment`` must carry an installation token
    (``run_gh_write``).
    """
    from .github_writes import run_gh_write
    from .recovery import record_intent, record_receipt

    request_id = update_request_id(pr_number)
    intent = record_intent(
        request_id=request_id, effect_kind=EFFECT_KIND, target=f"pr#{pr_number}",
        intended_postcondition={"pr_number": pr_number, "expected_head_sha": head_sha, "base_sha": base_sha},
        base_dir=base_dir,
    )
    row = {"pr_number": pr_number, "head_sha": head_sha, "base_sha": base_sha}
    try:
        completed = run_gh_write(
            ["api", "-X", "PUT", f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/update-branch",
             "-f", f"expected_head_sha={head_sha}"],
            env=environment, cwd=workspace_root, timeout=GH_UPDATE_BRANCH_TIMEOUT_SECONDS, runner=runner,
        )
    except OSError as exc:
        # Review LOW — `gh` missing or not executable: a failed request by
        # name, never an exception that aborts the caller's phase.
        record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                       observed={"os_error": type(exc).__name__}, status="failed", base_dir=base_dir)
        return {**row, "outcome": f"os_error:{type(exc).__name__}"}
    except subprocess.TimeoutExpired:
        # Unknown outcome: no receipt; the next pass answers it from the head.
        return {**row, "outcome": "timed_out"}
    except GovernanceError as exc:
        record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                       observed={"refused": str(exc)[:300]}, status="failed", base_dir=base_dir)
        return {**row, "outcome": f"refused:{str(exc)[:200]}"}
    accepted = completed.returncode == 0
    first_error = ((completed.stderr or "").strip().splitlines() or [""])[0]
    if not accepted:
        record_receipt(
            operation_id=str(intent["operation_id"]), request_id=request_id,
            observed={"returncode": completed.returncode, "stderr": [first_error] if first_error else []},
            status="failed", base_dir=base_dir,
        )
        return {**row, "outcome": f"failed:{first_error[:200]}"}
    # GSEC-MEDIUM-002 — the update runs on GitHub's side after the 202; the
    # head it produced is read back and recorded, and only that head is the
    # update's result the lineage accepts. Not observed inside the bound:
    # `absent`, never confirmed — the PR's next head is not attributable.
    result = (head_reader or _read_back_head)(
        pr_number=pr_number, previous_head=head_sha, environment=environment, workspace_root=workspace_root,
    )
    record_receipt(
        operation_id=str(intent["operation_id"]), request_id=request_id,
        observed={"returncode": 0, "result_head_sha": result},
        status="confirmed" if result else "absent", base_dir=base_dir,
    )
    return {**row, "outcome": "accepted" if result else "accepted_result_unobserved", "result_head_sha": result}


def update_behind_aria_prs(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    reader: Any,
    profile: str,
    credential_hold: Callable[..., Any] | None = None,
    runner: Callable[..., "subprocess.CompletedProcess[str]"] | None = None,
    head_reader: Callable[..., str | None] | None = None,
) -> dict[str, Any]:
    """Request ``update-branch`` for each qualifying ARIA PR; see module doc."""
    from .delivery_credentials import (
        DELIVERY_CREDENTIAL_BRANCH_UPDATE_CONSUMER,
        DeliveryCredentialError,
        hold_delivery_credentials,
    )
    from .runtime_profile import ACTION_PERMISSIONS

    if profile not in ACTION_PERMISSIONS["pr_open"]:
        return {"status": "skipped", "reason": f"profile_holds_no_pr_open:{profile}", "requested": [], "skipped": []}
    readable, reason = reader.readable()
    if not readable:
        return {"status": "unreadable", "reason": reason, "requested": [], "skipped": []}
    opened = aria_opened_prs(base_dir=base_dir)
    open_numbers = sorted(int(row["number"]) for row in reader.list_own_prs()
                          if type(row.get("number")) is int and row["number"] in opened)
    queue: list[tuple[int, str, str]] = []
    skipped: list[dict[str, Any]] = []
    # Intents left unanswered on PRs no longer open are answered too.
    for number in sorted(_prs_with_unanswered_intents(base_dir=base_dir) - set(open_numbers)):
        closed = reader.pr_delivery_state(number)
        if closed is not None:
            _answer_unreceipted(update_request_id(number), closed, base_dir=base_dir)
    for number in open_numbers:
        live = reader.pr_delivery_state(number)
        if live is not None:
            _answer_unreceipted(update_request_id(number), live, base_dir=base_dir)
        head, why = _candidate(live)
        if head is None:
            skipped.append({"pr_number": number, "reason": why})
            continue
        assert live is not None
        base = str(live.get("baseRefOid") or "")
        # GSEC-MEDIUM-002 — the shared predicate: ARIA merges main only into
        # a head it can vouch for (the delivered commit or a verified lineage).
        from .branch_update_lineage import fetch_pr_head, update_request_refusal

        fetch_pr_head(workspace_root, number)
        refusal = update_request_refusal(
            workspace=workspace_root, base_dir=base_dir, pr_number=number, head_sha=head, live_base_sha=base,
            branch=str(live.get("headRefName") or ""), base_branch=str(live.get("baseRefName") or ""),
            checks_green=ci_summary(live.get("statusCheckRollup"))["state"] == CI_GREEN,
        )
        if refusal is not None:
            skipped.append({"pr_number": number, "reason": refusal})
            continue
        if already_requested(pr_number=number, head_sha=head, base_sha=base, base_dir=base_dir):
            skipped.append({"pr_number": number, "reason": "already_requested_for_this_head_and_base"})
            continue
        queue.append((number, head, base))
    queue = queue[:MAX_UPDATES_PER_CYCLE]
    if not queue:
        return {"status": "ran", "requested": [], "skipped": skipped}
    hold = credential_hold or hold_delivery_credentials
    requested: list[dict[str, Any]] = []
    with ExitStack() as stack:
        try:
            credential = stack.enter_context(hold(
                profile=BranchUpdateGrant(), request_id=f"pr-branch-update:{cycle_id}", cycle_id=cycle_id,
                workspace_root=workspace_root, base_dir=base_dir,
                covers_seconds=GH_UPDATE_BRANCH_TIMEOUT_SECONDS * len(queue),
                consumer=DELIVERY_CREDENTIAL_BRANCH_UPDATE_CONSUMER,
            ))
        except DeliveryCredentialError as exc:
            return {"status": "credential_unavailable", "reason": str(exc)[:300], "requested": [], "skipped": skipped}
        environment = {**os.environ, **(dict(credential.env) if credential is not None else {})}
        for number, head, base in queue:
            requested.append(request_branch_update(
                pr_number=number, head_sha=head, base_sha=base, environment=environment,
                workspace_root=workspace_root, base_dir=base_dir, runner=runner, head_reader=head_reader,
            ))
    append_tools_governance(ensure_tools_dir(base_dir), UPDATE_REQUESTED_EVENT, {"cycle_id": cycle_id, "requested": requested})
    return {"status": "ran", "requested": requested, "skipped": skipped}


__all__ = [
    "BEHIND",
    "EFFECT_KIND",
    "BranchUpdateGrant",
    "GH_UPDATE_BRANCH_TIMEOUT_SECONDS",
    "MAX_UPDATES_PER_CYCLE",
    "UPDATE_REQUESTED_EVENT",
    "already_requested",
    "request_branch_update",
    "update_behind_aria_prs",
    "update_request_id",
]
