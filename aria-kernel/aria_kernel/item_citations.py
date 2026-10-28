"""ARIA-HIGH-1083 — the ONE reading of what a sampled adapter finding cites.

A sampled finding's item (``feedback_store._sample_item_from_finding``) names
its location twice: ``path`` (the file) and ``evidence`` (strings ``path:line``
or the adapter's dicts ``{"path", "line"}``; every adapter emits dicts). Four
modules read that shape for one purpose each: tier-0 (do the refs resolve at
the tree), the judge fan-out (which refs and which line a judge is handed), the
judgment funnel (the verdict-cache key's code half) and the System One shadow
asks (which ``(path, line)`` Jev is shown). They cannot import each other, so
the reading lives here, in a module that imports no kernel module at load
time, and each of them is a caller:

  * a string stripped is a ref; a dict with a non-empty string ``path`` is
    ``path:line`` when ``line`` is a positive ``int`` (a ``bool`` is not a
    line) and the bare path otherwise; anything else is skipped;
  * the item's own ``path`` comes first, and no ref is deduplicated (the
    fan-out records a repeat as a ``duplicate_ref`` excerpt entry);
  * ``evidence`` that is not a list is ignored (iterating a string read it one
    character at a time).

``cited_line`` is the one line the finding says its own path holds the defect
at: it never invents one. ``cited_target`` is that line with the file it is in,
and also reads the legacy shape whose ``path`` is itself ``path:line``: the one
``(path, line)`` a reader that shows a single line (the shadow asks) names.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# The two kinds a ref carries. Tier-0 chooses its refusal name by them
# (``cited_path_absent_at_target_sha`` for the item's own path,
# ``evidence_ref_absent_at_target_sha`` for an evidence ref).
CITED_PATH = "path"
CITED_EVIDENCE = "evidence"


def _evidence_ref(entry: Any) -> str:
    """One ``evidence`` entry as a ref, or ``""`` when it names none."""
    if isinstance(entry, str):
        return entry.strip()
    if not isinstance(entry, Mapping):
        return ""
    path = entry.get("path")
    if not isinstance(path, str) or not path.strip():
        return ""
    line = entry.get("line")
    if type(line) is int and line > 0:
        return f"{path.strip()}:{line}"
    return path.strip()


def item_cited_refs(item: Mapping[str, Any]) -> list[tuple[str, str]]:
    """The item's cited refs as ``(kind, ref)`` pairs, in order: its own
    ``path`` (kind ``CITED_PATH``) then each ``evidence`` ref (kind
    ``CITED_EVIDENCE``)."""
    refs: list[tuple[str, str]] = []
    path = str(item.get("path") or "").strip()
    if path:
        refs.append((CITED_PATH, path))
    evidence = item.get("evidence")
    if isinstance(evidence, (list, tuple)):
        refs.extend((CITED_EVIDENCE, ref) for ref in map(_evidence_ref, evidence) if ref)
    return refs


def _ref_line(ref: str) -> tuple[str, int] | None:
    """``(path, line)`` of a ref in the evidence grammar that names a positive line."""
    from .evidence_trust import parse_evidence_ref

    parsed = parse_evidence_ref(ref)
    if parsed is None or parsed[1] is None or parsed[1] <= 0:
        return None
    return parsed[0], parsed[1]


def cited_line(item: Mapping[str, Any]) -> int | None:
    """The line of the first evidence ref that carries one for the item's own
    ``path``; ``None`` when the item has no path, when its evidence names
    other files only, when the path itself carries a ``:line`` (the legacy
    shape), or when no ref has a line."""
    refs = item_cited_refs(item)
    if not refs or refs[0][0] != CITED_PATH:
        return None
    own_path = refs[0][1]
    for kind, ref in refs:
        if kind != CITED_EVIDENCE:
            continue
        located = _ref_line(ref)
        if located is not None and located[0] == own_path:
            return located[1]
    return None


def cited_target(item: Mapping[str, Any]) -> tuple[str, int] | None:
    """The ``(path, line)`` a reader that must name one line is about: the
    item's own path at ``cited_line``, or, for the legacy shape whose ``path``
    is itself ``path:line``, that file and line; ``None`` when the item cites
    no line (it never invents one)."""
    line = cited_line(item)
    path = str(item.get("path") or "").strip()
    if line is not None:
        return path, line
    return _ref_line(path)
