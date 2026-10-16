"""The one owner of the ``sha256:<64 lowercase hex>`` digest format (ARIA-LOW-517, E11-4).

WHY THIS EXISTS. No module owned the format. About 150 sites re-spelled the
``sha256:`` label; the validators diverged (``re.match`` that accepts a
trailing newline, prefix-only gates that pass ``sha256:abc``, ``len == 71``);
seven producers mint a *truncated* hex under the same label, so a value that
looks like a digest is not one; and a 96-bit truncation reached a signed
security grant through a prefix-only check. A format with no owner is
re-spelled by every caller, and nothing stops the next spelling.

WHAT IT OWNS. The label (private: a prefix-only check cannot be written
against it), the producers, the strict parsers, the validator, the one
legacy-bare policy, the truncated *fingerprint* form (whose value set is
disjoint from the digest set by construction) and the closed set of named
non-content values that may occupy a digest-labelled field. Every other module
calls these; none spells the label. The kernel's canonical JSON encoder is not
here: ``ledger.sha256_digest_of_canonical_json`` composes the two.

WHY A STDLIB LEAF. ``ledger`` composes over this module, and tools/aria-poc
imports it on kernel-dependent paths; an ``aria_kernel`` import here would be
a cycle for the first and drag the kernel into the second's closure.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from pathlib import Path
from typing import Final, TypeGuard

__all__ = [
    "ENVELOPE_UNREADABLE_SENTINEL",
    "SHA256_DIGEST_PATTERN",
    "ZERO_SHA256_DIGEST",
    "is_sha256_digest",
    "normalize_sha256_digest",
    "secret_matches_sha256_digest",
    "sha256_digest",
    "sha256_digest_file",
    "sha256_digest_from_hex",
    "sha256_digest_hex",
    "sha256_digest_text",
    "sha256_fingerprint",
    "sha256_fingerprint_hex",
    "sha256_hex",
]

# Private on purpose: exporting the label is what lets a caller write
# ``value.startswith(label)`` and call that validation.
_PREFIX: Final = "sha256:"
_HEX_DIGEST_CHARS: Final = 64
_HEX64: Final = re.compile(r"[0-9a-f]{64}")
_FINGERPRINT: Final = re.compile(_PREFIX + r"([0-9a-f]{1,63})")
_FILE_CHUNK_BYTES: Final = 1 << 20

# The full shape as a regex FRAGMENT, for composite grammars only (a digest
# embedded in a larger token). A whole value is checked with
# ``is_sha256_digest``, never with this fragment.
SHA256_DIGEST_PATTERN: Final = _PREFIX + r"[0-9a-f]{64}"
_DIGEST: Final = re.compile(SHA256_DIGEST_PATTERN)

# The all-zero digest: a contract field that must hold a digest when no
# content exists. Shape-valid, with no known preimage.
ZERO_SHA256_DIGEST: Final = _PREFIX + "0" * _HEX_DIGEST_CHARS
# Persisted in submit journals' ``envelope_evidence_hash`` when the envelope
# could not be read. Not a digest: ``is_sha256_digest`` rejects it.
ENVELOPE_UNREADABLE_SENTINEL: Final = _PREFIX + "envelope_unreadable"


def sha256_hex(data: bytes) -> str:
    """Bare lowercase 64-hex SHA-256 of ``data``: for ids and the integrity index, never a labelled digest."""
    return hashlib.sha256(data).hexdigest()


def sha256_digest(data: bytes) -> str:
    """``sha256:<64 lowercase hex>`` of ``data``."""
    return _PREFIX + sha256_hex(data)


def sha256_digest_text(text: str) -> str:
    """The digest of ``text`` encoded as strict UTF-8 (a lone surrogate raises ``UnicodeEncodeError``)."""
    return sha256_digest(text.encode("utf-8"))


def sha256_digest_file(path: str | Path) -> str:
    """The digest of the file's bytes, read in 1 MiB chunks.

    Raises ``OSError`` (``FileNotFoundError`` included). There is no
    empty-bytes digest for a missing file: each caller states its own
    missing-file policy.
    """
    hasher = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(_FILE_CHUNK_BYTES), b""):
            hasher.update(chunk)
    return sha256_digest_from_hex(hasher.hexdigest())


def sha256_digest_from_hex(hex_digest: str) -> str:
    """Label a precomputed hex digest. ``ValueError`` unless it is exactly 64 lowercase hex.

    The strictness is the point: a truncated or uppercase hex can never be
    labelled as a digest.
    """
    if not isinstance(hex_digest, str) or _HEX64.fullmatch(hex_digest) is None:
        raise ValueError("sha256_hex_digest_required")
    return _PREFIX + hex_digest


def is_sha256_digest(value: object) -> TypeGuard[str]:
    """True only for ``sha256:`` followed by exactly 64 lowercase hex, and nothing else.

    Any non-``str`` is False, so a caller needs no ``isinstance`` guard and a
    type checker narrows ``value`` to ``str`` on True.
    """
    return isinstance(value, str) and _DIGEST.fullmatch(value) is not None


def sha256_digest_hex(value: object) -> str | None:
    """The 64-hex body of a full digest; ``None`` for anything else, so each caller keeps its own error code."""
    if is_sha256_digest(value):
        return value[len(_PREFIX):]
    return None


def normalize_sha256_digest(value: object) -> str | None:
    """The one legacy-bare policy: a full digest, or a bare 64 lowercase hex, in the labelled form; else ``None``."""
    if is_sha256_digest(value):
        return value
    if isinstance(value, str) and _HEX64.fullmatch(value) is not None:
        return _PREFIX + value
    return None


def sha256_fingerprint(data: bytes, *, hex_chars: int) -> str:
    """A truncated label, ``sha256:<first hex_chars hex>``, for persisted short identities.

    NEVER a digest: ``1 <= hex_chars <= 63``, so ``is_sha256_digest`` rejects
    every fingerprint and the two value sets are disjoint. A ``bool`` is not a
    length.
    """
    if isinstance(hex_chars, bool) or not isinstance(hex_chars, int) or not 1 <= hex_chars < _HEX_DIGEST_CHARS:
        raise ValueError("sha256_fingerprint_length_out_of_range")
    return _PREFIX + sha256_hex(data)[:hex_chars]


def sha256_fingerprint_hex(value: object) -> str | None:
    """The 1..63-hex body of a fingerprint; ``None`` for anything else, a full digest included."""
    if not isinstance(value, str):
        return None
    match = _FINGERPRINT.fullmatch(value)
    return None if match is None else match.group(1)


def secret_matches_sha256_digest(secret: str, digest: object) -> bool:
    """Constant-time check that a stored digest is the digest of ``secret`` (lease tokens, holder secrets)."""
    return is_sha256_digest(digest) and hmac.compare_digest(digest, sha256_digest_text(secret))
