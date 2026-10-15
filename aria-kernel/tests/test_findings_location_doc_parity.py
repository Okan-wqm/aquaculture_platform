"""ARIA-HIGH-500 — the docs say where ARIA's own findings live, as the manifest does.

IDENTITY said findings "sit in `aria-findings/F-*.md`" and SPEC §8.4 said
they "live under `docs/reviews/aria/`"; the kernel writes `F-NNN.json` records
to the `aria-findings/` surface of the repo state root (manifest surface
`repo_finding_docs`). §8.4 also described a single CLAUDE.md commit trailer,
while ARIA's own commits take theirs from `plan_origin.commit_contract_for_plan`.
"""
from __future__ import annotations

import re
import unittest
from pathlib import PurePosixPath, Path

from aria_kernel.state_manifest import surface_by_name

_DOCS = Path(__file__).resolve().parents[2] / "docs" / "aria"
_FINDING_PATH = re.compile(r"aria-findings/F-[A-Za-z0-9*.\-]+")
_WRONG_HOME = re.compile(r"[Ff]indings (live|sit) (under|in) `docs/reviews/")


class FindingsLocationDocParity(unittest.TestCase):
    def test_finding_paths_carry_the_manifest_suffix(self) -> None:
        suffix = PurePosixPath(surface_by_name("repo_finding_docs").path_pattern).suffix
        self.assertEqual(suffix, ".json")
        wrong: list[str] = []
        for doc in sorted(_DOCS.glob("*.md")):
            for number, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), start=1):
                for match in _FINDING_PATH.findall(line):
                    # A sentence-final period is prose, not part of the path.
                    if not match.rstrip(".").endswith(suffix):
                        wrong.append(f"{doc.name}:{number}: {match}")
                if _WRONG_HOME.search(line):
                    wrong.append(f"{doc.name}:{number}: findings placed under docs/reviews/")
        self.assertEqual(wrong, [])

    def test_commit_format_names_the_trailer_owner(self) -> None:
        spec = (_DOCS / "SPEC.md").read_text(encoding="utf-8")
        start = spec.index("### 8.4")
        end = spec.find("\n### ", start + len("### 8.4"))
        section = spec[start:] if end == -1 else spec[start:end]
        self.assertTrue(
            "plan_origin.commit_contract_for_plan" in section,
            "SPEC §8.4 does not name the commit-contract owner",
        )


if __name__ == "__main__":
    unittest.main()
