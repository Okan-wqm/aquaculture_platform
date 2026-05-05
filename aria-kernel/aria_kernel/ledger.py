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


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def load_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"ledger_hashes": {}, "pressure_keys_emitted": [], "schema_version": 1}
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
    index["ledger_hashes"] = {name: file_hash(path) for name, path in ledgers.items()}
    index["schema_version"] = 1
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8")
