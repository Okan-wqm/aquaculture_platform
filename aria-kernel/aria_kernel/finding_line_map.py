"""ARIA-HIGH-369 (review H1) — where a cited line is at the anchor, read from the diff, never from its text.

WHY. The first seed re-anchored a moved ``path:line`` by searching the anchor
file for the cited line's bytes and accepting a single hit. A deleted or fixed
statement then "moved" to any one-off trivial line that happened to match
(``});``, ``</select>``, ``return null;``), and an unchanged line NUMBER holding
an equal trivial line was taken as the same line: a stale ref was planned as
current — fail-open, the class the seed exists to close.

WHAT. :func:`map_cited_line` asks git for the zero-context diff of the one path
between the commit the finding was verified at and the anchor
(``git diff -U0 --no-renames <origin> <anchor> -- <path>``) and walks its hunk
headers. A line inside an old-side hunk range was changed or deleted: it is
GONE, whatever text sits elsewhere. Any other line is the same line, shifted by
the net size of every hunk wholly above it. There is no text fallback, so a
trivial line can never be matched by content.
"""
from __future__ import annotations

import re
from pathlib import Path

_HUNK_RE = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
LINE_GONE = "cited_line_gone"
DIFF_UNREADABLE = "cited_line_diff_unreadable"


def map_cited_line(
    repo_root: Path, *, origin: str, anchor: str, path: str, line: int,
) -> tuple[int | None, str | None]:
    """(the line's number at ``anchor``, None) or (None, why) for a 1-based ``line`` of ``path`` at ``origin``."""
    from .main_anchor import _git

    proc = _git(repo_root, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0",
                origin, anchor, "--", path)
    if proc is None or proc.returncode != 0:
        return None, DIFF_UNREADABLE
    shift = 0
    for raw in proc.stdout.splitlines():
        if raw.startswith(b"Binary files "):
            return None, DIFF_UNREADABLE
        match = _HUNK_RE.match(raw)
        if match is None:
            continue
        old_start = int(match.group(1))
        old_count = int(match.group(2)) if match.group(2) is not None else 1
        new_count = int(match.group(4)) if match.group(4) is not None else 1
        if old_count and old_start <= line < old_start + old_count:
            return None, LINE_GONE
        # A pure insertion (``-a,0``) sits AFTER old line ``a``; a change
        # starting at ``a`` covers ``a..a+count-1``. Either is above ``line``
        # only when it ends before it.
        above = old_start < line if old_count == 0 else old_start + old_count - 1 < line
        if not above:
            break
        shift += new_count - old_count
    return line + shift, None


__all__ = ["DIFF_UNREADABLE", "LINE_GONE", "map_cited_line"]
