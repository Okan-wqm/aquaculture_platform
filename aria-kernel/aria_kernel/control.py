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
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

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
    path = commands_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=CONTROL_COMMANDS_SURFACE)


def record_control(
    verb: str,
    *,
    base_dir: str | Path | None = None,
    request_id: str | None = None,
    operator_ref: str | None = None,
    reason: str = "",
) -> dict[str, Any]:
    """Append one operator command. `cancel` requires a request id; `pause`
    and `resume` take one optionally (scope `request`) or apply to `all`."""
    if verb not in CONTROL_VERBS:
        raise ValueError(f"unknown control verb {verb!r}; expected one of {CONTROL_VERBS}")
    if verb == "cancel" and not request_id:
        raise ValueError("cancel requires --request-id (cancel is per request; pause stops everything)")
    scope = "request" if request_id else "all"
    root = ensure_tools_dir(base_dir)
    recorded_at = utc_now()
    digest = hashlib.sha256(f"{verb}|{scope}|{request_id or ''}|{recorded_at}".encode("utf-8")).hexdigest()[:16]
    row = {
        "schema_version": 1,
        "recorded_at": recorded_at,
        "command_id": f"ctl-{digest}",
        "verb": verb,
        "scope": scope,
        "request_id": request_id,
        "operator_ref": operator_ref,
        "reason": str(reason or "")[:500],
    }
    path = root.joinpath(*CONTROL_COMMANDS_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, row, expected_surface=CONTROL_COMMANDS_SURFACE)
    append_tools_governance(root, CONTROL_RECORDED_EVENT, {
        "command_id": row["command_id"], "verb": verb, "scope": scope,
        "request_id": request_id, "operator_ref": operator_ref,
    })
    return row


def effective_control(base_dir: str | Path | None = None) -> ControlState:
    """Fold the command ledger. Later rows win for pause/resume; cancel is sticky."""
    paused_all = False
    paused: set[str] = set()
    cancelled: set[str] = set()
    rows = _rows(base_dir)
    for row in rows:
        verb, rid = str(row.get("verb") or ""), row.get("request_id")
        if verb == "pause":
            if rid:
                paused.add(str(rid))
            else:
                paused_all = True
        elif verb == "resume":
            if rid:
                paused.discard(str(rid))
            else:
                paused_all = False
                paused.clear()
        elif verb == "cancel" and rid:
            cancelled.add(str(rid))
    return ControlState(paused_all=paused_all, paused_requests=frozenset(paused), cancelled=frozenset(cancelled), commands=len(rows))


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
    "CANCELLED_BY_OPERATOR_STATE",
    "CANCEL_APPLIED_EVENT",
    "CANCEL_OUTCOMES",
    "CONTROL_COMMANDS_RELPATH",
    "CONTROL_COMMANDS_SURFACE",
    "CONTROL_RECORDED_EVENT",
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
]
