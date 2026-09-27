"""Every dated waiver manifest the kernel enforces, read by ONE reader.

WHAT: three kernel gates accept a waiver — an entry with an owner, a reason,
a finding id and an `expires_on` date — that lets a known gap stand until a
day the operator chose, and each refuses a waiver whose day has passed:

    surface-reachability.unwritten.json   vocabulary members nothing writes
    control-reachability.dormant.json     controls nothing calls
    batch-containment.waivers.json        learning hooks that commit inside
                                          an unguarded loop on purpose

`WAIVER_MANIFESTS` is the CLOSED registry of those manifests. Each is
described once (`WaiverManifest`: its kind, its path, its shape, the gate
that enforces it, what a lapse costs), read by one parser
(`load_waiver_manifest`), walked by one iterator (`iter_waivers`) and
judged by one lapse predicate (`waiver_has_lapsed`).

WHY THIS MODULE EXISTS (ARIA-MEDIUM-128): the reader and the clock
comparison used to live inside each test file, so the only thing that could
ever read a waiver's date was the gate itself — and a gate reads a date on
the day it fires. Eight surface waivers lapsed on 2026-09-13 and every
kernel lane went red the next morning with no earlier word from anything.
The first fix moved the SURFACE manifest's reader here and taught the
doctor's `deadlines` organ (`deadlines.py`) to announce a waiver seven days
ahead — and left the control and batch gates with a parser and a clock of
their own, so six control waivers dated 2026-09-20 would have turned the
lanes red on the 21st while the organ tracked only the surface manifest.
A gate that reads a dated manifest the registry does not know is exactly
that defect again, and it has two doors. Through the first the gate borrows
this module's reader with a `WaiverManifest` it made itself: every reader
here refuses a spec that is not in `WAIVER_MANIFESTS` (`LookupError`,
naming the registry), so that gate is red the first time it runs. Through
the second the gate keeps a parser and a clock of its own: nothing here
can see that, so `tests/test_deadlines.py` walks EVERY test module by AST
— not only the gates the registry names, which is how a fourth manifest
once passed every pin — and refuses a module that handles dated waivers
(`expires_on`, a `*.waivers.json`-family path, the shared field tuple)
with a `json.load(s)`, `fromisoformat`, `strptime` or `date.today` of its
own; it also refuses a dated manifest file under `aria-kernel/` that no
registered spec names, and pins every registered manifest as a deadline
source.

`load_waiver_manifest` treats an ABSENT file as an empty manifest, exactly
as every gate does (a checkout with no waivers is a checkout where every
gap must be closed). A file that exists and cannot be parsed, or that is
not an object of the declared shape, RAISES: the gate errors on it and the
organ reports the source undecided by name — never an empty manifest that
silently vouches for nothing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterator

# The four fields every waiver carries, whatever manifest it lives in. The
# gates check them by name; without a finding id nothing gets worked, which
# is how twenty-five TypeScript waivers once reached one shared expiry.
REQUIRED_WAIVER_FIELDS: tuple[str, ...] = ("owner", "reason", "expires_on", "finding_id")


class ManifestShape(str, Enum):
    """How a manifest nests its entries. NESTED keys a waiver by surface then
    member (`ACTIVE` is a genesis state and a tool status, and a flat file
    would let one waiver silence the other); FLAT keys it by one name."""

    NESTED = "nested"
    FLAT = "flat"


@dataclass(frozen=True)
class WaiverManifest:
    """One dated waiver manifest the kernel enforces.

    `kind` is the deadline kind the organ reports it under; `relpath` is
    resolved against whichever checkout the caller holds; `enforced_by`
    names the gate test that refuses a lapsed entry; `consequence` is what
    the organ says a lapse costs, one sentence, the entry's finding id
    appended by the reader.
    """

    kind: str
    relpath: tuple[str, ...]
    shape: ManifestShape
    enforced_by: str
    consequence: str


UNWRITTEN_MANIFEST = WaiverManifest(
    kind="surface_waiver",
    relpath=("aria-kernel", "surface-reachability.unwritten.json"),
    shape=ManifestShape.NESTED,
    enforced_by="tests/test_surface_reachability.py::test_a_waiver_expires_against_the_clock_not_against_a_regex",
    consequence="the surface-reachability gate refuses the lapsed waiver and every kernel test lane goes red on main",
)
DORMANT_CONTROL_MANIFEST = WaiverManifest(
    kind="control_waiver",
    relpath=("aria-kernel", "control-reachability.dormant.json"),
    shape=ManifestShape.FLAT,
    enforced_by="tests/test_control_reachability.py::test_a_waiver_expires_against_the_clock_not_against_a_regex",
    consequence="the control-reachability gate refuses the lapsed waiver and every kernel test lane goes red on main",
)
BATCH_CONTAINMENT_MANIFEST = WaiverManifest(
    kind="batch_containment_waiver",
    relpath=("aria-kernel", "batch-containment.waivers.json"),
    shape=ManifestShape.FLAT,
    enforced_by="tests/test_batch_containment_gate.py::test_the_declared_waivers_are_all_valid",
    consequence="the batch-containment gate refuses the lapsed waiver and every kernel test lane goes red on main",
)

# THE closed registry. A gate that reads a dated waiver manifest registers it
# here, and `deadlines.DEADLINE_SOURCES` is built from this tuple — so the
# doctor, the daily report and the self-improvement scan announce every
# waiver the kernel will refuse, seven days before it refuses it.
WAIVER_MANIFESTS: tuple[WaiverManifest, ...] = (
    UNWRITTEN_MANIFEST,
    DORMANT_CONTROL_MANIFEST,
    BATCH_CONTAINMENT_MANIFEST,
)

# Kept for the callers that resolve the surface manifest by path alone.
UNWRITTEN_MANIFEST_RELPATH = UNWRITTEN_MANIFEST.relpath

# What every reader below says to a spec the registry does not know. The
# tests that walk the gates by AST quote the same words, so a gate author
# reads one instruction whichever door they came through.
REGISTER_IN_WAIVER_MANIFESTS = "register it in surface_waivers.WAIVER_MANIFESTS"

# A manifest as loaded: NESTED is surface → member → entry, FLAT is
# name → entry; both are objects whose values are objects.
LoadedManifest = dict[str, dict[str, Any]]


def _require_registered(manifest: WaiverManifest) -> None:
    """Refuse a spec outside the closed registry. A gate that built its own
    `WaiverManifest` and handed it to the one reader would be a gate the
    `deadlines` organ never announces — the reader is where that is caught,
    the first time the gate runs, rather than the morning its waiver lapses.
    Equality is by value (frozen dataclass), so a spec that names a
    registered manifest field-for-field IS that manifest."""
    if manifest not in WAIVER_MANIFESTS:
        raise LookupError(
            f"{manifest.kind} ({'/'.join(manifest.relpath)}) is not a kernel waiver manifest the "
            f"deadlines organ knows — {REGISTER_IN_WAIVER_MANIFESTS}"
        )


def waiver_manifest_path(repo_root: str | Path, manifest: WaiverManifest = UNWRITTEN_MANIFEST) -> Path:
    _require_registered(manifest)
    return Path(repo_root).joinpath(*manifest.relpath)


def load_waiver_manifest(repo_root: str | Path, manifest: WaiverManifest = UNWRITTEN_MANIFEST) -> LoadedManifest:
    """THE parser. `{}` when the file is absent; the object when it is well
    formed for its declared shape.

    Raises `OSError` / `ValueError` (json) / `TypeError` (not an object of
    the declared shape) for a file that is present and unreadable — the
    callers decide what a manifest they cannot read means, and none of them
    treats it as empty. Raises `LookupError` for a spec outside
    `WAIVER_MANIFESTS` before touching the disk.
    """
    path = waiver_manifest_path(repo_root, manifest)
    if not path.exists():
        return {}
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise TypeError(f"{manifest.kind} manifest is not an object: {type(loaded).__name__}")
    for key, value in loaded.items():
        if manifest.shape is ManifestShape.NESTED:
            if not isinstance(value, dict) or not all(isinstance(entry, dict) for entry in value.values()):
                raise TypeError(f"{manifest.kind} manifest surface {key!r} is not member→entry")
        elif not isinstance(value, dict):
            raise TypeError(f"{manifest.kind} manifest entry {key!r} is not an object")
    return loaded


def iter_waivers(loaded: LoadedManifest, manifest: WaiverManifest = UNWRITTEN_MANIFEST) -> Iterator[tuple[str, dict[str, Any]]]:
    """`(key, entry)` in sorted order — the order every gate reports in. A
    NESTED key reads `surface.member`; a FLAT key is the name itself."""
    _require_registered(manifest)
    if manifest.shape is ManifestShape.NESTED:
        for surface_id, entries in sorted(loaded.items()):
            for member, entry in sorted(entries.items()):
                yield f"{surface_id}.{member}", entry
        return
    for name, entry in sorted(loaded.items()):
        yield name, entry


def waiver_expires_on(entry: dict[str, Any]) -> date:
    """The calendar day a waiver is valid THROUGH. Raises `ValueError` on a
    date no gate could compare either."""
    return date.fromisoformat(str(entry.get("expires_on", "")))


def utc_today(now: datetime | None = None) -> date:
    """The clock every gate and the organ compare a waiver against. UTC,
    because the lanes that fire the gates run in UTC and a waiver written
    for a day must not lapse an hour early on a host in another zone."""
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date()


def waiver_has_lapsed(entry: dict[str, Any], today: date) -> bool:
    """THE lapse predicate: a waiver has lapsed when `expires_on` is before
    today — it is honoured through its own day. Every gate and the organ
    call this, so none of them can disagree about a waiver by a day."""
    return waiver_expires_on(entry) < today


def lapsed_waivers(
    loaded: LoadedManifest,
    manifest: WaiverManifest = UNWRITTEN_MANIFEST,
    *,
    today: date | None = None,
) -> list[str]:
    """The gates' report lines, `key (expired <date>, <finding>)`, for every
    waiver `waiver_has_lapsed` refuses on `today` (UTC today by default)."""
    day = today or utc_today()
    return [
        f"{key} (expired {entry['expires_on']}, {entry.get('finding_id')})"
        for key, entry in iter_waivers(loaded, manifest)
        if waiver_has_lapsed(entry, day)
    ]


__all__ = [
    "BATCH_CONTAINMENT_MANIFEST",
    "DORMANT_CONTROL_MANIFEST",
    "LoadedManifest",
    "ManifestShape",
    "REGISTER_IN_WAIVER_MANIFESTS",
    "REQUIRED_WAIVER_FIELDS",
    "UNWRITTEN_MANIFEST",
    "UNWRITTEN_MANIFEST_RELPATH",
    "WAIVER_MANIFESTS",
    "WaiverManifest",
    "iter_waivers",
    "lapsed_waivers",
    "load_waiver_manifest",
    "utc_today",
    "waiver_expires_on",
    "waiver_has_lapsed",
    "waiver_manifest_path",
]
