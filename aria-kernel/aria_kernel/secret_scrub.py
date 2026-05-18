"""Plan ARIA-V8 §4 Phase 8.0 (B-V2-10) — secret scrub helper.

WHY: cross-reviewer agent reads primary + challenger plan text from
disk; the plan text may quote evidence_refs derived from git diff
which can embed secrets (AWS keys, GitHub PATs, Anthropic API keys,
Bearer tokens, IP octets, emails). Cross-review output is persisted
to ``outputs/plan-<cycle_id>/round-N-cross_review-*.md`` — without
scrub, a secret quoted by the LLM leaks to disk.

HOW: regex sweep over a closed pattern set; matches are replaced with
``<REDACTED:type>``; pattern types (NEVER values) returned to caller
so a governance event can log WHAT was redacted without WHAT the
value was. Pattern set extends
``tools/aria-poc/agent_harness_security_adapter._SECRET_RES`` to
include IPv4 and email regexes.
"""
from __future__ import annotations

import re
from typing import Final


# Each tuple: (pattern_type_name, compiled_regex)
_SECRET_PATTERNS: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("github_pat", re.compile(r"ghp_[A-Za-z0-9]{36,}")),
    ("github_pat_long", re.compile(r"github_pat_[A-Za-z0-9_]{40,}")),
    ("anthropic_api_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{40,}")),
    ("openai_api_key", re.compile(r"sk-[A-Za-z0-9]{32,}")),
    ("bearer_token", re.compile(r"Bearer\s+[A-Za-z0-9._\-]{20,}")),
    ("basic_auth_password", re.compile(r"password\s*=\s*['\"][^'\"]{4,}['\"]")),
    ("token_assignment", re.compile(r"token\s*=\s*['\"][^'\"]{8,}['\"]")),
    ("ipv4_octet", re.compile(r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
)


def scrub_text(text: str) -> tuple[str, list[str]]:
    """Redact secrets in ``text``; return ``(scrubbed, redaction_types)``.

    redaction_types preserves match order and is suitable for emitting
    as a governance event payload. The raw matched strings are NEVER
    in the returned types list — only the pattern_type_name.
    """
    if not isinstance(text, str) or not text:
        return text, []
    scrubbed = text
    types: list[str] = []
    for type_name, pattern in _SECRET_PATTERNS:
        if pattern.search(scrubbed):
            scrubbed = pattern.sub(f"<REDACTED:{type_name}>", scrubbed)
            types.append(type_name)
    return scrubbed, types


def scrub_text_with_count(text: str) -> tuple[str, dict[str, int]]:
    """Variant: returns ``{pattern_type: match_count}`` instead of list.

    Useful for governance event payloads that prefer histogram shape.
    """
    if not isinstance(text, str) or not text:
        return text, {}
    scrubbed = text
    counts: dict[str, int] = {}
    for type_name, pattern in _SECRET_PATTERNS:
        matches = pattern.findall(scrubbed)
        if matches:
            counts[type_name] = len(matches)
            scrubbed = pattern.sub(f"<REDACTED:{type_name}>", scrubbed)
    return scrubbed, counts


def secret_pattern_types() -> tuple[str, ...]:
    """Expose pattern type names (for tests + governance schema)."""
    return tuple(name for name, _ in _SECRET_PATTERNS)
