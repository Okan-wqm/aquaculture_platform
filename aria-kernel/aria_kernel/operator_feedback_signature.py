"""V9.5 hard-fail check 12 — the kernel signs every operator-feedback row it records.

WHY: ``aria-tools/operator-feedback.jsonl`` is the highest-priority plan
source (``PlanCandidateSource.OPERATOR_FEEDBACK`` outranks every discovered
lane), and until this module the "signature" the synthesizer demanded was
field PRESENCE: any process that could append a line carrying
``"signature": "x"`` spoke with operator authority (ai-safety HIGH-010, the
unauthenticated injection lane). A signature nobody can verify is not a
signature.

WHAT: a keyed HMAC-SHA256 over the canonical row, under key material the
kernel holds at ``aria-tools/secrets/operator-feedback-hmac.key`` (0600,
rolling list, ``signer_kid`` = key id — the same custody the ack ledger
uses, via :mod:`hmac_keyring`). The kernel is both signer and verifier: a
row carries a valid signature exactly when it went through one of this
module's recorders. Every kernel writer of the ledger routes through
:func:`append_signed_operator_feedback_row` (verdict rows from
``feedback_store``, corpus fixtures from ``calibration_bootstrap``, request
rows from :func:`record_operator_request`), so an unsigned kernel-written
row is not a code path. The plan synthesizer verifies at ingestion
(:mod:`operator_feedback_ingestion`) and the pre-merge perimeter re-verifies
what a merged plan consumed.

The key is minted on first use rather than by an operator ceremony because
the signature attests "the kernel recorded this row", not "an operator
authorised it" — operator authority is carried by the CLI verb that reaches
the recorder, and the ack ledger keeps its own ceremony for tokens that DO
carry operator authorisation.
"""
from __future__ import annotations

import hmac
import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .hmac_keyring import HmacKeyring, hmac_sign
from .ledger import append_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

OPERATOR_FEEDBACK_SURFACE = "operator_feedback"
OPERATOR_FEEDBACK_LEDGER_NAME = "operator-feedback.jsonl"
_KEY_FILE_RELATIVE = ("secrets", "operator-feedback-hmac.key")
# Domain separation inside the signed bytes: even if key material were ever
# shared with another signer, a signature minted here verifies nowhere else.
SIGNING_DOMAIN = b"aria-operator-feedback/v1\n"
# Chain metadata is stamped by the ledger AFTER signing and must not enter
# the subject; ``signature`` is the field being computed.
_SIGNING_EXCLUDED_FIELDS: frozenset[str] = frozenset({
    "signature", "ledger_hash", "previous_ledger_hash",
})
_HEX_SIGNATURE = re.compile(r"^[0-9a-f]{64}$")

# The plan-request row the synthesizer consumes. ``status`` is what the
# scanner keys on; ``priority`` is a closed set (arb CRIT-006 — an invented
# "max" must not outrank the severity ladder).
OPERATOR_REQUEST_ROW_KIND = "operator_request"
OPERATOR_REQUEST_PRIORITIES: tuple[str, ...] = ("low", "medium", "high")
OPERATOR_REQUEST_STATUS_UNADDRESSED = "unaddressed"
MAX_OPERATOR_REQUEST_CHARS = 4096

# Closed vocabulary of verification failures. The ingestion governance event
# and the pre-merge evidence both speak it, so a reader can tell "no
# signature" from "signed under a key this store never held".
SIGNATURE_MISSING = "signature_missing"
SIGNER_KID_MISSING = "signer_kid_missing"
SIGNER_KID_UNKNOWN = "signer_kid_unknown"
SIGNATURE_MALFORMED = "signature_malformed"
SIGNATURE_INVALID = "signature_invalid"
VERIFICATION_REASONS: tuple[str, ...] = (
    SIGNATURE_MISSING, SIGNER_KID_MISSING, SIGNER_KID_UNKNOWN,
    SIGNATURE_MALFORMED, SIGNATURE_INVALID,
)


@dataclass(frozen=True)
class OperatorFeedbackSignatureVerdict:
    """One row's verification: ``valid`` with the key that signed it, or a reason."""

    valid: bool
    signer_kid: str | None
    reason: str | None


def operator_feedback_ledger_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / OPERATOR_FEEDBACK_LEDGER_NAME


def signing_key_path(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_KEY_FILE_RELATIVE)


def signing_keyring(base_dir: str | Path) -> HmacKeyring:
    return HmacKeyring(path=signing_key_path(base_dir), purpose="operator_feedback")


def canonical_signing_bytes(row: dict[str, Any]) -> bytes:
    """The signed subject: domain tag + canonical JSON of the row minus chain fields.

    Canonical JSON (sorted keys, no whitespace, ASCII) so a re-serialised row
    hashes identically; ``ensure_ascii`` matches ``ledger.canonical_json`` so
    a row that round-trips through the ledger verifies byte-for-byte.
    """
    subject = {key: value for key, value in row.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    encoded = json.dumps(subject, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return SIGNING_DOMAIN + encoded.encode("utf-8")


def sign_operator_feedback_row(row: dict[str, Any], *, base_dir: str | Path) -> dict[str, Any]:
    """Return ``row`` plus ``signer_kid`` and ``signature`` under the head key.

    ``schema_version`` is fixed BEFORE signing because the ledger stamps a
    silent row on append; a subject that changed between signing and
    storage would never verify.
    """
    if not isinstance(row, dict):
        raise GovernanceError("operator_feedback_row_must_be_object")
    root = ensure_tools_dir(base_dir)
    key = signing_keyring(root).ensure_head()
    subject = {key_name: value for key_name, value in row.items()
               if key_name not in _SIGNING_EXCLUDED_FIELDS}
    subject.setdefault("schema_version", 1)
    subject["signer_kid"] = str(key["key_id"])
    signed = dict(subject)
    signed["signature"] = hmac_sign(str(key["secret"]), canonical_signing_bytes(subject))
    return signed


def verify_operator_feedback_row(
    row: Any, *, base_dir: str | Path,
) -> OperatorFeedbackSignatureVerdict:
    """Recompute the HMAC under the row's ``signer_kid``; constant-time compare."""
    if not isinstance(row, dict):
        return OperatorFeedbackSignatureVerdict(False, None, SIGNATURE_MISSING)
    signer_kid = row.get("signer_kid")
    signature = row.get("signature")
    if not isinstance(signer_kid, str) or not signer_kid.strip():
        return OperatorFeedbackSignatureVerdict(False, None, SIGNER_KID_MISSING)
    if not isinstance(signature, str) or not signature:
        return OperatorFeedbackSignatureVerdict(False, signer_kid, SIGNATURE_MISSING)
    if _HEX_SIGNATURE.fullmatch(signature) is None:
        return OperatorFeedbackSignatureVerdict(False, signer_kid, SIGNATURE_MALFORMED)
    try:
        key = signing_keyring(Path(base_dir)).resolve(key_id=signer_kid)
    except (GovernanceError, OSError, ValueError):
        return OperatorFeedbackSignatureVerdict(False, signer_kid, SIGNER_KID_UNKNOWN)
    expected = hmac_sign(str(key["secret"]), canonical_signing_bytes(row))
    if not hmac.compare_digest(expected, signature):
        return OperatorFeedbackSignatureVerdict(False, signer_kid, SIGNATURE_INVALID)
    return OperatorFeedbackSignatureVerdict(True, signer_kid, None)


def append_signed_operator_feedback_row(
    row: dict[str, Any], *, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The ONE kernel write path into ``operator-feedback.jsonl``: sign, then append.

    Returns the stored row (with chain fields). Every kernel writer of the
    ledger calls this; ``tests/test_operator_feedback_signature.py`` pins
    that no kernel module appends to the surface any other way.
    """
    root = ensure_tools_dir(base_dir)
    signed = sign_operator_feedback_row(row, base_dir=root)
    return append_declared_jsonl(
        root / OPERATOR_FEEDBACK_LEDGER_NAME, signed,
        expected_surface=OPERATOR_FEEDBACK_SURFACE,
    )


def rotate_signing_key(*, base_dir: str | Path | None = None, reason: str) -> dict[str, Any]:
    """Retire the head key behind a new one; historical rows keep verifying.

    Recorded as ``operator_feedback_signing_key_rotated`` so the incident
    timeline shows WHEN rows started carrying the new ``signer_kid``.
    """
    from .tool_registry import append_tools_governance

    root = ensure_tools_dir(base_dir)
    keyring = signing_keyring(root)
    if not keyring.load():
        keyring.ensure_head()
    rotation = keyring.rotate()
    append_tools_governance(root, "operator_feedback_signing_key_rotated", {
        "old_key_id": rotation["previous_head"]["key_id"],
        "new_key_id": rotation["new_key"]["key_id"],
        "retired_keys": rotation["retired_keys"],
        "active_key_count": len(rotation["keys"]),
        "reason": reason,
    })
    return {
        "status": "ok",
        "old_key_id": rotation["previous_head"]["key_id"],
        "new_key_id": rotation["new_key"]["key_id"],
        "retired_keys": rotation["retired_keys"],
        "active_key_count": len(rotation["keys"]),
    }


def record_operator_request(
    *,
    request: str,
    priority: str,
    authored_by: str,
    request_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The kernel-owned writer for the plan-request rows the synthesizer mines.

    WHY: before this recorder existed the only way to author a request row
    was to append it by hand, which is exactly the lane check 12 closes. The
    CLI verb ``aria-kernel feedback request`` is the operator's channel;
    the row it produces is the only shape ``ingest_operator_feedback``
    admits.
    """
    text = str(request or "").strip()
    if not text:
        raise GovernanceError("operator_request_text_required")
    if len(text) > MAX_OPERATOR_REQUEST_CHARS:
        raise GovernanceError(
            f"operator_request_text_too_long: {len(text)} > {MAX_OPERATOR_REQUEST_CHARS}"
        )
    if priority not in OPERATOR_REQUEST_PRIORITIES:
        raise GovernanceError(f"operator_request_priority_unknown: {priority!r}")
    author = str(authored_by or "").strip()
    if not author:
        raise GovernanceError("operator_request_author_required")
    identifier = str(request_id or "").strip() or f"OP-{uuid.uuid4()}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", identifier):
        raise GovernanceError(f"operator_request_id_invalid: {identifier!r}")
    root = ensure_tools_dir(base_dir)
    row = {
        "schema_version": 1,
        "row_kind": OPERATOR_REQUEST_ROW_KIND,
        "id": identifier,
        "authored_at": utc_now(),
        "authored_by": author,
        "request": text,
        "priority": priority,
        "status": OPERATOR_REQUEST_STATUS_UNADDRESSED,
    }
    stored = append_signed_operator_feedback_row(row, base_dir=root)
    from .tool_registry import append_tools_governance

    append_tools_governance(root, "operator_request_recorded", {
        "id": identifier,
        "priority": priority,
        "signer_kid": stored["signer_kid"],
        "ledger_hash": stored.get("ledger_hash"),
    })
    return stored


def operator_request_schema_valid(row: dict[str, Any]) -> bool:
    """Shape check for a request row: the fields the synthesizer consumes.

    Kept separate from signature verification so the drop reason can say
    which of the two failed. A kernel-signed row always satisfies this; a
    signed row that does not is a leaked key, and it is still dropped.
    """
    for field in ("id", "authored_at", "request", "priority", "status"):
        value = row.get(field)
        if not isinstance(value, str) or not value.strip():
            return False
    return row["priority"] in OPERATOR_REQUEST_PRIORITIES


__all__ = [
    "MAX_OPERATOR_REQUEST_CHARS",
    "OPERATOR_FEEDBACK_LEDGER_NAME",
    "OPERATOR_FEEDBACK_SURFACE",
    "OPERATOR_REQUEST_PRIORITIES",
    "OPERATOR_REQUEST_ROW_KIND",
    "OPERATOR_REQUEST_STATUS_UNADDRESSED",
    "SIGNATURE_INVALID",
    "SIGNATURE_MALFORMED",
    "SIGNATURE_MISSING",
    "SIGNER_KID_MISSING",
    "SIGNER_KID_UNKNOWN",
    "SIGNING_DOMAIN",
    "VERIFICATION_REASONS",
    "OperatorFeedbackSignatureVerdict",
    "append_signed_operator_feedback_row",
    "canonical_signing_bytes",
    "operator_feedback_ledger_path",
    "operator_request_schema_valid",
    "record_operator_request",
    "rotate_signing_key",
    "sign_operator_feedback_row",
    "signing_key_path",
    "signing_keyring",
    "verify_operator_feedback_row",
]
