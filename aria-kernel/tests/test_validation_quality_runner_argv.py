"""ARIA-HIGH-279 — every quality-runner verb the kernel admits is one the runner has.

WHY. ``validation.ALLOWED_QUALITY_RUNNER_ARGV`` admits two argv shapes of
``node tools/quality/quality.mjs``. The runner is not kernel code: PR #1713
(F-P1, the format scope derived in memory) rewrites its ``format-scope``
domain and drops ``generate``. Had it dropped ``check`` too, the kernel would
have kept admitting — and its validation lane kept running — a command that
exits "usage", and nothing would have said so before a cycle hit it.

WHAT. The runner's ``main()`` dispatches ``if (domain === '<d>')`` blocks that
each test ``action === '<a>'``; every admitted (domain, action) pair must be
dispatched there. The parser is pinned against a synthetic runner without
``format-scope check`` so the pin is shown to fail when the verb is gone.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.validation import ALLOWED_QUALITY_RUNNER_ARGV

_QUALITY_RUNNER = Path(__file__).resolve().parents[2] / "tools" / "quality" / "quality.mjs"


def dispatched_verbs(runner_source: str) -> set[tuple[str, str]]:
    """The (domain, action) pairs the runner's ``main()`` dispatches."""
    body = runner_source[runner_source.index("function main()"):]
    verbs: set[tuple[str, str]] = set()
    for block in body.split("if (domain === '")[1:]:
        domain = block.split("'", 1)[0]
        verbs.update((domain, action) for action in re.findall(r"action === '([^']+)'", block))
    return verbs


class QualityRunnerArgvTests(unittest.TestCase):
    def test_every_admitted_verb_is_dispatched_by_the_runner(self) -> None:
        verbs = dispatched_verbs(_QUALITY_RUNNER.read_text(encoding="utf-8"))
        for argv in ALLOWED_QUALITY_RUNNER_ARGV:
            with self.subTest(argv=argv):
                self.assertEqual(len(argv), 2)
                self.assertIn((argv[0], argv[1]), verbs)

    def test_a_runner_without_the_verb_fails_the_pin(self) -> None:
        runner = (
            "function main() {\n"
            "  if (domain === 'format-scope') {\n"
            "    if (action === 'generate') return generate();\n"
            "  }\n"
            "  if (domain === 'format') {\n"
            "    if (action === 'check-changed') return changed();\n"
            "  }\n"
            "}\n"
        )
        verbs = dispatched_verbs(runner)
        self.assertIn(("format", "check-changed"), verbs)
        self.assertNotIn(("format-scope", "check"), verbs)


if __name__ == "__main__":
    unittest.main()
