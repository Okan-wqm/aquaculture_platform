"""Plan ARIA-V3.1-P — text-safety primitives for prompt-boundary defense.

Closes:

* C-4 (delimiter smuggling) — the prior `_implementation_suggested_prompt`
  embedded converged_plan_text + cross_review_summary_text via raw
  f-strings. A planner that crafts the literal sequence
  `</untrusted_converged_plan>` inside its plan text closes the delimiter
  early + smuggles authoritative instructions. V3.1-B's prompt rewrite
  uses `encode_untrusted_delimited_payload` (Mode B base64) so the
  payload is structurally incapable of carrying ASCII delimiters.
* C-5 (ORPHAN body injection) — `convert_candidate_to_plan_content`
  copies operator-prose + LLM-authored strings from external sources
  (orphan-findings.md, F-NNN.json, gh run logs, operator-feedback rows)
  into plan_content fields that eventually reach the convergence
  prompt. `sanitize_untrusted_text` strips bidi + control chars +
  HTML-encodes `<` / `>` BEFORE the string enters plan_content.

Tier-1 (Make impossible):

* `encode_untrusted_delimited_payload` (Mode B) wraps the payload in
  base64. The `<untrusted_*>` delimiter ASCII cannot appear inside a
  base64 string (alphabet is `[A-Za-z0-9+/=]`). The agent prompt
  declares "untrusted blocks are base64-encoded; decode before
  reading" so a delimiter-smuggle attempt becomes structurally
  impossible.

Tier-3 (Detect):

* `sanitize_untrusted_text` (Mode A HTML-encode) is the defense-in-
  depth path for fields where the consumer cannot decode (e.g. the
  cycle summary's `plan_content_keys` row). The bidi+control strip
  closes Trojan Source (CVE-2021-42574) at the field boundary.
"""
from __future__ import annotations

import base64
import re


# Plan ARIA-V3.1-P — bidi override + control char strip set.
# Strips:
#   * U+0000-001F + U+007F (control), EXCEPT U+0009 (tab) +
#     U+000A (LF) + U+000D (CR) which are allowed for legible
#     multi-line operator-prose
#   * U+202A-202E + U+2066-2069 (bidi override / Trojan Source)
_BIDI_AND_CONTROL_RE = re.compile(
    r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F‪-‮⁦-⁩]"
)


def sanitize_untrusted_text(text: str, *, max_len: int = 1024) -> str:
    """Plan ARIA-V3.1-P — HTML-encode + strip bidi/control + cap length.

    Use BEFORE any LLM-authored or operator-prose string is embedded
    into a plan_content field that reaches an LLM prompt. The helper
    is a Tier-3 detect primitive — it makes adversarial-payload
    detection trivial (HTML-encoded `&lt;` is visible in audit logs
    where raw `<` would smuggle) without rejecting the field outright.

    Operations (in order):

    1. Strip bidi override + control chars (U+202A-202E + U+2066-2069
       + U+0000-001F minus tab/newline/CR + U+007F).
    2. HTML-encode `<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;` (in that
       order — the `&` encode happens FIRST so `&lt;` literal in the
       source survives intact).
    3. Cap at `max_len` chars; truncate marker `...[truncated]`
       appended when the cap fires.

    Returns the sanitized string. Never raises; non-str input is
    coerced to str via `str(text)`.
    """
    if not isinstance(text, str):
        text = str(text)
    # Bidi + control strip.
    cleaned = _BIDI_AND_CONTROL_RE.sub("", text)
    # HTML-encode (& first to preserve literal `&lt;` in the source).
    cleaned = cleaned.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Length cap.
    if len(cleaned) > max_len:
        marker = "...[truncated]"
        cleaned = cleaned[: max_len - len(marker)] + marker
    return cleaned


def encode_untrusted_delimited_payload(
    text: str, *, max_len: int = 16384,
) -> str:
    """Plan ARIA-V3.1-P — Tier-1 base64-encoded delimiter payload.

    Used by V3.1-B's `_implementation_suggested_prompt` rewrite. The
    LLM-readable surface emits:

      <untrusted_converged_plan encoding="base64">{encoded}</untrusted_converged_plan>

    where `{encoded}` is the output of this helper. Because the base64
    alphabet is `[A-Za-z0-9+/=]`, NO `</untrusted_*>` ASCII substring
    can ever appear inside the payload — delimiter smuggling becomes
    structurally impossible.

    Operations:

    1. Cap raw text at `max_len` chars (truncate marker
       `...[truncated]` appended when cap fires; the encoded output
       is then ~4/3 × the cap).
    2. UTF-8 encode (binary).
    3. Base64-encode without newlines (`base64.b64encode`).
    4. Decode to ASCII str for prompt embedding.

    Returns the base64 ASCII string. Never raises; non-str input is
    coerced to str via `str(text)`.
    """
    if not isinstance(text, str):
        text = str(text)
    if len(text) > max_len:
        marker = "...[truncated]"
        text = text[: max_len - len(marker)] + marker
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def contains_bidi_or_control(text: str) -> bool:
    """True when ``text`` carries a bidi override or a control char.

    The detect-only counterpart to :func:`sanitize_untrusted_text`, for
    call sites that must REFUSE rather than clean. The pre-PR-open
    ``pr_body_templating`` hard-fail check is one: silently stripping a
    Trojan Source override from a PR body would leave the reviewer
    approving a diff whose rendering differed from its content, so the
    body is rejected instead of repaired.

    Both share ``_BIDI_AND_CONTROL_RE``, so the character class cannot
    drift between what gets stripped and what gets refused.
    """
    if not isinstance(text, str):
        text = str(text)
    return _BIDI_AND_CONTROL_RE.search(text) is not None


__all__ = [
    "contains_bidi_or_control",
    "encode_untrusted_delimited_payload",
    "sanitize_untrusted_text",
]
