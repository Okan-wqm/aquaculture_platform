"""K6 (ORPHAN-MEDIUM-287) — drafter refusal sentinel parsing."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel.draft_validator import (  # noqa: E402
    DRAFTER_REFUSAL_CLASS_BY_CODE,
    DRAFTER_REFUSAL_REASON_CODES,
    parse_drafter_refusal,
)


class DrafterRefusalSentinelTests(unittest.TestCase):
    def test_valid_sentinel_parses(self) -> None:
        self.assertEqual(
            parse_drafter_refusal("DRAFTER_REFUSAL:target_path_violates_lane"),
            "target_path_violates_lane",
        )

    def test_every_reason_code_has_a_refusal_class(self) -> None:
        self.assertEqual(
            set(DRAFTER_REFUSAL_CLASS_BY_CODE), set(DRAFTER_REFUSAL_REASON_CODES),
        )
        self.assertTrue(
            set(DRAFTER_REFUSAL_CLASS_BY_CODE.values())
            <= {"law", "scope", "evidence", "safety"}
        )

    def test_real_draft_body_is_not_a_refusal(self) -> None:
        body = "---\nname: x\n---\n\nDRAFTER_REFUSAL codes are documented here."
        self.assertIsNone(parse_drafter_refusal(body))

    def test_unknown_code_surfaces_raw(self) -> None:
        self.assertEqual(parse_drafter_refusal("DRAFTER_REFUSAL:novel"), "novel")
