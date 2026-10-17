"""Central artifact safety boundary for ARIA executor outputs."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterator

from .implementation_safety import SecretLeakDetected, verify_no_secret_in_diff
from .ledger import atomic_write_json
from .secret_scrub import CREDENTIAL_KEY_WORDS, UNIFORM_MARKER, credential_shapes_in, redact_secrets

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
    found four that each did part of this): a path under the store kept
    store-relative (``memory/beliefs.jsonl``), secret shapes redacted, any
    other absolute path reduced to its file name, then bounded. The
    redaction runs before the path reduction: reducing first cut a URL's
    ``//user:password@`` and a webhook's ``/services/`` path down to their
    last component, and the redaction no longer knew either (ARIA-MEDIUM-546).
    """
    out = str(text)
    if store_root is not None:
        for prefix in {Path(store_root).as_posix(), Path(store_root).resolve().as_posix()}:
            out = out.replace(f"{prefix}/", "")
    return _ABSOLUTE_PATH.sub(r"\1", scrub_text(out))[:limit]


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
            # keys stay masked (lease_token, oauth token, ...). The key words
            # are the credential table's (ARIA-HIGH-448 added the password
            # and private-key names a tool's JSON input or config carries).
            sensitive_key = any(word in key_text.lower() for word in CREDENTIAL_KEY_WORDS)
            if sensitive_key and isinstance(item, str):
                scrubbed[key_text] = UNIFORM_MARKER
            else:
                scrubbed[key_text] = scrub_json(item)
        return scrubbed
    return value


def scrub_transcript(text: str) -> str:
    """A run's transcript with every secret shape redacted, line for line.

    ARIA-HIGH-448 — every executor lane wrote the run's stdout to its
    transcript raw, and the kernel seals those bytes content-addressed and
    publishes them on aria/state: a key a tool read, echoed or was handed
    reached the store verbatim. A transcript is JSON Lines (Claude
    stream-json, Codex events, a vendor's JSON body, the executor's own
    records), so each line that parses is scrubbed as data (``scrub_json``:
    secret shapes in every string, and a string under a credential-named
    key) and written back compact, keys in their order, non-ASCII as is, so
    every reader still parses the same events; a line with nothing to redact
    keeps its exact bytes. A line that does not parse (a vendor's prose, a
    pretty-printed fragment) goes through ``scrub_text``.
    """
    lines = text.split("\n")
    for index, line in enumerate(lines):
        body = line.rstrip("\r")
        if not body.strip():
            continue
        try:
            parsed = json.loads(body)
        except ValueError:
            lines[index] = scrub_text(line)
            continue
        scrubbed = scrub_json(parsed)
        if scrubbed != parsed:
            lines[index] = json.dumps(scrubbed, ensure_ascii=False, separators=(",", ":")) + line[len(body):]
    return "\n".join(lines)


def write_sanitized_transcript(path: str | Path, text: str) -> None:
    """THE transcript write of every executor lane (ARIA-HIGH-448): scrubbed
    before the bytes exist, so the hash the executor submits and the kernel
    seals is the scrubbed bytes' and nothing raw reaches the store."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(scrub_transcript(text), encoding="utf-8")


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


def sanitized_json_text(document: Any, *, where: str | Path, **dumps: Any) -> str:
    """The JSON text a publishing writer may write for an already-scrubbed ``document``.

    The one encoding step of every published JSON writer (ARIA-LOW-547: the
    run-artifact writer encoded ``scrub_json(payload)`` itself and refused
    nothing). It refuses a credential-shaped mapping key (``scrub_json``
    never rewrites a key), encodes with the writer's own ``json.dumps``
    options, and refuses a refusal hit in the encoded text: escaping can form
    one the raw strings did not hold (``ensure_ascii`` writes an e-circumflex
    as an escape that ends in ``a``). Raises ``ArtifactSafetyError`` naming
    shape types, never a value; returns only text the kernel would not refuse.
    """
    refuse_credential_keys(document, where=where)
    text = json.dumps(document, **dumps)
    refuse_unredacted_credentials(text, where=where)
    return text


def write_sanitized_json(path: str | Path, payload: Any, *, max_bytes: int = 1_000_000) -> None:
    scrubbed = scrub_json(payload)
    # The size and the refusal scan read the bytes the format owner
    # (ledger.atomic_write_json) writes.
    raw = sanitized_json_text(scrubbed, where=path, indent=2, sort_keys=True)
    if len(raw.encode("utf-8")) > max_bytes:
        raise ArtifactSafetyError(f"artifact exceeds max_bytes={max_bytes}: {path}")
    atomic_write_json(Path(path), scrubbed)


__all__ = [
    "ArtifactSafetyError",
    "assert_real_mode_env_safe",
    "refuse_credential_keys",
    "refuse_unredacted_credentials",
    "sanitized_json_text",
    "scrub_json",
    "scrub_text",
    "write_sanitized_json",
]
