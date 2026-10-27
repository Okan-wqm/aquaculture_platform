"""The ONE Python owner of the registry finding-id grammar (REG-ID).

An id is ``DOMAIN-SEVERITY-SEQUENCE``: an upper-case alphanumeric domain that
starts with a letter, one of the four severities the registry stores, and a
sequence of three digits (001..999) or four with no leading zero (1000..9999).
An existing three-digit id stays valid and is never rewritten.

WHY ONE MODULE. ``finding-registry add`` refused with "Finding ID space
exhausted for domain ARIA (maximum 999)". The sequence's width was not one
constant: the kernel spelled it at every reader with its own digit count
(``plan_origin`` ``\\d{3}``, ``plan_convergence`` ``[0-9]{3,}``,
``adapter_quarantine`` and ``twin`` ``\\d+``), so no two of them agreed on what
``ARIA-HIGH-0999`` is. Every kernel reader now takes the grammar from here;
``tests/invariants/finding-id-grammar.spec.ts`` fails a kernel file that spells
a finding-id regex with a digit count of its own.

THE OTHER OWNER. Python cannot import ``tools/gates/finding-id-grammar.ts``, so
the two owners cannot be one module. They are one GRAMMAR because both are held
to one table, ``tools/gates/fixtures/finding-id-grammar-table.json``
(``tests/test_finding_id_grammar.py`` here,
``tests/invariants/finding-id-grammar-table.spec.ts`` there): a row added to the
table is judged by both. Widening the space again is one constant,
``_SEQUENCE_DIGITS``, and the table.

ASCII ONLY. The digit class is ``[0-9]``, not ``\\d`` (which also matches
Arabic-Indic digits), and the id ends at ``\\Z``, not ``$`` (which matches before
a trailing newline): the TypeScript regex does neither, and the table carries
both spellings.
"""
from __future__ import annotations

import re
from typing import NamedTuple

#: The severities a registry row carries; the classifier of every stored id.
FINDING_SEVERITIES: tuple[str, ...] = ("CRITICAL", "HIGH", "MEDIUM", "LOW")

#: Digits an id spells at least (``001``) and at most (``9999``).
_SEQUENCE_MIN_DIGITS = 3
_SEQUENCE_DIGITS = 4

#: The last sequence an id can carry, and so the allocator's limit.
FINDING_SEQUENCE_MAX = 10**_SEQUENCE_DIGITS - 1

# The grammar as regex source, for a reader that embeds an id in a larger
# pattern (a trailer, a search of prose). No anchors, no capture groups: the
# embedding pattern keeps its own group numbering. The sequence spells the
# longer form first and closes with a look-ahead, so it is read whole wherever
# it is embedded: ``1000`` is not ``100`` and a stray ``0``, and ``0999`` and a
# fifth digit are no sequence at all, anchored or not.
FINDING_DOMAIN_SOURCE = "[A-Z][A-Z0-9]*"
FINDING_SEVERITY_SOURCE = "(?:" + "|".join(FINDING_SEVERITIES) + ")"
FINDING_SEQUENCE_SOURCE = (
    f"(?:[1-9][0-9]{{{_SEQUENCE_MIN_DIGITS},{_SEQUENCE_DIGITS - 1}}}"
    f"|[0-9]{{{_SEQUENCE_MIN_DIGITS}}})(?![0-9])"
)
FINDING_ID_SOURCE = f"{FINDING_DOMAIN_SOURCE}-{FINDING_SEVERITY_SOURCE}-{FINDING_SEQUENCE_SOURCE}"

#: A severity-qualified id, whole (use ``fullmatch`` or ``match``: it ends at ``\Z``).
REGISTRY_FINDING_ID_RE = re.compile(
    f"(?P<domain>{FINDING_DOMAIN_SOURCE})"
    f"-(?P<classifier>{'|'.join(FINDING_SEVERITIES)})"
    f"-(?P<sequence>{FINDING_SEQUENCE_SOURCE})\\Z"
)


class ParsedFindingId(NamedTuple):
    id: str
    domain: str
    classifier: str
    sequence: int


def parse_finding_id(value: str) -> ParsedFindingId | None:
    """The parts of a severity-qualified registry id, or None when ``value`` is not one."""
    match = REGISTRY_FINDING_ID_RE.match(value)
    if match is None:
        return None
    return ParsedFindingId(value, match["domain"], match["classifier"], int(match["sequence"]))


def format_finding_id(domain: str, classifier: str, sequence: int) -> str:
    """The id of ``sequence`` in ``domain`` under ``classifier``: zero-padded to
    three digits, never truncated, refused outside 1..:data:`FINDING_SEQUENCE_MAX`."""
    if isinstance(sequence, bool) or not isinstance(sequence, int):
        raise TypeError(f"a finding sequence is an integer, got {sequence!r}")
    if not 1 <= sequence <= FINDING_SEQUENCE_MAX:
        raise ValueError(
            f"a finding sequence is between {1:0{_SEQUENCE_MIN_DIGITS}d} and {FINDING_SEQUENCE_MAX}, got {sequence}"
        )
    value = f"{domain}-{classifier}-{sequence:0{_SEQUENCE_MIN_DIGITS}d}"
    if parse_finding_id(value) is None:
        raise ValueError(f"not a finding id: {value!r}")
    return value


def finding_id_sort_key(value: str) -> tuple[str, str, int]:
    """The registry's order of ids: domain, classifier, then the SEQUENCE AS A
    NUMBER. A text order puts 1000 between 100 and 999."""
    parsed = parse_finding_id(value)
    if parsed is None:
        raise ValueError(f"not a finding id: {value!r}")
    return (parsed.domain, parsed.classifier, parsed.sequence)
