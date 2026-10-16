"""Central artifact safety boundary for ARIA executor outputs."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterator

from .implementation_safety import SecretLeakDetected, verify_no_secret_in_diff
from .ledger import atomic_write_json
from .secret_scrub import UNIFORM_MARKER, credential_shapes_in, redact_secrets

FORBIDDEN_REAL_MODE_ENV: frozenset[str] = frozenset({
    "CODEX_OSS_DEBUG",
})


class ArtifactSafetyError(RuntimeError):
    pass


def scrub_text(value: str) -> str:
    """The redact view of secret_scrub.CREDENTIAL_SHAPES, the one credential table.

    The boundary runs the table's own redactor instead of a loop of its own,
    so the table's import-time proof (the redact view removes every shape
    the kernel's refusal set fires on, implementation_safety.SECRET_SCAN_PATTERNS)
    covers the code that runs here (ARIA-HIGH-519).
    """
    return redact_secrets(value)


# An absolute POSIX path inside free text; group 1 is its last component.
_ABSOLUTE_PATH = re.compile(r"(?<![\w.\-~])/(?:[^\s/:'\"]+/)*([^\s/:'\"]+)")


def published_text(text: Any, *, store_root: Path | None, limit: int) -> str:
    """Free text as it may leave the host: on aria/state or a GitHub issue.

    Both places are public. A failure's text — a phase's error, a crashed
    cycle's exception, a refusal, a human-required reason — routinely names
    host paths and can carry anything an exception or an agent put into it.
    One sanitizer for all of them (the review of the 2026-10-10 repair stack
    found four that each did part of this): secret shapes redacted, a path
    under the store kept store-relative (``memory/beliefs.jsonl``), any other
    absolute path reduced to its file name, then bounded.
    """
    out = str(text)
    if store_root is not None:
        for prefix in {Path(store_root).as_posix(), Path(store_root).resolve().as_posix()}:
            out = out.replace(f"{prefix}/", "")
    return scrub_text(_ABSOLUTE_PATH.sub(r"\1", out))[:limit]


def scrub_json(value: Any) -> Any:
    if isinstance(value, str):
        return scrub_text(value)
    # json.dumps writes a tuple as an array, so its strings are scrubbed too.
    if isinstance(value, (list, tuple)):
        return [scrub_json(item) for item in value]
    if isinstance(value, dict):
        scrubbed: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            # A credential is a STRING; a counter is a number. The key
            # substring "token" also matches every usage counter the Claude
            # CLI reports (input_tokens, output_tokens, cache_read_...), and
            # masking those blinded cost telemetry while protecting nothing —
            # an integer cannot leak a secret. String values under token-ish
            # keys stay masked (lease_token, oauth token, ...).
            sensitive_key = any(
                token in key_text.lower()
                for token in ("token", "secret", "api_key", "apikey")
            )
            if sensitive_key and isinstance(item, str):
                scrubbed[key_text] = UNIFORM_MARKER
            else:
                scrubbed[key_text] = scrub_json(item)
        return scrubbed
    return value


def assert_real_mode_env_safe(env: dict[str, str]) -> None:
    for name in FORBIDDEN_REAL_MODE_ENV:
        if env.get(name) == "1":
            raise ArtifactSafetyError(f"{name}=1 is forbidden in ARIA real mode")


def refuse_unredacted_credentials(text: str, *, where: str | Path) -> None:
    """Raise ``ArtifactSafetyError`` when the kernel's refusal set fires on ``text``.

    The boundary's last word before bytes leave it: what it publishes is
    never something the kernel would refuse as a secret. For raw text the
    redaction covers the refusal set by construction (secret_scrub's table
    check). This still fires on serialized bytes the redaction never saw:
    a credential in a JSON key, or a hit that JSON escaping forms (an escape
    such as ``\\u00ea`` ends in ``a``, so an e-circumflex followed by
    ``ws_secret_access_key=`` serializes into a refusal hit), and on an
    incomplete redact view. The message names pattern counts, never a value.
    """
    try:
        verify_no_secret_in_diff(text)
    except SecretLeakDetected as exc:
        raise ArtifactSafetyError(f"artifact_credential_shape_unredacted: {where}: {exc}") from None


def _mapping_keys(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _mapping_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _mapping_keys(item)


def refuse_credential_keys(payload: Any, *, where: str | Path) -> None:
    """Raise ``ArtifactSafetyError`` when a mapping key carries a credential shape.

    ``scrub_json`` never rewrites a key (two keys could collapse into one),
    so a key holding a credential the redact view would remove from a value
    is refused instead of written. PII rows are not credentials: maps keyed
    by an address or an e-mail stay writable. The message names shape types,
    never a key.
    """
    shapes = sorted({name for key in _mapping_keys(payload) for name in credential_shapes_in(key)})
    if shapes:
        raise ArtifactSafetyError(f"artifact_credential_in_key: {where}: {shapes}")


def write_sanitized_json(path: str | Path, payload: Any, *, max_bytes: int = 1_000_000) -> None:
    scrubbed = scrub_json(payload)
    refuse_credential_keys(scrubbed, where=path)
    raw = json.dumps(scrubbed, indent=2, sort_keys=True)
    if len(raw.encode("utf-8")) > max_bytes:
        raise ArtifactSafetyError(f"artifact exceeds max_bytes={max_bytes}: {path}")
    # The size and the refusal scan read the bytes the format owner writes.
    refuse_unredacted_credentials(raw, where=path)
    atomic_write_json(Path(path), scrubbed)


__all__ = [
    "ArtifactSafetyError",
    "assert_real_mode_env_safe",
    "refuse_credential_keys",
    "refuse_unredacted_credentials",
    "scrub_json",
    "scrub_text",
    "write_sanitized_json",
]
