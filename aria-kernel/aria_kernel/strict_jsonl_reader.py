"""Plan 026R §A.3 — generic strict JSONL reader.

Pre-§A.3 ten+ callsites across the kernel re-implemented the
silent-skip pattern::

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        ...

That shape silently drops corrupt rows from any ledger — a fail-quiet
mode that destroys the kernel's ability to detect tamper or partial
write at consume time. Plan 025 §A.2 fixed it for ``governance.jsonl``
via ``governance_reader.read_governance_rows``; this module
generalises that contract to every JSONL consumer that does NOT
need the hash-chain check ``load_jsonl_verified`` enforces
(``load_jsonl_verified`` is the right primitive when chain
integrity is required; ``read_strict_jsonl`` is the right primitive
when "every line is valid JSON" is the contract).

Mirror of ``governance_reader.read_governance_rows``:

* ``on_corruption="strict"`` (default) — corrupt row raises
  ``GovernanceError`` AFTER ``emit_ledger_corruption_diagnostic``.
* ``on_corruption="tolerant"`` — corrupt row skipped, diagnostic
  still emitted. Operators who need partial reads opt in explicitly.
* Mode validation at entry — misspelled mode raises immediately.
* Non-existent path → empty iterator (caller decides whether that
  is a problem); preserves the early-return semantics of the legacy
  callsites.

§A.3 AST invariant ``test_jsonl_silent_skip_invariant`` enforces that
no module under ``aria-kernel/aria_kernel/`` re-introduces the bare
``except json.JSONDecodeError: continue`` pattern on a JSONL ledger
read path; new consumers MUST route through this module (or
``governance_reader`` / ``runs_reader`` / ``load_jsonl_verified``).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from .diagnostics import emit_ledger_corruption_diagnostic
from .ledger import (
    LedgerIntegrityError,
    REPLAY_TRANSPORT_SCHEMA_PREFIX,
    is_replay_transport_row,
    read_jsonl,
)
from .state_manifest import surface_for_path
from .tool_registry import GovernanceError


VALID_ON_CORRUPTION_MODES: frozenset[str] = frozenset({"strict", "tolerant"})


def read_strict_jsonl(
    path: Path,
    *,
    on_corruption: str = "strict",
    base_dir: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Iterate decoded JSON rows from a JSONL ledger, strict-by-default.

    Parameters
    ----------
    path
        Resolved absolute path to the JSONL ledger. Non-existent → empty
        iterator (no error).
    on_corruption
        ``"strict"`` (default) raises ``GovernanceError`` after emitting
        ``ledger_row_corrupt`` to the diagnostic sink on the first
        corrupt row. ``"tolerant"`` skips the corrupt row from the
        iterator + still emits to the sink. Any other value raises
        ``GovernanceError`` at entry — silent degradation is BANNED.
    base_dir
        Forwarded to ``emit_ledger_corruption_diagnostic`` so the sink
        lands in the right workspace's ``aria-tools/diagnostics/``.
        Defaults to ``path.parent``.
    """
    if on_corruption not in VALID_ON_CORRUPTION_MODES:
        raise GovernanceError(
            f"read_strict_jsonl_invalid_on_corruption_mode: "
            f"{on_corruption!r} (must be 'strict' or 'tolerant')"
        )
    if not path.exists():
        return
    sink_base = base_dir if base_dir is not None else path.parent
    raw_text = path.read_text(encoding="utf-8")
    declared = surface_for_path(path)
    if declared is not None:
        decoded: list[dict[str, Any]] = []
        transport_claimed = False
        for line_no, raw in enumerate(raw_text.splitlines(), start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                corruption = {
                    "kind": "ledger_row_corrupt",
                    "ledger": str(path),
                    "line_no": line_no,
                    "error": str(exc),
                    "raw_excerpt": line[:200],
                }
                emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
                if on_corruption == "strict":
                    raise GovernanceError(
                        f"strict_jsonl_row_corrupt: {path}:{line_no}: {exc}"
                    ) from exc
                continue
            if not isinstance(row, dict):
                corruption = {
                    "kind": "ledger_row_corrupt",
                    "ledger": str(path),
                    "line_no": line_no,
                    "error": "row_not_object",
                    "raw_excerpt": line[:200],
                }
                emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
                if on_corruption == "strict":
                    raise GovernanceError(
                        f"strict_jsonl_row_corrupt: {path}:{line_no}: row_not_object"
                    )
                continue
            decoded.append(row)
            transport_claimed = transport_claimed or is_replay_transport_row(row)
        if not transport_claimed:
            yield from decoded
            return
        try:
            yield from read_jsonl(path, expected_surface=declared[0].name)
            return
        except (LedgerIntegrityError, OSError, UnicodeError) as exc:
            corruption = {
                "kind": "ledger_row_corrupt",
                "ledger": str(path),
                "line_no": 0,
                "error": str(exc),
                "raw_excerpt": REPLAY_TRANSPORT_SCHEMA_PREFIX,
            }
            emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
            if on_corruption == "strict":
                raise GovernanceError(
                    f"strict_jsonl_replay_transport_corrupt: {path}: {exc}"
                ) from exc
            return
    if REPLAY_TRANSPORT_SCHEMA_PREFIX in raw_text:
        try:
            # A transport payload is exposed only after the complete outer
            # chain and exact envelope have been verified by the shared
            # ledger owner.  Legacy/hashless files retain the line-oriented
            # strict/tolerant behavior below.
            yield from read_jsonl(path)
            return
        except (LedgerIntegrityError, OSError, UnicodeError) as exc:
            corruption = {
                "kind": "ledger_row_corrupt",
                "ledger": str(path),
                "line_no": 0,
                "error": str(exc),
                "raw_excerpt": REPLAY_TRANSPORT_SCHEMA_PREFIX,
            }
            emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
            if on_corruption == "strict":
                raise GovernanceError(
                    f"strict_jsonl_replay_transport_corrupt: {path}: {exc}"
                ) from exc
            return
    for line_no, raw in enumerate(raw_text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as exc:
            corruption = {
                "kind": "ledger_row_corrupt",
                "ledger": str(path),
                "line_no": line_no,
                "error": str(exc),
                "raw_excerpt": line[:200],
            }
            emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
            if on_corruption == "strict":
                raise GovernanceError(
                    f"strict_jsonl_row_corrupt: "
                    f"{path}:{line_no}: {exc}"
                )
            continue


__all__ = ["VALID_ON_CORRUPTION_MODES", "read_strict_jsonl"]
