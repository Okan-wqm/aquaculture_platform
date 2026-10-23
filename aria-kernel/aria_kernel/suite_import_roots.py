"""The kernel suite's import roots — declared ONCE (PLAN-v2 B1, corrective round 2, R1).

WHY. ``scripts/ci/aria-suite-run.sh`` exported ``PYTHONPATH="aria-kernel:."``
and ``self_improvement`` spelt the same roots again for the authority set,
so the two could drift: the set would guard the top-level names at roots the
suite no longer imports from, and miss a root it added. Both now read this
module: the script runs it (``python3 -I aria-kernel/aria_kernel/
suite_import_roots.py`` prints the PYTHONPATH value), and the authority set
imports :data:`SUITE_PYTHONPATH_ROOTS`.

The module imports nothing and is run ISOLATED (``-I``: no
PYTHONPATH, no user site, no script directory on ``sys.path``), so nothing
at the roots it declares can run before it answers.
"""
from __future__ import annotations

# The suite's import roots in PYTHONPATH order, repo-relative; "" is the
# repository root. Both precede the standard library and site-packages, so
# every top-level module name at either root is an authority member
# (`self_improvement`, R3).
SUITE_PYTHONPATH_ROOTS: tuple[str, ...] = ("aria-kernel", "")


def suite_pythonpath() -> str:
    """The roots as the script exports them: relative to the repository root
    it runs from, joined with ':' ("" is spelt ".")."""
    return ":".join(root or "." for root in SUITE_PYTHONPATH_ROOTS)


__all__ = ["SUITE_PYTHONPATH_ROOTS", "suite_pythonpath"]


if __name__ == "__main__":
    print(suite_pythonpath())
