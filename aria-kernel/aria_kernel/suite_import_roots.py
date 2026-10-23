"""The kernel suite's import roots — declared ONCE (PLAN-v2 B1, corrective round 2, R1).

WHY. ``scripts/ci/aria-suite-run.sh`` exported ``PYTHONPATH="aria-kernel:."``
and ``self_improvement`` spelt the same roots again for the authority set,
so the two could drift: the set would guard the top-level names at roots the
suite no longer imports from, and miss a root it added.

WHAT. The roots live in one data file, ``aria-kernel/suite-import-roots``:
one repo-relative root per line in PYTHONPATH order, ``.`` for the
repository root. The script joins its lines with ``:`` (``paste -sd:``) and
exports that; this module parses the same lines into
:data:`SUITE_PYTHONPATH_ROOTS` for the authority set (``""`` is the
repository root). A data file, so the shell reads it without running an
interpreter at those roots, and both readers see the same bytes.
"""
from __future__ import annotations

from pathlib import Path

SUITE_IMPORT_ROOTS_RELPATH = "aria-kernel/suite-import-roots"
_FILE = Path(__file__).resolve().parents[1] / "suite-import-roots"

# The suite's import roots in PYTHONPATH order, repo-relative; "" is the
# repository root. Both precede the standard library and site-packages, so
# every top-level module name at either root is an authority member
# (`self_improvement`, R3).
SUITE_PYTHONPATH_ROOTS: tuple[str, ...] = tuple(
    "" if line == "." else line for line in _FILE.read_text(encoding="utf-8").splitlines())

__all__ = ["SUITE_IMPORT_ROOTS_RELPATH", "SUITE_PYTHONPATH_ROOTS"]
