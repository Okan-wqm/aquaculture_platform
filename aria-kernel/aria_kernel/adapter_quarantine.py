"""An adapter that is declared but not fit to run is quarantined by NAME (ARIA-MEDIUM-378).

WHY. Four Plan 016 adapters sat on the no-op ``shadow_runner.py`` for months:
a declared adapter that silently ran nothing looked exactly like an adapter
that ran and found nothing. Putting them on their real runners exposed two
whose rules are not fit to emit findings yet — outbox reads only the outbox
machinery, and the banned-phrase tree scan is far below the precision floor.
Neither may go back to being a silent no-op.

WHAT. A manifest may carry ``"quarantine": {"finding": <ID>, "reason": ...}``.
The manifest sync (``cycle._phase_tool_manifest_sync``) registers the adapter
like every other one and then quarantines it through ``quarantine.quarantine_tool``
when the registry does not already hold it QUARANTINED. The registry row, the
quarantine ledger and every ``tool_sit_out`` the degradation phase records name
the finding and the reason, so the gap stays visible each night.

Leaving the quarantine is NOT done by deleting the block: ``unquarantine_tool``
(QUARANTINED -> CALIBRATE with a root-cause note and a fixture update) is the
one audited way out, and the block only ever drives the way in.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, get_tool

QUARANTINE_FIELDS: tuple[str, ...] = ("finding", "reason")
_FINDING_ID_RE = re.compile(r"^[A-Z]+(?:-[A-Z]+)*-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d+$")
MANIFEST_QUARANTINE_PREFIX = "manifest_quarantine"


def validate_manifest_quarantine(block: Any, *, tool_id: str) -> dict[str, str]:
    """The manifest's ``quarantine`` block, refused unless it names a finding and a reason."""
    where = f"manifest_quarantine_invalid: {tool_id}"
    if not isinstance(block, dict) or set(block) != set(QUARANTINE_FIELDS):
        raise GovernanceError(f"{where}: fields must be exactly {QUARANTINE_FIELDS}")
    finding = block["finding"]
    reason = block["reason"]
    if not isinstance(finding, str) or not _FINDING_ID_RE.match(finding):
        raise GovernanceError(f"{where}: finding must be a registry finding id, got {finding!r}")
    if not isinstance(reason, str) or not reason.strip():
        raise GovernanceError(f"{where}: reason must be a non-empty string")
    return {"finding": finding, "reason": reason.strip()}


def manifest_quarantine_reason(block: dict[str, str]) -> str:
    return f"{MANIFEST_QUARANTINE_PREFIX}:{block['finding']}: {block['reason']}"


def apply_manifest_quarantine(
    manifest: dict[str, Any], *, base_dir: str | Path | None,
) -> dict[str, str] | None:
    """Quarantine a registered adapter whose manifest names a quarantine; None when it has none.

    Idempotent: a tool the registry already holds QUARANTINED is left as it
    is, so the nightly re-sync appends no second quarantine row.
    """
    block = manifest.get("quarantine")
    if block is None:
        return None
    tool_id = str(manifest.get("tool_id"))
    named = validate_manifest_quarantine(block, tool_id=tool_id)
    if get_tool(tool_id, base_dir).get("status") == "QUARANTINED":
        return None
    from .quarantine import quarantine_tool

    quarantine_tool(tool_id, manifest_quarantine_reason(named), base_dir=base_dir)
    return {"tool_id": tool_id, **named}


__all__ = [
    "MANIFEST_QUARANTINE_PREFIX",
    "QUARANTINE_FIELDS",
    "apply_manifest_quarantine",
    "manifest_quarantine_reason",
    "validate_manifest_quarantine",
]
