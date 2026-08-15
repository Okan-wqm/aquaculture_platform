"""E17-b — bounded evidence excerpt packing for the invocation envelope.

WHY this module exists
----------------------
An ARIA envelope names its evidence and carries none of it. Every judge
therefore opens its turn by Reading each `evidence_refs` file itself, and the
adversarial judge — by design — Reads the same files a second time in reverse
order. Two judges over one finding pay for the same bytes four times, and the
bytes are the same bytes every time: the file at the sha the request was
minted against.

The counter-pattern already exists in-repo. `aria-cross-reviewer` receives the
full plan text inline inside `<untrusted_primary_plan>` tags with a content
hash and its contract states that no file Read is required. This module is
that pattern generalised to evidence refs: quote the cited lines ONCE, at
mint, with a hash over the quoted bytes, so the judge verifies against the
excerpt and Reads the file only when the hash does not match what it finds or
the excerpt is genuinely insufficient.

WHY bounded, and why a skip is an ENTRY
---------------------------------------
Unbounded packing would trade a read-amplification problem for a
context-overflow one — a 40k-line file behind a single ref would fill a
judge's window with material it never asked for. Three caps bound the cost:
``line_radius`` (how much context around the cited line), ``per_ref_cap``
(bytes any one ref may spend) and ``total_cap`` (bytes the whole envelope may
spend).

Every ref that does not produce content still produces an ENTRY carrying a
structural ``skipped`` reason. A silent drop would make the excerpt set lie by
omission: the judge would see refs 1-3 quoted, ref 4 absent, and have no way
to tell "the budget ran out" from "that file does not exist" from "I was never
given it". The reason vocabulary below is the whole truth about why a ref
carries no bytes, and it is machine-readable so the renderer can print it and
a reader can count it.

Never raises into the mint path
-------------------------------
Same contract as ``_repository_map_for_refs`` / ``_recent_intent_for_refs`` in
``agent_invocations``: a missing or unreadable evidence file costs an agent an
excerpt, and that must not cost the cycle its request. Per-ref failures land
as ``skipped`` entries; the function itself raises only on a caller error
(a non-positive cap), which is a programming mistake, not repository state.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Sequence

from .canonical_path import _canonical_evidence_path
from .evidence_validator import _parse_agent_ref
from .tool_registry import GovernanceError

# Defaults are the packing policy. A cited line plus 40 lines either side is
# roughly a screen of surrounding code — enough to see the function the line
# lives in without pulling its neighbours. 8 KiB per ref and 64 KiB total keep
# the whole excerpt set below the smallest role cap's share of a 200K window
# (judges: 0.35 × 200_000 ≈ 70_000 tokens) with room for the agent .md and the
# preamble docs the budget gate already counts.
DEFAULT_LINE_RADIUS = 40
DEFAULT_PER_REF_CAP = 8192
DEFAULT_TOTAL_CAP = 65536

# The structural reason vocabulary. Every ref that yields no content yields
# one of these on a pointer-only entry — never nothing.
SKIP_MALFORMED_REF = "malformed_ref"
SKIP_DUPLICATE_REF = "duplicate_ref"
SKIP_OUTSIDE_REPO_ROOT = "outside_repo_root"
SKIP_UNREADABLE = "unreadable"
SKIP_EMPTY_FILE = "empty_file"
SKIP_LINE_OUT_OF_RANGE = "line_out_of_range"
SKIP_TOTAL_CAP = "excerpt_total_cap"

SKIP_REASONS: frozenset[str] = frozenset(
    {
        SKIP_MALFORMED_REF,
        SKIP_DUPLICATE_REF,
        SKIP_OUTSIDE_REPO_ROOT,
        SKIP_UNREADABLE,
        SKIP_EMPTY_FILE,
        SKIP_LINE_OUT_OF_RANGE,
        SKIP_TOTAL_CAP,
    }
)


def excerpt_content_hash(content: str) -> str:
    """sha256 over the EXCERPT bytes — the judge's Read trigger.

    Hashing the excerpt rather than the whole file is deliberate. The judge
    holds the excerpt, not the file, so the only hash it can recompute without
    a Read is this one. When the file is edited after the mint, a judge that
    re-derives the same line range gets different bytes and a different digest
    — which is exactly the signal that the excerpt is stale and the file must
    be Read.
    """
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def _skip(path: str, reason: str) -> dict[str, Any]:
    """A pointer-only entry: this ref was seen, and here is why it has no bytes."""
    if reason not in SKIP_REASONS:  # pragma: no cover — structural guard
        raise GovernanceError(f"unknown_excerpt_skip_reason: {reason!r}")
    return {"path": path, "skipped": reason}


def _fit_lines(lines: list[str], cap_bytes: int) -> tuple[str, int, bool]:
    """Pack whole lines into ``cap_bytes``; return (content, line_count, truncated).

    Whole lines are the unit because a half-line excerpt cannot be reasoned
    about against a `path:line` citation. The one exception is a first line
    that alone exceeds the cap (minified bundles, generated files): the head of
    that line is better than nothing, and ``truncated`` says so.
    """
    packed: list[str] = []
    used = 0
    for line in lines:
        size = len(line.encode("utf-8"))
        if used + size > cap_bytes:
            break
        packed.append(line)
        used += size
    if not packed:
        head = lines[0].encode("utf-8")[:cap_bytes].decode("utf-8", errors="ignore")
        return head, 1, True
    return "".join(packed), len(packed), len(packed) < len(lines)


def excerpts_for_refs(
    evidence_refs: Sequence[str] | None,
    *,
    repo_root: str | Path,
    line_radius: int = DEFAULT_LINE_RADIUS,
    per_ref_cap: int = DEFAULT_PER_REF_CAP,
    total_cap: int = DEFAULT_TOTAL_CAP,
) -> list[dict[str, Any]]:
    """Quote the cited lines for each evidence ref, bounded by three caps.

    Returns one entry per ref, in ref order:

    - content entry — ``{path, start_line, end_line, content, content_hash,
      truncated}``. ``content_hash`` covers ``content`` only (see
      ``excerpt_content_hash``); ``truncated`` is True when ``per_ref_cap`` or
      the remaining total budget cut the window short.
    - pointer-only entry — ``{path, skipped: <reason>}``. Structural, never a
      silent drop.

    A ref with no line number (``path``) gets the file HEAD within cap, which
    is what "look at this file" means when nobody named a line.
    """
    if line_radius < 0:
        raise GovernanceError(f"line_radius must be >= 0, got {line_radius!r}")
    if per_ref_cap <= 0:
        raise GovernanceError(f"per_ref_cap must be positive, got {per_ref_cap!r}")
    if total_cap <= 0:
        raise GovernanceError(f"total_cap must be positive, got {total_cap!r}")

    root = Path(repo_root)
    entries: list[dict[str, Any]] = []
    remaining = int(total_cap)
    seen: set[str] = set()

    for raw_ref in list(evidence_refs or []):
        if not isinstance(raw_ref, str) or not raw_ref.strip():
            entries.append(_skip(str(raw_ref), SKIP_MALFORMED_REF))
            continue
        ref = raw_ref.strip()
        parsed = _parse_agent_ref(ref)
        if parsed is None:
            entries.append(_skip(ref, SKIP_MALFORMED_REF))
            continue
        path, line = parsed
        # Line numbers are 1-based, so `path:0` cites nothing that exists.
        # The ref parser's `\d+` accepts it; the window arithmetic below would
        # produce an empty range from it, and an empty range is a citation
        # this module must refuse rather than silently reinterpret.
        if line is not None and line < 1:
            entries.append(_skip(path, SKIP_MALFORMED_REF))
            continue
        # The same ref twice would pay for the same bytes twice out of one
        # budget, starving a later ref of its excerpt. The repeat is recorded
        # rather than dropped so the entry list stays ref-for-ref aligned.
        if ref in seen:
            entries.append(_skip(path, SKIP_DUPLICATE_REF))
            continue
        seen.add(ref)

        # Fully-exhausted fast path for the SAME total-cap rule enforced
        # against the real window below: with nothing left, no file can
        # produce content, so the mint stops reading files it cannot use —
        # a 5 MB read whose bytes are discarded is pure cost. The entries
        # still name each ref, so the set never shortens.
        if remaining <= 0:
            entries.append(_skip(path, SKIP_TOTAL_CAP))
            continue

        # The shared canonical resolver owns traversal defence (Plan 026R
        # §E.5) — a lexical check here would be a second, weaker copy.
        try:
            _rel, absolute = _canonical_evidence_path(path, root)
        except GovernanceError:
            entries.append(_skip(path, SKIP_OUTSIDE_REPO_ROOT))
            continue

        try:
            if not absolute.is_file():
                entries.append(_skip(path, SKIP_UNREADABLE))
                continue
            text = absolute.read_text(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            entries.append(_skip(path, SKIP_UNREADABLE))
            continue

        lines = text.splitlines(keepends=True)
        if not lines:
            entries.append(_skip(path, SKIP_EMPTY_FILE))
            continue
        if line is not None and line > len(lines):
            # The ref points past EOF: the file changed under the citation, or
            # the citation was wrong. Either way quoting the tail would answer
            # a question nobody asked.
            entries.append(_skip(path, SKIP_LINE_OUT_OF_RANGE))
            continue

        if line is None:
            start_line = 1
        else:
            start_line = max(1, line - line_radius)
        end_bound = len(lines) if line is None else min(len(lines), line + line_radius)
        window = lines[start_line - 1:end_bound]

        # A byte-shred off the end of the total budget is not an excerpt. When
        # the remaining budget cannot afford even the smallest thing the
        # per-ref rules would have quoted — one whole line, or ``per_ref_cap``
        # bytes of a pathological single line — the operative constraint is
        # the TOTAL cap, and saying so beats handing over seven bytes that a
        # different ref order would have quoted in full.
        floor = min(per_ref_cap, len(window[0].encode("utf-8")))
        if remaining < floor:
            entries.append(_skip(path, SKIP_TOTAL_CAP))
            continue

        cap = min(per_ref_cap, remaining)
        content, packed_lines, truncated = _fit_lines(window, cap)
        remaining -= len(content.encode("utf-8"))
        entries.append(
            {
                "path": path,
                "start_line": start_line,
                "end_line": start_line + packed_lines - 1,
                "content": content,
                "content_hash": excerpt_content_hash(content),
                "truncated": truncated,
            }
        )

    return entries


__all__ = [
    "DEFAULT_LINE_RADIUS",
    "DEFAULT_PER_REF_CAP",
    "DEFAULT_TOTAL_CAP",
    "SKIP_REASONS",
    "SKIP_DUPLICATE_REF",
    "SKIP_EMPTY_FILE",
    "SKIP_LINE_OUT_OF_RANGE",
    "SKIP_MALFORMED_REF",
    "SKIP_OUTSIDE_REPO_ROOT",
    "SKIP_TOTAL_CAP",
    "SKIP_UNREADABLE",
    "excerpt_content_hash",
    "excerpts_for_refs",
]
