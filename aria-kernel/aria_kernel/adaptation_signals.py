"""ARIA-HIGH-122 — the conditions the kernel already NAMES, read as classes it can plan against.

WHY: the kernel copes with a changed environment (failover, bounded retry,
requeue on a harness fault, kernel dispositions) and names what it refused —
a harness-class release reason on the claims ledger
(`native_runtime_provider_undecided`, `native_runtime_task_binding_unavailable`,
a CLI exit, a contract violation), a HUMAN_REQUIRED record of a named kind
(`anchor_stale`, `lease_lifecycle`, `tool_degradation`, …), a lapsed dated
waiver. None of those was a self-improvement source: `scan_signals` read
capability gaps, funnel stalls, delivery gaps, MCP quarantine, doctor organs
and deadlines only, so every change of environment waited for an operator
(the 2026-09-14 direction: "ARIA koşulların değişmesine de kendini adapte
edebilmeli").

WHAT: three readers, one CLASS per name, never one row per record. The live
store held 503 open HUMAN_REQUIRED records on 2026-10-18, 355 of one kind; a
row-per-record signal would have filled the opener's budget with one
condition every night (the ARIA-MEDIUM-128 starvation, again). A class
carries its count and a bounded list of the ids that evidence it.

This module READS. What a class becomes — a `propose_self_change` mission or
an announcement — is decided in `self_improvement` (an AUTHORITY SURFACE:
ARIA does not get to re-route its own refusals into its own authority).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from .surface_waivers import WAIVER_MANIFESTS

# The sources a class is named under; a class key is `<source>:<name>`.
HUMAN_REQUIRED_SOURCE = "human_required"
RELEASE_SOURCE = "release"
WAIVER_SOURCE = "waiver"
ADAPTATION_SOURCES: tuple[str, ...] = (HUMAN_REQUIRED_SOURCE, RELEASE_SOURCE, WAIVER_SOURCE)

# How many evidence ids a class carries. The count is whole; the ids are the
# first this many (most urgent / newest first), so the signal — and the
# governance row and CLI output it reaches — stays bounded however large the
# class grows.
ADAPTATION_EVIDENCE_IDS_MAX = 10

# A harness-class release is a condition when it RECURS. The executor's retry
# absorbs one stalled probe or one CLI exit after a back-off, and a mission id
# is a hash of its class (`mission.mission_id_for`): a class minted on its
# first blip spends the one mission it will ever get on a blip. Three
# releases of one class inside a week is a changed environment, not noise.
RELEASE_WINDOW_DAYS = 7
RELEASE_MIN_IN_WINDOW = 3
RELEASE_FAULT_DOMAIN = "harness"

# The one shape a class name may take. A name reaches a governance row, the
# CLI, and — for a self-change class — a mission title and an agent's
# prompt, so it is a token from a producer's closed vocabulary or it is
# `unclassified`; never a record's free-text reason.
_CLASS_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
UNCLASSIFIED = "unclassified"


@dataclass(frozen=True)
class AdaptationClass:
    """One named condition: where it was named, its name, how often, and the ids that evidence it."""

    source: str
    name: str
    count: int
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.source not in ADAPTATION_SOURCES:
            raise ValueError(f"adaptation_source_unknown:{self.source}")
        if not _CLASS_NAME.fullmatch(self.name):
            raise ValueError(f"adaptation_class_name_not_a_token:{self.name!r}")
        if len(self.evidence_ids) > ADAPTATION_EVIDENCE_IDS_MAX:
            raise ValueError(f"adaptation_evidence_unbounded:{len(self.evidence_ids)}")

    @property
    def key(self) -> str:
        return f"{self.source}:{self.name}"

    def to_dict(self) -> dict[str, Any]:
        return {"source": self.source, "class": self.name, "count": self.count, "evidence_ids": list(self.evidence_ids)}


def class_name(value: object) -> str:
    """`value` when it is a class token, else `unclassified`."""
    return value if isinstance(value, str) and _CLASS_NAME.fullmatch(value) else UNCLASSIFIED


def _bounded(ids: Iterable[str]) -> tuple[str, ...]:
    seen: list[str] = []
    for item in ids:
        if item and item not in seen:
            seen.append(item)
        if len(seen) == ADAPTATION_EVIDENCE_IDS_MAX:
            break
    return tuple(seen)


def _fold(source: str, named: Iterable[tuple[str, str]]) -> list[AdaptationClass]:
    """(class name, evidence id) pairs → one class per name, ordered by name."""
    grouped: dict[str, list[str]] = {}
    for name, evidence_id in named:
        grouped.setdefault(name, []).append(evidence_id)
    return [AdaptationClass(source, name, len(ids), _bounded(ids)) for name, ids in sorted(grouped.items())]


def human_required_class(record: dict[str, Any]) -> str:
    """The class of one HUMAN_REQUIRED record: its producer's context kind.

    Every producer that knows what it escalated writes `context.kind`
    (`anchor_stale`, `lease_lifecycle`, `tool_degradation`, …). A record
    without one is classed by its reason only when the reason IS a token
    (`self_change_adjudication`); a prose reason is `unclassified` — it is a
    sentence, and a sentence is not a class.
    """
    context = record.get("context") if isinstance(record.get("context"), dict) else {}
    kind = context.get("kind")
    if kind is not None:
        return class_name(kind)
    return class_name(record.get("reason"))


def human_required_classes(*, base_dir: str | Path) -> list[AdaptationClass]:
    """Every OPEN HUMAN_REQUIRED record, one class per kind; ids most urgent first
    (`list_human_required` orders by SLA deadline). The lister returns its
    listing (ARIA-LOW-597): `rows` are the readable records, and when any
    record file could not be read the reader raises
    `PartiallyUnreadableAdaptation` carrying the readable classes and the
    unreadable names, so no partly unreadable directory reads as a smaller
    decided queue."""
    from .human_required import list_human_required

    listing = list_human_required(base_dir=base_dir)
    classes = _fold(HUMAN_REQUIRED_SOURCE, ((human_required_class(record), str(record.get("request_id") or ""))
                                            for record in listing.rows))
    if listing.unreadable:
        raise PartiallyUnreadableAdaptation(
            classes, [f"{record.record_id}:unreadable" for record in listing.unreadable]
        )
    return classes


def _parse_instant(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def release_classes(*, base_dir: str | Path, now: datetime) -> list[AdaptationClass]:
    """Harness-class releases inside the window, one class per structured reason
    code, kept when it recurred `RELEASE_MIN_IN_WINDOW` times; ids are the
    released requests, newest first.

    Reads the `reason_code` / `fault_domain` the release row carries
    (`release_reason.parse_release_reason`, ledger-anchored) — never the
    legacy reason string. A request- or operator-class release says
    something about ONE request and is not an environment condition.
    """
    from .agent_invocations import _claims_path
    from .ledger import load_declared_jsonl

    path = _claims_path(Path(base_dir))
    if not path.exists():
        return []
    since = now - timedelta(days=RELEASE_WINDOW_DAYS)
    named: list[tuple[str, str, datetime]] = []
    for row in load_declared_jsonl(path, expected_surface="agent_invocation_claims"):
        if row.get("event") != "released" or row.get("fault_domain") != RELEASE_FAULT_DOMAIN:
            continue
        at = _parse_instant(row.get("released_at"))
        if at is None or at < since or at > now:
            continue
        named.append((class_name(row.get("reason_code")), str(row.get("request_id") or ""), at))
    named.sort(key=lambda item: item[2], reverse=True)
    return [cls for cls in _fold(RELEASE_SOURCE, ((name, request_id) for name, request_id, _at in named))
            if cls.count >= RELEASE_MIN_IN_WINDOW]


# The deadline kinds that are dated WAIVERS (`surface_waivers.WAIVER_MANIFESTS`,
# the closed registry): a lapsed one is answered by wiring the waived surface
# or re-dating the waiver with measured evidence, both under `aria-kernel/`.
WAIVER_KINDS: frozenset[str] = frozenset(manifest.kind for manifest in WAIVER_MANIFESTS)


def waiver_classes(readout: Any) -> list[AdaptationClass]:
    """Lapsed waivers, one class per manifest kind, from the deadline reader's
    own readout (`deadlines.read_deadlines`) — the one clock the doctor, the
    daily report and the scan already share. Ids are the waiver keys,
    longest-lapsed first (the readout orders rows soonest due first)."""
    return _fold(WAIVER_SOURCE, ((row.kind, row.key) for row in readout.lapsed if row.kind in WAIVER_KINDS))


def adaptation_reader_faults() -> tuple[type[BaseException], ...]:
    """The closed set a caller of these readers may report as an unreadable
    source (ARIA-LOW-587): the claims ledger is read through
    `load_declared_jsonl` and the HUMAN_REQUIRED directory through the file
    system, so the ledger primitives' own (`ledger.ledger_read_faults`),
    beside the partial-read fault (ARIA-LOW-597) a HUMAN_REQUIRED directory
    read raises when records beside the readable ones could not be read.
    Anything else is a defect and raises."""
    from .ledger import ledger_read_faults

    return (*ledger_read_faults(), PartiallyUnreadableAdaptation)


class PartiallyUnreadableAdaptation(LookupError):
    """A HUMAN_REQUIRED read that was only PARTLY readable (ARIA-LOW-597,
    the deadline reader's `PartiallyUnreadableSource` doctrine): the
    readable records' classes still count; the unreadable records are named
    beside them, never silently dropped and never allowed to erase the
    readable half."""

    def __init__(self, classes: list["AdaptationClass"], undecided: list[str]) -> None:
        super().__init__(",".join(undecided))
        self.classes = classes
        self.undecided = undecided


__all__ = [
    "ADAPTATION_EVIDENCE_IDS_MAX", "ADAPTATION_SOURCES", "AdaptationClass", "HUMAN_REQUIRED_SOURCE",
    "PartiallyUnreadableAdaptation",
    "RELEASE_FAULT_DOMAIN", "RELEASE_MIN_IN_WINDOW", "RELEASE_SOURCE", "RELEASE_WINDOW_DAYS", "UNCLASSIFIED",
    "WAIVER_KINDS", "WAIVER_SOURCE", "adaptation_reader_faults", "class_name", "human_required_class",
    "human_required_classes", "release_classes", "waiver_classes",
]
