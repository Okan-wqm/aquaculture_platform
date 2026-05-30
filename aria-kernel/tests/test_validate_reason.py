"""Plan ARIA-V2 §Phase 1 invariants I-31, I-32 — _validate_reason discipline.

Locks the architectural decision that every operator-supplied
``--reason`` is validated for non-trivial content + absence of PII
tokens at CLI parse time. Reverting either check silently weakens the
audit trail to shape-only compliance.
"""

from __future__ import annotations

import argparse
import unittest

from aria_kernel.cli import _validate_reason


class ValidateReasonRejectsShortTextTests(unittest.TestCase):
    """Plan ARIA-V2 I-31 — short / empty / whitespace-only reasons rejected."""

    def test_empty_string_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("")

    def test_whitespace_only_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("   ")
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("\t\n")

    def test_short_text_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("short")
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("abc")

    def test_exactly_at_minimum_accepted(self) -> None:
        # 10 non-whitespace chars is the minimum.
        result = _validate_reason("abcdefghij")
        self.assertEqual(result, "abcdefghij")

    def test_real_audit_reason_accepted(self) -> None:
        result = _validate_reason("Plan ARIA-V2 §Phase-1 validation cycle")
        self.assertEqual(result, "Plan ARIA-V2 §Phase-1 validation cycle")


class ValidateReasonRejectsPIITests(unittest.TestCase):
    """Plan ARIA-V2 I-32 — PII tokens (email / phone / SSN) rejected."""

    def test_email_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("operator user@example.com requesting rebuild for stale state")

    def test_phone_dash_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("operator at 555-123-4567 requesting rebuild for stale state")

    def test_phone_dotted_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("operator at 555.123.4567 requesting rebuild for stale state")

    def test_ssn_rejected(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _validate_reason("SSN 123-45-6789 reference for stale-state rebuild")

    def test_pii_free_reason_accepted(self) -> None:
        result = _validate_reason("stale-state rebuild after operator-initiated cycle reset")
        self.assertIn("stale-state", result)


if __name__ == "__main__":
    unittest.main()
