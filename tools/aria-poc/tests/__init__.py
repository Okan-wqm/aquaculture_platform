"""Plan ARIA-V2 §3.6 — invariant tests for the ARIA Phase-1 PoC.

The legacy in-place ``tools/aria-poc/test_poc.py`` covers the original
unit suite; this subpackage hosts the architectural invariants added
by the v2 plan (worktree exclusion, drift dedup, real-repo bound).
Kept under a dedicated subdir so CI can dispatch ``unittest discover``
against it independently and the Plan-026R discipline (load-bearing
invariant tests) stays visible.
"""
