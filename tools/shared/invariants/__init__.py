"""Plan ARIA-V2 §3.6 + ORPHAN-MEDIUM-075 — invariant tests for ``tools.shared``.

Subpackage NAME ``invariants/`` (not ``tests/``) so it cannot shadow
the kernel's ``aria-kernel/tests/`` package on the ``sys.path`` of
spawn'd multiprocessing children. See the matching note in
``tools/aria-poc/invariants/__init__.py`` for the full rationale.
"""
