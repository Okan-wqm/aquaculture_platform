from __future__ import annotations

import unittest

from aria_kernel.artifact_safety import scrub_text


class ArtifactSafetyDlpTests(unittest.TestCase):
    def test_runner_token_env_assignments_are_scrubbed(self) -> None:
        for key in (
            "ACTIONS_RUNTIME_TOKEN",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "RUNNER_TOKEN",
        ):
            with self.subTest(key=key):
                raw = f"{key}=secret-runner-token-value"
                scrubbed = scrub_text(raw)
                self.assertNotIn("secret-runner-token-value", scrubbed)
                self.assertNotEqual(raw, scrubbed)


if __name__ == "__main__":
    unittest.main()
