"""C4-a (ORPHAN-674) — the operator-approval ledger gets its writer.

`operator-provenance/events.jsonl` was a declared surface with readers
on the promotion-critical path (`verify_shadow_eval_proof` resolves the
eval run's `operator_approval_ledger_ref` here and matches
`operator_provenance_ref` by set-membership) and ZERO writers outside
tests — every genesis SHADOW/EVAL transition was structurally
unreachable because its proof chain dead-ended at a ledger nothing
could mint. This module is the single mint point; the CLI wires it as
`aria-kernel operator-provenance record|list`.

ARIA-MEDIUM-512 — an approval authorizes ONE agent. ``target_agent`` was
optional and stored as None, and the shadow bridge compared it only when it
was non-empty, so an approval minted without the flag promoted whichever
agent it was presented for. The mint now refuses an approval that names no
agent, and :func:`require_approval_scope` is the one rule every consumer of
an approval row applies (``agent_eval._validate_real_eval_provenance``, which
both the eval run and ``genesis_lifecycle.verify_shadow_eval_proof`` go
through, and the shadow bridge before its first write): a row with no agent
is refused, never read as a wildcard.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

_SURFACE = "operator_provenance"


def events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-provenance" / "events.jsonl"


def _require_future_iso(expires_at: str) -> None:
    # Same contract agent_eval enforces at CONSUME time
    # (`_require_operator_approval_future`) — minting an already-expired
    # approval would only defer the refusal to a noisier place.
    if not isinstance(expires_at, str) or not expires_at.strip():
        raise GovernanceError("operator_approval_expiry_required")
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GovernanceError("operator_approval_expiry_invalid") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise GovernanceError("operator_approval_expired_at_mint")


def _approval_target(value: Any) -> str:
    return str(value or "").strip()


def require_approval_scope(row: dict[str, Any], *, target_agent: str) -> None:
    """Refuse an approval row that does not name exactly ``target_agent``.

    A row with no ``target_agent`` (the pre-ARIA-MEDIUM-512 writer stored
    None when the operator left the flag out) authorizes no agent; it is
    never a wildcard.
    """
    scope = _approval_target(row.get("target_agent"))
    ref = str(row.get("operator_provenance_ref") or row.get("event_id") or "")
    if not scope:
        raise GovernanceError(f"operator_approval_unscoped:{ref}")
    if scope != _approval_target(target_agent):
        raise GovernanceError(
            f"operator_approval_scope_mismatch:approval={scope!r}!=target={target_agent!r}"
        )


def record_operator_approval(
    *,
    ref: str,
    expires_at: str,
    target_agent: str | None,
    note: str = "",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Mint one operator-approval row for the one agent it promotes.

    ``ref`` is the free-form string the shadow-eval proof will carry as
    ``operator_provenance_ref`` — the verifier matches it against this
    row's ``operator_provenance_ref``/``event_id`` fields by equality,
    so the operator chooses it and the proof must repeat it verbatim.
    ``target_agent`` is required: :func:`require_approval_scope` refuses a
    row without it at every consumer, so minting one would only defer the
    refusal.
    """
    ref = str(ref or "").strip()
    if not ref:
        raise GovernanceError("operator_approval_ref_required")
    _require_future_iso(expires_at)
    agent = _approval_target(target_agent)
    if not agent:
        raise GovernanceError("operator_approval_target_agent_required")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"operator-approval:{uuid.uuid4().hex[:16]}",
        "row_type": "operator_approval",
        "event_id": ref,
        "operator_provenance_ref": ref,
        "target_agent": agent,
        "expires_at": expires_at,
        "note": str(note or ""),
    }
    return append_declared_jsonl(events_path(base_dir), row, expected_surface=_SURFACE)


def list_operator_approvals(
    *, base_dir: str | Path | None = None
) -> list[dict[str, Any]]:
    path = events_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=_SURFACE)
