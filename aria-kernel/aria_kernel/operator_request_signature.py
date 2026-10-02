"""ADR-0020 — an operator plan request is signed by the operator, not by the runner.

WHY. The request rows the plan synthesizer ranks at priority 0 used to carry
a keyed HMAC the kernel minted on first use under
``aria-tools/secrets/operator-feedback-hmac.key``. That key lived on the
runner, so the signature attested "a process with the runner uid wrote this
row" — exactly the population the signature was meant to exclude. It was
also never published with the state store and the self-hosted lanes'
``git clean -ffdx`` swept it at job start (``aria-auto-cycle.yml``), so no
later job could verify a row, and the pre-merge perimeter (check 12) runs on
GitHub-hosted runners that never held it: an operator-sourced plan could not
merge by construction.

WHAT. The operator signs with an ed25519 key held off-runner through
``ssh-keygen -Y sign`` under the namespace :data:`SIGNATURE_NAMESPACE`; the
verifier needs only the allowed-signers file committed at
:data:`ALLOWED_SIGNERS_PATH`, read as a git OBJECT at a commit proven on
``main`` through the hardened reader of :mod:`main_anchor` (scrubbed git
environment, replace objects off, blob re-hashed) — never the working tree,
never a commit the checkout merely points at. ``.github/`` is in
``implementation_safety.READONLY_PATHS``, so ARIA cannot enrol a key for
itself; enrolment and rotation are reviewed pull requests. No signing
material exists anywhere a runner uid can read.

The kernel-written row kinds of the same ledger (verdict rows, calibration
fixtures) keep their HMAC in ``operator_feedback_signature``; they are never
plan candidates, and nothing here verifies them.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from .main_anchor import committed_blob, resolve_main_anchor
from .tool_registry import GovernanceError

SIGNATURE_NAMESPACE = "aria-operator-request"
ALLOWED_SIGNERS_PATH = ".github/manifests/aria-operator-signers"
# Domain separation inside the signed bytes, distinct from the HMAC rows'
# ``aria-operator-feedback/v1``: a signature over one subject verifies as
# no other.
SIGNING_DOMAIN = b"aria-operator-request/v1\n"
# Chain metadata is stamped by the ledger after signing; ``signature`` is
# the field being computed. Everything else — the principal included — is
# signed, so a row cannot be re-attributed without breaking it.
_SIGNING_EXCLUDED_FIELDS: frozenset[str] = frozenset({
    "signature", "ledger_hash", "previous_ledger_hash",
})
# The operator-signed request row format (ADR-0018/0020). Fixed in the
# subject BEFORE signing: the ledger stamps a missing ``schema_version`` on
# append, and a subject that changes between signing and storage never
# verifies.
REQUEST_ROW_SCHEMA_VERSION = 2
# The principal reaches ssh-keygen's argv as ``-I``: a closed charset with
# no leading dash keeps a row from smuggling an option.
_PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$")
_ARMOR_RE = re.compile(
    r"\A-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+-----END SSH SIGNATURE-----\n?\Z"
)
MAX_SIGNATURE_CHARS = 4096
_VERIFY_TIMEOUT_SECONDS = 15
# Signing is an operator act at a terminal: an encrypted key prompts for its
# passphrase on the tty, which takes longer than a verifier ever should.
_SIGN_TIMEOUT_SECONDS = 300
_GIT_TIMEOUT_SECONDS = 15

# Closed vocabulary of verification failures, spoken by the ingestion
# governance event and by the pre-merge evidence alike.
SIGNATURE_MISSING = "signature_missing"
SIGNATURE_MALFORMED = "signature_malformed"
SIGNER_PRINCIPAL_MISSING = "signer_principal_missing"
SIGNER_PRINCIPAL_INVALID = "signer_principal_invalid"
ALLOWED_SIGNERS_UNAVAILABLE = "allowed_signers_unavailable"
SIGNER_NOT_ENROLLED = "signer_not_enrolled"
VERIFIER_UNAVAILABLE = "signature_verifier_unavailable"
VERIFICATION_TIMEOUT = "signature_verification_timeout"
SIGNATURE_INVALID = "signature_invalid"
VERIFICATION_REASONS: tuple[str, ...] = (
    SIGNATURE_MISSING, SIGNATURE_MALFORMED, SIGNER_PRINCIPAL_MISSING,
    SIGNER_PRINCIPAL_INVALID, ALLOWED_SIGNERS_UNAVAILABLE, SIGNER_NOT_ENROLLED,
    VERIFIER_UNAVAILABLE, VERIFICATION_TIMEOUT, SIGNATURE_INVALID,
)
# The runner could not judge the row (no anchor, no verifier, a verifier
# that hung). Never evidence against the request, so never a reason to
# spend it (ADR-0018, arbiter ruling iii).
VERIFICATION_RUNNER_FAULTS: frozenset[str] = frozenset({
    ALLOWED_SIGNERS_UNAVAILABLE, VERIFIER_UNAVAILABLE, VERIFICATION_TIMEOUT,
})


@dataclass(frozen=True)
class OperatorRequestVerdict:
    """One request row's verification: valid with the principal that signed it, or a reason."""

    valid: bool
    signer: str | None
    reason: str | None


def request_signing_bytes(row: dict[str, Any]) -> bytes:
    """Domain tag + canonical JSON of the row minus chain fields and the signature.

    Same canonicalisation as ``operator_feedback_signature.canonical_signing_bytes``
    (sorted keys, no whitespace, ASCII) so a row that round-trips through the
    ledger verifies byte-for-byte.
    """
    subject = {key: value for key, value in row.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    encoded = json.dumps(subject, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return SIGNING_DOMAIN + encoded.encode("utf-8")


def valid_principal(value: Any) -> bool:
    return isinstance(value, str) and _PRINCIPAL_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class AllowedSigners:
    """The trust anchor's bytes and where they came from (recorded per ingestion)."""

    content: bytes
    commit: str
    blob_oid: str


def allowed_signers_at(repo_root: str | Path, *, commit: str) -> AllowedSigners | None:
    """The allowed-signers file as committed at ``commit``, read through the hardened git.

    ``main_anchor.committed_blob``: a scrubbed environment, replace objects
    off, the blob re-hashed against its object id. None is not a pass —
    every caller turns it into :data:`ALLOWED_SIGNERS_UNAVAILABLE`.
    """
    blob = committed_blob(repo_root, commit=commit, path=ALLOWED_SIGNERS_PATH)
    if blob is None or not blob.content.strip():
        return None
    return AllowedSigners(content=blob.content, commit=blob.commit, blob_oid=blob.blob_oid)


def allowed_signers_for_checkout(repo_root: str | Path) -> tuple[AllowedSigners | None, str | None]:
    """The anchor a cycle (or the recorder) may trust: its checkout's commit, proven on main.

    Returns ``(anchor, None)`` or ``(None, reason)`` with a
    ``main_anchor.ANCHOR_*`` reason, or :data:`ALLOWED_SIGNERS_UNAVAILABLE`
    when the proven commit carries no allowed-signers file.
    """
    anchor = resolve_main_anchor(repo_root)
    if anchor.commit is None:
        return None, anchor.reason
    signers = allowed_signers_at(repo_root, commit=anchor.commit)
    return (signers, None) if signers is not None else (None, ALLOWED_SIGNERS_UNAVAILABLE)


def request_subject_digest(row: dict[str, Any]) -> str:
    """``sha256:`` of the signed subject — the request's identity beyond its id."""
    return "sha256:" + hashlib.sha256(request_signing_bytes(row)).hexdigest()


def enrolled_principals(allowed_signers: bytes) -> frozenset[str]:
    """Principals the allowed-signers file names (first field, comma-separated).

    Used only to name ``signer_not_enrolled`` before ssh-keygen runs; the
    binding of key, principal and namespace is ssh-keygen's to judge.
    """
    principals: set[str] = set()
    for raw in allowed_signers.decode("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        principals.update(part for part in line.split()[0].split(",") if part)
    return frozenset(principals)


def sign_operator_request(
    row: dict[str, Any], *, signing_key: str | Path, signer_principal: str,
    subject_stream: TextIO | None = None,
) -> dict[str, Any]:
    """Return ``row`` plus ``signer_principal`` and the armored ``signature``.

    ``signing_key`` is the operator's private key, or its public half when
    the private key sits in ssh-agent; the kernel passes the path through to
    ssh-keygen and never reads, copies or stores it. The subject travels by
    file so stdin stays the operator's terminal for a passphrase prompt, and
    the file lives in a fresh private directory so ssh-keygen never meets an
    existing ``.sig`` it would ask to overwrite.

    ``subject_stream`` (the recorder passes stderr) receives the exact bytes
    about to be signed BEFORE ssh-keygen runs, so the operator signs what
    they read, not what a process between them and the key assembled
    (security-reviewer GSEC-MEDIUM-005).
    """
    if not isinstance(row, dict):
        raise GovernanceError("operator_request_row_must_be_object")
    if not valid_principal(signer_principal):
        raise GovernanceError(f"operator_request_signer_principal_invalid: {signer_principal!r}")
    key_path = Path(signing_key).expanduser()
    if not key_path.is_file():
        raise GovernanceError(f"operator_request_signing_key_missing: {key_path.as_posix()}")
    keygen = shutil.which("ssh-keygen")
    if keygen is None:
        raise GovernanceError("operator_request_signing_unavailable: ssh-keygen not on PATH")
    subject = {key: value for key, value in row.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    subject.setdefault("schema_version", REQUEST_ROW_SCHEMA_VERSION)
    subject["signer_principal"] = signer_principal
    subject_bytes = request_signing_bytes(subject)
    if subject_stream is not None:
        subject_stream.write("aria-kernel: signing this subject (namespace "
                             f"{SIGNATURE_NAMESPACE}):\n{subject_bytes.decode('ascii')}\n")
        subject_stream.flush()
    with tempfile.TemporaryDirectory(prefix="aria-operator-request-") as scratch:
        data_path = Path(scratch) / "request"
        data_path.write_bytes(subject_bytes)
        try:
            proc = subprocess.run(
                [keygen, "-Y", "sign", "-f", str(key_path),
                 "-n", SIGNATURE_NAMESPACE, str(data_path)],
                capture_output=True, text=True, check=False, timeout=_SIGN_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise GovernanceError("operator_request_signing_timeout: ssh-keygen did not return") from exc
        signature_path = data_path.with_name(data_path.name + ".sig")
        if proc.returncode != 0 or not signature_path.is_file():
            raise GovernanceError(f"operator_request_signing_failed: {proc.stderr.strip()[:200]}")
        signed = dict(subject)
        signed["signature"] = signature_path.read_text(encoding="ascii")
    return signed


def verify_operator_request(
    row: Any, *, allowed_signers: bytes | None,
) -> OperatorRequestVerdict:
    """Verify one request row against the committed allowed-signers bytes.

    Fail-closed at every step: an absent verifier, an absent anchor or a
    verifier that hangs is a named reason, never a pass.
    """
    if not isinstance(row, dict):
        return OperatorRequestVerdict(False, None, SIGNATURE_MISSING)
    signature = row.get("signature")
    if not isinstance(signature, str) or not signature:
        return OperatorRequestVerdict(False, None, SIGNATURE_MISSING)
    if len(signature) > MAX_SIGNATURE_CHARS or _ARMOR_RE.fullmatch(signature) is None:
        return OperatorRequestVerdict(False, None, SIGNATURE_MALFORMED)
    principal = row.get("signer_principal")
    if not isinstance(principal, str) or not principal:
        return OperatorRequestVerdict(False, None, SIGNER_PRINCIPAL_MISSING)
    if not valid_principal(principal):
        return OperatorRequestVerdict(False, None, SIGNER_PRINCIPAL_INVALID)
    if not allowed_signers:
        return OperatorRequestVerdict(False, principal, ALLOWED_SIGNERS_UNAVAILABLE)
    if principal not in enrolled_principals(allowed_signers):
        return OperatorRequestVerdict(False, principal, SIGNER_NOT_ENROLLED)
    # Resolved once and executed by absolute path: the binary that was
    # checked is the binary that runs (security-reviewer GSEC-LOW-006).
    keygen = shutil.which("ssh-keygen")
    if keygen is None:
        return OperatorRequestVerdict(False, principal, VERIFIER_UNAVAILABLE)
    with tempfile.TemporaryDirectory(prefix="aria-operator-verify-") as scratch:
        allowed_path = Path(scratch) / "allowed_signers"
        allowed_path.write_bytes(allowed_signers)
        signature_path = Path(scratch) / "request.sig"
        signature_path.write_text(signature, encoding="ascii")
        try:
            proc = subprocess.run(
                [keygen, "-Y", "verify", "-f", str(allowed_path), "-I", principal,
                 "-n", SIGNATURE_NAMESPACE, "-s", str(signature_path)],
                input=request_signing_bytes(row), capture_output=True, check=False,
                timeout=_VERIFY_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return OperatorRequestVerdict(False, principal, VERIFICATION_TIMEOUT)
        except OSError:
            return OperatorRequestVerdict(False, principal, VERIFIER_UNAVAILABLE)
    if proc.returncode != 0:
        return OperatorRequestVerdict(False, principal, SIGNATURE_INVALID)
    return OperatorRequestVerdict(True, principal, None)


__all__ = [
    "ALLOWED_SIGNERS_PATH",
    "ALLOWED_SIGNERS_UNAVAILABLE",
    "MAX_SIGNATURE_CHARS",
    "REQUEST_ROW_SCHEMA_VERSION",
    "SIGNATURE_INVALID",
    "SIGNATURE_MALFORMED",
    "SIGNATURE_MISSING",
    "SIGNATURE_NAMESPACE",
    "SIGNER_NOT_ENROLLED",
    "SIGNER_PRINCIPAL_INVALID",
    "SIGNER_PRINCIPAL_MISSING",
    "SIGNING_DOMAIN",
    "VERIFICATION_REASONS",
    "VERIFICATION_TIMEOUT",
    "VERIFIER_UNAVAILABLE",
    "VERIFICATION_RUNNER_FAULTS",
    "AllowedSigners",
    "OperatorRequestVerdict",
    "allowed_signers_at",
    "allowed_signers_for_checkout",
    "enrolled_principals",
    "request_signing_bytes",
    "request_subject_digest",
    "sign_operator_request",
    "valid_principal",
    "verify_operator_request",
]
