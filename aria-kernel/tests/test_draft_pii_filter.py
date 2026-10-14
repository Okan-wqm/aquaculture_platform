"""Direct tests for ``draft_pii_filter``.

The PII mask sat only behind agent_genesis's indirect path; these cases
exercise the mask itself: deterministic hash-prefix tokens for email /
phone / SSN, plaintext never surviving, and idempotency (a re-run
produces the same token for the same input).
"""
from __future__ import annotations

import unittest

from aria_kernel.draft_pii_filter import mask_pii_in_string


class MaskPiiInStringBehavior(unittest.TestCase):
    def test_email_phone_ssn_are_all_masked(self) -> None:
        raw = "contact jane.doe@example.com or (555) 123-4567 or 123-45-6789"
        masked = mask_pii_in_string(raw)
        self.assertNotIn("jane.doe@example.com", masked)
        self.assertNotIn("555", masked)
        self.assertNotIn("123-45-6789", masked)
        self.assertIn("<pii:email:", masked)
        self.assertIn("<pii:phone:", masked)
        self.assertIn("<pii:ssn:", masked)

    def test_masking_is_deterministic(self) -> None:
        once = mask_pii_in_string("mail: a@b.com")
        twice = mask_pii_in_string("mail: a@b.com")
        self.assertEqual(once, twice)

    def test_clean_text_passes_through_unchanged(self) -> None:
        self.assertEqual(mask_pii_in_string("no secrets here"), "no secrets here")
        self.assertEqual(mask_pii_in_string(""), "")


if __name__ == "__main__":
    unittest.main()
