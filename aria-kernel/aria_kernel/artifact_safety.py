"""Central artifact safety boundary for ARIA executor outputs."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .secret_scrub import secret_patterns

# One pattern set, one policy: the compiled patterns live in
# secret_scrub (the typed cross-review scrubber) and are consumed here so
# the artifact boundary can never drift from it again. The local set this
# replaced carried a raw-string `=\\S+` that matches a literal
# backslash-S rather than non-whitespace, so `OPENAI_API_KEY=...` and
# `ARIA_LEASE_TOKEN=...` passed through executor artifacts unredacted.
SECRET_PATTERNS: tuple[re.Pattern[str], ...] = secret_patterns()

FORBIDDEN_REAL_MODE_ENV: frozenset[str] = frozenset({
    "CODEX_OSS_DEBUG",
})


class ArtifactSafetyError(RuntimeError):
    pass


def scrub_text(value: str) -> str:
    out = value
    for pattern in SECRET_PATTERNS:
        out = pattern.sub("<secret-redacted>", out)
    return out


def scrub_json(value: Any) -> Any:
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
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
                scrubbed[key_text] = "<secret-redacted>"
            else:
                scrubbed[key_text] = scrub_json(item)
        return scrubbed
    return value


def assert_real_mode_env_safe(env: dict[str, str]) -> None:
    for name in FORBIDDEN_REAL_MODE_ENV:
        if env.get(name) == "1":
            raise ArtifactSafetyError(f"{name}=1 is forbidden in ARIA real mode")


def write_sanitized_json(path: str | Path, payload: Any, *, max_bytes: int = 1_000_000) -> None:
    scrubbed = scrub_json(payload)
    raw = json.dumps(scrubbed, indent=2, sort_keys=True)
    if len(raw.encode("utf-8")) > max_bytes:
        raise ArtifactSafetyError(f"artifact exceeds max_bytes={max_bytes}: {path}")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(raw + "\n", encoding="utf-8")
    tmp.replace(target)


__all__ = [
    "ArtifactSafetyError",
    "assert_real_mode_env_safe",
    "scrub_json",
    "scrub_text",
    "write_sanitized_json",
]
