"""ARIA-MEDIUM-127 — every decision ARIA is waiting on a person for, on one surface.

WHY. The decisions ARIA asks the operator for live in four owners, each
behind its own verb: HUMAN_REQUIRED records (``human_required``; the panel's
escalations to the operator among them, ``human_required_adjudication``),
dated waivers about to lapse or lapsed (``deadlines`` over
``surface_waivers``), and missions parked for a person
(``mission.OPERATOR_HELD_STATES``). Nothing listed them together, so the
operator, the one reader every one of them waits on, had to know every
ledger and every verb to find out what was waiting. On the live store 502
HUMAN_REQUIRED records were open on 2026-10-16.

WHAT. :func:`read_operator_inbox` reads each owner through its own reader and
returns one inbox: per section the count, the counts by kind and the most
urgent items, each with the one command that answers it. The inbox decides
nothing and writes nothing. Every answer goes through the owner's own verb,
which records it (a HUMAN_REQUIRED resolution and a mission transition are
ledger rows; a waiver is renewed or removed by a reviewed change to its
committed manifest). A source that cannot be read is named in ``undecided``,
never shown as an empty section (HIGH-108 doctrine, as ``deadlines``).

The CLI verb ``aria-kernel operator inbox`` and the MCP read tool
``operator_inbox`` serve the same payload.
"""
from __future__ import annotations

import shlex
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

INBOX_SCHEMA = "aria/operator-inbox/v1"
# Items shown per section; the counts always cover every item.
DEFAULT_ITEM_LIMIT = 25
HUMAN_REQUIRED_SECTION = "human_required"
WAIVER_SECTION = "waivers"
MISSION_SECTION = "missions"


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _human_required(tools: Path, workspace: Path | None, now: datetime, limit: int) -> dict[str, Any]:
    from .human_required import list_human_required
    from .human_required_adjudication import DISPOSITION_ESCALATE_OPERATOR

    records = list_human_required(base_dir=tools)
    now_text = _stamp(now)

    def kind_of(record: dict[str, Any]) -> str:
        context = record.get("context")
        kind = context.get("kind") if isinstance(context, dict) else None
        return str(kind) if kind else "unspecified"

    def escalated(record: dict[str, Any]) -> bool:
        return record.get("panel_disposition") == DISPOSITION_ESCALATE_OPERATOR

    # The panel's escalations first (a person is the only answer left), then
    # by SLA deadline, soonest first (the lister's own order).
    ordered = sorted(records, key=lambda record: (not escalated(record), str(record.get("sla_deadline") or "")))
    items = [{
        "request_id": record.get("request_id"),
        "severity": record.get("severity"),
        "context_kind": kind_of(record),
        "reason": record.get("reason"),
        "sla_deadline": record.get("sla_deadline"),
        "sla_lapsed": bool(record.get("sla_deadline")) and str(record["sla_deadline"]) <= now_text,
        "escalated_by_panel": escalated(record),
        "answer": (
            "aria-kernel human-required resolve --request-id "
            f"{shlex.quote(str(record.get('request_id')))} --resolution-note '<decision>'"
        ),
    } for record in ordered[:limit]]
    return {
        "open": len(records),
        "escalated_by_panel": sum(1 for record in records if escalated(record)),
        "sla_lapsed": sum(1 for record in records
                          if record.get("sla_deadline") and str(record["sla_deadline"]) <= now_text),
        "by_kind": dict(sorted(Counter(kind_of(record) for record in records).items())),
        "items": items,
    }


def _waivers(tools: Path, workspace: Path | None, now: datetime, limit: int) -> dict[str, Any]:
    from .deadlines import read_deadlines
    from .surface_waivers import WAIVER_MANIFESTS

    if workspace is None:
        raise LookupError("checkout_unbound")
    manifests = {manifest.kind: "/".join(manifest.relpath) for manifest in WAIVER_MANIFESTS}
    readout = read_deadlines(tools_dir=tools, workspace_root=workspace, now=now)
    unreadable = [name for name in readout.undecided if name.split(":", 1)[0] in manifests]
    if unreadable:
        raise LookupError(",".join(unreadable))
    rows = [row for row in (*readout.lapsed, *readout.due_soon) if row.kind in manifests]
    items = [{
        **row.to_dict(now),
        "manifest": manifests[row.kind],
        "answer": f"renew or remove {row.key} in {manifests[row.kind]} through a reviewed PR",
    } for row in rows[:limit]]
    return {
        "lapsed": sum(1 for row in rows if row.lapsed(now)),
        "due_soon": sum(1 for row in rows if not row.lapsed(now)),
        "warning_days": readout.warning_days,
        "by_kind": dict(sorted(Counter(row.kind for row in rows).items())),
        "items": items,
    }


def _missions(tools: Path, workspace: Path | None, now: datetime, limit: int) -> dict[str, Any]:
    from .mission import OPERATOR_HELD_STATES, list_open_missions

    held = [mission for mission in list_open_missions(base_dir=tools) if mission.get("state") in OPERATOR_HELD_STATES]
    items = [{
        "mission_id": mission.get("mission_id"),
        "state": mission.get("state"),
        "title": mission.get("title"),
        "next_action": mission.get("next_action"),
        "updated_at": mission.get("updated_at"),
        "answer": (
            f"aria-kernel mission transition --mission-id {shlex.quote(str(mission.get('mission_id')))} "
            "--to-state <state> --reason-code <code> --step-id <step> [--next-action ... --wake-file ...]"
        ),
    } for mission in held[:limit]]
    return {
        "held": len(held),
        "by_kind": dict(sorted(Counter(str(mission.get("state")) for mission in held).items())),
        "items": items,
    }


_SECTIONS: tuple[tuple[str, Callable[[Path, Path | None, datetime, int], dict[str, Any]]], ...] = (
    (HUMAN_REQUIRED_SECTION, _human_required),
    (WAIVER_SECTION, _waivers),
    (MISSION_SECTION, _missions),
)


def read_operator_inbox(
    *,
    tools_dir: str | Path | None,
    workspace_root: str | Path | None,
    now: datetime | None = None,
    limit: int = DEFAULT_ITEM_LIMIT,
) -> dict[str, Any]:
    """Every section read to the end; one that raises is named in ``undecided`` and left out.

    ``tools_dir`` resolves as every kernel reader resolves it
    (``tool_registry.tools_dir``); ``workspace_root`` is the checkout that
    holds the committed waiver manifests, None when there is none.
    """
    from .tool_registry import tools_dir as resolve_tools_dir

    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"operator_inbox_limit_invalid: {limit!r}")
    tools = resolve_tools_dir(tools_dir)
    workspace = Path(workspace_root) if workspace_root is not None else None
    moment = now or datetime.now(timezone.utc)
    sections: dict[str, Any] = {}
    undecided: list[str] = []
    for name, read in _SECTIONS:
        try:
            sections[name] = read(tools, workspace, moment, limit)
        except Exception as exc:  # noqa: BLE001 — an unreadable owner is named, the others are still read
            detail = str(exc) if isinstance(exc, LookupError) and str(exc) else type(exc).__name__
            undecided.append(f"{name}:{detail}")
    return {
        "schema": INBOX_SCHEMA,
        "generated_at": _stamp(moment),
        "sections": sections,
        "undecided": undecided,
    }


def render_operator_inbox(inbox: dict[str, Any]) -> str:
    """The inbox as the lines an operator reads at a terminal."""
    lines = [f"ARIA operator inbox — {inbox['generated_at']}"]
    for name in inbox["undecided"]:
        lines.append(f"UNDECIDED {name} — this source could not be read; its items are not listed")
    sections = inbox["sections"]
    if HUMAN_REQUIRED_SECTION in sections:
        section = sections[HUMAN_REQUIRED_SECTION]
        lines.append("")
        lines.append(f"HUMAN_REQUIRED: {section['open']} open, {section['escalated_by_panel']} escalated by the "
                     f"panel, {section['sla_lapsed']} past SLA; by kind {section['by_kind']}")
        lines.extend(f"  - {item['request_id']} [{item['severity']}, {item['context_kind']}, SLA "
                     f"{item['sla_deadline']}]: {item['reason']}\n    answer: {item['answer']}"
                     for item in section["items"])
    if WAIVER_SECTION in sections:
        section = sections[WAIVER_SECTION]
        lines.append("")
        lines.append(f"Waivers: {section['lapsed']} lapsed, {section['due_soon']} due within "
                     f"{section['warning_days']} days")
        lines.extend(f"  - {item['key']} [{item['kind']}, due {item['due_at']}, {item['days_left']:+d}d]: "
                     f"{item['consequence']}\n    answer: {item['answer']}" for item in section["items"])
    if MISSION_SECTION in sections:
        section = sections[MISSION_SECTION]
        lines.append("")
        lines.append(f"Missions held for the operator: {section['held']}")
        lines.extend(f"  - {item['mission_id']} [{item['state']}]: {item['title']} — next: {item['next_action']}"
                     f"\n    answer: {item['answer']}" for item in section["items"])
    return "\n".join(lines) + "\n"


__all__ = [
    "DEFAULT_ITEM_LIMIT",
    "HUMAN_REQUIRED_SECTION",
    "INBOX_SCHEMA",
    "MISSION_SECTION",
    "WAIVER_SECTION",
    "read_operator_inbox",
    "render_operator_inbox",
]
