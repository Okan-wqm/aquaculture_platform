"""E17-d — per-spawn context usage ledger (record-only observation surface).

WHY this module exists
----------------------
`tools/aria-poc/claude_runtime.extract_usage` has forwarded the API's
`cache_creation_input_tokens` / `cache_read_input_tokens` fields since the
usage plumbing landed — and NOTHING recorded them per role/agent. Whether
the server prompt-cache actually spans judge spawns (the assumption behind
"the 138KB doc preamble is cheap after the first spawn") was therefore an
untested belief with zero evidence trail. This module gives the numbers a
declared, hash-chained home: `knowledge-graph/context-usage.jsonl`
(StateSurface `context_usage`), sibling of the kg_ observation family.

Record-only by design: no consumer ships in this change — the calibration
consumer is a tracked plan item, and an observation ledger must exist and
accumulate BEFORE any consumer can be calibrated against it. The surface is
write_driving=False; a row here never authorises an action.

Failure semantics
-----------------
A ``usage=None`` call is a STRUCTURAL outcome, not an error: the CLI run
ended without a terminal usage payload (error-typed result, parse gap).
The caller must be able to distinguish "nothing to record" from "record
failed", so the None branch returns an explicit skip dict and writes
nothing — it is never an exception swallow. Everything else fails loudly
(GovernanceError from the declared-surface append) and the SPAWNER decides
how loud is acceptable — see the best-effort seam in claude_runtime.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now

# The four usage fields the Anthropic API returns on every message and
# claude_runtime.extract_usage forwards verbatim. Absent → None (recorded
# as null): an old CLI that omits cache fields must stay distinguishable
# from a run that genuinely created/read zero cache tokens.
_USAGE_FIELDS: tuple[str, ...] = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


def _usage_value(usage: dict[str, Any], key: str) -> int | None:
    """A token count, or None when absent/non-numeric.

    bool is excluded explicitly (bool subclasses int); a True in a usage
    field is a malformed payload, and recording it as 1 would fabricate a
    measurement.
    """
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def record_context_usage(
    *,
    request_id: str,
    role: str,
    target_agent: str,
    model: str | None,
    usage: dict[str, Any] | None,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """Append one per-spawn usage row to knowledge-graph/context-usage.jsonl.

    Returns the stored row (with its ledger_hash envelope) on success, or
    the structural skip dict when ``usage`` is None — the explicit branch
    documented in the module docstring. Raises GovernanceError on a
    refused append (undeclared surface, frozen profile, broken chain);
    best-effort handling belongs to the spawner, not here.
    """
    if usage is None:
        return {
            "recorded": False,
            "skip_reason": "usage_none",
            "request_id": request_id,
            "role": role,
            "target_agent": target_agent,
        }
    row: dict[str, Any] = {
        "$schema": "aria/context-usage/v1",
        "schema_version": 1,
        "recorded_at": utc_now(),
        "request_id": request_id,
        "role": role,
        "target_agent": target_agent,
        "model": model,
    }
    for key in _USAGE_FIELDS:
        row[key] = _usage_value(usage, key)
    root = ensure_tools_dir(base_dir)
    # Literal path (not a constant) so tests/test_ledger_roster_invariant.py's
    # static sweep sees this writer and re-verifies it resolves to the
    # declared `context_usage` surface forever.
    return append_declared_jsonl(
        root / "knowledge-graph" / "context-usage.jsonl",
        row,
        expected_surface="context_usage",
    )


__all__ = ["record_context_usage"]
