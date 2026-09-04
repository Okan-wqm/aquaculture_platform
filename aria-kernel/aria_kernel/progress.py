"""Plan 032 Faz 032e — sanitized live progress per request (`tail`).

WHY: while an agent runs, the only signal is the workflow log — raw
stream-json, which carries prompt text, file contents and anything the
agent echoed, including secrets. The operator needs "what is it doing
right now" without a transcript dump.

WHAT: `run-artifacts/hot/<request_id>/progress.jsonl` — one sanitized row
per stream-json event: event type, tool NAMES with the work-journal's
redacted view of the call (command family, scrubbed argv, files), a
scrubbed 240-char text preview, and the terminal result's numbers (cost,
turns, duration). The full transcript stays where it is (sealed artifact);
this file is the glance, hash-chained like every other row.
"""
from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Mapping

from .hooks import sanitize_journal_entry
from .ledger import append_declared_jsonl, load_declared_jsonl
from .secret_scrub import scrub_text
from .tool_registry import ensure_tools_dir, utc_now

PROGRESS_SURFACE = "agent_progress"
PROGRESS_RELPATH: tuple[str, ...] = ("run-artifacts", "hot")
PROGRESS_FILENAME = "progress.jsonl"
TEXT_PREVIEW_CHARS = 240
PROGRESS_EVENT_TYPES: tuple[str, ...] = ("system", "assistant", "tool_result", "result", "other")
_RESULT_NUMERIC_KEYS = ("total_cost_usd", "duration_ms", "duration_api_ms", "num_turns")


def progress_path(request_id: str, base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*PROGRESS_RELPATH, request_id, PROGRESS_FILENAME)


def _preview(text: Any) -> tuple[str, list[str]]:
    scrubbed, kinds = scrub_text(str(text or "")[:TEXT_PREVIEW_CHARS * 2])
    return scrubbed[:TEXT_PREVIEW_CHARS], sorted(kinds)


def sanitize_stream_event(event: Mapping[str, Any]) -> dict[str, Any] | None:
    """The operator's view of one Claude stream-json event; None = nothing to show."""
    kind = str(event.get("type") or "")
    if kind == "system":
        return {
            "type": "system", "subtype": str(event.get("subtype") or ""),
            "model": event.get("model"), "session_id": event.get("session_id"),
        }
    if kind == "assistant":
        message = event.get("message") or {}
        content = message.get("content") if isinstance(message, Mapping) else None
        texts: list[str] = []
        redactions: set[str] = set()
        tool_uses: list[dict[str, Any]] = []
        for block in content or []:
            if not isinstance(block, Mapping):
                continue
            if block.get("type") == "text":
                preview, kinds = _preview(block.get("text"))
                texts.append(preview)
                redactions.update(kinds)
            elif block.get("type") == "tool_use":
                entry = sanitize_journal_entry({"tool_name": block.get("name"), "tool_input": block.get("input") or {}})
                tool_uses.append({
                    "tool_name": entry.get("tool_name"), "command_family": entry.get("command_family"),
                    "external_effect": entry.get("external_effect"),
                    "argv_redacted": entry.get("argv_redacted"), "files_touched": entry.get("files_touched"),
                })
        return {
            "type": "assistant",
            "text_preview": " ".join(texts)[:TEXT_PREVIEW_CHARS] if texts else "",
            "redaction_types": sorted(redactions),
            "tool_uses": tool_uses,
        }
    if kind == "user":
        message = event.get("message") or {}
        content = message.get("content") if isinstance(message, Mapping) else None
        results = [b for b in (content or []) if isinstance(b, Mapping) and b.get("type") == "tool_result"]
        if not results:
            return None
        size = 0
        errors = 0
        for block in results:
            payload = block.get("content")
            size += len(json.dumps(payload, default=str)) if payload is not None else 0
            errors += 1 if block.get("is_error") else 0
        return {"type": "tool_result", "count": len(results), "bytes": size, "errors": errors}
    if kind == "result":
        row: dict[str, Any] = {"type": "result", "subtype": str(event.get("subtype") or ""), "is_error": bool(event.get("is_error"))}
        for key in _RESULT_NUMERIC_KEYS:
            value = event.get(key)
            if isinstance(value, (int, float)):
                row[key] = value
        return row
    return {"type": "other", "raw_type": kind[:40]} if kind else None


class ProgressWriter:
    """Appends sanitized rows; never raises into the spawn it observes."""

    def __init__(self, request_id: str, *, base_dir: str | Path | None, claim_id: str | None = None) -> None:
        self.request_id = request_id
        self.claim_id = claim_id
        self.path = progress_path(request_id, base_dir)
        self.seq = 0
        self.failures = 0

    def write(self, event: Mapping[str, Any]) -> dict[str, Any] | None:
        try:
            row = sanitize_stream_event(event)
            if row is None:
                return None
            self.seq += 1
            full = {"schema_version": 1, "recorded_at": utc_now(), "request_id": self.request_id,
                    "claim_id": self.claim_id, "seq": self.seq, **row}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            append_declared_jsonl(self.path, full, expected_surface=PROGRESS_SURFACE)
            return full
        except Exception:  # noqa: BLE001 — progress is a glance, never a fault
            self.failures += 1
            return None


def read_progress(request_id: str, *, base_dir: str | Path | None = None, last: int | None = None) -> list[dict[str, Any]]:
    path = progress_path(request_id, base_dir)
    if not path.exists():
        return []
    rows = load_declared_jsonl(path, expected_surface=PROGRESS_SURFACE)
    return rows[-last:] if last else rows


def tail_progress(
    request_id: str,
    *,
    base_dir: str | Path | None = None,
    last: int = 20,
    follow: bool = False,
    interval_seconds: float = 2.0,
    max_wait_seconds: float | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield the last `last` rows, then (with follow) every new row as it lands."""
    seen = 0
    rows = read_progress(request_id, base_dir=base_dir)
    for row in rows[-last:] if last else rows:
        yield row
    seen = len(rows)
    if not follow:
        return
    started = time.monotonic()
    while True:
        rows = read_progress(request_id, base_dir=base_dir)
        for row in rows[seen:]:
            yield row
        seen = len(rows)
        if rows and rows[-1].get("type") == "result":
            return
        if max_wait_seconds is not None and time.monotonic() - started > max_wait_seconds:
            return
        time.sleep(interval_seconds)


def render_progress_row(row: Mapping[str, Any]) -> str:
    kind = str(row.get("type") or "")
    stamp = str(row.get("recorded_at") or "")[11:19]
    if kind == "assistant":
        tools = ", ".join(
            f"{t.get('tool_name')}[{t.get('command_family')}]" + (f" {' '.join(t.get('argv_redacted') or [])[:80]}" if t.get("argv_redacted") else "")
            + (f" {','.join(t.get('files_touched') or [])[:80]}" if t.get("files_touched") else "")
            for t in row.get("tool_uses") or []
        )
        return f"{stamp} #{row.get('seq')} assistant {row.get('text_preview') or ''}{(' → ' + tools) if tools else ''}"
    if kind == "tool_result":
        return f"{stamp} #{row.get('seq')} tool_result ×{row.get('count')} {row.get('bytes')}B errors={row.get('errors')}"
    if kind == "result":
        return (f"{stamp} #{row.get('seq')} result {row.get('subtype')} error={row.get('is_error')} "
                f"turns={row.get('num_turns')} cost=${row.get('total_cost_usd')} {row.get('duration_ms')}ms")
    return f"{stamp} #{row.get('seq')} {kind} {row.get('subtype') or row.get('raw_type') or ''}"


__all__ = [
    "PROGRESS_EVENT_TYPES",
    "PROGRESS_FILENAME",
    "PROGRESS_RELPATH",
    "PROGRESS_SURFACE",
    "ProgressWriter",
    "progress_path",
    "read_progress",
    "render_progress_row",
    "sanitize_stream_event",
    "tail_progress",
]
