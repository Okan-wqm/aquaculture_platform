"""Regression test for F-006 anchor 1.

Operator-conducted ARIA self-audit (2026-05-10) found that
`pressure._phase2_effective_context` wrapped both the deferred trust
import and the trust function calls in a single broad `except
Exception`. The deferred import is a legitimate circular-import break
(`pressure -> trust -> feedback -> pressure`); the broad catch also
silently swallowed real data errors raised by `trust.trusted_gap_keys`
or `trust.ref_status_by_feedback_id`, masking bugs whose downstream
effect feeds pressure evaluation feeding operator decisions.

Fix: narrow the except to `ImportError`. Trust function calls are
moved out of the try.
"""
from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

from aria_kernel.pressure import _phase2_effective_context
from aria_kernel.workspace import WorkspacePaths


class _FakePaths:
    """Stand-in for WorkspacePaths — _phase2_effective_context only
    forwards `paths` to the trust functions; it never inspects
    attributes itself, so a bare object is sufficient."""


class Phase2ImportFallbackTests(unittest.TestCase):
    def test_import_error_returns_empty_context(self) -> None:
        # Force `from .trust import ...` to raise ImportError by
        # poisoning sys.modules — Python treats `sys.modules[name] =
        # None` as "import was attempted and failed".
        with patch.dict(sys.modules, {"aria_kernel.trust": None}):
            trusted_keys, ref_statuses = _phase2_effective_context(_FakePaths())
        self.assertEqual(trusted_keys, set())
        self.assertEqual(ref_statuses, {})

    def test_data_error_propagates(self) -> None:
        # Real bug in trust.trusted_gap_keys MUST surface, not be
        # swallowed into an empty fallback. The pre-fix code wrapped
        # this in `except Exception` and silently returned (set(), {}),
        # masking the bug.
        from aria_kernel import trust

        sentinel = RuntimeError("trust.trusted_gap_keys synthetic data error")
        with patch.object(trust, "trusted_gap_keys", side_effect=sentinel):
            with self.assertRaises(RuntimeError) as ctx:
                _phase2_effective_context(_FakePaths())
        self.assertIs(ctx.exception, sentinel)

    def test_data_error_in_ref_status_propagates(self) -> None:
        # Same coverage for ref_status_by_feedback_id — the second
        # trust function. The pre-fix code masked errors from either.
        from aria_kernel import trust

        sentinel = RuntimeError("trust.ref_status_by_feedback_id synthetic data error")
        with patch.object(trust, "trusted_gap_keys", return_value=set()):
            with patch.object(trust, "ref_status_by_feedback_id", side_effect=sentinel):
                with self.assertRaises(RuntimeError) as ctx:
                    _phase2_effective_context(_FakePaths())
        self.assertIs(ctx.exception, sentinel)


if __name__ == "__main__":
    unittest.main()
