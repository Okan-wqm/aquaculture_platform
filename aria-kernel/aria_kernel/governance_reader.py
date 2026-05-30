"""Plan 025 §A.2 — single shared reader for governance.jsonl.

WHY this module exists
----------------------
Pre-Plan-025 four governance.jsonl readers (handoff_ledger._last_validation,
architecture_spine_gate._latest_baseline_for_plan,
architecture_spine_gate._consecutive_regression_count,
architecture_spine_gate.list_spine_events) each duplicated the
``try: row = json.loads(line); except json.JSONDecodeError: continue``
silent-skip pattern. governance.jsonl is the audit-bound CRITICAL
ledger (hash-chain integrity layer) — silently dropping a corrupt
row is the WRONG default for a critical reader. The handoff_ledger
.list_handoffs reader (Plan 024 §H-7) already proved the right
shape: STRICT default + explicit ``on_corruption='tolerant'`` opt-in
+ diagnostic sink emit on every corruption observation regardless
of mode.

This module collapses the four readers to a single shared helper
so future governance.jsonl callsites cannot re-introduce the
silent-skip pattern by accident.

Mirror of the Plan 024 §H-7 contract
------------------------------------
- ``on_corruption='strict'`` (default) — corrupt row raises
  ``GovernanceError`` after the diagnostic sink has been written.
  Critical-ledger default; matches list_handoffs.
- ``on_corruption='tolerant'`` — corrupt row skipped from the
  iterator, diagnostic still emitted. Operators who need partial
  reads (e.g. recovery / forensic dump) opt in explicitly.
- ``emit_ledger_corruption_diagnostic`` is called for EVERY
  corrupt row in BOTH modes. The sink owns its stderr fallback
  (Plan 024 §H-7 — recursion-safe write surface), so the helper
  must NOT swallow exceptions from the emit call.
- Mode validation happens at function entry — a misspelled mode
  raises immediately rather than silently degrading to one of
  the two valid modes.
- Non-existent ``path`` returns an empty iterator (caller decides
  whether that is a problem); this preserves the early-return
  semantics of the legacy callsites.
- ``reverse=True`` iterates rows newest-first while keeping the
  ORIGINAL forward line number in any emitted diagnostic. Used by
  ``_consecutive_regression_count`` which scans from the tail.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from .diagnostics import emit_ledger_corruption_diagnostic
from .tool_registry import GovernanceError


VALID_ON_CORRUPTION_MODES: frozenset[str] = frozenset({"strict", "tolerant"})


def read_governance_rows(
    path: Path,
    *,
    on_corruption: str = "strict",
    reverse: bool = False,
    base_dir: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Iterate decoded JSON rows from a governance.jsonl-shape file.

    Parameters
    ----------
    path
        Resolved absolute path to the governance.jsonl-shape ledger.
        If the path does not exist the iterator yields nothing — no
        error is raised so callers that already early-return on the
        non-existent case keep their behaviour.
    on_corruption
        ``"strict"`` (default) raises ``GovernanceError`` after the
        diagnostic sink emit on the first corrupt row. ``"tolerant"``
        skips the corrupt row from the iterator, still emits to the
        diagnostic sink. Any other value raises ``GovernanceError``
        at function entry — silent degradation to one of the two
        valid modes is BANNED.
    reverse
        When ``True`` the iterator yields rows newest-first
        (``reversed(splitlines())`` semantics). The diagnostic
        ``line_no`` is the ORIGINAL forward line number even in
        reverse iteration so operators reading the sink can locate
        the corrupt row in the file directly.
    base_dir
        Forwarded to ``emit_ledger_corruption_diagnostic`` so the
        sink lands inside the correct workspace's
        ``aria-tools/diagnostics/``. When ``None`` the helper falls
        back to ``path.parent`` (which is the conventional
        ``aria-tools/`` directory for governance.jsonl).
    """
    if on_corruption not in VALID_ON_CORRUPTION_MODES:
        raise GovernanceError(
            f"read_governance_rows_invalid_on_corruption_mode: "
            f"{on_corruption!r} (must be 'strict' or 'tolerant')"
        )
    if not path.exists():
        return
    sink_base = base_dir if base_dir is not None else path.parent
    raw_text = path.read_text(encoding="utf-8")
    # Compute forward (line_no, line) tuples first so reverse=True
    # iteration still surfaces the ORIGINAL line number to operators.
    enumerated: list[tuple[int, str]] = list(
        enumerate(raw_text.splitlines(), start=1)
    )
    if reverse:
        enumerated = list(reversed(enumerated))
    for line_no, raw in enumerated:
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
            # Plan 024 §H-7 — sink owns its own stderr fallback.
            # Caller-side ``try/except: pass`` swallow is BANNED.
            emit_ledger_corruption_diagnostic(corruption, base_dir=sink_base)
            if on_corruption == "strict":
                raise GovernanceError(
                    f"governance_row_corrupt_strict_mode: "
                    f"{path}:{line_no}: {exc}"
                )
            # tolerant: skip + continue
            continue


_BOUNDED_READ_CHUNK_SIZE: int = 65536  # 64 KB


def read_governance_rows_reverse(
    *,
    base_dir: Path,
    limit: int = 100,
    kind_filter: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V3.1-C-1 — bounded seek-to-end governance reader.

    Closes 6-validator audit C-12 (performance): the pre-existing
    `read_governance_rows(path, reverse=True)` reader loads the
    FULL `governance.jsonl` ledger into memory via `path.read_text`.
    On a 100MB ledger (~1M rows in a sustained autonomous run) that
    costs ~600ms per cycle just on the read — throttling the V10.2
    skill genesis stability check.

    V3.1-C-1 Tier-1 anchor: `seek(0, 2)` to EOF, then read backwards
    in 64 KB chunks until either `limit` rows accumulated OR BOF
    reached. Worst case for a 100MB ledger:

      * 64 KB read from disk
      * ~100 JSON parses (avg row ~640 bytes)
      * <50 ms wall-clock

    Bounded irrespective of total ledger size — the cost scales with
    the requested `limit`, NOT the ledger's full row count.

    Returns up to `limit` rows in REVERSE chronological order (newest
    first). When the ledger has fewer than `limit` rows, returns all
    rows. Malformed rows are skipped (verify_chain_or_quarantine
    remains the integrity gate; this reader is a perf primitive).

    `kind_filter` is an optional tuple of `kind` strings; only rows
    whose `kind` attribute matches one of the filter values are
    returned. Pre-filter reduces the JSON-parse cost when only
    specific event types are needed (V3.1-C MemoryHook uses
    kind_filter=("convergence_resolved", ...) to drive the stability
    check on CONVERGED-only events).
    """
    path = Path(base_dir) / "governance.jsonl"
    if not path.exists():
        return []
    file_size = path.stat().st_size
    if file_size == 0:
        return []
    rows: list[dict[str, Any]] = []
    leftover = b""
    pos = file_size
    with path.open("rb") as f:
        while pos > 0 and len(rows) < limit:
            chunk_start = max(0, pos - _BOUNDED_READ_CHUNK_SIZE)
            chunk_len = pos - chunk_start
            f.seek(chunk_start)
            chunk = f.read(chunk_len) + leftover
            pos = chunk_start
            lines = chunk.split(b"\n")
            # When chunk_start > 0, the first split fragment may be
            # an incomplete line (carries forward to the next read
            # iteration). When chunk_start == 0, the first fragment
            # is a complete first line.
            if chunk_start > 0:
                leftover = lines[0]
                completed_lines = lines[1:]
            else:
                leftover = b""
                completed_lines = lines
            # Walk completed_lines in reverse so newest rows accumulate
            # first within this chunk.
            for raw in reversed(completed_lines):
                raw_stripped = raw.strip()
                if not raw_stripped:
                    continue
                try:
                    row = json.loads(raw_stripped)
                except json.JSONDecodeError:
                    # Malformed row — skip (Tier-3 detect runs at
                    # verify_chain_or_quarantine callsite, not here).
                    continue
                if not isinstance(row, dict):
                    continue
                if kind_filter is not None:
                    if row.get("kind") not in kind_filter:
                        continue
                rows.append(row)
                if len(rows) >= limit:
                    break
    return rows


__all__ = [
    "VALID_ON_CORRUPTION_MODES",
    "read_governance_rows",
    "read_governance_rows_reverse",
]
