"""Plan 032 Faz 032e — notifications with a dedup outbox.

WHY: `observability/alerts.jsonl` had no reader; a cycle failed, a breaker
tripped, a request went HUMAN_REQUIRED and nobody was told until the next
manual look. WHAT: a closed event vocabulary, channels configured by env
NAMES only (values never touch a ledger), a per-signature dedup window,
and `notifications/outbox.jsonl` recording every attempt — sent, failed,
deduped, dry-run or unconfigured — so silence is itself auditable.
"""
from __future__ import annotations

import hashlib
import json
import os
import smtplib
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable, Mapping

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now

OUTBOX_SURFACE = "notifications_outbox"
OUTBOX_RELPATH: tuple[str, ...] = ("notifications", "outbox.jsonl")
NOTIFY_EVENT_KINDS: tuple[str, ...] = (
    "cycle_failed", "breaker_tripped", "human_required_opened", "human_required_sla_breached",
    "pr_opened", "pr_red", "pr_merged", "daily_report", "delivery_slo_gap", "doctor_unhealthy",
    "operator_cancelled", "gateway_rejected", "test",
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
DEFAULT_DEDUP_WINDOW = timedelta(hours=6)
ISSUE_MARKER_PREFIX = "[aria-notify:"
Sender = Callable[[str, str, Mapping[str, str]], dict[str, Any]]


def signature_for(kind: str, key: str | None, title: str) -> str:
    return "sha256:" + hashlib.sha256(f"{kind}|{key or title}".encode("utf-8")).hexdigest()[:24]


def outbox_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*OUTBOX_RELPATH)


def read_outbox(base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = outbox_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=OUTBOX_SURFACE)


def configured_channels(environ: Mapping[str, str] | None = None) -> tuple[str, ...]:
    env = os.environ if environ is None else environ
    selected = [c.strip() for c in str(env.get(CHANNEL_SELECTOR_ENV) or "").split(",") if c.strip()]
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


def _send_stdout(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    print(f"[aria notify] {title}\n{body}")
    return {"transport": "stdout"}


def _issue_marker(title: str) -> str:
    return f"{ISSUE_MARKER_PREFIX}{hashlib.sha256(title.encode('utf-8')).hexdigest()[:10]}]"


def _send_github_issue(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    """Upsert: comment on the open issue carrying this title's marker, else create."""
    repo = environ["ARIA_NOTIFY_GITHUB_REPO"]
    marker = _issue_marker(title)
    env = {**os.environ, **{k: v for k, v in environ.items() if k in {"GH_TOKEN", "GITHUB_TOKEN"}}}
    listed = subprocess.run(
        ["gh", "issue", "list", "--repo", repo, "--state", "open", "--search", f'"{marker}" in:body',
         "--json", "number", "--limit", "1"],
        capture_output=True, text=True, timeout=60, check=False, env=env,
    )
    number: int | None = None
    if listed.returncode == 0:
        try:
            rows = json.loads(listed.stdout or "[]")
            number = int(rows[0]["number"]) if rows else None
        except (ValueError, KeyError, IndexError, TypeError):
            number = None
    text = f"{body}\n\n{marker}"
    if number is not None:
        done = subprocess.run(["gh", "issue", "comment", str(number), "--repo", repo, "--body", text],
                              capture_output=True, text=True, timeout=60, check=False, env=env)
        action = "commented"
    else:
        done = subprocess.run(["gh", "issue", "create", "--repo", repo, "--title", title, "--body", text, "--label", "aria"],
                              capture_output=True, text=True, timeout=60, check=False, env=env)
        action = "created"
    if done.returncode != 0:
        raise RuntimeError(f"gh issue {action} failed rc={done.returncode}: {(done.stderr or '')[:200]}")
    return {"transport": "github_issue", "action": action, "issue": number, "ref": (done.stdout or "").strip()[:200]}


def _send_email(title: str, body: str, environ: Mapping[str, str]) -> dict[str, Any]:
    message = EmailMessage()
    message["Subject"] = title
    message["From"] = environ["ARIA_NOTIFY_EMAIL_FROM"]
    message["To"] = environ["ARIA_NOTIFY_EMAIL_TO"]
    message.set_content(body)
    host = environ["ARIA_SMTP_HOST"]
    port = int(environ.get("ARIA_SMTP_PORT") or 587)
    with smtplib.SMTP(host, port, timeout=30) as smtp:
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
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"telegram refused: {str(payload)[:200]}")
    return {"transport": "telegram", "message_id": (payload.get("result") or {}).get("message_id")}


SENDERS: dict[str, Sender] = {
    "stdout": _send_stdout,
    "github_issue": _send_github_issue,
    "email": _send_email,
    "telegram": _send_telegram,
}


def _recent_sent(rows: list[dict[str, Any]], signature: str, *, now: datetime, window: timedelta) -> dict[str, Any] | None:
    for row in reversed(rows):
        if row.get("signature") != signature or row.get("status") != "sent":
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
    base_dir: str | Path | None = None,
    channels: tuple[str, ...] | list[str] | None = None,
    environ: Mapping[str, str] | None = None,
    dry_run: bool = False,
    senders: Mapping[str, Sender] | None = None,
    dedup_window: timedelta = DEFAULT_DEDUP_WINDOW,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Deliver one event to every configured channel; one outbox row per channel."""
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
    targets = tuple(channels) if channels else configured_channels(env)
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
        if channel == "unconfigured":
            row.update({"status": "unconfigured", "detail": {"hint": f"set {CHANNEL_SELECTOR_ENV} or a channel's env names"}})
        elif channel not in NOTIFY_CHANNELS:
            row.update({"status": "failed", "detail": {"error": f"unknown channel {channel}"}})
        elif not all(env.get(name) for name in CHANNEL_ENV_NAMES[channel]):
            row.update({"status": "unconfigured", "detail": {"missing_env_names": [n for n in CHANNEL_ENV_NAMES[channel] if not env.get(n)]}})
        elif _recent_sent([*existing, *rows], signature, now=stamp, window=dedup_window) is not None:
            row.update({"status": "deduped", "detail": {"window_seconds": int(dedup_window.total_seconds())}})
        elif dry_run:
            row.update({"status": "dry_run", "detail": {}})
        else:
            try:
                row.update({"status": "sent", "detail": table[channel](title, body, env)})
            except Exception as exc:  # noqa: BLE001 — a channel failure is a row, never a crash
                row.update({"status": "failed", "detail": {"error_class": type(exc).__name__, "error": str(exc)[:300]}})
        append_declared_jsonl(path, row, expected_surface=OUTBOX_SURFACE)
        rows.append(row)
    return rows


def notify_best_effort(**kwargs: Any) -> list[dict[str, Any]]:
    """Producers call this: a notification must never break the event it reports."""
    try:
        return notify(**kwargs)
    except Exception:  # noqa: BLE001
        return []


__all__ = [
    "CHANNEL_ENV_NAMES",
    "CHANNEL_SELECTOR_ENV",
    "DEFAULT_DEDUP_WINDOW",
    "NOTIFY_CHANNELS",
    "NOTIFY_EVENT_KINDS",
    "NOTIFY_STATUSES",
    "OUTBOX_RELPATH",
    "OUTBOX_SURFACE",
    "SENDERS",
    "configured_channels",
    "notify",
    "notify_best_effort",
    "outbox_path",
    "read_outbox",
    "signature_for",
]
