"""One definition of what a confidence value IS, refusing what it is not.

ORPHAN-HIGH-541 (PLAN §4d.1). `confidence` is a bare float in five places
with five different meanings — pattern score, belief weight, judge
probability, adapter score, instinct score — and before this module two of
the accepting surfaces disagreed about out-of-range input in opposite
directions: `instinct_candidate` refused, `tool_runner` clamped with
``min(float(confidence), 1.0)``. The clamp fails OPEN: an adapter emitting a
count, a severity grade or a milliseconds reading as ``confidence`` was
silently promoted to 1.0 — maximum certainty — and flowed into
`memory._record_belief` as a belief weight. Coercion toward maximum trust is
the worst possible reading of malformed input on a trust surface.

Booleans are refused even though ``bool`` is an ``int``: a flag is a claim of
KIND, not of degree, and ``True`` reading as certainty re-opens the same
door.

The kind vocabulary names the distinct quantities so a threshold meant for
one is never silently compared against another; it is closed here and only
here.
"""

from __future__ import annotations

import math
from typing import Any

from .tool_registry import GovernanceError

CONFIDENCE_KINDS: tuple[str, ...] = (
    "pattern_score",
    "belief_weight",
    "judge_probability",
    "adapter_score",
    "instinct_score",
)


def confidence_in_unit_interval(value: Any) -> float | None:
    """The value as a probability, or None — never a coerced substitute."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if math.isnan(number) or not (0.0 <= number <= 1.0):
        return None
    return number


def validated_confidence(value: Any, *, kind: str) -> float:
    """The raising form, for callers whose contract is refusal."""
    if kind not in CONFIDENCE_KINDS:
        raise GovernanceError(
            f"confidence kind {kind!r} is outside the closed vocabulary "
            f"{list(CONFIDENCE_KINDS)}"
        )
    number = confidence_in_unit_interval(value)
    if number is None:
        raise GovernanceError(
            f"{kind} confidence out of range: {value!r} (must be a number in [0, 1])"
        )
    return number


__all__ = [
    "CONFIDENCE_KINDS",
    "confidence_in_unit_interval",
    "validated_confidence",
]
