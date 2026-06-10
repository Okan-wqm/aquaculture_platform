from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl
from .tool_registry import GovernanceError


SOURCE_LEDGER_REF_FIELDS: tuple[str, ...] = (
    "surface",
    "ledger_path",
    "row_id",
    "row_type",
    "row_hash",
    "schema_version",
)


def ledger_ref_for_row(
    *,
    surface: str,
    ledger_path: str,
    row_id: str,
    row_type: str,
    row: dict[str, Any],
) -> dict[str, Any]:
    row_hash = row.get("ledger_hash")
    if not isinstance(row_hash, str) or not row_hash.startswith("sha256:"):
        raise GovernanceError("source_ledger_ref_row_missing_ledger_hash")
    return {
        "surface": surface,
        "ledger_path": ledger_path,
        "row_id": row_id,
        "row_type": row_type,
        "row_hash": row_hash,
        "schema_version": row.get("schema_version"),
    }


def find_row_by_source_ledger_ref(
    root: Path,
    ref: dict[str, Any],
    *,
    expected_surface: str | None = None,
    expected_row_type: str | None = None,
) -> dict[str, Any]:
    _validate_source_ref_shape(ref)
    surface = str(ref["surface"])
    if expected_surface is not None and surface != expected_surface:
        raise GovernanceError(
            f"source_ledger_ref_surface_mismatch:{surface}!={expected_surface}"
        )
    row_type = str(ref["row_type"])
    if expected_row_type is not None and row_type != expected_row_type:
        raise GovernanceError(
            f"source_ledger_ref_row_type_mismatch:{row_type}!={expected_row_type}"
        )
    ledger_path = _resolve_ledger_path(root, str(ref["ledger_path"]))
    rows = load_declared_jsonl(ledger_path, expected_surface=surface)
    matches = [
        row for row in rows
        if row.get("ledger_hash") == ref["row_hash"]
        and str(row.get("row_id") or "") == str(ref["row_id"])
        and str(row.get("row_type") or "") == row_type
        and row.get("schema_version") == ref["schema_version"]
    ]
    if len(matches) != 1:
        raise GovernanceError(
            "source_ledger_ref_exact_match_required:"
            f"{surface}:{ref['ledger_path']}:{ref['row_id']}:{len(matches)}"
        )
    return matches[0]


def _validate_source_ref_shape(ref: dict[str, Any]) -> None:
    if not isinstance(ref, dict):
        raise GovernanceError("source_ledger_ref_must_be_object")
    missing = [field for field in SOURCE_LEDGER_REF_FIELDS if field not in ref]
    if missing:
        raise GovernanceError("source_ledger_ref_missing_fields:" + ",".join(missing))
    for field in ("surface", "ledger_path", "row_id", "row_type", "row_hash"):
        value = ref.get(field)
        if not isinstance(value, str) or not value.strip():
            raise GovernanceError(f"source_ledger_ref_invalid_field:{field}")
    schema_version = ref.get("schema_version")
    if not isinstance(schema_version, int) or isinstance(schema_version, bool) or schema_version <= 0:
        raise GovernanceError("source_ledger_ref_invalid_field:schema_version")
    row_hash = str(ref["row_hash"])
    if (
        not row_hash.startswith("sha256:")
        or len(row_hash) != len("sha256:") + 64
        or any(ch not in "0123456789abcdef" for ch in row_hash[len("sha256:"):])
    ):
        raise GovernanceError("source_ledger_ref_row_hash_must_be_sha256")


def _resolve_ledger_path(root: Path, ledger_path: str) -> Path:
    candidate = Path(ledger_path)
    if candidate.is_absolute():
        raise GovernanceError("source_ledger_ref_absolute_path_forbidden")
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError("source_ledger_ref_path_escape") from exc
    return resolved


__all__ = [
    "SOURCE_LEDGER_REF_FIELDS",
    "find_row_by_source_ledger_ref",
    "ledger_ref_for_row",
]
