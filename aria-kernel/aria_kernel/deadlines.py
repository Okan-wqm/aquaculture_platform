"""ARIA-MEDIUM-128 — every clock-bound rule the kernel enforces, read by one reader.

WHY: the kernel enforces several deadlines — a waiver's `expires_on` in any
of the three dated manifests (surface-reachability, control-reachability,
batch-containment; the gate that owns each refuses a lapsed one), a HUMAN_REQUIRED
record's `sla_deadline` (the operator's Plan-016 promise), a review-registry
finding's `deadline` (the daily state sweep plans a lapsed one to BLOCKED) —
and each fired at its own gate on its own day with no earlier word from
anything. Eight waivers lapsed on 2026-09-13 and every kernel lane on main
was red the next morning. A deadline the kernel will enforce is a deadline
the kernel announces first: this module is the ONE place that reads them,
and the doctor (`doctor._check_deadlines`), the daily report
(`reflection._render_deadlines_section`) and the self-improvement scan
(`self_improvement.scan_signals`, kind `deadline_due`) all read this.

WHAT A SOURCE IS. A `DeadlineSource` reads its rows from the AUTHORITATIVE
place — every dated waiver manifest in `surface_waivers.WAIVER_MANIFESTS`
through the gates' own reader (one source per manifest, built from that
registry so a manifest the kernel enforces cannot be one the organ forgets),
the HUMAN_REQUIRED records through the report's own lister, the registry
through its committed jsonl — never from a hand-kept list of dates. Each row mirrors the CLOCK of the gate that enforces it
(`due_at` is the first instant that gate calls it lapsed), so the organ and
the gate cannot disagree by a day: a waiver is honoured through its
`expires_on` day; a registry deadline lapses at the start of its day (the
sweep compares `new Date(deadline) < now`); an SLA lapses at its instant.

WHAT A LAPSE MEANS is the source's to say (`lapse_is_fault`). A lapsed
waiver leaves the kernel's own lanes red and a lapsed SLA is a broken
promise — nothing automated resolves either, so they are FAULTS. A lapsed
registry deadline is the daily sweep's to convert: `finding-state-sweep.yml`
plans BLOCKED into a sweep PR (`planSweep`), and the state lands only when
a CODEOWNER merges that PR — auto-commits to main are a tampering surface,
so the workflow never pushes; the open sweep PR of 2026-08-28 has carried
lapsed rows for weeks. The doctor names such a row as information rather
than illness because 132 registry deadlines had lapsed on the day this was
written and an organ that is red for a quarter is an organ nobody reads
(the always-burning class). The early warning is the same for all three:
named, with days left, `DEADLINE_WARNING_DAYS` ahead.

A source that cannot be read answers UNDECIDED by name (`<source>:<error>`),
never an empty list — HIGH-108 doctrine: an unreadable source is a finding,
not a clean bill.
"""
from __future__ import annotations

import functools
import json
import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from . import surface_waivers
from .surface_waivers import (
    BATCH_CONTAINMENT_MANIFEST,
    DORMANT_CONTROL_MANIFEST,
    UNWRITTEN_MANIFEST,
    WAIVER_MANIFESTS,
    WaiverManifest,
)

# How far ahead a deadline is announced. Seven days: the operator reads the
# doctor daily and the daily report once a day; a week is one re-dating
# conversation, not a scramble.
DEADLINE_WARNING_DAYS = 7

# Where the review registry keeps every finding; the daily sweep
# (`tools/gates/finding-registry.ts planSweep`) reads the same file.
REGISTRY_FINDINGS_RELPATH = ("docs", "reviews", "_registry", "findings.jsonl")
# The states the sweep can still act on: RESOLVED is done, BLOCKED is the
# state the sweep plans (a BLOCKED finding's deadline moves nothing).
REGISTRY_DEADLINE_STATES_EXCLUDED: frozenset[str] = frozenset({"RESOLVED", "BLOCKED"})

# The waiver kinds are the manifests' own: a source's kind IS the manifest's
# kind, so the organ, the report and the scan name a waiver the way the
# registry that enforces it does.
SURFACE_WAIVER = UNWRITTEN_MANIFEST.kind
CONTROL_WAIVER = DORMANT_CONTROL_MANIFEST.kind
BATCH_CONTAINMENT_WAIVER = BATCH_CONTAINMENT_MANIFEST.kind
HUMAN_REQUIRED_SLA = "human_required_sla"
REGISTRY_FINDING = "registry_finding"

_DAY = timedelta(days=1)


@dataclass(frozen=True)
class DeadlineRow:
    kind: str
    key: str
    due_at: datetime
    enforced_by: str
    consequence: str
    lapse_is_fault: bool

    def days_left(self, now: datetime) -> int:
        """Whole days until `due_at`; negative once lapsed (floor, so a
        deadline 36 h away reads 1 and one 12 h past reads -1)."""
        return math.floor((self.due_at - now) / _DAY)

    def lapsed(self, now: datetime) -> bool:
        return now >= self.due_at

    def to_dict(self, now: datetime) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "key": self.key,
            "due_at": self.due_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "days_left": self.days_left(now),
            "lapsed": self.lapsed(now),
            "enforced_by": self.enforced_by,
            "consequence": self.consequence,
            "lapse_is_fault": self.lapse_is_fault,
        }


@dataclass(frozen=True)
class DeadlineSource:
    kind: str
    read: Callable[[Path, Path], list[DeadlineRow]]
    # A committed surface lives in the checkout; a store-only reader does
    # not need one. With no checkout bound, a committed source is UNDECIDED
    # (`<kind>:checkout_unbound`), never quietly empty.
    needs_workspace: bool


def _start_of_day(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=timezone.utc)


def _parse_instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def read_waiver_deadlines(tools_dir: Path, workspace_root: Path, manifest: WaiverManifest) -> list[DeadlineRow]:
    """One manifest through the gates' reader and the gates' calendar: a
    waiver is honoured THROUGH `expires_on` (`surface_waivers.waiver_has_lapsed`
    is `expires_on < today`), so the row lapses at the start of the day after."""
    loaded = surface_waivers.load_waiver_manifest(workspace_root, manifest)
    return [
        DeadlineRow(
            kind=manifest.kind,
            key=key,
            due_at=_start_of_day(surface_waivers.waiver_expires_on(entry) + _DAY),
            enforced_by=manifest.enforced_by,
            consequence=f"{manifest.consequence} ({entry.get('finding_id')})",
            lapse_is_fault=True,
        )
        for key, entry in surface_waivers.iter_waivers(loaded, manifest)
    ]


def _waiver_source(manifest: WaiverManifest) -> DeadlineSource:
    """The source for one registered manifest. Its kind is the manifest's,
    so an unreadable manifest is undecided by its own name and the other
    manifests are still read."""
    return DeadlineSource(manifest.kind, functools.partial(read_waiver_deadlines, manifest=manifest), needs_workspace=True)


def read_human_required_deadlines(tools_dir: Path, workspace_root: Path) -> list[DeadlineRow]:
    """Open records through the report's own lister, so the doctor and the
    daily report's HUMAN_REQUIRED section count the same queue."""
    from .human_required import list_human_required

    rows: list[DeadlineRow] = []
    for record in list_human_required(base_dir=tools_dir, include_resolved=False):
        rows.append(DeadlineRow(
            kind=HUMAN_REQUIRED_SLA,
            key=str(record["request_id"]),
            due_at=_parse_instant(str(record["sla_deadline"])),
            enforced_by="human_required.SLA_WINDOWS (Plan 016 operator SLA; reflection escalation ladder)",
            consequence=f"the operator SLA is breached [{record.get('severity')}]",
            lapse_is_fault=True,
        ))
    return rows


def _registry_due_at(deadline: str) -> datetime:
    # The sweep's comparison is `new Date(deadline) < now`: a date-only value
    # is UTC midnight of that day, so the finding lapses as the day begins.
    if len(deadline) == 10:
        return _start_of_day(date.fromisoformat(deadline))
    return _parse_instant(deadline)


def read_registry_deadlines(tools_dir: Path, workspace_root: Path) -> list[DeadlineRow]:
    """Every finding the daily sweep would still act on, from the committed
    registry. An absent registry is not "no findings": this checkout is not
    the repository the kernel serves, and the reader raises."""
    path = workspace_root.joinpath(*REGISTRY_FINDINGS_RELPATH)
    rows: list[DeadlineRow] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        finding = json.loads(line)
        deadline = finding.get("deadline")
        if not deadline or str(finding.get("state")) in REGISTRY_DEADLINE_STATES_EXCLUDED:
            continue
        rows.append(DeadlineRow(
            kind=REGISTRY_FINDING,
            key=str(finding["id"]),
            due_at=_registry_due_at(str(deadline)),
            enforced_by="finding-state-sweep.yml → sweep PR (tools/gates/finding-registry.ts planSweep)",
            consequence=f"the daily sweep plans BLOCKED into a sweep PR that lands only when merged [{finding.get('severity')}, {finding.get('state')}]",
            lapse_is_fault=False,
        ))
    return rows


# THE registry of clock-bound rules. Adding a rule the kernel enforces means
# adding its reader here — the doctor, the report and the scan follow. A
# dated waiver manifest is added to `surface_waivers.WAIVER_MANIFESTS` and
# its source is built from that registry, never written here by hand: the
# control manifest was enforced for weeks with no row in this tuple.
DEADLINE_SOURCES: tuple[DeadlineSource, ...] = (
    *(_waiver_source(manifest) for manifest in WAIVER_MANIFESTS),
    DeadlineSource(HUMAN_REQUIRED_SLA, read_human_required_deadlines, needs_workspace=False),
    DeadlineSource(REGISTRY_FINDING, read_registry_deadlines, needs_workspace=True),
)


@dataclass(frozen=True)
class DeadlineReadout:
    rows: tuple[DeadlineRow, ...]
    undecided: tuple[str, ...]
    now: datetime
    warning_days: int

    @property
    def lapsed(self) -> tuple[DeadlineRow, ...]:
        return tuple(row for row in self.rows if row.lapsed(self.now))

    @property
    def lapsed_faults(self) -> tuple[DeadlineRow, ...]:
        return tuple(row for row in self.lapsed if row.lapse_is_fault)

    @property
    def due_soon(self) -> tuple[DeadlineRow, ...]:
        return tuple(
            row for row in self.rows
            if not row.lapsed(self.now) and row.days_left(self.now) <= self.warning_days
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "warning_days": self.warning_days,
            "sources": [source.kind for source in DEADLINE_SOURCES],
            "undecided": list(self.undecided),
            "lapsed": [row.to_dict(self.now) for row in self.lapsed],
            "due_soon": [row.to_dict(self.now) for row in self.due_soon],
            "tracked": len(self.rows),
        }


def read_deadlines(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path | None,
    now: datetime | None = None,
    warning_days: int = DEADLINE_WARNING_DAYS,
) -> DeadlineReadout:
    """Every source, each read to the end; a source that raises is named in
    `undecided` and the others are still read. Rows are ordered soonest
    first so every consumer names the most urgent deadline first."""
    tools = Path(tools_dir)
    workspace = Path(workspace_root) if workspace_root is not None else None
    moment = now or datetime.now(timezone.utc)
    rows: list[DeadlineRow] = []
    undecided: list[str] = []
    for source in DEADLINE_SOURCES:
        if source.needs_workspace and workspace is None:
            undecided.append(f"{source.kind}:checkout_unbound")
            continue
        try:
            rows.extend(source.read(tools, workspace or tools))
        except Exception as exc:  # noqa: BLE001 — the reader reports, it does not crash the doctor
            undecided.append(f"{source.kind}:{type(exc).__name__}")
    rows.sort(key=lambda row: (row.due_at, row.kind, row.key))
    return DeadlineReadout(rows=tuple(rows), undecided=tuple(undecided), now=moment, warning_days=warning_days)


def name_rows(rows: tuple[DeadlineRow, ...], now: datetime, *, limit: int = 6) -> str:
    """`key(+Nd)` / `key(-Nd)` for the first `limit` rows, `+N more` after —
    a doctor reason names what is due; the detail carries the whole list."""
    named = [f"{row.key}({row.days_left(now):+d}d)" for row in rows[:limit]]
    if len(rows) > limit:
        named.append(f"+{len(rows) - limit} more")
    return ",".join(named)


def render_deadlines_markdown(readout: DeadlineReadout) -> list[str]:
    """The daily report's `## Deadlines` section: undecided sources first
    (a report that cannot see a source says so before it counts), then
    every lapsed row, then every row inside the warning window."""
    lines = ["## Deadlines", "", f"- Warning window: {readout.warning_days} days", f"- Tracked: {len(readout.rows)}"]
    for name in readout.undecided:
        lines.append(f"- **UNDECIDED**: {name} — source unreadable, its deadlines are not counted")
    lapsed = readout.lapsed
    due_soon = readout.due_soon
    lines.append(f"- Lapsed: {len(lapsed)}")
    lines.append(f"- Due within window: {len(due_soon)}")
    lines.extend(
        f"- **LAPSED** {row.kind} {row.key} ({row.days_left(readout.now):+d}d, {row.to_dict(readout.now)['due_at']}) — {row.consequence}; enforced by {row.enforced_by}"
        for row in lapsed
    )
    lines.extend(
        f"- DUE {row.kind} {row.key} ({row.days_left(readout.now):+d}d, {row.to_dict(readout.now)['due_at']}) — {row.consequence}; enforced by {row.enforced_by}"
        for row in due_soon
    )
    lines.append("")
    return lines


def signal_priority(row: DeadlineRow, now: datetime) -> int:
    """Priority for the `deadline_due` self-improvement signal: 2 when lapsed
    or within two days, 3 otherwise — the order the scan and the CLI list
    the rows in. Never 1: the signal's remedy is ANNOUNCE
    (`self_improvement.SIGNAL_REMEDIES`), so the mission opener never mints
    it at any priority; the lapsed FAULTS reach the opener at priority 1
    through the `deadlines` organ's own `doctor_fail`."""
    return 2 if row.days_left(now) <= 2 else 3


__all__ = [
    "BATCH_CONTAINMENT_WAIVER",
    "CONTROL_WAIVER",
    "DEADLINE_SOURCES",
    "DEADLINE_WARNING_DAYS",
    "HUMAN_REQUIRED_SLA",
    "REGISTRY_DEADLINE_STATES_EXCLUDED",
    "REGISTRY_FINDINGS_RELPATH",
    "REGISTRY_FINDING",
    "SURFACE_WAIVER",
    "DeadlineReadout",
    "DeadlineRow",
    "DeadlineSource",
    "name_rows",
    "read_deadlines",
    "read_human_required_deadlines",
    "read_registry_deadlines",
    "read_waiver_deadlines",
    "render_deadlines_markdown",
    "signal_priority",
]
