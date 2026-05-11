"""Plan 024 §H-7 — recursion-safe ledger corruption diagnostic sink.

Pre-fix the silent-skip pattern in handoff_ledger.py + finding.py
discarded JSONDecodeError on corrupt rows, so the audit + integrity-
chain layer (every row must be seen-or-flagged) lost the signal
entirely. Adding a corruption event back into governance.jsonl would
have spiralled if governance.jsonl itself was the corrupt ledger
(append_tools_governance → append_jsonl → read_jsonl → LedgerIntegrityError
chain). The fix is a SEPARATE sink:
``aria-tools/diagnostics/ledger-corruption.jsonl``.

Critical readers (handoff_ledger, finding, claim/result/governance/
runs/health ledgers) default to STRICT — a corrupt row raises
GovernanceError instead of silent skip. Advisory readers (display
surfaces) opt into tolerant mode and consume the corruption list
returned alongside the rows. Either way, every corruption observation
lands in the diagnostic sink.

This module owns no business logic; it is exclusively the
recursion-safe write surface for the diagnostic event.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LEDGER_CORRUPTION_SINK_DIRNAME: str = "diagnostics"
LEDGER_CORRUPTION_SINK_FILENAME: str = "ledger-corruption.jsonl"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def emit_ledger_corruption_diagnostic(
    corruption: dict[str, Any],
    *,
    base_dir: str | os.PathLike[str] | Path | None = None,
) -> None:
    """Plan 024 §H-7 — append a corruption observation to the diagnostic
    sink.

    Recursion-safe: writes to a SEPARATE file (NOT governance.jsonl),
    so a corrupt governance.jsonl can be reported without the
    emit-into-corrupt-ledger spiral. Best-effort: if the diagnostic
    sink itself cannot be written (permission denied, disk full),
    the failure falls back to stderr; we never recurse into another
    governance / diagnostic emission.

    Caller-provided ``corruption`` payload SHOULD include:
    - ``kind`` — one of {"ledger_row_corrupt", "ledger_row_unreadable",
      "ledger_index_rebuild_skip"}.
    - ``ledger`` — absolute path to the corrupt ledger.
    - ``line_no`` — 1-indexed line number when applicable.
    - ``error`` — the underlying exception's str().
    - ``raw_excerpt`` — first ~200 chars of the corrupt line (debug aid).
    """
    if base_dir is None:
        # Without a base_dir we cannot derive the sink path; emit to
        # stderr only. This branch is reached only by call sites that
        # do not have a tools directory bound (rare).
        _stderr_fallback(corruption, reason="no_base_dir")
        return
    sink_dir = Path(base_dir) / LEDGER_CORRUPTION_SINK_DIRNAME
    sink_path = sink_dir / LEDGER_CORRUPTION_SINK_FILENAME
    row = {
        "$schema": "aria/ledger-corruption-diagnostic/v1",
        "schema_version": 1,
        "recorded_at": _utc_now_iso(),
        **corruption,
    }
    try:
        sink_dir.mkdir(parents=True, exist_ok=True)
        with sink_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
    except OSError as exc:
        _stderr_fallback(corruption, reason=f"sink_write_failed: {exc}")


def _stderr_fallback(corruption: dict[str, Any], *, reason: str) -> None:
    """Last-resort fallback when the diagnostic sink cannot be written.

    Never recurses; never raises. The caller still gets the protective
    effect of the read-side reject (STRICT mode) or the corruption-list
    return (tolerant mode); only the audit event observability is
    degraded to stderr.
    """
    try:
        msg = (
            f"ledger_corruption_diagnostic_emit_fallback: reason={reason} "
            f"corruption={json.dumps(corruption, sort_keys=True)}"
        )
        print(msg, file=sys.stderr)
    except Exception:
        # If even stderr write raises (closed pipe?) we swallow. The
        # protective rejection of the corrupt row has already happened
        # at the caller; we never want to escalate further.
        pass


__all__ = [
    "LEDGER_CORRUPTION_SINK_DIRNAME",
    "LEDGER_CORRUPTION_SINK_FILENAME",
    "emit_ledger_corruption_diagnostic",
]
