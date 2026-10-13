"""One sanitizer for every text that leaves the host (review of the 2026-10-10 repair stack).

aria/state and the GitHub issues are public. A failure's text names host paths and can carry
anything an exception or an agent put in it; four places each did part of the cleaning.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.artifact_safety import published_text


class PublishedTextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Path(tempfile.mkdtemp(prefix="aria-published-")) / "aria-tools"

    def test_a_store_path_stays_store_relative(self) -> None:
        text = f"Invalid JSONL at {self.store}/memory/beliefs.jsonl:17"
        self.assertEqual(published_text(text, store_root=self.store, limit=300), "Invalid JSONL at memory/beliefs.jsonl:17")

    def test_any_other_absolute_path_is_reduced_to_its_name(self) -> None:
        text = "refused /home/gharunner/actions-runner/_work/x/finding-events.jsonl and /etc/passwd"
        self.assertEqual(published_text(text, store_root=self.store, limit=300), "refused finding-events.jsonl and passwd")

    def test_secret_shapes_are_redacted(self) -> None:
        token = "ghp_" + "A" * 36
        out = published_text(f"auth failed with {token}", store_root=None, limit=300)
        self.assertNotIn(token, out)
        self.assertIn("<secret-redacted>", out)

    def test_the_text_is_bounded(self) -> None:
        self.assertEqual(len(published_text("x" * 5000, store_root=None, limit=300)), 300)


if __name__ == "__main__":
    unittest.main()
