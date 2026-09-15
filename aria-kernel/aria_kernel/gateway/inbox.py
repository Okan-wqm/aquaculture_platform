"""Declared inbox ledger: accepted deliveries, reserved mission attempts, and their outcomes."""
from __future__ import annotations

from pathlib import Path
from typing import Any
from dataclasses import asdict as _asdict, dataclass as _dataclass, fields as _fields
from datetime import datetime as _datetime, timedelta as _timedelta, timezone as _timezone

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import append_tools_governance, ensure_tools_dir, utc_now
from ..tool_registry import GovernanceError as _GovernanceError, parse_utc_stamp as _parse_utc_stamp
from .normalize import NormalizedEvent, event_from_dict

INBOX_SURFACE = "gateway_inbox"
INBOX_RELPATH: tuple[str, ...] = ("gateway", "inbox.jsonl")
INBOX_EVENTS: tuple[str, ...] = ("accepted", "routed", "rejected", "mission_route_attempt")
GATEWAY_REJECTED_EVENT = "gateway_rejected"

_MISSION_ROUTE_OWNER = "gateway.github_issue_mission.v1"
_MISSION_RETRY_DELAYS = (60, 120)
_MISSION_MAX_ATTEMPTS = 3
_MISSION_OUTCOME_STATUSES = frozenset({
    "succeeded", "reconciled", "retryable_error", "permanent_error", "exhausted", "reconciliation_required",
})
_MISSION_PENDING_STATUSES = frozenset({"retryable_error", "reconciliation_required"})


@_dataclass(frozen=True)
class _MissionRouteBinding:
    accepted_ledger_hash: str
    payload_digest: str
    event_kind: str
    source_kind: str
    source_id: str
    repo_hash: str
    mission_id: str
    schema_version: int = 1
    owner: str = _MISSION_ROUTE_OWNER


@_dataclass(frozen=True)
class _DeliveryState:
    accepted: dict[str, Any]
    attempts: tuple[dict[str, Any], ...] = ()
    binding: _MissionRouteBinding | None = None
    outcome: dict[str, Any] | None = None
    status: str | None = None
    invalid: bool = False

    @property
    def unresolved(self) -> bool:
        if self.invalid or self.outcome is None:
            return True
        return bool(self.attempts and self.status in _MISSION_PENDING_STATUSES)

    def due(self, now: _datetime) -> bool:
        if self.invalid or not self.unresolved:
            return False
        if not self.attempts:
            return True
        stamp = self.attempts[-1]["mission_route"]["next_attempt_not_before"]
        return stamp is None or now >= _parse_utc_stamp(stamp)


def _utc(now: _datetime | None = None) -> _datetime:
    stamp = now if now is not None else _datetime.now(_timezone.utc)
    return stamp.replace(tzinfo=_timezone.utc) if stamp.tzinfo is None else stamp.astimezone(_timezone.utc)


def _attempt_binding(row: dict[str, Any], accepted: dict[str, Any], number: int) -> _MissionRouteBinding:
    """Validate the owner descriptor; errors cannot reset a consumed attempt count."""
    from ..mission import mission_id_for

    descriptor = row["mission_route"]
    binding = _MissionRouteBinding(**{field.name: descriptor[field.name] for field in _fields(_MissionRouteBinding)})
    if (row.get("action") != "mission_open" or binding.owner != _MISSION_ROUTE_OWNER
            or type(binding.schema_version) is not int or binding.schema_version != 1
            or binding.accepted_ledger_hash != accepted["ledger_hash"]
            or binding.payload_digest != accepted["payload_digest"]
            or binding.event_kind != accepted["kind"]
            or binding.event_kind not in {"github.issue_opened", "github.issue_labeled"}
            or "aria" not in (accepted["subject"].get("labels") or [])
            or binding.source_kind != "github_issue"
            or binding.source_id != f"issue-{accepted['subject'].get('number')}"
            or binding.mission_id != mission_id_for(binding.source_kind, binding.source_id, binding.repo_hash)
            or type(descriptor["attempt"]) is not int or descriptor["attempt"] != number
            or not 1 <= number <= _MISSION_MAX_ATTEMPTS):
        raise ValueError("mission_route_binding_invalid")
    stamp = _parse_utc_stamp(descriptor["attempted_at"])
    if stamp is None:
        raise ValueError("mission_route_attempt_time_invalid")
    expected_due = (stamp + _timedelta(seconds=_MISSION_RETRY_DELAYS[number - 1])).isoformat() if number < _MISSION_MAX_ATTEMPTS else None
    if descriptor["next_attempt_not_before"] != expected_due:
        raise ValueError("mission_route_retry_time_invalid")
    return binding


def _fold_deliveries(rows: list[dict[str, Any]]) -> list[_DeliveryState]:
    """One projection for routing and status; only exact latest-attempt outcomes close work."""
    histories: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("event") in {"accepted", "routed", "mission_route_attempt"}:
            histories.setdefault(row["delivery_id"], []).append(row)
    states: list[_DeliveryState] = []
    for history in histories.values():
        accepted_rows = [row for row in history if row["event"] == "accepted"]
        if not accepted_rows:
            continue
        accepted = accepted_rows[0]
        attempts: list[dict[str, Any]] = []
        binding = None
        outcome = None
        status = None
        invalid = len(accepted_rows) != 1
        for row in history:
            if row["event"] == "mission_route_attempt":
                try:
                    candidate = _attempt_binding(row, accepted, len(attempts) + 1)
                    if binding is not None and candidate != binding:
                        raise ValueError("mission_route_binding_changed")
                    if outcome is not None and (not attempts or status not in _MISSION_PENDING_STATUSES):
                        raise ValueError("mission_route_already_terminal")
                    binding = candidate
                except (KeyError, TypeError, ValueError, _GovernanceError):
                    invalid = True
                attempts.append(row)
                outcome, status = None, None
            elif row["event"] == "routed":
                outcome = row
                if not attempts:
                    continue  # Historical outcomes, including errors, remain terminal.
                descriptor = row.get("refs", {}).get("mission_route")
                attempt = attempts[-1]
                if (not isinstance(descriptor, dict)
                        or descriptor.get("attempt_ledger_hash") != attempt.get("ledger_hash")
                        or any(descriptor.get(key) != value for key, value in attempt["mission_route"].items())
                        or descriptor.get("status") not in _MISSION_OUTCOME_STATUSES):
                    invalid = True
                else:
                    status = descriptor["status"]
        states.append(_DeliveryState(accepted, tuple(attempts), binding, outcome, status, invalid))
    return states


def _reserve_mission_attempt(
    *, state: _DeliveryState, binding: _MissionRouteBinding, now: _datetime, base_dir: Path,
) -> dict[str, Any]:
    """Called under the routing mutex; successful native append must precede every dispatch."""
    number = len(state.attempts) + 1
    if state.invalid or not state.due(now) or number > _MISSION_MAX_ATTEMPTS:
        raise _GovernanceError("mission_route_attempt_not_available")
    descriptor = {
        **_asdict(binding), "attempt": number, "attempted_at": now.isoformat(),
        "next_attempt_not_before": (now + _timedelta(seconds=_MISSION_RETRY_DELAYS[number - 1])).isoformat()
        if number < _MISSION_MAX_ATTEMPTS else None,
    }
    return _append(base_dir, {"event": "mission_route_attempt", "delivery_id": state.accepted["delivery_id"],
                              "action": "mission_open", "mission_route": descriptor})


def inbox_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*INBOX_RELPATH)


def read_inbox(base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = inbox_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=INBOX_SURFACE)


def _append(base_dir: str | Path | None, row: dict[str, Any]) -> dict[str, Any]:
    path = inbox_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=INBOX_SURFACE)


def seen_delivery(delivery_id: str, base_dir: str | Path | None = None) -> bool:
    return any(r.get("event") == "accepted" and r.get("delivery_id") == delivery_id for r in read_inbox(base_dir))


def record_event(event: NormalizedEvent, *, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    """Accept once per delivery id; a replay returns None and writes nothing."""
    if seen_delivery(event.delivery_id, base_dir):
        return None
    return _append(base_dir, {"event": "accepted", **event.to_dict()})


def record_rejection(*, base_dir: str | Path | None, source: str, reason: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    append_tools_governance(root, GATEWAY_REJECTED_EVENT, {"source": source, "reason": reason, **(detail or {})})
    return _append(root, {"event": "rejected", "source": source, "reason": reason, "detail": detail or {}})


def mark_routed(delivery_id: str, *, base_dir: str | Path | None, action: str, refs: dict[str, Any] | None = None, error: str | None = None) -> dict[str, Any]:
    return _append(base_dir, {"event": "routed", "delivery_id": delivery_id, "action": action, "refs": refs or {}, "error": error})


def pending_events(base_dir: str | Path | None = None, *, now: _datetime | None = None) -> list[NormalizedEvent]:
    stamp = _utc(now)
    return [event_from_dict(state.accepted) for state in _fold_deliveries(read_inbox(base_dir)) if state.due(stamp)]


def inbox_summary(base_dir: str | Path | None = None) -> dict[str, Any]:
    rows = read_inbox(base_dir)
    accepted = [r for r in rows if r.get("event") == "accepted"]
    routed = {r.get("delivery_id") for r in rows if r.get("event") == "routed"}
    by_kind: dict[str, int] = {}
    for r in accepted:
        by_kind[str(r.get("kind"))] = by_kind.get(str(r.get("kind")), 0) + 1
    return {
        "accepted": len(accepted), "routed": len(routed), "pending": sum(state.unresolved for state in _fold_deliveries(rows)),
        "rejected": sum(1 for r in rows if r.get("event") == "rejected"), "by_kind": dict(sorted(by_kind.items())),
        "last_recorded_at": rows[-1].get("recorded_at") if rows else None,
    }


__all__ = ["GATEWAY_REJECTED_EVENT", "INBOX_EVENTS", "INBOX_RELPATH", "INBOX_SURFACE", "inbox_path", "inbox_summary",
           "mark_routed", "pending_events", "read_inbox", "record_event", "record_rejection", "seen_delivery"]
