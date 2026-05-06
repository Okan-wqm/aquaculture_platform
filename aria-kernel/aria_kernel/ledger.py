from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class LedgerIntegrityError(RuntimeError):
    pass


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    if path.exists():
        digest.update(path.read_bytes())
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except json.JSONDecodeError as exc:
            raise LedgerIntegrityError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return records


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return read_jsonl(path)


def _canonical_json(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _record_hash(record: dict[str, Any], previous_hash: str | None = None) -> str:
    payload = dict(record)
    payload.pop("ledger_hash", None)
    payload.pop("previous_ledger_hash", None)
    raw = _canonical_json({"previous_ledger_hash": previous_hash, "record": payload})
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = read_jsonl(path)
    previous_hash = str(rows[-1].get("ledger_hash")) if rows and rows[-1].get("ledger_hash") else None
    stored = dict(record)
    stored.setdefault("previous_ledger_hash", previous_hash)
    stored["ledger_hash"] = _record_hash(stored, previous_hash)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(stored, sort_keys=True, separators=(",", ":")) + "\n")
    _refresh_adjacent_index(path)
    return stored


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_hash: str | None = None
    lines = []
    for row in rows:
        stored = dict(row)
        stored["previous_ledger_hash"] = previous_hash
        stored["ledger_hash"] = _record_hash(stored, previous_hash)
        previous_hash = stored["ledger_hash"]
        lines.append(json.dumps(stored, sort_keys=True, separators=(",", ":")))
    path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
    _refresh_adjacent_index(path)


def verify_jsonl(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"path": path.as_posix(), "valid": True, "row_count": 0, "missing": True}
    rows: list[dict[str, Any]] = []
    previous_hash: str | None = None
    try:
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                return {"path": path.as_posix(), "valid": False, "line": line_no, "reason": "row_not_object"}
            rows.append(row)
            expected = row.get("ledger_hash")
            if expected:
                actual = _record_hash(row, previous_hash)
                if expected != actual:
                    return {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": "ledger_hash_mismatch",
                        "expected": expected,
                        "actual": actual,
                    }
                if row.get("previous_ledger_hash") != previous_hash:
                    return {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": "previous_hash_mismatch",
                    }
            previous_hash = str(expected) if expected else previous_hash
    except json.JSONDecodeError as exc:
        return {"path": path.as_posix(), "valid": False, "line": exc.lineno, "reason": str(exc)}
    except OSError as exc:
        return {"path": path.as_posix(), "valid": False, "reason": str(exc)}
    return {"path": path.as_posix(), "valid": True, "row_count": len(rows), "last_hash": previous_hash}


def load_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "ledger_hashes": {},
            "pressure_evidence_fingerprints_emitted": [],
            "schema_version": 2,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def verify_index_hashes(index_path: Path, ledgers: dict[str, Path]) -> dict[str, Any]:
    index = load_index(index_path)
    for name, expected_hash in index.get("ledger_hashes", {}).items():
        ledger = ledgers.get(name)
        if ledger is None:
            continue
        actual_hash = file_hash(ledger)
        if actual_hash != expected_hash:
            raise LedgerIntegrityError(
                f"Ledger integrity check failed for {name}: expected {expected_hash}, got {actual_hash}"
            )
    return index


def write_index(index_path: Path, index: dict[str, Any], ledgers: dict[str, Path]) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index.pop("pressure_keys_emitted", None)
    index["ledger_hashes"] = {name: file_hash(path) for name, path in ledgers.items()}
    index["schema_version"] = 2
    _atomic_write_text(index_path, json.dumps(index, indent=2, sort_keys=True) + "\n")


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _refresh_adjacent_index(path: Path) -> None:
    tool_names = {"runs.jsonl": "runs", "health.jsonl": "health", "cycles.jsonl": "cycles", "governance.jsonl": "governance"}
    if path.name in tool_names and (path.parent / "integrity_index.json").exists():
        ledgers = {name: path.parent / filename for filename, name in tool_names.items()}
        current = load_index(path.parent / "integrity_index.json")
        write_index(path.parent / "integrity_index.json", current, ledgers)
        return
    if path.parent.name == "aria-memory" and (path.parent.parent / "aria-state" / "integrity_index.json").exists():
        ledgers = {
            "unknowns": path.parent / "unknowns.jsonl",
            "missed_signals": path.parent / "missed_signals.jsonl",
            "external_feedback": path.parent / "external_feedback.jsonl",
            "pressure": path.parent / "pressure.jsonl",
            "pressure_state": path.parent / "pressure_state.jsonl",
            "vocabulary_rejections": path.parent / "vocabulary_rejections.jsonl",
            "since_migration_events": path.parent / "since_migration_events.jsonl",
            "governance": path.parent / "governance.jsonl",
        }
        index_path = path.parent.parent / "aria-state" / "integrity_index.json"
        current = load_index(index_path)
        write_index(index_path, current, ledgers)
