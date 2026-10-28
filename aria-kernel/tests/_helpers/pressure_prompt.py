"""ARIA-HIGH-384 — read the untrusted pressure context a projected queue prompt carries.

The drain wraps a pressure's reason, provenance and refused refs in an
``<untrusted_pressure_context>`` block (``pressure_evidence.untrusted_context_fields``,
built on ``text_safety.untrusted_block``: the whole JSON body is entity-encoded once);
tests that assert on those fields read them back through this one parser.
"""
from __future__ import annotations

import html
import json
from typing import Any

from aria_kernel.pressure_evidence import PROMPT_UNTRUSTED_CONTEXT_KEY, UNTRUSTED_CONTEXT_TAG


def untrusted_pressure_context(suggested_prompt: str) -> dict[str, Any]:
    """The JSON payload inside the prompt's untrusted block, with the block's entity encoding undone."""
    block = json.loads(suggested_prompt)[PROMPT_UNTRUSTED_CONTEXT_KEY]
    opening, closing = f"<{UNTRUSTED_CONTEXT_TAG}>\n", f"\n</{UNTRUSTED_CONTEXT_TAG}>"
    assert block.startswith(opening) and block.endswith(closing), block
    result: dict[str, Any] = json.loads(html.unescape(block[len(opening):-len(closing)]))
    return result
