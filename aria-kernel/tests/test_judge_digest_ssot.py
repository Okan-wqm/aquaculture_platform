"""E17-a — judge contract digest SSoT invariants.

WHY these tests exist
---------------------
docs/aria/generated/JUDGE-DIGEST.md is a committed render of the
``judge-digest`` marked sections of SPEC.md + CONTRACTS.md + PIPELINES.md.
Four runtime agent preambles (aria-evidence-judge, aria-adversarial-judge,
aria-cross-reviewer, aria-worker) read the digest instead of the full docs
(125,735 bytes of @-refs pre-E17-a). Three failure modes are pinned here:

1. Digest drift — a marked source edited without regenerating the digest
   would silently feed judges stale law text (byte-for-byte + source_hash
   tests).
2. Preamble regression — a full-doc @-ref reappearing in one of the four
   agent .md files silently restores the cold-read cost (reference tests).
3. Cap erosion — the digest regrowing past 10KB defeats its purpose
   (deliberate-break ValueError test).
"""
from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.contract_digest import (
    BEGIN_MARKER,
    END_MARKER,
    JUDGE_DIGEST_PATH,
    JUDGE_DIGEST_SOURCES,
    MAX_DIGEST_BYTES,
    concatenated_marked_sources,
    render_judge_digest,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

JUDGE_DIGEST_AGENT_FILES = (
    ".claude/agents/aria-evidence-judge.md",
    ".claude/agents/aria-adversarial-judge.md",
    ".claude/agents/aria-cross-reviewer.md",
    ".claude/agents/aria-worker.md",
)

DIGEST_LAW_SENTENCE = (
    "Read the FULL SPEC/CONTRACTS only when a digest pointer proves "
    "insufficient — cite the anchor you followed."
)


def _copy_sources_to(tmp_root: Path) -> None:
    for rel in JUDGE_DIGEST_SOURCES:
        target = tmp_root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO_ROOT / rel, target)


class JudgeDigestCommittedRenderInvariant(unittest.TestCase):
    """(a) committed digest ≡ renderer output, byte-for-byte."""

    def test_committed_digest_matches_render_byte_for_byte(self):
        committed = (REPO_ROOT / JUDGE_DIGEST_PATH).read_text(encoding="utf-8")
        rendered = render_judge_digest(REPO_ROOT)
        self.assertEqual(
            committed,
            rendered,
            (
                f"{JUDGE_DIGEST_PATH} is stale — a judge-digest marked section "
                "changed without regenerating. Run: PYTHONPATH=aria-kernel "
                "python3 -m aria_kernel.docs_ssot judge-digest "
                f"> {JUDGE_DIGEST_PATH}"
            ),
        )

    def test_committed_digest_within_hard_cap(self):
        size = len(
            (REPO_ROOT / JUDGE_DIGEST_PATH).read_text(encoding="utf-8").encode("utf-8")
        )
        self.assertLessEqual(size, MAX_DIGEST_BYTES)


class JudgeDigestSourceHashInvariant(unittest.TestCase):
    """(b) the header source_hash recomputes from the marked sources."""

    def test_source_hash_recomputes(self):
        committed = (REPO_ROOT / JUDGE_DIGEST_PATH).read_text(encoding="utf-8")
        match = re.search(r"^source_hash: sha256:([a-f0-9]{64})$", committed, re.MULTILINE)
        self.assertIsNotNone(match, "digest header must carry a source_hash line")
        recomputed = hashlib.sha256(
            concatenated_marked_sources(REPO_ROOT).encode("utf-8")
        ).hexdigest()
        self.assertEqual(match.group(1), recomputed)


class JudgeDigestAgentPreambleInvariant(unittest.TestCase):
    """(c) the four runtime agent preambles consume the digest, not the full docs."""

    def test_agents_reference_digest_and_law_sentence(self):
        for rel in JUDGE_DIGEST_AGENT_FILES:
            body = (REPO_ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("@docs/aria/generated/JUDGE-DIGEST.md", body, rel)
            self.assertIn(
                "@.claude/knowledge/layer-2-aria-canonical-envelope.md", body, rel
            )
            self.assertIn(DIGEST_LAW_SENTENCE, body, rel)

    def test_agents_do_not_reference_full_docs_directly(self):
        # An @-ref (the Claude Code preamble read instruction) is the failure
        # mode; prose MENTIONS of SPEC/CONTRACTS remain legitimate.
        for rel in JUDGE_DIGEST_AGENT_FILES:
            body = (REPO_ROOT / rel).read_text(encoding="utf-8")
            self.assertNotIn("@docs/aria/SPEC.md", body, rel)
            self.assertNotIn("@docs/aria/CONTRACTS.md", body, rel)
            self.assertNotIn("@docs/aria/PIPELINES.md", body, rel)


class JudgeDigestDeliberateBreaks(unittest.TestCase):
    """(d) the invariants actually detect the failures they claim to detect."""

    def test_mutated_marked_source_changes_render(self):
        tmp_root = Path(tempfile.mkdtemp(prefix="judge-digest-break-"))
        try:
            _copy_sources_to(tmp_root)
            spec = tmp_root / "docs/aria/SPEC.md"
            body = spec.read_text(encoding="utf-8")
            begin = body.index(BEGIN_MARKER) + len(BEGIN_MARKER)
            end = body.index(END_MARKER, begin)
            # Mutate INSIDE the first marked block — exactly the edit the
            # byte-for-byte pin must catch when the digest is not regenerated.
            mutated = body[:begin] + "\nINJECTED-DRIFT-SENTINEL\n" + body[begin:end] + body[end:]
            spec.write_text(mutated, encoding="utf-8")
            baseline = render_judge_digest(REPO_ROOT)
            broken = render_judge_digest(tmp_root)
            self.assertNotEqual(baseline, broken)
            self.assertIn("INJECTED-DRIFT-SENTINEL", broken)
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_mutation_outside_markers_does_not_change_render(self):
        # The complement: unmarked prose is NOT digest input, so editing it
        # must not force a digest regen. Guards against over-broad extraction.
        tmp_root = Path(tempfile.mkdtemp(prefix="judge-digest-outside-"))
        try:
            _copy_sources_to(tmp_root)
            spec = tmp_root / "docs/aria/SPEC.md"
            spec.write_text(
                spec.read_text(encoding="utf-8") + "\nUNMARKED-TRAILING-PROSE\n",
                encoding="utf-8",
            )
            self.assertEqual(render_judge_digest(REPO_ROOT), render_judge_digest(tmp_root))
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_oversized_marked_content_raises_value_error(self):
        tmp_root = Path(tempfile.mkdtemp(prefix="judge-digest-cap-"))
        try:
            for rel in JUDGE_DIGEST_SOURCES:
                target = tmp_root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(
                    f"# fixture\n{BEGIN_MARKER}\nsmall marked block\n{END_MARKER}\n",
                    encoding="utf-8",
                )
            spec = tmp_root / "docs/aria/SPEC.md"
            oversized = "X" * (MAX_DIGEST_BYTES + 1024)
            spec.write_text(
                f"# fixture\n{BEGIN_MARKER}\n{oversized}\n{END_MARKER}\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "hard cap"):
                render_judge_digest(tmp_root)
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_unbalanced_marker_raises_value_error(self):
        tmp_root = Path(tempfile.mkdtemp(prefix="judge-digest-marker-"))
        try:
            _copy_sources_to(tmp_root)
            spec = tmp_root / "docs/aria/SPEC.md"
            body = spec.read_text(encoding="utf-8")
            spec.write_text(body.replace(END_MARKER, "", 1), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "never closed|nested"):
                render_judge_digest(tmp_root)
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
