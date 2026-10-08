"""ARIA-HIGH-384 — read the untrusted pressure context a projected queue prompt carries.

The drain wraps a pressure's reason, provenance and refused refs in an
``<untrusted_pressure_context>`` block (``pressure_evidence.prompt_fields``);
tests that assert on those fields read them back through this one parser.
"""
from __future__ import annotations

import html
import json
from typing import Any

from aria_kernel.pressure_evidence import PROMPT_UNTRUSTED_CONTEXT_KEY, UNTRUSTED_CONTEXT_TAG


def untrusted_pressure_context(suggested_prompt: str) -> dict[str, Any]:
    """The JSON payload inside the prompt's untrusted block, with the sanitizer's encoding undone."""
    block = json.loads(suggested_prompt)[PROMPT_UNTRUSTED_CONTEXT_KEY]
    opening, closing = f"<{UNTRUSTED_CONTEXT_TAG}>\n", f"\n</{UNTRUSTED_CONTEXT_TAG}>"
    assert block.startswith(opening) and block.endswith(closing), block
    payload = json.loads(block[len(opening):-len(closing)])

    def unescape(value: Any) -> Any:
        if isinstance(value, str):
            return html.unescape(value)
        if isinstance(value, list):
            return [unescape(item) for item in value]
        if isinstance(value, dict):
            return {key: unescape(item) for key, item in value.items()}
        return value

    return unescape(payload)
