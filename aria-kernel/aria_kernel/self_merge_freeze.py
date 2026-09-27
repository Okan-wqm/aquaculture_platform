"""ARIA-HIGH-200 — the self-merge freeze ARIA sets and only an operator lifts.

After a bad ARIA merge nothing stopped the next one: ``merge_authority``
checked the external watchdog freeze but ARIA had no freeze of its own. This
module is that freeze, one declared ledger
(``enterprise/self-merge-freeze.jsonl``) folded into one state:

* ``self_merge_frozen`` — written by ARIA (the self-revert producer) BEFORE it
  opens the revert, naming the merge it reverts. Idempotent per merge sha.
* ``revert_registered`` — the revert PR (number + head sha) that the freeze
  admits. A frozen merge authority refuses every PR except this one. The
  same (freeze, PR, head) registers once: a producer resumed after a crash
  between registering and recording its own decision registers again, and
  that is a no-op.
* ``self_merge_unfrozen`` — written only through :func:`unfreeze_self_merge`,
  which demands an operator's GitHub act approving exactly
  ``surface=self_merge_unfreeze freeze_id=<id>`` (ARIA-CRITICAL-216). A
  governance event, a review file or an environment variable is refused:
  ARIA can author every one of them.

A frozen state survives the revert merging: reverting restores the code, it
does not establish why the change was bad. Lifting the freeze is the
operator's decision.

THE NOTICE (ARIA-MEDIUM-227). The freeze is written in the self-hosted
cycle's local store and reaches ``aria/state`` only at that job's end
publish, hours later; the merge lane restores ``aria/state``. So every
freeze also has a GitHub issue — ``freeze_notice_title(freeze_id)`` under
``FREEZE_NOTICE_LABELS``, one per freeze, written only when its body
changes (``publish_freeze_notice``) and closed once the freeze is lifted
(``close_freeze_notice``) — that names the revert PR and the unfreeze
command. The notice is itself a freeze: :func:`assert_self_merge_not_frozen`
reads the open notices through the merge lane's adapter, the same read the
external watchdog's freeze uses, and an open notice whose freeze this lane's
state does not hold yet refuses every merge. The ledger stays the authority
for which revert is admitted and for the lift: a notice whose freeze the
ledger shows lifted freezes nothing. An unreadable notice list refuses, as
an unreadable watchdog alarm does. Each notice outcome is a ``freeze_notice``
row on this ledger (the same restriction's visibility, so it bypasses the
profile gate like the freeze), recorded once per distinct outcome.

The freeze and the unfreeze rows bypass the runtime-profile write gate, as
``runtime_profile.set_profile`` does for a thaw: a restriction must land
whatever profile is active, and the operator's recorded act is the authority
for lifting it. ``revert_registered`` keeps the gate — it is what lets a merge
through — and that gate is the ledger's surface write gate
(``enforce_profile_for_write`` on the ``pr_merge`` surface kind): it refuses
the write under ``frozen`` and ``observe`` and admits it under ``standard``,
``strict`` and ``autonomous``. It is not the ``pr_merge`` action cell, which
only ``autonomous`` holds.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Protocol, Sequence

from .ledger import append_declared_jsonl, load_declared_jsonl
from .operator_approval import OperatorApprovalUnrecorded, verify_operator_approval
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

SELF_MERGE_FREEZE_SURFACE = "enterprise_self_merge_freeze"
SELF_MERGE_FREEZE_RELPATH = ("enterprise", "self-merge-freeze.jsonl")
FROZEN_EVENT = "self_merge_frozen"
REVERT_REGISTERED_EVENT = "revert_registered"
UNFROZEN_EVENT = "self_merge_unfrozen"
NOTICE_EVENT = "freeze_notice"
# The freeze notice's identity on GitHub. Both halves live here — the
# writer (the self-revert producer) and the reader (the merge lane) — so
# the two cannot drift: the title carries the freeze id, the labels are
# what the merge lane's issue read filters on.
FREEZE_NOTICE_LABELS: tuple[str, ...] = ("aria", "self-merge-freeze")
FREEZE_NOTICE_TITLE_PREFIX = "ARIA self-merge freeze:"
# A writer's outcomes (``FreezeNoticeWriter``).
NOTICE_WRITTEN_OUTCOMES = frozenset({"created", "updated"})
NOTICE_CLOSED_OUTCOMES = frozenset({"closed", "absent"})


class FreezeNoticeWriter(Protocol):
    """Where a freeze's notice is written (``github_adapters.select_issue_writer``).

    Each call returns ``{"outcome", "number", "url", "reason"}`` and never
    raises for a transport failure: ``outcome`` is ``created``/``updated``
    (upsert), ``closed``/``absent`` (close), ``failed`` (with ``reason``),
    or ``recorded`` for a writer that only records its intent."""

    def upsert_issue(self, *, title: str, body: str, labels: Sequence[str]) -> dict[str, Any]: ...

    def close_issue(self, *, title: str, labels: Sequence[str], comment: str) -> dict[str, Any]: ...


def freeze_ledger_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*SELF_MERGE_FREEZE_RELPATH)


def _rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    path = freeze_ledger_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=SELF_MERGE_FREEZE_SURFACE)


def freeze_id_for(merge_sha: str) -> str:
    return "freeze-" + hashlib.sha256(merge_sha.encode("utf-8")).hexdigest()[:16]


def list_freezes(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Every freeze ever written, oldest first, folded to its current state:
    the freeze row plus ``revert`` (the registered revert, or None) and
    ``lifted`` (an operator unfroze it)."""
    freezes: dict[str, dict[str, Any]] = {}
    for row in _rows(base_dir):
        freeze_id = str(row.get("freeze_id") or "")
        event = row.get("event")
        if event == FROZEN_EVENT:
            freezes[freeze_id] = {**row, "revert": None, "lifted": False}
        elif event == REVERT_REGISTERED_EVENT and freeze_id in freezes:
            freezes[freeze_id]["revert"] = {
                "pr_number": row.get("pr_number"),
                "head_sha": row.get("head_sha"),
            }
        elif event == UNFROZEN_EVENT and freeze_id in freezes:
            freezes[freeze_id]["lifted"] = True
    return sorted(freezes.values(), key=lambda row: str(row.get("recorded_at") or ""))


def freeze_in_force(freeze_id: str, *, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    """The freeze ``freeze_id`` while it is in force, or None."""
    for freeze in list_freezes(base_dir=base_dir):
        if freeze.get("freeze_id") == freeze_id and not freeze["lifted"]:
            return freeze
    return None


def active_freeze(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    """The freeze in force, with the revert it admits, or None."""
    in_force = [freeze for freeze in list_freezes(base_dir=base_dir) if not freeze["lifted"]]
    # The oldest freeze in force is the one an operator must clear first.
    return in_force[0] if in_force else None


def freeze_self_merge(
    *,
    merge_sha: str,
    pr_number: int | None,
    trigger: str,
    evidence: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Freeze self-merge for a bad merge; the same merge freezes once."""
    if not merge_sha.strip():
        raise GovernanceError("self_merge_freeze_requires_merge_sha")
    freeze_id = freeze_id_for(merge_sha)
    for row in _rows(base_dir):
        if row.get("event") == FROZEN_EVENT and row.get("freeze_id") == freeze_id:
            return row
    row = append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": FROZEN_EVENT,
            "freeze_id": freeze_id,
            "merge_sha": merge_sha,
            "pr_number": pr_number,
            "trigger": trigger,
            "evidence": dict(evidence),
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
        bypass_profile_gate=True,
    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        FROZEN_EVENT,
        {"freeze_id": freeze_id, "merge_sha": merge_sha, "pr_number": pr_number, "trigger": trigger},
        bypass_profile_gate=True,
    )
    return row


def register_revert(
    *,
    freeze_id: str,
    pr_number: int,
    head_sha: str,
    purity: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Name the one PR a freeze admits: ``pr_number`` at exactly ``head_sha``.

    What it checks is narrow, and the caller carries the rest. It refuses a
    ``purity`` whose ``pure`` flag is not True and a ``freeze_id`` that was
    never frozen, and the row goes through the ledger's surface write gate
    (refused under ``frozen`` and ``observe``). It does not prove the revert
    pure — it trusts the caller's purity mapping
    (``self_revert.prove_revert_purity``) — and it does not check that the
    head is committed and validated: the merge authority's triple gate
    checks that at merge time. Idempotent on (freeze, PR, head): the same
    registration returns the row already written.
    """
    if purity.get("pure") is not True:
        raise GovernanceError("self_merge_revert_not_pure")
    rows = _rows(base_dir)
    if not any(
        row.get("event") == FROZEN_EVENT and row.get("freeze_id") == freeze_id
        for row in rows
    ):
        raise GovernanceError(f"self_merge_revert_unknown_freeze:{freeze_id}")
    for row in rows:
        if (row.get("event") == REVERT_REGISTERED_EVENT and row.get("freeze_id") == freeze_id
                and row.get("pr_number") == pr_number and row.get("head_sha") == head_sha):
            return row
    return append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": REVERT_REGISTERED_EVENT,
            "freeze_id": freeze_id,
            "pr_number": pr_number,
            "head_sha": head_sha,
            "purity": dict(purity),
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
    )


def freeze_notice_title(freeze_id: str) -> str:
    return f"{FREEZE_NOTICE_TITLE_PREFIX} {freeze_id}"


def unfreeze_command(freeze_id: str) -> str:
    """The operator's way out of ``freeze_id``: the GitHub act to post and the
    CLI call that consumes it (ARIA-CRITICAL-216 — only an operator's GitHub
    act approving exactly this freeze lifts it)."""
    from .operator_approval import GITHUB_REF_GRAMMAR, approval_line

    return (
        f"post `{approval_line('self_merge_unfreeze', {'freeze_id': freeze_id})}` "
        f"as an operator comment or review, then run `aria-kernel merge-lane unfreeze "
        f"--freeze-id {freeze_id} --operator-approval-ref <ref>` where <ref> is "
        f"{GITHUB_REF_GRAMMAR}"
    )


def _latest_notice(freeze_id: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    latest: dict[str, Any] | None = None
    for row in rows:
        if row.get("event") == NOTICE_EVENT and row.get("freeze_id") == freeze_id:
            latest = row
    return latest


_NOTICE_IDENTITY_FIELDS = ("state", "status", "body_digest", "issue_number", "reason")


def _record_notice(freeze_id: str, row: dict[str, Any], *, base_dir: str | Path | None) -> dict[str, Any]:
    """Append one notice outcome, unless it is the outcome already recorded."""
    latest = _latest_notice(freeze_id, _rows(base_dir))
    if latest is not None and all(latest.get(field) == row.get(field) for field in _NOTICE_IDENTITY_FIELDS):
        return latest
    persisted = append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {"schema_version": 1, "recorded_at": utc_now(), "event": NOTICE_EVENT, "freeze_id": freeze_id, **row},
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
        bypass_profile_gate=True,
    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "self_merge_freeze_notice",
        {"freeze_id": freeze_id, **{field: row.get(field) for field in _NOTICE_IDENTITY_FIELDS}},
        bypass_profile_gate=True,
    )
    return persisted


def _notice_status(outcome: str, done: frozenset[str]) -> str:
    if outcome in done:
        return "published"
    return "recorded_only" if outcome == "recorded" else "failed"


def publish_freeze_notice(
    *,
    freeze_id: str,
    body: str,
    writer: FreezeNoticeWriter,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Open or update ``freeze_id``'s GitHub issue with ``body``.

    Idempotent per freeze: a body already published open is not written
    again, and the writer upserts by exact title, so a notice whose row was
    lost with a killed job is updated, never duplicated. Returns the
    notice row: ``status`` ``published``, ``failed`` (retried on the next
    call) or ``recorded_only`` (a writer that writes nothing)."""
    digest = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    latest = _latest_notice(freeze_id, _rows(base_dir))
    if (latest is not None and latest.get("status") == "published" and latest.get("state") == "open"
            and latest.get("body_digest") == digest):
        return latest
    result = writer.upsert_issue(title=freeze_notice_title(freeze_id), body=body, labels=FREEZE_NOTICE_LABELS)
    outcome = str(result.get("outcome") or "failed")
    return _record_notice(freeze_id, {
        "state": "open",
        "status": _notice_status(outcome, NOTICE_WRITTEN_OUTCOMES),
        "outcome": outcome,
        "body_digest": digest,
        "issue_number": result.get("number"),
        "issue_url": result.get("url"),
        "reason": result.get("reason"),
    }, base_dir=base_dir)


def close_freeze_notice(
    *,
    freeze_id: str,
    comment: str,
    writer: FreezeNoticeWriter,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Close a lifted freeze's issue, once."""
    latest = _latest_notice(freeze_id, _rows(base_dir))
    if latest is not None and latest.get("status") == "published" and latest.get("state") == "closed":
        return latest
    result = writer.close_issue(title=freeze_notice_title(freeze_id), labels=FREEZE_NOTICE_LABELS, comment=comment)
    outcome = str(result.get("outcome") or "failed")
    return _record_notice(freeze_id, {
        "state": "closed",
        "status": _notice_status(outcome, NOTICE_CLOSED_OUTCOMES),
        "outcome": outcome,
        "body_digest": (latest or {}).get("body_digest"),
        "issue_number": result.get("number", (latest or {}).get("issue_number")),
        "issue_url": result.get("url", (latest or {}).get("issue_url")),
        "reason": result.get("reason"),
    }, base_dir=base_dir)


def open_freeze_notices(*, adapter: Any) -> dict[str, Any]:
    """The open freeze notices, and whether the read succeeded.

    The label filter is what the API can do; the title prefix is checked
    here, so an unrelated issue carrying the labels freezes nothing. A title
    with the prefix names its freeze id after it; an empty or unknown id is
    still a notice (the caller refuses on it)."""
    try:
        payload = adapter.get_open_issues(labels=list(FREEZE_NOTICE_LABELS))
    except Exception as exc:  # noqa: BLE001 — an unreadable freeze is not an absent freeze
        return {"readable": False, "reason": f"{exc.__class__.__name__}: {exc}", "notices": []}
    if not isinstance(payload, dict) or payload.get("readable") is not True:
        reason = payload.get("reason") if isinstance(payload, dict) else None
        return {"readable": False, "reason": reason or "adapter_reported_unreadable", "notices": []}
    issues = payload.get("issues")
    if not isinstance(issues, list):
        return {"readable": False, "reason": "adapter_returned_no_issue_list", "notices": []}
    notices = [
        {"number": issue.get("number"), "title": issue.get("title"),
         "freeze_id": str(issue.get("title") or "")[len(FREEZE_NOTICE_TITLE_PREFIX):].strip()}
        for issue in issues
        if isinstance(issue, dict) and str(issue.get("title") or "").startswith(FREEZE_NOTICE_TITLE_PREFIX)
    ]
    return {"readable": True, "reason": None, "notices": notices}


def assert_self_merge_not_frozen(
    *,
    pr_number: int,
    head_sha: str,
    adapter: Any,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Refuse a self-merge while frozen, except the registered revert.

    Frozen means a freeze in force on this lane's ledger, or an open freeze
    notice on GitHub (read through ``adapter``) whose freeze this lane's
    ledger does not hold yet — the freeze was written on the cycle's host
    and has not been published. Returns the freeze when the PR is its
    admitted revert, None when no freeze is in force; raises otherwise.
    """
    notices = open_freeze_notices(adapter=adapter)
    if notices["readable"] is not True:
        raise GovernanceError(
            "self_merge_freeze_notices_unreadable: cannot confirm no self-merge freeze is "
            f"open ({notices['reason']}); refusing to merge rather than reading an unreadable "
            "freeze as none"
        )
    known = {str(freeze.get("freeze_id")) for freeze in list_freezes(base_dir=base_dir)}
    unarrived = [notice for notice in notices["notices"] if notice["freeze_id"] not in known]
    if unarrived:
        listed = ", ".join(f"{notice['freeze_id'] or '<none>'} (#{notice['number']})" for notice in unarrived)
        raise GovernanceError(
            f"self_merge_frozen_by_notice: {listed}. ARIA froze self-merge on its cycle host and "
            "this lane's state does not hold the freeze yet; no PR merges until it arrives"
        )
    freeze = active_freeze(base_dir=base_dir)
    if freeze is None:
        return None
    revert = freeze.get("revert") or {}
    if revert.get("pr_number") == pr_number and revert.get("head_sha") == head_sha:
        return freeze
    raise GovernanceError(
        f"self_merge_frozen:{freeze.get('freeze_id')}: ARIA merge "
        f"{freeze.get('merge_sha')} is being reverted; only its registered revert "
        "may merge until an operator unfreezes"
    )


def unfreeze_self_merge(
    *,
    freeze_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Lift a freeze on an operator's GitHub act, and nothing else."""
    freeze = active_freeze(base_dir=base_dir)
    if freeze is None or freeze.get("freeze_id") != freeze_id:
        raise GovernanceError(f"self_merge_unfreeze_unknown_or_inactive:{freeze_id}")
    try:
        approval = verify_operator_approval(
            operator_approval_ref,
            surface="self_merge_unfreeze",
            scope={"freeze_id": freeze_id},
            base_dir=base_dir,
        )
    except OperatorApprovalUnrecorded as exc:
        raise GovernanceError(f"self_merge_unfreeze_approval_unrecorded:{exc}") from exc
    row = append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": UNFROZEN_EVENT,
            "freeze_id": freeze_id,
            "merge_sha": freeze.get("merge_sha"),
            "operator_approval_ref": operator_approval_ref,
            "approval": approval,
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
        bypass_profile_gate=True,
    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        UNFROZEN_EVENT,
        {"freeze_id": freeze_id, "operator_approval_ref": operator_approval_ref},
        bypass_profile_gate=True,
    )
    return row


__all__ = [
    "FREEZE_NOTICE_LABELS",
    "FREEZE_NOTICE_TITLE_PREFIX",
    "FROZEN_EVENT",
    "FreezeNoticeWriter",
    "NOTICE_EVENT",
    "REVERT_REGISTERED_EVENT",
    "SELF_MERGE_FREEZE_SURFACE",
    "UNFROZEN_EVENT",
    "active_freeze",
    "assert_self_merge_not_frozen",
    "close_freeze_notice",
    "freeze_id_for",
    "freeze_in_force",
    "freeze_ledger_path",
    "freeze_notice_title",
    "freeze_self_merge",
    "list_freezes",
    "open_freeze_notices",
    "publish_freeze_notice",
    "register_revert",
    "unfreeze_command",
    "unfreeze_self_merge",
]
