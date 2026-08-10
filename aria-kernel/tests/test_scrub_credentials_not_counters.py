"""The scrubber masks credentials, not the numbers that happen to say token.

Every usage counter the Claude CLI reports contains the substring "token"
(input_tokens, output_tokens, cache_read_input_tokens, ...), and the key
match masked them all — cost telemetry read <secret-redacted> where the
spend was, protecting nothing: an integer cannot leak a secret. A credential
is a string; a counter is a number. String values under token-ish keys stay
masked.
"""
from __future__ import annotations

import unittest

from aria_kernel.artifact_safety import scrub_json, scrub_text


class ScrubberFaultLineTest(unittest.TestCase):
    def test_token_counters_survive(self) -> None:
        payload = {
            "input_tokens": 48213,
            "output_tokens": 1921,
            "cache_creation": {"ephemeral_1h_input_tokens": 12000},
        }

        out = scrub_json(payload)

        self.assertEqual(out["input_tokens"], 48213)
        self.assertEqual(out["cache_creation"]["ephemeral_1h_input_tokens"], 12000)

    def test_string_credentials_under_token_keys_stay_masked(self) -> None:
        payload = {
            "lease_token": "raw-lease-value",
            "api_key": "sk-" + "a" * 30,
            "oauth_token": "sk-ant-oat01-xyz",
        }

        out = scrub_json(payload)

        self.assertEqual(out["lease_token"], "<secret-redacted>")
        self.assertEqual(out["api_key"], "<secret-redacted>")
        self.assertEqual(out["oauth_token"], "<secret-redacted>")

    def test_value_patterns_still_fire_inside_free_text(self) -> None:
        # The pattern layer is untouched: a bare sk- credential inside any
        # string is still scrubbed regardless of its key.
        out = scrub_text("before sk-" + "b" * 24 + " after")

        self.assertIn("<secret-redacted>", out)
        self.assertNotIn("sk-" + "b" * 24, out)


if __name__ == "__main__":
    unittest.main()
