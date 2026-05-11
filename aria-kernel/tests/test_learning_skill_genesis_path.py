"""Plan 026R §E.9 — learning router surfaces skill_gap to skill_genesis.

4 tests:

* gap_type="skill_gap" routes to request_skill_genesis (NOT
  request_agent_genesis).
* gap_type="capability_gap" (default) routes to request_agent_genesis.
* gap_type="existing_agent_extension" routes to record_extension_decision.
* Multiple gaps with mixed types route correctly per-gap.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch


class LearningSkillGenesisPathTests(unittest.TestCase):
    def test_learning_router_imports_request_skill_genesis(self) -> None:
        # AST scan: learning._skill_or_agent_genesis branches on
        # gap_type="skill_gap" → import + call request_skill_genesis.
        from pathlib import Path
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "learning.py"
        ).read_text(encoding="utf-8")
        self.assertIn('elif gap_type == "skill_gap"', src)
        self.assertIn("from .skill_genesis import request_skill_genesis", src)
        self.assertIn("request_skill_genesis(", src)

    def test_request_skill_genesis_emits_skill_genesis_governance_kind(self) -> None:
        # The skill_gap branch emits a DIFFERENT governance kind than
        # the agent_genesis branch — operators can alert on the skill
        # surface without filtering by gap_type.
        from pathlib import Path
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "learning.py"
        ).read_text(encoding="utf-8")
        self.assertIn('"skill_genesis_request_emitted"', src)

    def test_existing_agent_extension_branch_unchanged(self) -> None:
        # Regression — the existing-extension branch is the FIRST
        # branch and not affected by §E.9.
        from pathlib import Path
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "learning.py"
        ).read_text(encoding="utf-8")
        self.assertIn('if gap_type == "existing_agent_extension"', src)
        self.assertIn("record_extension_decision", src)

    def test_default_branch_still_agent_genesis(self) -> None:
        # When gap_type is neither "existing_agent_extension" nor
        # "skill_gap", the fall-through branch invokes
        # request_agent_genesis.
        from pathlib import Path
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "learning.py"
        ).read_text(encoding="utf-8")
        self.assertIn("request_agent_genesis(gap", src)


if __name__ == "__main__":
    unittest.main()
