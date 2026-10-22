"""Plan 032 Faz 032e — operator control plane: pause, resume, cancel.

WHY: the only way to stop a running agent used to be the workflow's cancel
button or killing the daemon — both leave the claim CLAIMED until lease
expiry, the workspace half-edited and no ledger row saying a person did
it. Hermes stops a run by closing the terminal. ARIA records the command
FIRST, then the executor obeys it at the next seam (before claim, before
spawn, or mid-spawn via SIGTERM → SIGKILL on the process group), restores
the pre-spawn checkpoint and releases with the OPERATOR fault domain so
the request's requeue budget is untouched and its state is terminal.

WHAT: `control/commands.jsonl` is the declared, hash-chained command
ledger; :func:`effective_control` folds it into what is paused and what
is cancelled; the executor and the drain loop read that fold. Cancel is
sticky — a cancelled request never runs again; mint a new one.

ARIA-HIGH-238 — pausing and cancelling narrow authority, so a reason is
enough. Resuming lifts an operator's pause and lets ARIA act again, so it
is the authority-raising surface ``control_resume``: an operator's GitHub
act scoped to the pause it lifts (:func:`resume_scope`), consumed once.
The resume row records that pause and the fold lifts it only while it is
still the one standing, so a pause recorded while the act was being
verified stays in force.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .operator_approval import require_operator_act
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, tools_dir, utc_now

CONTROL_COMMANDS_SURFACE = "control_commands"
CONTROL_COMMANDS_RELPATH: tuple[str, ...] = ("control", "commands.jsonl")
CONTROL_VERBS: tuple[str, ...] = ("pause", "resume", "cancel")
CONTROL_SCOPES: tuple[str, ...] = ("all", "request")
CANCEL_OUTCOMES: tuple[str, ...] = ("before_claim", "before_spawn", "sigterm", "sigkill", "already_terminal", "noop")
OPERATOR_CANCELLED_RELEASE_REASON = "operator_cancelled"
CANCELLED_BY_OPERATOR_STATE = "CANCELLED_BY_OPERATOR"
CONTROL_RECORDED_EVENT = "operator_control_recorded"
CANCEL_APPLIED_EVENT = "operator_cancel_applied"
EXECUTOR_PAUSED_EVENT = "executor_paused_skip"
# Schema 2 (ARIA-HIGH-238): a command's id is unique by construction, not by
# the second it was recorded in, and a resume names the pause it lifts.
CONTROL_SCHEMA_VERSION = 2
# The scope target of an all-scope pause or resume (otherwise the request id).
ALL_TARGET = "all"


@dataclass(frozen=True)
class ControlState:
    paused_all: bool
    paused_requests: frozenset[str]
    cancelled: frozenset[str]
    commands: int

    def is_paused(self, request_id: str | None = None) -> bool:
        return self.paused_all or (request_id is not None and request_id in self.paused_requests)

    def is_cancelled(self, request_id: str) -> bool:
        return request_id in self.cancelled

    def to_dict(self) -> dict[str, Any]:
        return {
            "paused_all": self.paused_all,
            "paused_requests": sorted(self.paused_requests),
            "cancelled": sorted(self.cancelled),
            "commands": self.commands,
        }


def commands_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*CONTROL_COMMANDS_RELPATH)


def _rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    # ARIA-HIGH-153 — a fold is a read. `commands_path` goes through
    # `ensure_tools_dir`, which rewrites the tools index under a store
    # transaction; the per-request state derivation called this fold for
    # every request in the queue. A store that does not exist has no
    # commands; nothing is created to find that out.
    path = tools_dir(base_dir).joinpath(*CONTROL_COMMANDS_RELPATH)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=CONTROL_COMMANDS_SURFACE)


def _target(request_id: object) -> str:
    return str(request_id) if request_id else ALL_TARGET


def _latest_standing(standing: list[tuple[str, str]], target: str) -> str | None:
    """The id of the newest standing pause a resume of ``target`` lifts: any
    pause for ``all`` (an all-scope resume lifts every pause), else that
    request's."""
    for pause_id, pause_target in reversed(standing):
        if target == ALL_TARGET or pause_target == target:
            return pause_id
    return None


def _fold(rows: list[dict[str, Any]]) -> tuple[list[tuple[str, str]], frozenset[str]]:
    """The standing pauses as ``(command_id, target)``, oldest first, and the
    cancelled requests. A schema-2 resume lifts only while the pause it names
    is still the newest one standing for its target; a schema-1 row predates
    that binding and folds as it was recorded."""
    standing: list[tuple[str, str]] = []
    cancelled: set[str] = set()
    for row in rows:
        verb, rid = str(row.get("verb") or ""), row.get("request_id")
        target = _target(rid)
        if verb == "pause":
            standing.append((str(row.get("command_id") or ""), target))
        elif verb == "resume":
            bound = row.get("schema_version") != 1
            if bound and row.get("pause_id") != _latest_standing(standing, target):
                continue
            standing = [] if target == ALL_TARGET else [pause for pause in standing if pause[1] != target]
        elif verb == "cancel" and rid:
            cancelled.add(str(rid))
    return standing, frozenset(cancelled)


def resume_scope(request_id: str | None = None, *, base_dir: str | Path | None = None) -> dict[str, str]:
    """ARIA-HIGH-238 — the pause an operator act resuming ``request_id`` (or
    everything) binds to: the newest standing pause that resume would lift.
    An act minted for one pause cannot lift a later one, or a newer pause
    recorded on top of it. ``aria-kernel control resume --print-approval-line``
    prints the line for it."""
    target = _target(request_id)
    pause_id = _latest_standing(_fold(_rows(base_dir))[0], target)
    if pause_id is None:
        raise GovernanceError(f"control_resume_not_paused: nothing is paused for {target}")
    return {"target": target, "pause_id": pause_id}


def record_control(
    verb: str,
    *,
    base_dir: str | Path | None = None,
    request_id: str | None = None,
    operator_ref: str | None = None,
    reason: str = "",
) -> dict[str, Any]:
    """Append one operator command. `cancel` requires a request id; `pause`
    and `resume` take one optionally (scope `request`) or apply to `all`.

    `pause` and `cancel` narrow authority: ``operator_ref`` is provenance and
    a reason is enough. `resume` raises it (ARIA-HIGH-238): ``operator_ref``
    must be an operator's GitHub act approving ``surface=control_resume`` for
    the pause it lifts (:func:`resume_scope`); anything else is refused
    before a row is written, and nothing standing is refused as
    ``control_resume_not_paused``."""
    if verb not in CONTROL_VERBS:
        raise ValueError(f"unknown control verb {verb!r}; expected one of {CONTROL_VERBS}")
    if verb == "cancel" and not request_id:
        raise ValueError("cancel requires --request-id (cancel is per request; pause stops everything)")
    scope = "request" if request_id else "all"
    root = ensure_tools_dir(base_dir)
    row: dict[str, Any] = {
        "schema_version": CONTROL_SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "command_id": f"ctl-{secrets.token_hex(8)}",
        "verb": verb,
        "scope": scope,
        "request_id": request_id,
        "operator_ref": operator_ref,
        "reason": str(reason or "")[:500],
    }
    recorded: dict[str, Any] = {}
    if verb == "resume":
        resume = resume_scope(request_id, base_dir=root)
        # The audit row below is refused under a frozen profile (and the
        # command row with it); refusing first keeps the act unspent and the
        # pause in place.
        from .runtime_profile import enforce_profile_for_write

        enforce_profile_for_write("tool_governance", base_dir=root)
        approval = require_operator_act(operator_ref, surface="control_resume", scope=resume, base_dir=root)
        row["pause_id"] = resume["pause_id"]
        row["operator_approval"] = approval
        recorded = {"pause_id": resume["pause_id"], "operator_approval": approval}
    path = root.joinpath(*CONTROL_COMMANDS_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, row, expected_surface=CONTROL_COMMANDS_SURFACE)
    append_tools_governance(root, CONTROL_RECORDED_EVENT, {
        "command_id": row["command_id"], "verb": verb, "scope": scope,
        "request_id": request_id, "operator_ref": operator_ref, **recorded,
    })
    return row


def effective_control(base_dir: str | Path | None = None) -> ControlState:
    """Fold the command ledger. A resume lifts the pause it names (see
    :func:`_fold`); an all-scope resume lifts every pause; cancel is sticky."""
    rows = _rows(base_dir)
    standing, cancelled = _fold(rows)
    targets = {target for _, target in standing}
    return ControlState(
        paused_all=ALL_TARGET in targets,
        paused_requests=frozenset(targets - {ALL_TARGET}),
        cancelled=cancelled,
        commands=len(rows),
    )


def is_cancelled(request_id: str, base_dir: str | Path | None = None) -> bool:
    return effective_control(base_dir).is_cancelled(request_id)


def is_paused(request_id: str | None = None, base_dir: str | Path | None = None) -> bool:
    return effective_control(base_dir).is_paused(request_id)


def record_cancel_outcome(
    request_id: str,
    *,
    outcome: str,
    base_dir: str | Path | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    if outcome not in CANCEL_OUTCOMES:
        raise ValueError(f"unknown cancel outcome {outcome!r}")
    append_tools_governance(ensure_tools_dir(base_dir), CANCEL_APPLIED_EVENT, {
        "request_id": request_id, "outcome": outcome, **(detail or {}),
    })


def record_pause_skip(*, base_dir: str | Path | None, request_id: str | None, where: str) -> None:
    append_tools_governance(ensure_tools_dir(base_dir), EXECUTOR_PAUSED_EVENT, {"request_id": request_id, "where": where})


__all__ = [
    "ALL_TARGET",
    "CANCELLED_BY_OPERATOR_STATE",
    "CANCEL_APPLIED_EVENT",
    "CANCEL_OUTCOMES",
    "CONTROL_COMMANDS_RELPATH",
    "CONTROL_COMMANDS_SURFACE",
    "CONTROL_RECORDED_EVENT",
    "CONTROL_SCHEMA_VERSION",
    "CONTROL_SCOPES",
    "CONTROL_VERBS",
    "ControlState",
    "EXECUTOR_PAUSED_EVENT",
    "OPERATOR_CANCELLED_RELEASE_REASON",
    "commands_path",
    "effective_control",
    "is_cancelled",
    "is_paused",
    "record_cancel_outcome",
    "record_control",
    "record_pause_skip",
    "resume_scope",
]
