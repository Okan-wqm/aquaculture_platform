"""Declared inbox ledger: every accepted event once, routed outcomes next to it."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import append_tools_governance, ensure_tools_dir, utc_now
from .normalize import NormalizedEvent, event_from_dict

INBOX_SURFACE = "gateway_inbox"
INBOX_RELPATH: tuple[str, ...] = ("gateway", "inbox.jsonl")
INBOX_EVENTS: tuple[str, ...] = ("accepted", "routed", "rejected")
GATEWAY_REJECTED_EVENT = "gateway_rejected"


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


def pending_events(base_dir: str | Path | None = None) -> list[NormalizedEvent]:
    rows = read_inbox(base_dir)
    routed = {r.get("delivery_id") for r in rows if r.get("event") == "routed"}
    return [event_from_dict(r) for r in rows if r.get("event") == "accepted" and r.get("delivery_id") not in routed]


def inbox_summary(base_dir: str | Path | None = None) -> dict[str, Any]:
    rows = read_inbox(base_dir)
    accepted = [r for r in rows if r.get("event") == "accepted"]
    routed = {r.get("delivery_id") for r in rows if r.get("event") == "routed"}
    by_kind: dict[str, int] = {}
    for r in accepted:
        by_kind[str(r.get("kind"))] = by_kind.get(str(r.get("kind")), 0) + 1
    return {
        "accepted": len(accepted), "routed": len(routed), "pending": len([r for r in accepted if r.get("delivery_id") not in routed]),
        "rejected": sum(1 for r in rows if r.get("event") == "rejected"), "by_kind": dict(sorted(by_kind.items())),
        "last_recorded_at": rows[-1].get("recorded_at") if rows else None,
    }


__all__ = ["GATEWAY_REJECTED_EVENT", "INBOX_EVENTS", "INBOX_RELPATH", "INBOX_SURFACE", "inbox_path", "inbox_summary",
           "mark_routed", "pending_events", "read_inbox", "record_event", "record_rejection", "seen_delivery"]
