"""ARIA-HIGH-195 — one evidence-ref grammar, and the synthesizer speaks it.

`plan_synthesizer` emitted `path:line:snippet`; `evidence_validator` admitted
the triplet (V8.6) while `evidence_trust._split_ref` split on the LAST colon,
so the snippet became part of the path and a synthesized plan's own evidence
was graded missing (`agent_evidence_not_repo_verified`). The grammar now lives
once, in `evidence_trust.EVIDENCE_REF_RE`, and the synthesizer emits
`path:line`.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import agent_compliance, evidence_validator
from aria_kernel.evidence_trust import EVIDENCE_REF_RE, _split_ref, classify_evidence_ref, parse_evidence_ref
from aria_kernel.plan_synthesizer import _evidence_refs_from_hunks


class OneGrammarTests(unittest.TestCase):
    def test_every_reader_uses_the_one_regex(self) -> None:
        self.assertIs(evidence_validator._AGENT_REF_RE, EVIDENCE_REF_RE)
        self.assertIs(agent_compliance._EVIDENCE_REF_RE, EVIDENCE_REF_RE)

    def test_validator_and_classifier_agree(self) -> None:
        for ref, expected in (
            ("apps/x.ts", ("apps/x.ts", None)),
            ("apps/x.ts:12", ("apps/x.ts", 12)),
            ("apps/x.ts:12:const a = 1", None),
            ("apps/x.ts:12-40", None),
        ):
            with self.subTest(ref=ref):
                self.assertEqual(parse_evidence_ref(ref), expected)
                self.assertEqual(evidence_validator._parse_agent_ref(ref), expected)
                if expected is not None:
                    self.assertEqual(_split_ref(ref), expected)


class SynthesizedRefsResolveTests(unittest.TestCase):
    def test_hunk_refs_are_repo_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "src").mkdir()
            (repo / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
            subprocess.run([*git, "add", "."], check=True)
            subprocess.run([*git, "commit", "-qm", "seed"], check=True)
            (repo / "src" / "a.py").write_text("x = 1\ny: int = 2\n", encoding="utf-8")
            subprocess.run([*git, "commit", "-qam", "change"], check=True)
            refs = _evidence_refs_from_hunks(
                workspace_root=repo, path="src/a.py", git_diff_base="HEAD~1", remaining=5,
            )
            self.assertEqual(refs, ["src/a.py:2"])
            envelope = classify_evidence_ref(refs[0], workspace_root=repo)
            self.assertEqual(envelope.canonical_ref, "src/a.py")
            self.assertEqual(envelope.line, 2)
            self.assertTrue(envelope.exists)


if __name__ == "__main__":
    unittest.main()
