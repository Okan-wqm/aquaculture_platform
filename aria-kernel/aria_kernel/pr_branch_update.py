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

WHAT IT DOES NOT DO. An update changes the PR head, and every self-merge
gate binds the head to the delivered commit (``change_committed.commit_sha``,
the triple gate, the native merge context). An updated ARIA PR is therefore
a human merge until the merge authority accepts ARIA's own recorded,
server-made updates of a delivered commit — tracked as ARIA-HIGH-374
(owner claude, deadline 2026-10-14). ``human_merge_surface`` names exactly
that reason on the PR's HUMAN_REQUIRED item.
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


def update_request_id(pr_number: int) -> str:
    return f"pr-branch-update:{pr_number}"


def _attempted(request_id: str, *, base_dir: str | Path | None) -> dict[str, dict[str, Any]]:
    """This PR's update intents by operation id, each with its receipt (or None)."""
    from .ledger import load_declared_jsonl
    from .recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return {}
    rows = [row for row in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE)
            if row.get("request_id") == request_id]
    intents = {str(row["operation_id"]): {"intent": row, "receipt": None} for row in rows if row.get("event") == "intent"}
    for row in rows:
        if row.get("event") == "receipt" and str(row.get("operation_id")) in intents:
            intents[str(row["operation_id"])]["receipt"] = row
    return intents


def _answer_unreceipted(
    request_id: str, live_head: str, *, base_dir: str | Path | None,
) -> None:
    """An intent a killed or timed-out pass left without a receipt is answered
    from the PR's head now: it moved (the update landed) or it did not."""
    from .recovery import record_receipt

    for operation_id, entry in _attempted(request_id, base_dir=base_dir).items():
        if entry["receipt"] is not None:
            continue
        expected = str((entry["intent"].get("intended_postcondition") or {}).get("expected_head_sha") or "")
        landed = bool(expected) and live_head != expected
        record_receipt(
            operation_id=operation_id, request_id=request_id,
            observed={"head_sha": live_head, "answered_from": "pr_head", "landed": landed},
            status="confirmed" if landed else "absent", base_dir=base_dir,
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
    if merge_state != BEHIND:
        return None, f"merge_state:{merge_state or 'unknown'}"
    ci = ci_summary(live.get("statusCheckRollup"))
    if ci["state"] != CI_GREEN:
        return None, f"head_checks_not_green:{ci['state']}"
    head = str(live.get("headRefOid") or "")
    if re.fullmatch(r"[0-9a-f]{40}", head) is None:
        return None, "head_sha_unreadable"
    return head, ""


def update_behind_aria_prs(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    reader: Any,
    profile: str,
    credential_hold: Callable[..., Any] | None = None,
    runner: Callable[..., "subprocess.CompletedProcess[str]"] | None = None,
) -> dict[str, Any]:
    """Request ``update-branch`` for each qualifying ARIA PR; see module doc."""
    from .delivery_credentials import (
        DELIVERY_CREDENTIAL_BRANCH_UPDATE_CONSUMER,
        DeliveryCredentialError,
        hold_delivery_credentials,
    )
    from .github_writes import run_gh_write
    from .recovery import idempotency_key, record_intent, record_receipt
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
    for number in open_numbers:
        live = reader.pr_delivery_state(number)
        if live is not None:
            _answer_unreceipted(update_request_id(number), str(live.get("headRefOid") or ""), base_dir=base_dir)
        head, why = _candidate(live)
        if head is None:
            skipped.append({"pr_number": number, "reason": why})
            continue
        assert live is not None
        base = str(live.get("baseRefOid") or "")
        intended = {"pr_number": number, "expected_head_sha": head, "base_sha": base}
        key = idempotency_key(effect_kind=EFFECT_KIND, target=f"pr#{number}", intended=intended)
        if f"{EFFECT_KIND}:{key}" in _attempted(update_request_id(number), base_dir=base_dir):
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
            request_id = update_request_id(number)
            intent = record_intent(
                request_id=request_id, effect_kind=EFFECT_KIND, target=f"pr#{number}",
                intended_postcondition={"pr_number": number, "expected_head_sha": head, "base_sha": base},
                base_dir=base_dir,
            )
            try:
                completed = run_gh_write(
                    ["api", "-X", "PUT", f"repos/{{owner}}/{{repo}}/pulls/{number}/update-branch",
                     "-f", f"expected_head_sha={head}"],
                    env=environment, cwd=workspace_root, timeout=GH_UPDATE_BRANCH_TIMEOUT_SECONDS, runner=runner,
                )
            except subprocess.TimeoutExpired:
                # Unknown outcome: no receipt; the next pass answers it from the head.
                requested.append({"pr_number": number, "head_sha": head, "outcome": "timed_out"})
                continue
            except GovernanceError as exc:
                record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                               observed={"refused": str(exc)[:300]}, status="failed", base_dir=base_dir)
                requested.append({"pr_number": number, "head_sha": head, "outcome": f"refused:{str(exc)[:200]}"})
                continue
            accepted = completed.returncode == 0
            record_receipt(
                operation_id=str(intent["operation_id"]), request_id=request_id,
                observed={"returncode": completed.returncode,
                          "stderr": (completed.stderr or "").strip().splitlines()[:1]},
                status="confirmed" if accepted else "failed", base_dir=base_dir,
            )
            outcome = "accepted" if accepted else f"failed:{((completed.stderr or '').strip().splitlines() or [''])[0][:200]}"
            requested.append({"pr_number": number, "head_sha": head, "base_sha": base, "outcome": outcome})
    append_tools_governance(ensure_tools_dir(base_dir), UPDATE_REQUESTED_EVENT, {"cycle_id": cycle_id, "requested": requested})
    return {"status": "ran", "requested": requested, "skipped": skipped}


__all__ = [
    "BEHIND",
    "BranchUpdateGrant",
    "GH_UPDATE_BRANCH_TIMEOUT_SECONDS",
    "MAX_UPDATES_PER_CYCLE",
    "UPDATE_REQUESTED_EVENT",
    "update_behind_aria_prs",
    "update_request_id",
]
