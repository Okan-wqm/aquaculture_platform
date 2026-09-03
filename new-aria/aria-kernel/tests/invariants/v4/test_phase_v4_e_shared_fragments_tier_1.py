"""Plan ARIA-V4 Phase E — `.claude/shared/*.md` stays Tier-1 imperative.

Plan ARIA-V4 §2a + §2b decisions:

  * ARIA-scoped agent prompts (`.claude/agents/aria-*.md`) shift to
    tiered pedagogy (1/2/3 per registry).
  * `.claude/shared/*.md` fragments STAY Tier-1 imperative because
    they are CROSS-LANE SSoT — consumed by both Lane-A
    (orchestrator-dispatched specialists) and Lane-B
    (product-audit specialists), parsed by automated scanners,
    and referenced by `.claude/agents/**` agents from BOTH lanes.

Narrativizing `.claude/shared/*.md` would:
  * Break the grep-stable contract surface that automated gates
    (banned-phrase scanner, tier-claim linter, commit-msg
    validator) depend on.
  * Cross-pollinate narrative pedagogy into non-ARIA agents that
    explicitly opted out via the V4 tier registry.

I-V4-13 invariant: every `.claude/shared/*.md` file MUST NOT
contain any ``### Prohibition:`` H3 narrative-prohibition block.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_SHARED_DIR = _REPO_ROOT / ".claude" / "shared"

if str(_REPO_ROOT / "aria-kernel") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))


def _shared_fragments() -> list[Path]:
    if not _SHARED_DIR.exists():
        return []
    return sorted(_SHARED_DIR.glob("*.md"))


class PhaseV4ESharedFragmentsTier1(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.shared_files = _shared_fragments()

    def test_shared_directory_exists(self) -> None:
        self.assertTrue(
            _SHARED_DIR.exists() and _SHARED_DIR.is_dir(),
            msg=f".claude/shared/ directory missing at {_SHARED_DIR}",
        )
        self.assertGreater(
            len(self.shared_files), 0,
            msg=".claude/shared/ contains zero .md fragments — "
            "baseline guard for cross-lane SSoT",
        )

    # I-V4-13 — shared fragments remain Tier-1 imperative.
    def test_i_v4_13_shared_fragments_remain_tier_1_imperative(
        self,
    ) -> None:
        # Plan ARIA-V4 §2a — .claude/shared/*.md must NOT carry any
        # ``### Prohibition:`` narrative block (the cross-lane SSoT
        # is parsed by automated gates; narrative form would break
        # grep-stability + cross-pollinate pedagogy into non-ARIA
        # agents).
        prohibition_h3_re = re.compile(r"^### Prohibition:", re.MULTILINE)
        violations: list[str] = []
        for path in self.shared_files:
            text = path.read_text(encoding="utf-8")
            matches = prohibition_h3_re.findall(text)
            if matches:
                violations.append(
                    f"{path.relative_to(_REPO_ROOT)}: contains "
                    f"{len(matches)} ``### Prohibition:`` H3 "
                    f"block(s) — Plan ARIA-V4 §2a I-V4-13: shared "
                    f"fragments stay Tier-1 imperative (cross-lane "
                    f"SSoT). Narrative pedagogy lives in "
                    f".claude/agents/aria-*.md only."
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    # Also: shared fragments MUST NOT declare ``pedagogy-tier:`` (the
    # tier registry covers ARIA-scoped agents only).
    def test_shared_fragments_have_no_pedagogy_tier_field(self) -> None:
        pedagogy_tier_re = re.compile(
            r"^pedagogy-tier:", re.MULTILINE,
        )
        violations: list[str] = []
        for path in self.shared_files:
            text = path.read_text(encoding="utf-8")
            if pedagogy_tier_re.search(text):
                violations.append(
                    f"{path.relative_to(_REPO_ROOT)}: declares "
                    f"`pedagogy-tier:` — Plan ARIA-V4 §2a: shared "
                    f"fragments are cross-lane SSoT and DO NOT "
                    f"participate in the ARIA pedagogy registry."
                )
        self.assertEqual(violations, [], msg="\n".join(violations))


if __name__ == "__main__":
    unittest.main()
