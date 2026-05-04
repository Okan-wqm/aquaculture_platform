from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


GENESIS_HASH = "GENESIS"
HASH_FIELD = "ledger_hash"
PREV_HASH_FIELD = "ledger_prev_hash"


def append_jsonl(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    row = dict(payload)
    row[PREV_HASH_FIELD] = _last_hash(path)
    row[HASH_FIELD] = _row_hash(row)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
    return row


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = GENESIS_HASH
    with path.open("w", encoding="utf-8") as handle:
        for payload in rows:
            row = strip_ledger_fields(payload)
            row[PREV_HASH_FIELD] = previous
            row[HASH_FIELD] = _row_hash(row)
            previous = row[HASH_FIELD]
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def verify_jsonl(path: Path) -> dict[str, Any]:
    previous = GENESIS_HASH
    row_count = 0
    if not path.exists():
        return {"path": path.as_posix(), "valid": True, "row_count": 0}
    with path.open("r", encoding="utf-8") as handle:
        for row_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            row_count += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                return _invalid(path, row_number, f"invalid JSON: {exc}")
            if row.get(PREV_HASH_FIELD) != previous:
                return _invalid(path, row_number, "previous hash mismatch")
            if row.get(HASH_FIELD) != _row_hash(row):
                return _invalid(path, row_number, "row hash mismatch")
            previous = str(row[HASH_FIELD])
    return {"path": path.as_posix(), "valid": True, "row_count": row_count, "head_hash": previous}


def strip_ledger_fields(payload: dict[str, Any]) -> dict[str, Any]:
    row = dict(payload)
    row.pop(HASH_FIELD, None)
    row.pop(PREV_HASH_FIELD, None)
    return row


def _last_hash(path: Path) -> str:
    rows = load_jsonl(path)
    if not rows:
        return GENESIS_HASH
    last = rows[-1]
    if HASH_FIELD in last:
        return str(last[HASH_FIELD])
    return _row_hash(last)


def _row_hash(row: dict[str, Any]) -> str:
    payload = dict(row)
    payload.pop(HASH_FIELD, None)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _invalid(path: Path, row_number: int, reason: str) -> dict[str, Any]:
    return {
        "path": path.as_posix(),
        "valid": False,
        "row_number": row_number,
        "reason": reason,
    }
