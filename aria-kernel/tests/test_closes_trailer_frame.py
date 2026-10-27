"""ARIA-MEDIUM-1000 — the Closes-trailer frame and the F-NNN / F-AUTO / DEBT forms are held to the gate.

WHY. The kernel mints the ``Closes:`` trailer a commit carries and the gate
(``tools/gates/commit-msg-validator.ts``, ``CLOSES_TRAILER_REGEX``) judges it.
Both build the registry id inside the trailer from their own grammar owner, and
``test_registry_finding_id_four_digits.py`` holds that part to one table of ids.
Everything around it is typed twice and was held to the gate by a byte-for-byte
mirror (``test_closes_trailer_regex_mirror``) that went away with the registry
id: the prefix ``Closes:\\s+(\\S+?)#``, the ``F-NNN`` form, the ``F-AUTO-V`` form,
the ``DEBT`` form and the closing ``\\s*$``. With nothing comparing them, an edit
of the gate's ``F-NNN`` or ``DEBT`` form left every kernel test green while the
kernel minted trailers the gate refuses, or refused ones the gate accepts.

WHAT this module pins, on the two owners rather than on typed copies of the id:

  * the kernel's trailer pattern is the gate's template literal with the owner's
    id source in the placeholder (``${FINDING_ID_SOURCE}``): edit any other part
    of either side and the pattern differs;
  * the trailer lines the gate documents are read the same way whatever the
    mirror's text says: the ``F-NNN``, ``F-AUTO-V`` and ``DEBT`` forms, a trailing
    space, a missing ``#``.

The registry id alternative is not compared here: that is the table's job.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the gate's source from
# the live checkout (outside the kernel surface), so it runs in aria-kernel.yml's
# always-run `workspace` job, never in a skippable shard.
READS_LIVE_CHECKOUT = 'tools/gates/commit-msg-validator.ts is the gate whose Closes trailer the kernel mints'

import re
import unittest
from pathlib import Path

from aria_kernel.finding_id_grammar import FINDING_ID_SOURCE
from aria_kernel.plan_origin import CLOSES_TRAILER_RE

_GATE = Path(__file__).resolve().parents[2] / "tools" / "gates" / "commit-msg-validator.ts"
_PLACEHOLDER = "${FINDING_ID_SOURCE}"
_REVIEW = "docs/reviews/claude/2026-10-25-trailer-frame.md"


def _gate_trailer_pattern() -> str:
    """The gate's ``CLOSES_TRAILER_REGEX`` as the regex it builds, the owner's id source in its placeholder."""
    source = _GATE.read_text(encoding="utf-8")
    match = re.search(r"const CLOSES_TRAILER_REGEX = new RegExp\(\s*`(.+?)`,?\s*\);", source, re.DOTALL)
    assert match is not None, "the gate no longer builds CLOSES_TRAILER_REGEX from one template literal"
    # A template literal spells a backslash as two; the regex it builds has one.
    template = match.group(1).replace("\\\\", "\\")
    assert template.count(_PLACEHOLDER) == 1, "the gate's trailer names the registry id grammar exactly once"
    pattern = template.replace(_PLACEHOLDER, FINDING_ID_SOURCE)
    assert "${" not in pattern, "the gate's trailer interpolates something this mirror does not know"
    return pattern


class TheKernelTrailerIsTheGatesTrailer(unittest.TestCase):
    def test_the_kernel_pattern_is_the_gates_template_with_the_owner_substituted(self) -> None:
        self.assertEqual(CLOSES_TRAILER_RE.pattern, _gate_trailer_pattern())


class TheTrailerFormsTheGateDocuments(unittest.TestCase):
    _ACCEPTED = (
        f"Closes: {_REVIEW}#F-001",
        f"Closes: {_REVIEW}#ARIA-HIGH-1000",
        "Closes: aria-findings/F-018.json#F-018",
        "Closes: aria-findings/F-AUTO-V10.6-SELF-FEED.json#F-AUTO-V10.6-SELF-FEED",
        "Closes: aria-debts/DEBT-2026-05-08-001.json#DEBT-2026-05-08-001",
        f"Closes:   {_REVIEW}#F-001",
        f"Closes: {_REVIEW}#F-001   ",
        f"Closes: {_REVIEW}#F-001\t",
        f"Closes: {_REVIEW}#F-001\n",
    )
    _REFUSED = (
        f"Closes: {_REVIEW} F-001",
        f"Closes: {_REVIEW}#",
        "Closes: #F-001",
        f"Closes:{_REVIEW}#F-001",
        f"closes: {_REVIEW}#F-001",
        f" Closes: {_REVIEW}#F-001",
        f"Closes: {_REVIEW}#F-001 and more",
        f"Closes: {_REVIEW}#F-0001",
        f"Closes: {_REVIEW}#F-1000",
        f"Closes: {_REVIEW}#F-01",
        f"Closes: {_REVIEW}#F-AUTO-V10.6",
        f"Closes: {_REVIEW}#F-AUTO-V10-SELF-FEED",
        f"Closes: {_REVIEW}#DEBT-2026-05-08-0001",
        f"Closes: {_REVIEW}#DEBT-26-05-08-001",
        f"Closes: {_REVIEW}#DEBT-2026-05-08",
    )

    def test_each_documented_form_is_a_trailer(self) -> None:
        for line in self._ACCEPTED:
            with self.subTest(line=line):
                self.assertIsNotNone(CLOSES_TRAILER_RE.match(line))

    def test_the_form_names_its_own_id_in_the_second_group(self) -> None:
        for finding_id in ("F-001", "F-AUTO-V10.6-SELF-FEED", "DEBT-2026-05-08-001", "ARIA-HIGH-1000"):
            with self.subTest(finding_id=finding_id):
                match = CLOSES_TRAILER_RE.match(f"Closes: {_REVIEW}#{finding_id}")
                self.assertIsNotNone(match)
                assert match is not None
                self.assertEqual((match.group(1), match.group(2)), (_REVIEW, finding_id))

    def test_a_line_outside_the_frame_or_the_forms_is_not_a_trailer(self) -> None:
        for line in self._REFUSED:
            with self.subTest(line=line):
                self.assertIsNone(CLOSES_TRAILER_RE.match(line))


if __name__ == "__main__":
    unittest.main()
