"""The provider outage fact: one row when a provider goes away, one when it is back.

WHY (ARIA-HIGH-365/366, operator requirement 2026-10-07: "the subscription or
API key may run out and be bought again later; everything must continue from
where it left off and nothing may be lost"). Before this module the ledger
said a provider was unavailable only as a probe back-off
(``provider_quota_cooldown``: 900 s for a dead credential, the vendor's reset
for a quota). A back-off row says when to ASK again, not whether the provider
CAME back, so no timer could tell "three days without a provider" from
"three days of nobody doing the work": the 72 h plan-stall rule abandoned a
plan whose stall cause it had itself recorded as
``provider_quota_unavailable:anthropic`` (B1), and 37 of 43 requests that
aged out on 2026-08-21..25 had seen nothing but provider-class releases (B3).
An auth outage re-emitted a cooldown row and an ``::error::`` every 900 s
while a logged-out session (2026-09-18/19, 73 releases) emitted nothing.

WHAT. An outage is an interval per ``(provider, kind)``:

* ``provider_outage_opened`` — written by :func:`open_provider_outage` at the
  FIRST detection while no outage of that kind is open for the provider. The
  one writer of a detection is ``provider_cooldown.record_provider_cooldown``
  (every detection seam already cools the provider), so a seam cannot record
  a cooldown and forget the outage. It opens ONE HUMAN_REQUIRED item carrying
  the remedy, and nothing else while the outage stands.
* ``provider_restored`` — written by :func:`record_provider_restored` on
  POSITIVE evidence only: a spawn that ran to completion closes every kind; an
  admission that found the session logged in closes ``logged_out`` (the one
  kind an admission can see), or the operator resolving the outage's item
  (``operator_attested``, review HIGH-2: a provider nothing spawns again must
  not hold a clock open forever). The cooldown's ``until`` is NOT a restore: a
  quota reset the vendor promised, or a back-off that ran out, says when to
  probe, and a nightly lane probes up to a day later. Counting that gap as
  "available" is how the clock would kill work again, so an outage stays open
  until something succeeds. The open item is resolved automatically then.

Readers fold the rows with :func:`outage_intervals`; ``provider_clock`` turns
the intervals into the provider-available clock the timers use.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .ledger import load_jsonl, state_transaction
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, tools_dir

OUTAGE_OPENED_KIND = "provider_outage_opened"
PROVIDER_RESTORED_KIND = "provider_restored"
OUTAGE_SIGNAL_FAILED_KIND = "provider_outage_signal_unavailable"
OUTAGE_PROLONGED_KIND = "provider_outage_prolonged"
OUTAGE_SCHEMA_VERSION = 1
# The closed outage vocabulary (``provider_cooldown.PROVIDER_EXHAUSTION_SIGNATURES``
# maps every detection signature onto one of these).
OUTAGE_KINDS: tuple[str, ...] = ("quota", "auth", "logged_out", "unreachable")
# Restores an admission may record: it observes the login, nothing else. An
# expired OAuth token still reads "logged in" to `claude auth status`
# (2026-08-04..08), so an admission closing `auth` would flap the item.
ADMISSION_RESTORABLE_KINDS: frozenset[str] = frozenset({"logged_out"})
# Bound on the clock (design item 2): an outage open this long is surfaced
# once more as its own HUMAN_REQUIRED item. Work is never killed by it; the
# operator decides whether the provider is coming back.
OUTAGE_ESCALATION_AFTER = timedelta(days=30)
# A transient 429/network loss heals without an operator; the item exists so
# the interval is visible, at a severity that does not page like a dead key.
_SIGNAL_SEVERITY: dict[str, str] = {"quota": "HIGH", "auth": "HIGH", "logged_out": "HIGH",
                                    "unreachable": "MEDIUM"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def outage_remedy(provider: str, kind: str) -> str:
    """The human act that ends this outage, in the item itself (not a runbook)."""
    from .model_fleet import _FLEET

    row = next((member for member in _FLEET if member.key == provider), None)
    key_env = row.credential_file_env if row is not None else None
    if kind == "quota":
        return (f"renew the {provider} subscription or credit, or wait for its quota reset; "
                "ARIA resumes on its own at the next successful spawn")
    if kind in ("auth", "logged_out") and key_env:
        return f"replace the {provider} key file at {os.environ.get(key_env) or '$' + key_env}"
    if kind in ("auth", "logged_out"):
        return (f"re-login the {provider} runtime on the runner host as the runner user "
                "(`claude` then /login for anthropic, `codex login` for openai)")
    return (f"check the runner host's network and the {provider} status page; "
            "ARIA resumes on its own at the next successful spawn")


@dataclass(frozen=True)
class OutageInterval:
    provider: str
    kind: str
    opened_at: datetime
    closed_at: datetime | None
    signal_id: str


def _governance(base_dir: str | Path | None) -> Path:
    return tools_dir(base_dir) / "governance.jsonl"


def _fold(rows: Iterable[dict[str, Any]]) -> list[OutageInterval]:
    """Every outage interval in ledger order; an open one has ``closed_at`` None."""
    intervals: list[OutageInterval] = []
    open_at: dict[tuple[str, str], int] = {}
    for row in rows:
        kind, details = row.get("kind"), row.get("details")
        if kind not in (OUTAGE_OPENED_KIND, PROVIDER_RESTORED_KIND) or not isinstance(details, dict):
            continue
        if details.get("schema_version") != OUTAGE_SCHEMA_VERSION:
            raise GovernanceError(f"provider_outage_row_malformed:schema_version:{kind}")
        provider = details.get("provider")
        if kind == OUTAGE_OPENED_KIND:
            opened = _parse(details.get("opened_at"))
            if not isinstance(provider, str) or details.get("outage_kind") not in OUTAGE_KINDS or opened is None:
                raise GovernanceError(f"provider_outage_row_malformed:{kind}:{provider!r}")
            key = (provider, details["outage_kind"])
            if key not in open_at:
                open_at[key] = len(intervals)
                intervals.append(OutageInterval(provider, key[1], opened, None, str(details.get("signal_id"))))
            continue
        restored = _parse(details.get("restored_at"))
        closed = details.get("closed_kinds")
        if not isinstance(provider, str) or restored is None or not isinstance(closed, list):
            raise GovernanceError(f"provider_outage_row_malformed:{kind}:{provider!r}")
        for outage_kind in closed:
            index = open_at.pop((provider, outage_kind), None)
            if index is not None:
                interval = intervals[index]
                intervals[index] = OutageInterval(interval.provider, interval.kind, interval.opened_at,
                                                  restored, interval.signal_id)
    return intervals


def outage_intervals(base_dir: str | Path | None) -> tuple[OutageInterval, ...]:
    """The store's outage intervals (read-only; an absent store has none)."""
    path = _governance(base_dir)
    return tuple(_fold(load_jsonl(path))) if path.is_file() else ()


def open_outages(base_dir: str | Path | None) -> tuple[OutageInterval, ...]:
    return tuple(interval for interval in outage_intervals(base_dir) if interval.closed_at is None)


def _signal_id(provider: str, kind: str, opened: datetime) -> str:
    return f"provider-unavailable-{provider}-{kind}-{opened.strftime('%Y%m%dT%H%M%SZ')}"


def open_provider_outage(
    base_dir: str | Path | None, *, provider: str, kind: str, detection: dict[str, Any],
    request_id: str, claim_id: str, now: datetime | None = None,
) -> dict[str, Any] | None:
    """Open the ``(provider, kind)`` outage; None when it is already open.

    The read and the append share one ledger transaction, so two executors
    detecting the same outage write one row. The HUMAN_REQUIRED item is
    opened after the row lands; a store that refuses the item (a frozen
    profile) is said on the ledger by name, never swallowed.
    """
    if kind not in OUTAGE_KINDS:
        raise GovernanceError(f"provider_outage_kind_unknown:{kind!r}")
    started = now or _utc_now()
    root = ensure_tools_dir(base_dir)
    governance = root / "governance.jsonl"
    with state_transaction([governance]) as transaction:
        rows = transaction.load_declared_jsonl(governance, expected_surface="tools_governance")
        if any(i.provider == provider and i.kind == kind and i.closed_at is None for i in _fold(rows)):
            return None
        signal_id = _signal_id(provider, kind, started)
        row = append_tools_governance(root, OUTAGE_OPENED_KIND, {
            "schema_version": OUTAGE_SCHEMA_VERSION, "provider": provider, "outage_kind": kind,
            "opened_at": _iso(started), "signal_id": signal_id, "request_id": request_id,
            "claim_id": claim_id, "detection": detection, "remedy": outage_remedy(provider, kind),
        }, transaction=transaction)
    _open_signal(root, provider=provider, kind=kind, signal_id=signal_id, opened=started,
                 detection=detection, request_id=request_id)
    return row


def _open_signal(root: Path, *, provider: str, kind: str, signal_id: str, opened: datetime,
                 detection: dict[str, Any], request_id: str) -> None:
    from .human_required import record_human_required

    try:
        record_human_required(
            request_id=signal_id, severity=_SIGNAL_SEVERITY[kind],
            reason=f"provider_unavailable:{provider}:{kind} — {outage_remedy(provider, kind)}",
            context={"kind": "provider_outage", "provider": provider, "outage_kind": kind,
                     "opened_at": _iso(opened), "first_request_id": request_id,
                     "signature": detection.get("signature")},
            base_dir=root, now=opened,
        )
    except GovernanceError as exc:
        append_tools_governance(root, OUTAGE_SIGNAL_FAILED_KIND, {
            "signal_id": signal_id, "provider": provider, "outage_kind": kind,
            "error_class": type(exc).__name__, "error_message": str(exc)[:500],
        }, bypass_profile_gate=True)


def record_provider_restored(
    base_dir: str | Path | None, *, provider: str, seam: str, request_id: str | None,
    kinds: frozenset[str] | None = None, now: datetime | None = None,
) -> dict[str, Any] | None:
    """Close the provider's open outages (``kinds`` None: every kind); None when none was open.

    Cheap on the success path: the ledger is read only when the file exists,
    and nothing is written unless an outage of the provider is open.
    """
    path = _governance(base_dir)
    if not path.is_file():
        return None
    moment = now or _utc_now()
    root = ensure_tools_dir(base_dir)
    with state_transaction([path]) as transaction:
        rows = transaction.load_declared_jsonl(path, expected_surface="tools_governance")
        closing = [i for i in _fold(rows) if i.provider == provider and i.closed_at is None
                   and (kinds is None or i.kind in kinds)]
        if not closing:
            return None
        row = append_tools_governance(root, PROVIDER_RESTORED_KIND, {
            "schema_version": OUTAGE_SCHEMA_VERSION, "provider": provider, "restored_at": _iso(moment),
            "closed_kinds": sorted(i.kind for i in closing), "seam": seam, "request_id": request_id,
            "outages": [{"outage_kind": i.kind, "opened_at": _iso(i.opened_at), "signal_id": i.signal_id,
                         "duration_seconds": int((moment - i.opened_at).total_seconds())} for i in closing],
        }, transaction=transaction)
    _resolve_signals(root, closing, moment)
    return row


def _resolve_signals(root: Path, closing: list[OutageInterval], moment: datetime) -> None:
    """Close each closed outage's items through the kernel's one resolver.

    ``write_kernel_disposition`` (ARIA-HIGH-360) is the only way the kernel
    closes a record, and it states the rule it applied: here, that the
    provider served again. A kernel record never proves a panel approval.
    """
    from .human_required import open_human_required_record, write_kernel_disposition

    for interval in closing:
        for signal in (interval.signal_id, _prolonged_id(interval)):
            record = open_human_required_record(signal, base_dir=root)
            if record is None:
                continue
            write_kernel_disposition(base_dir=root, now=moment, item={
                "request_id": signal, "severity": record.get("severity"), "reason": record.get("reason"),
                "context": record.get("context") or {}, "status": "resolved",
                "disposition": {"disposition": "provider_restored",
                                "reason": (f"{interval.provider} {interval.kind} outage "
                                           f"{_iso(interval.opened_at)} -> {_iso(moment)}")},
            })


def outage_opened_by_claim(base_dir: str | Path | None, *, provider: str, claim_id: str) -> bool:
    """True when THIS claim's detection opened the provider's newest outage.

    The executor says ``::error::`` only then: a re-probe that meets the same
    standing outage is quiet (ARIA-HIGH-366 — every 900 s before).
    """
    path = _governance(base_dir)
    rows = load_jsonl(path) if path.is_file() else []
    opened = [row["details"] for row in rows if row.get("kind") == OUTAGE_OPENED_KIND
              and isinstance(row.get("details"), dict) and row["details"].get("provider") == provider]
    return bool(opened) and opened[-1].get("claim_id") == claim_id


def _prolonged_id(interval: OutageInterval) -> str:
    return f"{interval.signal_id}-prolonged"


def escalate_prolonged_outages(base_dir: str | Path | None, *, now: datetime | None = None) -> list[str]:
    """Raise one HUMAN_REQUIRED item per outage open longer than ``OUTAGE_ESCALATION_AFTER``.

    The bound on the provider-available clock: an outage that never ends would
    keep every timer paused, so after 30 days the operator is asked again —
    by an item, never by a timer killing the work that waits.
    """
    from .human_required import record_human_required

    moment = now or _utc_now()
    raised: list[str] = []
    for interval in open_outages(base_dir):
        if moment - interval.opened_at <= OUTAGE_ESCALATION_AFTER:
            continue
        record_human_required(
            request_id=_prolonged_id(interval), severity="HIGH",
            reason=(f"provider_outage_prolonged:{interval.provider}:{interval.kind} open since "
                    f"{_iso(interval.opened_at)}; every waiting plan and request is paused, none is "
                    f"lost — {outage_remedy(interval.provider, interval.kind)}, or cancel the waiting work"),
            context={"kind": OUTAGE_PROLONGED_KIND, "provider": interval.provider,
                     "outage_kind": interval.kind, "opened_at": _iso(interval.opened_at)},
            base_dir=base_dir, now=moment,
        )
        raised.append(_prolonged_id(interval))
    return raised


def render_outage_section(base_dir: str | Path | None, *, now: datetime | None = None) -> list[str]:
    """The daily report's view of every outage of the last 7 days and every open one."""
    moment = now or _utc_now()
    window = moment - timedelta(days=7)
    shown = [i for i in outage_intervals(base_dir) if i.closed_at is None or i.closed_at >= window]
    lines = ["## Provider Outages", ""]
    for interval in shown:
        end = interval.closed_at or moment
        state = "OPEN" if interval.closed_at is None else f"restored {_iso(interval.closed_at)}"
        lines.append(f"- {interval.provider} {interval.kind}: {_iso(interval.opened_at)} -> {state} "
                     f"({(end - interval.opened_at).total_seconds() / 3600:.1f}h; timers paused)")
    return [*lines, *([] if shown else ["- (no provider outage in the last 7 days)"]), ""]


__all__ = [
    "ADMISSION_RESTORABLE_KINDS", "OUTAGE_ESCALATION_AFTER", "OUTAGE_KINDS", "OUTAGE_OPENED_KIND",
    "PROVIDER_RESTORED_KIND", "OutageInterval", "escalate_prolonged_outages", "open_outages",
    "open_provider_outage", "outage_intervals", "outage_opened_by_claim", "outage_remedy",
    "record_provider_restored", "render_outage_section",
]
