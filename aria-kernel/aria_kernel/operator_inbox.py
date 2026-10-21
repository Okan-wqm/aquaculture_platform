"""ARIA-MEDIUM-127 — every decision ARIA is waiting on a person for, on one surface.

WHY. The decisions ARIA asks the operator for live in five owners, each
behind its own verb: HUMAN_REQUIRED records (``human_required``; the panel's
escalations to the operator among them, ``human_required_adjudication``),
dated waivers about to lapse or lapsed (``deadlines`` over
``surface_waivers``), missions parked for a person
(``mission.OPERATOR_HELD_STATES``), and — ARIA-MEDIUM-129 — the conventions
the night measured a lift for (``convention_usefulness``, carried by the
nightly ``fitness`` report): a convention the measurement calls harmful is
still served at the same confidence, and whether that should change is the
finding's recorded operator decision. Nothing listed them together, so the
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
never shown as an empty section (HIGH-108 doctrine, as ``deadlines``). The
convention-lift section adds no second measurement: it reads the lift the
nightly fitness report already measured (one measurement per night, stamped
with its cycle), so the inbox can only be as current as the last report.

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
CONVENTION_LIFT_SECTION = "convention_lift"
# ARIA-MEDIUM-129 — the one answer a measured lift waits on: whether it
# should couple to convention decay is the finding's recorded operator
# decision, and nothing in ARIA reads the number back today.
CONVENTION_LIFT_ANSWER = (
    "decide whether a measured lift should couple to convention decay "
    "(ARIA-MEDIUM-129's recorded residual); the lift is observational — "
    "nothing in ARIA reads it back"
)


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _human_required(tools: Path, workspace: Path | None, now: datetime, limit: int) -> dict[str, Any]:
    from .human_required import list_human_required
    from .human_required_adjudication import DISPOSITION_ESCALATE_OPERATOR

    listing = list_human_required(base_dir=tools)
    records = listing.rows
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
        # ARIA-LOW-597 — the records the lister could not read are named in
        # the section and lifted into the inbox's `undecided` roll-up by
        # `read_operator_inbox`; a corrupted record file must shrink nothing.
        "unreadable": [{"request_id": u.record_id, "reason": u.reason} for u in listing.unreadable],
        "undecided": [f"human_required:{u.record_id}:unreadable" for u in listing.unreadable],
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


def _convention_lift(tools: Path, workspace: Path | None, now: datetime, limit: int) -> dict[str, Any]:
    """ARIA-MEDIUM-129 — the night's convention lift, read from the fitness
    report that measured it (the owner's reader; the inbox never re-measures,
    so there is one measurement per night). Most harmful first: a convention
    the measurement calls harmful is still served at the same confidence."""
    from .fitness import list_fitness_reports

    reports = list_fitness_reports(base_dir=tools)
    if not reports:
        raise LookupError("no_fitness_report")
    latest = reports[-1]
    lift = latest.get("convention_lift")
    if not isinstance(lift, dict):
        # A report from a kernel older than the measurement: the source is
        # there, the measurement is not.
        raise LookupError("convention_lift_absent")
    rows = [row for row in lift.get("conventions") or [] if isinstance(row, dict)]
    measured = [row for row in rows if row.get("status") == "measured"]

    def lift_of(row: dict[str, Any]) -> float:
        value = row.get("lift")
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0

    ordered = sorted(measured, key=lambda row: (lift_of(row), str(row.get("pattern_id"))))
    items = [{
        "pattern_id": row.get("pattern_id"),
        "lift": row.get("lift"),
        "success_rate": row.get("success_rate"),
        "baseline_rate": row.get("baseline_rate"),
        "n": row.get("n"),
        "matched_n": row.get("matched_n"),
        "answer": CONVENTION_LIFT_ANSWER,
    } for row in ordered[:limit]]
    return {
        "status": str(lift.get("status")),
        "measured": len(measured),
        "harmful": sum(1 for row in measured if lift_of(row) < 0),
        "insufficient_samples": sum(1 for row in rows if row.get("status") == "undecided:insufficient_samples"),
        "convention_bearing_requests": lift.get("convention_bearing_requests"),
        "report": {"cycle_id": latest.get("cycle_id"), "recorded_at": latest.get("recorded_at")},
        "items": items,
    }


_SECTIONS: tuple[tuple[str, Callable[[Path, Path | None, datetime, int], dict[str, Any]]], ...] = (
    (HUMAN_REQUIRED_SECTION, _human_required),
    (WAIVER_SECTION, _waivers),
    (MISSION_SECTION, _missions),
    (CONVENTION_LIFT_SECTION, _convention_lift),
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
            section = read(tools, workspace, moment, limit)
        except Exception as exc:  # noqa: BLE001 — an unreadable owner is named, the others are still read
            detail = str(exc) if isinstance(exc, LookupError) and str(exc) else type(exc).__name__
            undecided.append(f"{name}:{detail}")
            continue
        sections[name] = section
        # A section that read PART of its surface names what it could not
        # (ARIA-LOW-597): its dict may carry `undecided` entries, which are
        # lifted into the inbox's roll-up beside the sections that raised.
        undecided.extend(f"{entry}" for entry in section.pop("undecided", []))
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
    if CONVENTION_LIFT_SECTION in sections:
        section = sections[CONVENTION_LIFT_SECTION]
        lines.append("")
        source = section["report"]["cycle_id"]
        if section["status"] == "measured":
            lines.append(f"Convention lift (does ARIA learn?): {section['measured']} conventions measured, "
                         f"{section['harmful']} with a negative lift; night {source}")
            lines.extend(f"  - {item['pattern_id']} [lift {item['lift']:+.2f} over a {item['baseline_rate']} "
                         f"baseline, n {item['n']}]: {item['answer']}" for item in section["items"])
        else:
            lines.append(f"Convention lift (does ARIA learn?): {section['status']} — no number to show; "
                         f"night {source}")
    return "\n".join(lines) + "\n"


__all__ = [
    "CONVENTION_LIFT_SECTION",
    "DEFAULT_ITEM_LIMIT",
    "HUMAN_REQUIRED_SECTION",
    "INBOX_SCHEMA",
    "MISSION_SECTION",
    "WAIVER_SECTION",
    "read_operator_inbox",
    "render_operator_inbox",
]
