"""Strict parsing for pre-registered policy blocks (SE-13).

WHY a second parsing discipline next to genesis_policy's accessors: every
accessor there fills a missing key from a defaults dict, and
``genesis_policy.merge_with_override`` replaces a block WHOLESALE. For a
pre-registered decision rule that combination forges the registration: an
override that forgets ``k_min`` runs on the shipped number and nobody is told.
A pre-registered block therefore has NO defaults dict in code. The shipped JSON
is the one place each value is written; this parser requires every key,
refuses an unknown one, refuses a value outside its type or range, and names
the dotted path of what it refused.

Keys starting with ``_`` are prose for the operator: never configuration,
carried through unread so the parsed block is the registered block.

WHAT: a schema is a dict whose values are either a nested schema (a dict) or a
check ``(where, raw) -> value`` built by ``real``, ``whole``, ``one_of`` or
``names``. ``parse_block`` applies it; ``refuse`` is the one refusal shape,
``GovernanceError("genesis_policy_preregistered_<code>: <path> <detail>")``.
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable, NoReturn

Check = Callable[[str, Any], Any]

_SNAKE_CASE = re.compile(r"[a-z][a-z0-9_]*")


def refuse(code: str, where: str, detail: str) -> NoReturn:
    # Imported here, as in genesis_policy: tool_registry's import chain reaches
    # the policy modules, so a module-level import would be circular.
    from .tool_registry import GovernanceError

    raise GovernanceError(f"genesis_policy_preregistered_{code}: {where} {detail}")


def real(low: float, high: float, *, open_low: bool = False, open_high: bool = False) -> Check:
    """A finite real in the stated interval; bool is refused, an int is read as a float."""

    def check(where: str, raw: Any) -> float:
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            refuse("value_not_a_number", where, f"= {raw!r}")
        value = float(raw)
        below = value <= low if open_low else value < low
        above = value >= high if open_high else value > high
        if below or above:
            span = f"{'(' if open_low else '['}{low:g}, {high:g}{')' if open_high else ']'}"
            refuse("value_out_of_range", where, f"= {raw!r} must lie in {span}")
        return value

    return check


def whole(low: int, high: int) -> Check:
    """A whole number in [low, high]; bool and 3.0 are refused, not coerced."""

    def check(where: str, raw: Any) -> int:
        if isinstance(raw, bool) or not isinstance(raw, int):
            refuse("value_not_a_whole_number", where, f"= {raw!r}")
        if not low <= raw <= high:
            refuse("value_out_of_range", where, f"= {raw!r} must lie in [{low}, {high}]")
        return raw

    return check


def one_of(*allowed: str) -> Check:
    """A string from a closed vocabulary (a one-member vocabulary is a pin)."""

    def check(where: str, raw: Any) -> str:
        if raw not in allowed:
            refuse("value_not_in_vocabulary", where, f"= {raw!r} must be one of {sorted(allowed)}")
        return raw

    return check


def names(allowed: frozenset[str] | None = None, *, min_len: int = 1) -> Check:
    """A list of distinct snake_case names, drawn from ``allowed`` when it is closed."""

    def check(where: str, raw: Any) -> list[str]:
        if not isinstance(raw, list) or len(raw) < min_len:
            refuse("value_not_a_name_list", where, f"= {raw!r} must list at least {min_len} name(s)")
        for name in raw:
            if not isinstance(name, str) or not _SNAKE_CASE.fullmatch(name):
                refuse("value_not_a_name_list", where, f"entry {name!r} is not a snake_case name")
            if allowed is not None and name not in allowed:
                refuse("value_not_in_vocabulary", where, f"entry {name!r} must be one of {sorted(allowed)}")
        if len(set(raw)) != len(raw):
            refuse("value_repeats_a_name", where, f"= {raw!r}")
        return list(raw)

    return check


def parse_block(where: str, raw: Any, schema: dict[str, Any]) -> dict[str, Any]:
    """Parse one object against its schema: every key required, no unknown key."""
    if not isinstance(raw, dict):
        refuse(
            "block_not_an_object", where,
            f"= {raw!r}. Write an object with the keys {sorted(schema)}; a pre-registered value is "
            "never taken from a default.",
        )
    unknown = sorted(str(k) for k in raw if not str(k).startswith("_") and k not in schema)
    if unknown:
        refuse("key_unknown", where, f"carries {unknown}; it knows only {sorted(schema)}")
    missing = [key for key in schema if key not in raw]
    if missing:
        refuse(
            "key_missing", where,
            f"lacks {', '.join(f'{where}.{key}' for key in missing)}. The block is replaced whole by an "
            "override, and the shipped value does NOT stand in for a missing one (it would forge the "
            "pre-registration); write every key.",
        )
    parsed = {key: value for key, value in raw.items() if str(key).startswith("_")}
    for key, check in schema.items():
        parsed[key] = (
            parse_block(f"{where}.{key}", raw[key], check) if isinstance(check, dict)
            else check(f"{where}.{key}", raw[key])
        )
    return parsed
