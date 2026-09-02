"""One secret policy, two consumers — the single-pattern-set contract.

The 2026-09-01 audit reproduced `OPENAI_API_KEY=topsecret` and
`ARIA_LEASE_TOKEN=topsecret` passing through executor artifacts
unredacted: artifact_safety's local pattern set carried a raw-string
`=\\S+` (literal backslash-S) and had drifted from secret_scrub's
separate policy. The pattern set now lives once, in secret_scrub, and
artifact_safety consumes it — these tests pin BOTH consumers to the same
policy so drift fails CI instead of leaking.
"""
from __future__ import annotations

import unittest

from aria_kernel.artifact_safety import SECRET_PATTERNS, scrub_text as artifact_scrub
from aria_kernel.secret_scrub import (
    scrub_text as review_scrub,
    secret_patterns,
)


class SinglePolicyTests(unittest.TestCase):
    def test_artifact_boundary_consums_the_central_patterns(self) -> None:
        self.assertEqual(SECRET_PATTERNS, secret_patterns())

    def test_named_env_assignments_never_survive_either_scrubber(self) -> None:
        # The audit's exact reproduction strings.
        samples = (
            "OPENAI_API_KEY=topsecret123",
            "ARIA_LEASE_TOKEN=topsecret123",
            "ANTHROPIC_API_KEY=sk-live-abc",
            "CODEX_API_KEY=topsecret123",
            "CLAUDE_CODE_OAUTH_TOKEN=topsecret123",
        )
        for sample in samples:
            with self.subTest(sample=sample):
                out = artifact_scrub(f"before {sample} after")
                self.assertNotIn("topsecret", out)
                self.assertNotIn("sk-live-abc", out)
                self.assertIn("<secret-redacted>", out)

                out2, types = review_scrub(f"before {sample} after")
                self.assertNotIn("topsecret", out2)
                self.assertNotIn("sk-live-abc", out2)
                self.assertIn("named_env_assignment", types)

    def test_bearer_and_gh_token_families_are_redacted_by_both(self) -> None:
        samples = (
            "Bearer abcdefghijklmnopqrstuvwxyz012345",
            "ghs_abcdefghijklmnopqrst",
            "ghu_abcdefghijklmnopqrst",
        )
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertNotIn(sample, artifact_scrub(f"x {sample} y"))
                scrubbed, _ = review_scrub(f"x {sample} y")
                self.assertNotIn(sample, scrubbed)

    def test_scrub_json_still_masks_string_credentials_only(self) -> None:
        from aria_kernel.artifact_safety import scrub_json

        out = scrub_json({
            "ARIA_LEASE_TOKEN": "raw-lease",
            "input_tokens": 42,
        })
        self.assertEqual(out["ARIA_LEASE_TOKEN"], "<secret-redacted>")
        self.assertEqual(out["input_tokens"], 42)


if __name__ == "__main__":
    unittest.main()
