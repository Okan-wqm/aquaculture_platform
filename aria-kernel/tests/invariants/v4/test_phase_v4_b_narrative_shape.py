"""Plan ARIA-V4 Phase B — narrative shape + imperative-residue + consequence-leak + token-budget + banned-phrase canonical-drift invariants.

Six cases (I-V4-04..09):

  * I-V4-04 — every ``### Prohibition:`` block in a Tier-2/3 file
    contains the required 4 narrative sections (Plan §2b).
  * I-V4-05 — every Tier-2 hybrid Rule first-line starts with a
    grep-stable imperative (Plan §2c).
  * I-V4-06 — Tier-1 consequence-leak protected rule_classes
    (kernel-self-modification, secret-exfiltration on aria-drafter)
    MUST omit the consequence section (Plan §2d).
  * I-V4-07 — per-agent narrative-token budget ≤ TOKEN_BUDGET_PER_FILE
    (Plan §2g).
  * I-V4-08 — CLAUDE.md banned-phrase canonical list and
    tools/gates/banned-phrase.ts regex source remain co-equal
    (Plan §2f).
  * I-V4-09 — the kernel's ``draft_intent.BANNED_PHRASES_DEFAULT``
    is the third co-equal source: it equals the CLAUDE.md list.

Transitional behavior: until Phase D + E convert content, no
``### Prohibition:`` H3 blocks exist in the corpus, so I-V4-04 +
I-V4-05 + I-V4-06 pass trivially. They ENGAGE the moment any
agent file gains a ``### Prohibition:`` H3 block. I-V4-07 + I-V4-08
work today.
"""

from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = 'the live CLAUDE.md and tools/gates/banned-phrase.ts hold the banned-phrase list the narrative shape checks'

import re
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_AGENTS_DIR = _REPO_ROOT / ".claude" / "agents"
_PEDAGOGY_REGISTRY = _AGENTS_DIR / "_pedagogy-registry.json"
_CLAUDE_MD = _REPO_ROOT / "CLAUDE.md"
_BANNED_PHRASE_TS = _REPO_ROOT / "tools" / "gates" / "banned-phrase.ts"

if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _claude_md_banned_phrases() -> set[str]:
    """The canonical banned-phrase list, lower-cased, from CLAUDE.md.

    The "Phrases BANNED as gating excuses" section carries it as
    bullet lines of quoted phrases, possibly several per bullet via
    " / " separators, up to the next bold heading.
    """
    claude_md = _CLAUDE_MD.read_text(encoding="utf-8")
    section_match = re.search(
        r"\*\*Phrases BANNED as gating excuses:?\*\*\s*\n(.*?)\n\*\*",
        claude_md,
        re.DOTALL,
    )
    if section_match is None:
        raise AssertionError("CLAUDE.md missing 'Phrases BANNED' canonical section")
    phrases: set[str] = set()
    for line in section_match.group(1).splitlines():
        line = line.strip()
        if not line.startswith("-"):
            continue
        for q in re.findall(r'"([^"]+)"', line):
            phrases.add(q.lower())
    return phrases


def _aria_agent_files() -> list[Path]:
    return sorted(
        list(_AGENTS_DIR.glob("aria-*.md"))
        + list((_AGENTS_DIR / "_maintenance").glob("aria-*.md"))
    )


class PhaseV4BNarrativeShape(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from aria_kernel.narrative_prompt_validator import load_registry
        cls.registry = load_registry(_PEDAGOGY_REGISTRY)
        cls.agent_files = _aria_agent_files()

    # I-V4-04 / I-V4-05 / I-V4-06 / I-V4-07 all share validator path.
    def test_i_v4_04_05_06_07_all_agents_pass_narrative_validator(
        self,
    ) -> None:
        from aria_kernel.narrative_prompt_validator import validate_file

        violations: list[str] = []
        for path in self.agent_files:
            result = validate_file(path, pedagogy_registry=self.registry)
            violations.extend(result.violations)
        self.assertEqual(
            violations,
            [],
            msg="Plan ARIA-V4 §2 narrative-shape violations:\n"
            + "\n".join(violations),
        )

    # I-V4-07 explicit token-budget check (also covered by validator
    # but expose it as its own case for the invariant catalogue).
    def test_i_v4_07_token_budget_per_agent(self) -> None:
        from aria_kernel.narrative_prompt_validator import (
            TOKEN_BUDGET_PER_FILE,
            parse_agent_file,
        )

        oversized: list[str] = []
        for path in self.agent_files:
            result = parse_agent_file(path)
            if result.approx_tokens > TOKEN_BUDGET_PER_FILE:
                oversized.append(
                    f"{path.relative_to(_REPO_ROOT)}: "
                    f"approx_tokens={result.approx_tokens} > "
                    f"budget={TOKEN_BUDGET_PER_FILE}"
                )
        self.assertEqual(
            oversized,
            [],
            msg="Plan ARIA-V4 §2g token budget exceeded:\n"
            + "\n".join(oversized),
        )

    # I-V4-08 — banned-phrase canonical co-equality.
    def test_i_v4_08_banned_phrase_canonical_drift(self) -> None:
        """Plan ARIA-V4 §2f — CLAUDE.md and banned-phrase.ts MUST
        carry the same canonical banned-phrase list. A drift between
        the two sources is the worst-case scenario (one says "for
        now is banned" and the other doesn't catch it).

        Pull both sources, extract the phrase list, assert
        set-equality.
        """
        banned_ts = _BANNED_PHRASE_TS.read_text(encoding="utf-8")
        claude_phrases = _claude_md_banned_phrases()

        # banned-phrase.ts source — extract phrases from the
        # docstring at lines 9-21 (per file header).
        ts_phrases: set[str] = set()
        ts_header_match = re.search(
            r"Banned phrases \([^)]+\):\n(.*?)\n \*\s+Exempt paths",
            banned_ts,
            re.DOTALL,
        )
        self.assertIsNotNone(
            ts_header_match,
            msg="banned-phrase.ts missing canonical-list docstring",
        )
        ts_section_text = ts_header_match.group(1)
        for line in ts_section_text.splitlines():
            line = line.strip().lstrip("*").strip()
            if not line.startswith("-"):
                continue
            for q in re.findall(r'"([^"]+)"', line):
                ts_phrases.add(q.lower())

        # Some phrases have parenthetical conditions in CLAUDE.md
        # but not the regex source ("deferred" unless paired with
        # owner+deadline+finding-ID). Compare the raw phrase strings;
        # the docstring may list the bare phrase even when the regex
        # is conditional. For drift detection we only require the
        # PHRASE itself to appear in both lists.
        only_in_claude = claude_phrases - ts_phrases
        only_in_ts = ts_phrases - claude_phrases
        # Allowlist the legitimate CLAUDE.md-only context phrases
        # (Plan ARIA-V4 §2f narrative discussion of "follow-up
        # commit will handle it" etc. — these are operator-facing
        # narrative, not load-bearing regex tokens).
        claude_only_allowlist: set[str] = {
            "follow-up commit will handle it",
        }
        unexpected_only_in_claude = only_in_claude - claude_only_allowlist
        self.assertEqual(
            unexpected_only_in_claude,
            set(),
            msg=(
                "Plan ARIA-V4 §2f banned-phrase drift — phrases in "
                "CLAUDE.md but missing from banned-phrase.ts regex "
                f"source: {sorted(unexpected_only_in_claude)}"
            ),
        )
        self.assertEqual(
            only_in_ts,
            set(),
            msg=(
                "Plan ARIA-V4 §2f banned-phrase drift — phrases in "
                "banned-phrase.ts regex source but missing from "
                f"CLAUDE.md canonical list: {sorted(only_in_ts)}"
            ),
        )

    # I-V4-09 — the kernel's banned-phrase tuple mirrors CLAUDE.md.
    def test_i_v4_09_kernel_banned_phrases_equal_claude_md(self) -> None:
        """Plan ARIA-V3 §A3 — ``draft_validator`` and every kernel
        banned-phrase gate read ``BANNED_PHRASES_DEFAULT``, and agent
        prompts promise that gate catches the CLAUDE.md list. A phrase
        CLAUDE.md bans but the tuple lacks passes every kernel gate;
        a phrase only the tuple carries is a ban CLAUDE.md never made.
        """
        from aria_kernel.draft_intent import BANNED_PHRASES_DEFAULT

        kernel_phrases = {p.lower() for p in BANNED_PHRASES_DEFAULT}
        claude_phrases = _claude_md_banned_phrases()
        self.assertEqual(
            kernel_phrases,
            claude_phrases,
            msg=(
                "Plan ARIA-V3 §A3 banned-phrase drift — in CLAUDE.md but "
                f"not the kernel: {sorted(claude_phrases - kernel_phrases)}; "
                "in the kernel but not CLAUDE.md: "
                f"{sorted(kernel_phrases - claude_phrases)}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
