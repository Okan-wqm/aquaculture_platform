"""Plan 032 Faz 032c — a searchable DERIVED index over ARIA's ledgers.

WHY: "what did we decide about X, and why" was answerable only by grep over
JSONL. Hermes has FTS5 session search; ARIA's version indexes the ledgers
that carry decisions and their reasons — requests, results, the work
journal, missions, findings, governance — and stays subordinate to them.

WHAT: SQLite FTS5 at ``~/.aria/workspaces/<repo_hash>/index/search.sqlite``
— OUTSIDE the store, never published, rebuildable from the ledgers at any
time (``rebuild_index``). It is an index, not a truth source: a hit points
at a ledger row (surface + row hash) and the reader goes to the ledger. The
Faz 032i context compiler reads it to hand an agent "prior decisions on
these paths" without re-reading every ledger.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .ledger import load_declared_jsonl
from .tool_registry import ensure_tools_dir

INDEX_DIRNAME = "index"
INDEX_FILENAME = "search.sqlite"
SEARCH_KINDS: tuple[str, ...] = ("requests", "results", "journal", "missions", "findings", "governance", "decisions")
# (kind, relative path under the tools root, declared surface name, text fields)
_SOURCES: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("requests", "agent-invocations/requests.jsonl", "agent_invocation_requests", ("request_id", "role", "target_agent", "suggested_prompt", "convergence_id")),
    ("results", "agent-invocations/results.jsonl", "agent_invocation_results", ("request_id", "status", "decision", "summary")),
    ("journal", "agent-invocations/work-journal.jsonl", "agent_work_journal", ("request_id", "command_family", "argv_redacted", "files_touched")),
    ("missions", "missions/mission-events.jsonl", "mission_events", ("mission_id", "event", "reason_code", "source_kind", "source_id", "note")),
    ("governance", "governance.jsonl", "tools_governance", ("kind", "details")),
    ("decisions", "recovery/decisions.jsonl", "recovery_decisions", ("request_id", "decision", "reason")),
)


@dataclass(frozen=True)
class SearchHit:
    kind: str
    ref: str
    ledger_hash: str
    snippet: str
    rank: float


def index_path(workspace_root: str | Path) -> Path:
    from .workspace import workspace_paths

    return workspace_paths(Path(workspace_root).resolve()).workspace_root / INDEX_DIRNAME / INDEX_FILENAME


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS hits USING fts5(kind, ref, ledger_hash UNINDEXED, body, tokenize='porter unicode61')"
    )
    conn.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    return conn


def _text(row: dict[str, Any], fields: Iterable[str]) -> str:
    parts: list[str] = []
    for field in fields:
        value = row.get(field)
        if value is None:
            continue
        parts.append(value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False))
    return "\n".join(parts)


def rebuild_index(*, workspace_root: str | Path, base_dir: str | Path | None = None) -> dict[str, int]:
    """Drop and rebuild the whole index from the ledgers. Idempotent."""
    root = ensure_tools_dir(base_dir)
    path = index_path(workspace_root)
    counts: dict[str, int] = {}
    conn = _connect(path)
    try:
        conn.execute("DELETE FROM hits")
        for kind, rel, surface, fields in _SOURCES:
            ledger = root / rel
            if not ledger.exists():
                counts[kind] = 0
                continue
            rows = load_declared_jsonl(ledger, expected_surface=surface)
            n = 0
            for row in rows:
                ref = str(row.get("request_id") or row.get("mission_id") or row.get("event_id") or row.get("row_id") or "")
                body = _text(row, fields)
                if not body:
                    continue
                conn.execute("INSERT INTO hits(kind, ref, ledger_hash, body) VALUES (?,?,?,?)",
                             (kind, ref, str(row.get("ledger_hash") or ""), body))
                n += 1
            counts[kind] = n
        from .tool_registry import utc_now

        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('rebuilt_at', ?)", (utc_now(),))
        conn.commit()
    finally:
        conn.close()
    return counts


def search(query: str, *, workspace_root: str | Path, kinds: Iterable[str] | None = None, limit: int = 20) -> list[SearchHit]:
    path = index_path(workspace_root)
    if not path.exists():
        return []
    wanted = tuple(kinds) if kinds else SEARCH_KINDS
    for kind in wanted:
        if kind not in SEARCH_KINDS:
            raise ValueError(f"search_kind_unknown:{kind}")
    conn = _connect(path)
    try:
        placeholders = ",".join("?" for _ in wanted)
        cursor = conn.execute(
            f"SELECT kind, ref, ledger_hash, snippet(hits, 3, '[', ']', '…', 12), bm25(hits) FROM hits "
            f"WHERE hits MATCH ? AND kind IN ({placeholders}) ORDER BY bm25(hits) LIMIT ?",
            (query, *wanted, int(limit)),
        )
        return [SearchHit(kind, ref, ledger_hash, snippet, float(rank)) for kind, ref, ledger_hash, snippet, rank in cursor.fetchall()]
    except sqlite3.OperationalError as exc:
        raise ValueError(f"search_query_invalid:{exc}") from exc
    finally:
        conn.close()


__all__ = ["INDEX_FILENAME", "SEARCH_KINDS", "SearchHit", "index_path", "rebuild_index", "search"]
