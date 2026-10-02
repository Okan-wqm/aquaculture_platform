"""V9.5 hard-fail check 12 — who signs each row of ``operator-feedback.jsonl``.

WHY: ``aria-tools/operator-feedback.jsonl`` carries the highest-priority plan
source (``PlanCandidateSource.OPERATOR_FEEDBACK`` outranks every discovered
lane), and until check 12 the "signature" the synthesizer demanded was field
PRESENCE: any process that could append a line carrying ``"signature": "x"``
spoke with operator authority (ai-safety HIGH-010).

WHAT: two row families share the ledger and are signed by two different
parties.

* Kernel-written rows — verdict rows from ``feedback_store`` and corpus
  fixtures from ``calibration_bootstrap`` — carry a keyed HMAC-SHA256 under
  key material the kernel holds at
  ``aria-tools/secrets/operator-feedback-hmac.key`` (0600, rolling list,
  ``signer_kid`` = key id, :mod:`hmac_keyring`). The signature attests "the
  kernel recorded this row"; these rows are never plan candidates. Every
  kernel writer routes through :func:`append_signed_operator_feedback_row`.
* Operator REQUEST rows (``row_kind`` ``operator_request``) are the plan
  source. ADR-0020: they are signed by the operator with an ed25519 key held
  off-runner and verified against the committed allowed-signers file
  (:mod:`operator_request_signature`). The runner-held HMAC key could not
  carry that authority — any runner-uid process could mint with it, the
  self-hosted lanes swept it at job start, and the GitHub-hosted merge lane
  never held it. :func:`record_operator_request` is the one writer; a request
  row must name the F finding it is about (ADR-0018).
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
from .operator_request_signature import REQUEST_ROW_SCHEMA_VERSION
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

# The plan-request row the synthesizer consumes. ``status`` /
# ``row_kind`` are what the scanner keys on; ``priority`` is a closed set
# (arb CRIT-006 — an invented "max" must not outrank the severity ladder).
# Schema version 2 is the operator-signed shape (ADR-0020) that names its
# finding (ADR-0018); a version-1 row was signed by the runner's HMAC key
# and carries no operator authority.
OPERATOR_REQUEST_ROW_KIND = "operator_request"
OPERATOR_REQUEST_SCHEMA_VERSION = REQUEST_ROW_SCHEMA_VERSION
OPERATOR_REQUEST_PRIORITIES: tuple[str, ...] = ("low", "medium", "high")
OPERATOR_REQUEST_STATUS_UNADDRESSED = "unaddressed"
MAX_OPERATOR_REQUEST_CHARS = 4096
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
# The request names one of ARIA's own F findings (ADR-0018): the kernel's
# allocator form, so `F-1000` after `F-999` is a valid target.
_REQUEST_FINDING_ID_RE = re.compile(r"^F-\d{3,}$")
# Schema-refusal vocabulary, beside the signature reasons of
# ``operator_request_signature.VERIFICATION_REASONS``.
FINDING_ID_MISSING = "finding_id_missing"
FINDING_ID_INVALID = "finding_id_invalid"
SCHEMA_INVALID = "schema_invalid"

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
    """The ONE kernel write path for kernel-written rows: HMAC-sign, then append.

    Returns the stored row (with chain fields). Every kernel writer of a
    verdict or calibration row calls this; ``tests/test_operator_feedback_signature.py``
    pins that no other kernel module appends to the surface. A request row
    is refused here (ADR-0020): the runner's key cannot speak for the
    operator, so the kernel has no path to mint one with it.
    """
    if is_operator_request_row(row):
        raise GovernanceError("operator_request_rows_are_operator_signed")
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


def is_operator_request_row(row: Any) -> bool:
    """A row that asks for a plan — judged by either marker, so a row that
    drops one of them is refused as a request instead of ignored as a verdict."""
    return isinstance(row, dict) and (
        row.get("status") == OPERATOR_REQUEST_STATUS_UNADDRESSED
        or row.get("row_kind") == OPERATOR_REQUEST_ROW_KIND
    )


def record_operator_request(
    *,
    request: str,
    priority: str,
    authored_by: str,
    finding_id: str,
    signing_key: str | Path,
    signer_principal: str,
    request_id: str | None = None,
    base_dir: str | Path | None = None,
    repo_root: str | Path = ".",
) -> dict[str, Any]:
    """The kernel-owned writer for the plan-request rows the synthesizer mines.

    WHY: a request is an operator act, so the operator signs it (ADR-0020)
    and names the F finding it wants planned (ADR-0018); the CLI verb
    ``aria-kernel feedback request`` is the channel. The recorder refuses
    what ingestion would refuse, so a row that can never be admitted is
    never written: a reused id, a malformed finding id, and a signature the
    allowed-signers file committed at ``repo_root``'s HEAD does not verify.
    """
    from .operator_request_signature import (
        committed_allowed_signers,
        sign_operator_request,
        verify_operator_request,
    )

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
    target = str(finding_id or "").strip()
    if _REQUEST_FINDING_ID_RE.fullmatch(target) is None:
        raise GovernanceError(f"operator_request_finding_id_invalid: {finding_id!r}")
    identifier = str(request_id or "").strip() or f"OP-{uuid.uuid4()}"
    if _REQUEST_ID_RE.fullmatch(identifier) is None:
        raise GovernanceError(f"operator_request_id_invalid: {identifier!r}")
    root = ensure_tools_dir(base_dir)
    ledger = root / OPERATOR_FEEDBACK_LEDGER_NAME
    if any(row.get("id") == identifier for row in _request_rows(ledger, root)):
        raise GovernanceError(f"operator_request_id_reused: {identifier!r}")
    row = sign_operator_request({
        "schema_version": OPERATOR_REQUEST_SCHEMA_VERSION,
        "row_kind": OPERATOR_REQUEST_ROW_KIND,
        "id": identifier,
        "finding_id": target,
        "authored_at": utc_now(),
        "authored_by": author,
        "request": text,
        "priority": priority,
        "status": OPERATOR_REQUEST_STATUS_UNADDRESSED,
    }, signing_key=signing_key, signer_principal=signer_principal)
    verdict = verify_operator_request(
        row, allowed_signers=committed_allowed_signers(repo_root, rev="HEAD"),
    )
    if not verdict.valid:
        raise GovernanceError(f"operator_request_signature_unverified: {verdict.reason}")
    stored = append_declared_jsonl(ledger, row, expected_surface=OPERATOR_FEEDBACK_SURFACE)
    from .tool_registry import append_tools_governance

    append_tools_governance(root, "operator_request_recorded", {
        "id": identifier,
        "finding_id": target,
        "priority": priority,
        "signer": verdict.signer,
        "ledger_hash": stored.get("ledger_hash"),
    })
    return stored


def _request_rows(ledger: Path, root: Path) -> list[dict[str, Any]]:
    from .strict_jsonl_reader import read_strict_jsonl

    if not ledger.exists():
        return []
    return [row for row in read_strict_jsonl(ledger, on_corruption="tolerant", base_dir=root)
            if is_operator_request_row(row)]


def operator_request_schema_reason(row: dict[str, Any]) -> str | None:
    """Why a request row is not one the synthesizer consumes, or None.

    Kept separate from signature verification so the drop reason can say
    which of the two failed: a validly signed row without a finding id is
    a malformed operator act, still refused.
    """
    finding_id = row.get("finding_id")
    if not isinstance(finding_id, str) or not finding_id.strip():
        return FINDING_ID_MISSING
    if _REQUEST_FINDING_ID_RE.fullmatch(finding_id) is None:
        return FINDING_ID_INVALID
    for field in ("id", "authored_at", "request", "priority", "status"):
        value = row.get(field)
        if not isinstance(value, str) or not value.strip():
            return SCHEMA_INVALID
    if _REQUEST_ID_RE.fullmatch(row["id"]) is None:
        return SCHEMA_INVALID
    if row["priority"] not in OPERATOR_REQUEST_PRIORITIES:
        return SCHEMA_INVALID
    return None


__all__ = [
    "FINDING_ID_INVALID",
    "FINDING_ID_MISSING",
    "MAX_OPERATOR_REQUEST_CHARS",
    "OPERATOR_FEEDBACK_LEDGER_NAME",
    "OPERATOR_FEEDBACK_SURFACE",
    "OPERATOR_REQUEST_PRIORITIES",
    "OPERATOR_REQUEST_ROW_KIND",
    "OPERATOR_REQUEST_SCHEMA_VERSION",
    "OPERATOR_REQUEST_STATUS_UNADDRESSED",
    "SIGNATURE_INVALID",
    "SIGNATURE_MALFORMED",
    "SIGNATURE_MISSING",
    "SCHEMA_INVALID",
    "SIGNER_KID_MISSING",
    "SIGNER_KID_UNKNOWN",
    "SIGNING_DOMAIN",
    "VERIFICATION_REASONS",
    "OperatorFeedbackSignatureVerdict",
    "append_signed_operator_feedback_row",
    "canonical_signing_bytes",
    "is_operator_request_row",
    "operator_feedback_ledger_path",
    "operator_request_schema_reason",
    "record_operator_request",
    "rotate_signing_key",
    "sign_operator_feedback_row",
    "signing_key_path",
    "signing_keyring",
    "verify_operator_feedback_row",
]
