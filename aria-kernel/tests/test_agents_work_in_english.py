"""ARIA's agents work in English (operator rule, 2026-10-03).

Measured on origin/aria/state the same day: 0 of 135 recorded agent transcripts carried Turkish in a prompt, and the
4 of 213 agent text blocks with a Turkish letter quoted a Turkish file name. The one channel that put operator prose
straight into an agent envelope was the signed operator request; it now refuses Turkish text at record time. The agent
definitions and the captured rendered prompts are pinned here so a Turkish sentence cannot enter either by edit.
"""
from __future__ import annotations

import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import operator_feedback_signature as ofs
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture

REPO_ROOT = Path(__file__).resolve().parents[2]
TURKISH_LETTERS = re.compile(r"[ğĞüÜşŞıİöÖçÇ]")


def _clean_env() -> mock._patch:
    env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
    return mock.patch.dict(os.environ, env, clear=True)


def _turkish_lines(path: Path) -> list[str]:
    return [f"{path.relative_to(REPO_ROOT)}:{n}" for n, line in
            enumerate(path.read_text(encoding="utf-8").splitlines(), 1) if TURKISH_LETTERS.search(line)]


class AgentFacingTextIsEnglish(unittest.TestCase):
    def test_aria_agent_definitions_are_english(self) -> None:
        agents = sorted((REPO_ROOT / ".claude" / "agents").rglob("aria-*.md"))
        self.assertGreater(len(agents), 10)
        self.assertEqual([hit for path in agents for hit in _turkish_lines(path)], [])

    def test_captured_rendered_prompts_are_english(self) -> None:
        prompts = sorted((REPO_ROOT / "aria-kernel" / "tests" / "fixtures").rglob("*.prompt.utf8"))
        self.assertGreater(len(prompts), 0)
        self.assertEqual([hit for path in prompts for hit in _turkish_lines(path)], [])


class OperatorRequestIsEnglish(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-english-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fixture = OperatorRequestFixture(Path(self.tmp.name))
        self.fixture.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])

    def test_a_turkish_request_is_refused_before_anything_is_signed(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "operator_request_text_not_english"):
            self.fixture.record(request="İzin filtresindeki eksik durumları düzelt")
        self.assertFalse((self.fixture.tools / "operator-feedback.jsonl").exists())
        self.assertEqual(self.fixture.subjects.getvalue(), "", "nothing reached ssh-keygen")

    def test_an_english_request_is_recorded(self) -> None:
        stored = self.fixture.record(request="Fix the missing statuses in the leave filter")
        self.assertEqual(stored["finding_id"], "F-007")

    def test_the_rule_names_its_letters_once(self) -> None:
        self.assertEqual(ofs.NON_ENGLISH_LETTERS.pattern, TURKISH_LETTERS.pattern)


if __name__ == "__main__":
    unittest.main()
