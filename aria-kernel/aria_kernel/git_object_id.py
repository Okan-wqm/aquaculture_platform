"""What a git object id looks like — the one owner of that rule (ARIA-LOW-518).

WHY: fifteen kernel modules each carried their own regex for "a full commit
sha", and they disagreed. Some accepted 40 hex digits only, some 40 or 64,
some 40 plus an optional 24; some were anchored with ``^...$`` and called
through ``re.match``, where ``$`` also matches before a trailing newline, so
``"<40 hex>\\n"`` passed one reader and failed the next. On today's SHA-1
repository nothing broke, but under git's SHA-256 object format one reader
accepted an id another refused, and nobody could tell which reading was the
rule.

WHAT: git names objects in one of two formats (``git rev-parse
--show-object-format``): ``sha1`` (40 lowercase hex digits) and ``sha256``
(64). :func:`is_object_id` is the full-id test, :func:`is_object_id_prefix`
the abbreviated one (a caller that hands a prefix to git, which resolves it).
Both match the WHOLE string — never a prefix of it, never with a trailing
newline. Every caller states its policy through ``formats``, a required
argument, so no site inherits a policy it did not choose:

* :data:`ANY_OBJECT_FORMAT` — an id git itself produced or will resolve,
  whichever format the repository uses.
* :data:`SHA1_OBJECT_FORMAT` — only where the value is bound to SHA-1 by
  something outside git's choice, and the caller names that something (a
  hard-coded SHA-1 constant beside it).

:func:`object_id_pattern` is the same rule as a regex fragment, for the few
patterns that embed an id inside a larger grammar.
``tests/test_git_object_id.py`` fails on a kernel module that restates the
rule instead of calling this one.
"""
from __future__ import annotations

import hashlib
import re
from enum import Enum
from typing import Final


class ObjectFormat(Enum):
    """A git object format, valued by the hex digits of its full id."""

    SHA1 = 40
    SHA256 = 64


ANY_OBJECT_FORMAT: Final[frozenset[ObjectFormat]] = frozenset(ObjectFormat)
SHA1_OBJECT_FORMAT: Final[frozenset[ObjectFormat]] = frozenset({ObjectFormat.SHA1})

# git's own floor for an abbreviation (`core.abbrev` minimum).
MIN_ABBREVIATED_HEX_DIGITS: Final[int] = 4

_LOWER_HEX: Final = re.compile(r"[0-9a-f]+")


def _lengths(formats: frozenset[ObjectFormat]) -> frozenset[int]:
    if not formats:
        raise ValueError("an object-id policy names at least one object format")
    return frozenset(fmt.value for fmt in formats)


def is_object_id(value: object, *, formats: frozenset[ObjectFormat]) -> bool:
    """True when ``value`` is exactly one full object id in one of ``formats`` (lowercase hex)."""
    return (
        isinstance(value, str)
        and len(value) in _lengths(formats)
        and _LOWER_HEX.fullmatch(value) is not None
    )


def is_object_id_prefix(
    value: object,
    *,
    formats: frozenset[ObjectFormat],
    min_digits: int = MIN_ABBREVIATED_HEX_DIGITS,
    case_insensitive: bool = False,
) -> bool:
    """True when ``value`` is a hex prefix git could resolve: ``min_digits`` up to a full id.

    ``case_insensitive`` admits uppercase digits (git resolves either case);
    a caller that passes the value on to git keeps it as given.
    """
    if not isinstance(value, str) or min_digits < MIN_ABBREVIATED_HEX_DIGITS:
        return False
    if not min_digits <= len(value) <= max(_lengths(formats)):
        return False
    text = value.lower() if case_insensitive else value
    return _LOWER_HEX.fullmatch(text) is not None


def blob_object_id(content: bytes, object_format: ObjectFormat) -> str:
    """The id git names ``content`` with as a blob (``git hash-object --no-filters``), computed without git."""
    return hashlib.new(object_format.name.lower(), b"blob %d\0" % len(content) + content).hexdigest()


def object_id_pattern(formats: frozenset[ObjectFormat]) -> str:
    """The full-id rule as an unanchored, non-capturing regex fragment, for embedding in a larger pattern."""
    alternatives = "|".join(f"[0-9a-f]{{{length}}}" for length in sorted(_lengths(formats), reverse=True))
    return f"(?:{alternatives})"


__all__ = [
    "ANY_OBJECT_FORMAT",
    "MIN_ABBREVIATED_HEX_DIGITS",
    "ObjectFormat",
    "SHA1_OBJECT_FORMAT",
    "blob_object_id",
    "is_object_id",
    "is_object_id_prefix",
    "object_id_pattern",
]
