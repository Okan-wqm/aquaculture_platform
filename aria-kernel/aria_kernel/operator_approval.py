"""Typed operator approval — a reference is authority only when recorded.

The audit's class (ARIA-AUDIT-015): several promotion surfaces accepted
"operator approval" as any non-empty string (or a >=16-char "signature"),
so a producer could bless its own output with a plausible-looking token.
One verifier, one grammar, one rule: the reference must resolve to
something OUTSIDE the caller's own message —

``gov:<event_id>``     an operator-action governance event that exists in
                      the store's governance ledger;
``review:<path>#<id>`` a review document on disk that contains the exact
                      finding id (the registry's store-3 rule, reused);
``ack-env:<VAR>``      an operator-injected environment acknowledgment
                      (CI secret/variable), non-empty at consume time.

Anything else — including every bare string the old checks accepted —
refuses. Callers convert the refusal to their own typed error.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import ensure_tools_dir


class OperatorApprovalUnrecorded(Exception):
    """The reference does not resolve to recorded operator authority."""


def verify_operator_approval_ref(
    ref: str | None,
    *,
    base_dir: str | Path | None,
    surface: str,
) -> dict[str, Any]:
    """Resolve ``ref`` against the grammar; raise or describe the proof."""
    text = (ref or "").strip()
    if not text:
        raise OperatorApprovalUnrecorded(
            f"{surface}: operator approval reference is required"
        )
    kind, _, value = text.partition(":")
    if not value:
        raise OperatorApprovalUnrecorded(
            f"{surface}: operator approval reference {text!r} has no '<kind>:<value>' form"
        )
    if kind == "gov":
        root = ensure_tools_dir(base_dir)
        ledger = root / "governance.jsonl"
        if not ledger.exists():
            raise OperatorApprovalUnrecorded(
                f"{surface}: governance ledger absent — {text!r} cannot resolve"
            )
        for line in ledger.read_text(encoding="utf-8").splitlines():
            if f'"event_id": "{value}"' in line or f'"event_id":"{value}"' in line:
                return {"kind": "gov", "event_id": value, "surface": surface}
        raise OperatorApprovalUnrecorded(
            f"{surface}: governance event {value!r} not found — a producer may "
            "not bless itself with an unrecorded reference"
        )
    if kind == "review":
        path_part, _, anchor = value.partition("#")
        if not path_part or not anchor:
            raise OperatorApprovalUnrecorded(
                f"{surface}: review reference needs '<path>#<finding-id>'"
            )
        doc = Path(path_part)
        if not doc.is_file() or anchor not in doc.read_text(encoding="utf-8", errors="replace"):
            raise OperatorApprovalUnrecorded(
                f"{surface}: review document does not carry {anchor!r}"
            )
        return {"kind": "review", "path": path_part, "anchor": anchor, "surface": surface}
    if kind == "ack-env":
        import os

        if not os.environ.get(value, "").strip():
            raise OperatorApprovalUnrecorded(
                f"{surface}: acknowledgment variable {value!r} is empty or unset"
            )
        return {"kind": "ack-env", "variable": value, "surface": surface}
    raise OperatorApprovalUnrecorded(
        f"{surface}: operator approval reference {text!r} is not one of "
        "gov:<event_id>, review:<path>#<id>, ack-env:<VAR>"
    )


__all__ = ("OperatorApprovalUnrecorded", "verify_operator_approval_ref")
