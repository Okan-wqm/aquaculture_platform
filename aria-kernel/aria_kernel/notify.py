"""Plan 032 Faz 032e — notifications with a dedup outbox.

WHY: `observability/alerts.jsonl` had no reader; a cycle failed, a breaker
tripped, a request went HUMAN_REQUIRED and nobody was told until the next
manual look. WHAT: a closed event vocabulary, channels configured by env
NAMES only (values never touch a ledger), a dedup window per signature
and channel, and `notifications/outbox.jsonl` recording every attempt — sent, failed,
deduped, dry-run or unconfigured — so silence is itself auditable.
"""
from __future__ import annotations

import json
import os
import re
import smtplib
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable, Mapping

from .ledger import STATE_LOCK_LIVENESS_SECONDS, load_declared_jsonl, state_transaction
from .tool_registry import ensure_tools_dir, utc_now
from .digest import sha256_fingerprint

OUTBOX_SURFACE = "notifications_outbox"
OUTBOX_RELPATH: tuple[str, ...] = ("notifications", "outbox.jsonl")
NOTIFY_EVENT_KINDS: tuple[str, ...] = (
    "cycle_failed", "breaker_tripped", "human_required_opened", "human_required_sla_breached",
    "pr_opened", "pr_red", "pr_merged", "daily_report", "delivery_slo_gap", "doctor_unhealthy",
    "operator_cancelled", "gateway_rejected", "test",
    # ARIA-HIGH-579 — a night held in place because every provider is out (`provider_hold`).
    "cycle_held",
    # ARIA-HIGH-579 (review) — the night's hold question could not even be asked: a ledger
    # it reads was unreadable, the night failed open, and the failure names itself.
    "hold_indeterminate",
)
NOTIFY_CHANNELS: tuple[str, ...] = ("stdout", "github_issue", "email", "telegram")
NOTIFY_STATUSES: tuple[str, ...] = ("sent", "failed", "deduped", "dry_run", "unconfigured")
# Env NAMES each channel needs. Presence configures the channel; values are read at send time only.
CHANNEL_ENV_NAMES: dict[str, tuple[str, ...]] = {
    "stdout": (),
    "github_issue": ("ARIA_NOTIFY_GITHUB_REPO",),
    "email": ("ARIA_SMTP_HOST", "ARIA_NOTIFY_EMAIL_FROM", "ARIA_NOTIFY_EMAIL_TO"),
    "telegram": ("ARIA_TELEGRAM_BOT_TOKEN", "ARIA_TELEGRAM_CHAT_ID"),
}
CHANNEL_SELECTOR_ENV = "ARIA_NOTIFY_CHANNELS"
# ARIA-HIGH-415 — the operator's explicit "nobody": `ARIA_NOTIFY_CHANNELS=none`.
# It is not a channel and never enters NOTIFY_CHANNELS, whose LENGTH prices
# NOTIFY_WORST_CASE_SECONDS and through it the executor's 2280 s record wait.
# It is a statement the doctor can tell apart from a configuration nobody
# wrote (an empty selector with no channel env, which in CI is a fault).
CHANNELS_DISABLED_SENTINEL = "none"
DEFAULT_DEDUP_WINDOW = timedelta(hours=6)
# The label every notice issue carries; the issue writer creates it when the
# repository lacks it (`gh issue create` refuses an unknown label).
NOTIFY_ISSUE_LABELS: tuple[str, ...] = ("aria",)
# ARIA-MEDIUM-556 — a GitHub issue is a public page. A tripped cost breaker
# posted its dollar amounts there and a CRITICAL HUMAN_REQUIRED record its
# free-text reason, which can describe a weakness nobody has fixed yet. For
# the kinds below the notifier renders a public channel's body itself: the
# kind's fixed sentence and a pointer to the governed record (``record=``, a
# store-relative path). The producer's body reaches the private channels
# (stdout, email, telegram) only. A pointer kind without a valid pointer is a
# failed public row, never the producer's body.
PUBLIC_CHANNELS: frozenset[str] = frozenset({"github_issue"})
POINTER_ONLY_SUMMARIES: dict[str, str] = {
    "breaker_tripped": "A breaker tripped. ARIA holds the work it guards until an operator resets it.",
    "human_required_opened": "A request needs an operator decision.",
    "human_required_sla_breached": "A request that needs an operator decision is past its SLA.",
}
# A store-relative path: no leading slash, no whitespace, no parent step. A
# request id may hold ":" (operator_feedback_signature's id grammar).
_RECORD_POINTER = re.compile(r"(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")
PUBLIC_RECORD_INVALID = "notify_public_record_invalid"
Sender = Callable[[str, str, Mapping[str, str]], dict[str, Any]]

# One transport call's bound — the number each sender hands its transport.
# 30 s, so the GitHub sender's longest sequence still fits the 120 s wall
# clock below (it was 60 s while that sequence was two calls).
_GH_CALL_TIMEOUT_SECONDS = 30
_SMTP_SOCKET_TIMEOUT_SECONDS = 30
_HTTP_TIMEOUT_SECONDS = 30
# The wall clock ONE sender gets, whatever its transport. WHY a wall clock
# and not the transport bounds alone: a socket timeout (SMTP, HTTP) bounds
# one operation and a session is many, so the transport bounds do not add
# up to a bound on the sender. The sender runs on a worker joined for this
# long — the GitHub sender's longest sequence (issue list, label list, label
# create, issue create; a found issue is list + comment) at its per-call
# bound — and one that has not returned by then is recorded `failed` and the
# next channel runs. 4 x 30 s = 120 s: the same wall clock as before the
# issue writer took over, so NOTIFY_WORST_CASE_SECONDS (4 x 120 + 900 = 1380)
# and HUMAN_REQUIRED_RECORD_WAIT_SECONDS (900 + 1380 = 2280) do not move.
SENDER_WALL_CLOCK_SECONDS: float = float(4 * _GH_CALL_TIMEOUT_SECONDS)
# The longest one `notify()` can legitimately take: every channel the
# vocabulary knows at its sender's wall clock, then ONE state transaction
# for all of the call's outbox rows (`ledger.STATE_LOCK_LIVENESS_SECONDS`
# behind a live holder). Exported so a caller that runs a notifying kernel
# command as a child — the executor's `human-required record` — sizes its
# wall clock from this number instead of a guess (30 s, until 2026-09-12).
NOTIFY_WORST_CASE_SECONDS: float = (
    len(NOTIFY_CHANNELS) * SENDER_WALL_CLOCK_SECONDS + STATE_LOCK_LIVENESS_SECONDS
)


def signature_for(kind: str, key: str | None, title: str) -> str:
    return sha256_fingerprint(f"{kind}|{key or title}".encode("utf-8"), hex_chars=24)


def outbox_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*OUTBOX_RELPATH)


def read_outbox(base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = outbox_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=OUTBOX_SURFACE)


class ChannelSelectorInvalid(ValueError):
    """`none` combined with a channel: the selector says both "nobody" and "somebody"."""


def _selected_channels(env: Mapping[str, str]) -> list[str]:
    selected = [c.strip() for c in str(env.get(CHANNEL_SELECTOR_ENV) or "").split(",") if c.strip()]
    if CHANNELS_DISABLED_SENTINEL in selected and set(selected) != {CHANNELS_DISABLED_SENTINEL}:
        raise ChannelSelectorInvalid(
            f"notify_channel_selector_invalid:none_combined:{str(env.get(CHANNEL_SELECTOR_ENV))[:100]}"
        )
    return selected


def notifications_disabled(environ: Mapping[str, str] | None = None) -> bool:
    """True only when the operator selected `none`; raises ChannelSelectorInvalid on `none,<channel>`."""
    env = os.environ if environ is None else environ
    return set(_selected_channels(env)) == {CHANNELS_DISABLED_SENTINEL}


def configured_channels(environ: Mapping[str, str] | None = None) -> tuple[str, ...]:
    env = os.environ if environ is None else environ
    selected = _selected_channels(env)
    if set(selected) == {CHANNELS_DISABLED_SENTINEL}:
        return ()
    # `stdout` is never implied: a daemon's journal is not a person's inbox, and an
    # event that only reached stdout must show as `unconfigured` in the outbox.
    candidates = selected or [c for c in NOTIFY_CHANNELS if c != "stdout"]
    out: list[str] = []
    for channel in candidates:
        if channel not in NOTIFY_CHANNELS:
            continue
        if all(env.get(name) for name in CHANNEL_ENV_NAMES[channel]):
            out.append(channel)
    return tuple(out)


def channel_body(kind: str, channel: str, body: str, record: str | None) -> str | None:
    """The body ``channel`` is handed for one event; None when a public channel may not carry it.

    A private channel gets the producer's body. A public channel gets it too,
    except for a ``POINTER_ONLY_SUMMARIES`` kind, where it gets the kind's
    fixed sentence and ``record: <pointer>``, or nothing when the pointer is
    not a store-relative path.
    """
    if channel not in PUBLIC_CHANNELS or kind not in POINTER_ONLY_SUMMARIES:
        return body
    if not isinstance(record, str) or _RECORD_POINTER.fullmatch(record) is None:
        return None
    return f"{POINTER_ONLY_SUMMARIES[kind]}\nrecord: {record}"


def _send_stdout(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    print(f"[aria notify] {title}\n{body}")
    return {"transport": "stdout"}


def _send_github_issue(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    """One issue per TITLE: a comment on the open issue with this exact title, else a new one.

    ARIA-HIGH-415. The kernel's one issue writer (`GhCliIssueWriter`, also
    the self-merge freeze notice's) finds the issue through the issue LIST
    filtered by label. This sender used to search the issue index for a
    marker; the index lags a just-created issue, so a second notice seconds
    later opened a second issue. Identity is the exact title, which is why
    every producer's title is FIXED and what varies rides the body. The
    credential is this process's (`run_gh_write` refuses anything but an
    installation token); `environ` only says which repository.
    """
    from .github_adapters import GhCliIssueWriter
    from .github_writes import require_installation_credential

    # ARIA-CRITICAL-246 — the notice is a write: a credential that is not an
    # installation token is refused by name before any gh call, and the
    # dispatcher records the GitHubWriteRefused as this channel's failed row.
    require_installation_credential(os.environ)
    writer = GhCliIssueWriter(repo=environ["ARIA_NOTIFY_GITHUB_REPO"], timeout_seconds=_GH_CALL_TIMEOUT_SECONDS)
    outcome = writer.comment_or_create(title=title, body=body, labels=NOTIFY_ISSUE_LABELS)
    if outcome["outcome"] == "failed":
        raise RuntimeError(f"github issue {outcome['reason']}"[:300])
    return {"transport": "github_issue", "action": outcome["outcome"], "issue": outcome["number"],
            "ref": str(outcome.get("url") or "")[:200]}


def _send_email(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    message = EmailMessage()
    message["Subject"] = title
    message["From"] = environ["ARIA_NOTIFY_EMAIL_FROM"]
    message["To"] = environ["ARIA_NOTIFY_EMAIL_TO"]
    message.set_content(body)
    host = environ["ARIA_SMTP_HOST"]
    port = int(environ.get("ARIA_SMTP_PORT") or 587)
    with smtplib.SMTP(host, port, timeout=_SMTP_SOCKET_TIMEOUT_SECONDS) as smtp:
        smtp.ehlo()
        if port != 25:
            smtp.starttls()
        user, password = environ.get("ARIA_SMTP_USER"), environ.get("ARIA_SMTP_PASSWORD")
        if user and password:
            smtp.login(user, password)
        smtp.send_message(message)
    return {"transport": "email", "to": environ["ARIA_NOTIFY_EMAIL_TO"]}


def _send_telegram(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    token, chat = environ["ARIA_TELEGRAM_BOT_TOKEN"], environ["ARIA_TELEGRAM_CHAT_ID"]
    data = urllib.parse.urlencode({"chat_id": chat, "text": f"{title}\n{body}"[:4000]}).encode("utf-8")
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST")
    with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"telegram refused: {str(payload)[:200]}")
    return {"transport": "telegram", "message_id": (payload.get("result") or {}).get("message_id")}


class SenderWallClockExceeded(RuntimeError):
    """A sender did not return inside SENDER_WALL_CLOCK_SECONDS."""


def _send_bounded(sender: Sender, title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    """Run one sender under the wall clock; its result or its exception, or the timeout."""
    outcome: dict[str, Any] = {}
    failure: list[BaseException] = []

    def run() -> None:
        try:
            outcome.update(sender(title, body, environ))
        except BaseException as exc:  # noqa: BLE001 — handed back to the caller below
            failure.append(exc)

    # A daemon so a transport that never returns cannot hold the process
    # open past the caller's own exit; the row it would have produced is
    # written as `failed` by the caller right now.
    worker = threading.Thread(target=run, name="aria-notify-sender", daemon=True)
    worker.start()
    worker.join(SENDER_WALL_CLOCK_SECONDS)
    if worker.is_alive():
        raise SenderWallClockExceeded(
            f"sender exceeded SENDER_WALL_CLOCK_SECONDS={SENDER_WALL_CLOCK_SECONDS:g}"
        )
    if failure:
        raise failure[0]
    return outcome


SENDERS: dict[str, Sender] = {
    "stdout": _send_stdout,
    "github_issue": _send_github_issue,
    "email": _send_email,
    "telegram": _send_telegram,
}


def _recent_sent(
    rows: list[dict[str, Any]], signature: str, channel: str, *, now: datetime, window: timedelta,
) -> dict[str, Any] | None:
    """The newest `sent` row of ``signature`` on ``channel`` inside ``window``, else None.

    ARIA-MEDIUM-110 — the channel is part of the key. Matched on the
    signature alone, the first channel to send silenced every other one for
    the window: a two-channel operator got one delivery, and a channel whose
    send had failed was not retried while another had sent.
    """
    for row in reversed(rows):
        if row.get("signature") != signature or row.get("channel") != channel or row.get("status") != "sent":
            continue
        try:
            stamp = datetime.fromisoformat(str(row.get("recorded_at")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if now - stamp <= window:
            return row
        return None
    return None


def notify(
    *,
    kind: str,
    title: str,
    body: str,
    key: str | None = None,
    record: str | None = None,
    base_dir: str | Path | None = None,
    channels: tuple[str, ...] | list[str] | None = None,
    environ: Mapping[str, str] | None = None,
    dry_run: bool = False,
    senders: Mapping[str, Sender] | None = None,
    dedup_window: timedelta = DEFAULT_DEDUP_WINDOW,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Deliver one event to every configured channel; one outbox row per channel.

    ``record`` is the store-relative path of the governed record the event is
    about; a public channel names it instead of ``body`` for a pointer kind
    (``POINTER_ONLY_SUMMARIES``).
    """
    if kind not in NOTIFY_EVENT_KINDS:
        raise ValueError(f"unknown notify kind {kind!r}")
    env = os.environ if environ is None else environ
    # WHY the row stamp derives from `now`: the dedup window compares the injected clock
    # against recorded rows; a wall-clock stamp made a fixed-date test flip on the calendar.
    stamp = now or datetime.now(timezone.utc)
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*OUTBOX_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_declared_jsonl(path, expected_surface=OUTBOX_SURFACE) if path.exists() else []
    signature = signature_for(kind, key, title)
    # A malformed selector is this call's ONE failed row, by name: raised
    # out of here it would be swallowed by `notify_best_effort`, and silence
    # is what the outbox exists to make auditable.
    selector_error: str | None = None
    disabled = False
    try:
        targets = tuple(channels) if channels else configured_channels(env)
        disabled = not channels and notifications_disabled(env)
    except ChannelSelectorInvalid as exc:
        targets, selector_error = (), str(exc)
    if not targets:
        targets = ("unconfigured",)
    table = dict(SENDERS)
    if senders:
        table.update(senders)
    rows: list[dict[str, Any]] = []
    for channel in targets:
        row: dict[str, Any] = {
            "schema_version": 1, "recorded_at": stamp.replace(microsecond=0).isoformat(), "kind": kind, "signature": signature,
            "channel": channel, "title": title[:200], "status": "failed", "detail": {},
        }
        if channel == "unconfigured" and selector_error is not None:
            row.update({"status": "failed", "detail": {"error": selector_error}})
        elif channel == "unconfigured" and disabled:
            row.update({"status": "unconfigured", "detail": {"disabled_by": f"{CHANNEL_SELECTOR_ENV}={CHANNELS_DISABLED_SENTINEL}"}})
        elif channel == "unconfigured":
            row.update({"status": "unconfigured", "detail": {"hint": f"set {CHANNEL_SELECTOR_ENV} or a channel's env names"}})
        elif channel not in NOTIFY_CHANNELS:
            row.update({"status": "failed", "detail": {"error": f"unknown channel {channel}"}})
        elif not all(env.get(name) for name in CHANNEL_ENV_NAMES[channel]):
            row.update({"status": "unconfigured", "detail": {"missing_env_names": [n for n in CHANNEL_ENV_NAMES[channel] if not env.get(n)]}})
        elif (channel_text := channel_body(kind, channel, body, record)) is None:
            row.update({"status": "failed", "detail": {"error": PUBLIC_RECORD_INVALID}})
        elif _recent_sent([*existing, *rows], signature, channel, now=stamp, window=dedup_window) is not None:
            row.update({"status": "deduped", "detail": {"window_seconds": int(dedup_window.total_seconds())}})
        elif dry_run:
            row.update({"status": "dry_run", "detail": {}})
        else:
            try:
                row.update({"status": "sent", "detail": _send_bounded(table[channel], title, channel_text, env)})
            except Exception as exc:  # noqa: BLE001 — a channel failure is a row, never a crash
                row.update({"status": "failed", "detail": {"error_class": type(exc).__name__, "error": str(exc)[:300]}})
        rows.append(row)
    # ONE transaction for every row of this call, after every send: the
    # senders (network) never run under the state lock, and the call waits
    # for the lock once, not once per channel — the shape every kernel
    # state-writing command has (claim, release, submit), and the shape
    # NOTIFY_WORST_CASE_SECONDS prices.
    with state_transaction([path]) as transaction:
        for row in rows:
            transaction.append_declared_jsonl(path, row, expected_surface=OUTBOX_SURFACE)
    return rows


def notify_best_effort(**kwargs: Any) -> list[dict[str, Any]]:
    """Producers call this: a notification must never break the event it reports."""
    try:
        return notify(**kwargs)
    except Exception:  # noqa: BLE001
        return []


__all__ = [
    "CHANNELS_DISABLED_SENTINEL",
    "CHANNEL_ENV_NAMES",
    "CHANNEL_SELECTOR_ENV",
    "DEFAULT_DEDUP_WINDOW",
    "NOTIFY_CHANNELS",
    "NOTIFY_EVENT_KINDS",
    "NOTIFY_ISSUE_LABELS",
    "NOTIFY_STATUSES",
    "NOTIFY_WORST_CASE_SECONDS",
    "OUTBOX_RELPATH",
    "OUTBOX_SURFACE",
    "POINTER_ONLY_SUMMARIES",
    "PUBLIC_CHANNELS",
    "PUBLIC_RECORD_INVALID",
    "SENDERS",
    "SENDER_WALL_CLOCK_SECONDS",
    "ChannelSelectorInvalid",
    "SenderWallClockExceeded",
    "channel_body",
    "configured_channels",
    "notifications_disabled",
    "notify",
    "notify_best_effort",
    "outbox_path",
    "read_outbox",
    "signature_for",
]
